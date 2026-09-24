import type { CalendarRepo } from '../../calendar/repo.js';
import type { AppConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import { addHours, nowIso } from '../../domain/dates.js';
import type { Logger } from '../../logger.js';
import { cwlGroupFound, raidEnded, raidEnding, raidStarted, warEnded, warEnding, warFound, warStarted, type CwlGroupSnapshot, type RaidSnapshot, type WarSnapshot } from '../../messages/clan.js';
import type { Outbox } from '../../outbox/queue.js';
import { recordRunEnd, recordRunStart } from '../announcements/index.js';
import { CocApiError, CocUnavailableError, parseCocTime, type CocClient, type RawLeagueGroup, type RawWar, type RawWarClan } from './client.js';

export interface ClanPollerDeps {
  client: CocClient;
  clanTag: string;
  db: Db;
  repo: CalendarRepo;
  outbox: Outbox;
  cfg: AppConfig;
  log: Logger;
}

export interface ClanPollResult {
  ok: boolean;
  errors: string[];
  war?: WarSnapshot['state'];
  cwl?: string;
  raid?: RaidSnapshot['state'];
}

/**
 * Coletor do estado do clã. Máquina de estados persistida em clan_state; avisos com chaves
 * clan:war:<key>:<estado>, clan:cwl:<season>:group, clan:raid:<key>:<estado>, e lembretes
 * clan:*:<key>:ending:<horas>. Falhas de consulta nunca alteram o estado nem geram avisos.
 */
export class ClanPoller {
  constructor(private readonly d: ClanPollerDeps) {}

  private get tz() {
    return this.d.cfg.tzDisplay;
  }
  private get ttl() {
    return this.d.cfg.delivery.noticeTtlHours;
  }
  private get lead() {
    return this.d.cfg.reminders.leadClanHours;
  }
  private normTag(t?: string) {
    return (t ?? '').toUpperCase().replace(/^#?/, '#');
  }

  async pollOnce(now = nowIso()): Promise<ClanPollResult> {
    const runId = recordRunStart(this.d.db, 'clan', now);
    const result: ClanPollResult = { ok: true, errors: [] };
    await this.step('war', result, now, async () => {
      const raw = await this.d.client.currentWar(this.d.clanTag);
      result.war = raw.state;
      if (raw.state !== 'notInWar') this.handleWar(raw, { kind: 'war', key: this.warKey(raw) }, now);
    });
    await this.step('cwl', result, now, async () => {
      let group: RawLeagueGroup | null = null;
      try {
        group = await this.d.client.leagueGroup(this.d.clanTag);
      } catch (err) {
        if (err instanceof CocApiError && err.isNotFound) return; // fora da Liga de Guerra no momento
        throw err;
      }
      if (!group || group.state === 'notInWar') return;
      result.cwl = `${group.season}:${group.state}`;
      this.handleCwlGroup(group, now);
      for (const [idx, round] of (group.rounds ?? []).entries()) {
        for (const tag of round.warTags ?? []) {
          if (!tag || tag === '#0') continue;
          const war = await this.d.client.leagueWar(tag);
          const mine = this.normTag(this.d.clanTag);
          if (this.normTag(war.clan?.tag) !== mine && this.normTag(war.opponent?.tag) !== mine) continue;
          this.handleWar(war, { kind: 'cwl', key: `${group.season}:${tag}`, cwlRound: idx + 1, cwlSeason: group.season }, now);
        }
      }
    });
    await this.step('raid', result, now, async () => {
      const seasons = await this.d.client.capitalRaidSeasons(this.d.clanTag, 1);
      const cur = seasons.items?.[0];
      if (!cur) return;
      result.raid = cur.state;
      this.handleRaid(cur, now);
    });
    recordRunEnd(this.d.db, runId, result.ok, result.errors.join('; ') || null, 0, nowIso());
    return result;
  }

  private async step(name: string, result: ClanPollResult, now: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      result.ok = false;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${name}: ${msg}`);
      if (err instanceof CocApiError && err.isForbidden) {
        this.d.log.warn({ step: name }, 'acesso negado (403): log de guerra privado, chave inválida ou IP não autorizado na chave');
      } else if (err instanceof CocUnavailableError) {
        this.d.log.warn({ step: name, err: msg }, 'API do Clash indisponível; estado anterior mantido');
      } else {
        this.d.log.warn({ step: name, err: msg }, 'falha na consulta do clã; estado anterior mantido');
      }
    }
  }

  // ---------- estado ----------

  private getState(kind: string, key: string): { state: string; snapshot: unknown } | undefined {
    const r = this.d.db.get<{ state: string; snapshot_json: string }>('SELECT state, snapshot_json FROM clan_state WHERE kind = ? AND key = ?', kind, key);
    return r ? { state: r.state, snapshot: JSON.parse(r.snapshot_json) } : undefined;
  }

  private setState(kind: string, key: string, state: string, snapshot: unknown, now: string) {
    this.d.db.run(
      `INSERT INTO clan_state (kind, key, state, snapshot_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, key) DO UPDATE SET state = excluded.state, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      kind, key, state, JSON.stringify(snapshot), now,
    );
  }

  private recent(iso: string | null, now: string): boolean {
    if (!iso) return false;
    return new Date(now).getTime() - new Date(iso).getTime() <= this.ttl * 3600_000;
  }

  // ---------- guerra ----------

  private warKey(raw: RawWar): string {
    return parseCocTime(raw.preparationStartTime) ?? parseCocTime(raw.startTime) ?? 'unknown';
  }

  private side(c?: RawWarClan) {
    return c ? { name: c.name ?? '?', tag: this.normTag(c.tag), stars: c.stars ?? 0, destructionPercentage: c.destructionPercentage ?? 0, attacks: c.attacks ?? 0 } : null;
  }

  snapshotWar(raw: RawWar, ctx: { key: string; cwlRound?: number; cwlSeason?: string }): WarSnapshot {
    const mine = this.normTag(this.d.clanTag);
    const swap = raw.opponent && this.normTag(raw.opponent.tag) === mine;
    const clan = this.side(swap ? raw.opponent : raw.clan);
    const opponent = this.side(swap ? raw.clan : raw.opponent);
    return {
      key: ctx.key,
      state: raw.state,
      teamSize: raw.teamSize ?? null,
      attacksPerMember: raw.attacksPerMember ?? (ctx.cwlRound ? 1 : null),
      preparationStartTime: parseCocTime(raw.preparationStartTime),
      startTime: parseCocTime(raw.startTime),
      endTime: parseCocTime(raw.endTime),
      clan,
      opponent,
      ...(ctx.cwlRound ? { cwlRound: ctx.cwlRound, cwlSeason: ctx.cwlSeason } : {}),
    };
  }

  handleWar(raw: RawWar, ctx: { kind: 'war' | 'cwl'; key: string; cwlRound?: number; cwlSeason?: string }, now = nowIso()) {
    const snap = this.snapshotWar(raw, ctx);
    const prev = this.getState(ctx.kind, ctx.key);
    const changed = !prev || prev.state !== snap.state;
    const prefix = `clan:${ctx.kind}:${ctx.key}`;
    const expires = addHours(now, this.ttl);

    if (changed) {
      if (snap.state === 'preparation') {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:preparation`, kind: 'clan_war_found', body: warFound(snap, this.tz), expiresAt: expires }, now);
      } else if (snap.state === 'inWar' && this.recent(snap.startTime, now)) {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:inWar`, kind: 'clan_war_started', body: warStarted(snap, this.tz), expiresAt: expires }, now);
      } else if (snap.state === 'warEnded' && this.recent(snap.endTime, now)) {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:warEnded`, kind: 'clan_war_ended', body: warEnded(snap, this.tz), expiresAt: expires }, now);
      }
    }
    if (snap.state === 'inWar' && snap.endTime) {
      const endMs = new Date(snap.endTime).getTime();
      const nowMs = new Date(now).getTime();
      if (nowMs >= endMs - this.lead * 3600_000 && nowMs < endMs) {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:ending:${this.lead}`, kind: 'clan_war_ending', body: warEnding(snap, this.tz, new Date(now)), expiresAt: snap.endTime }, now);
      }
    }
    this.setState(ctx.kind, ctx.key, snap.state, snap, now);

    // Evento do clã no calendário (aparece no semanal; sem lembretes do motor global).
    if (snap.startTime && snap.endTime) {
      const title = ctx.cwlRound ? `Liga de Guerra ${ctx.cwlSeason} · rodada ${ctx.cwlRound}${snap.opponent ? ` vs ${snap.opponent.name}` : ''}` : `Guerra de clãs${snap.opponent ? ` vs ${snap.opponent.name}` : ''}`;
      this.d.repo.applyEvent(
        { id: `clan_${ctx.kind}_${ctx.key.replace(/[^A-Za-z0-9]/g, '')}`, category: ctx.kind === 'cwl' ? 'cwl' : 'war', scope: 'clan', title, startAt: snap.startTime, startPrecision: 'datetime', endAt: snap.endTime, endPrecision: 'datetime', rewardsStatus: 'not_announced', extra: { key: ctx.key } },
        { origin: 'clan', now },
      );
    }
  }

  // ---------- liga ----------

  handleCwlGroup(group: RawLeagueGroup, now = nowIso()) {
    const snap: CwlGroupSnapshot = { season: group.season, state: group.state, rounds: (group.rounds ?? []).length, clans: (group.clans ?? []).map((c) => c.name) };
    const prev = this.getState('cwl_group', group.season);
    if (!prev) {
      this.d.outbox.enqueue({ dedupKey: `clan:cwl:${group.season}:group`, kind: 'clan_cwl_group', body: cwlGroupFound(snap), expiresAt: addHours(now, this.ttl) }, now);
    }
    this.setState('cwl_group', group.season, group.state, snap, now);
  }

  // ---------- raides ----------

  handleRaid(raw: { state: 'ongoing' | 'ended'; startTime: string; endTime: string; capitalTotalLoot?: number; raidsCompleted?: number; totalAttacks?: number; enemyDistrictsDestroyed?: number; offensiveReward?: number; defensiveReward?: number }, now = nowIso()) {
    const start = parseCocTime(raw.startTime);
    const end = parseCocTime(raw.endTime);
    if (!start || !end) return;
    const snap: RaidSnapshot = {
      key: start, state: raw.state, startTime: start, endTime: end,
      capitalTotalLoot: raw.capitalTotalLoot ?? null, raidsCompleted: raw.raidsCompleted ?? null, totalAttacks: raw.totalAttacks ?? null,
      enemyDistrictsDestroyed: raw.enemyDistrictsDestroyed ?? null, offensiveReward: raw.offensiveReward ?? null, defensiveReward: raw.defensiveReward ?? null,
    };
    const prev = this.getState('raid', snap.key);
    const changed = !prev || prev.state !== snap.state;
    const prefix = `clan:raid:${snap.key}`;
    if (changed) {
      if (snap.state === 'ongoing' && this.recent(start, now)) {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:ongoing`, kind: 'clan_raid_started', body: raidStarted(snap, this.tz), expiresAt: addHours(now, this.ttl) }, now);
      } else if (snap.state === 'ended' && this.recent(end, now)) {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:ended`, kind: 'clan_raid_ended', body: raidEnded(snap, this.tz), expiresAt: addHours(now, this.ttl) }, now);
      }
    }
    if (snap.state === 'ongoing') {
      const endMs = new Date(end).getTime();
      const nowMs = new Date(now).getTime();
      if (nowMs >= endMs - this.lead * 3600_000 && nowMs < endMs) {
        this.d.outbox.enqueue({ dedupKey: `${prefix}:ending:${this.lead}`, kind: 'clan_raid_ending', body: raidEnding(snap, this.tz, new Date(now)), expiresAt: end }, now);
      }
    }
    this.setState('raid', snap.key, snap.state, snap, now);

    const rewards = snap.offensiveReward !== null
      ? [{ label: 'Medalhas de raide (ofensiva)', quantity: snap.offensiveReward, condition: 'por membro que atacou', tier: 'free' as const }, ...(snap.defensiveReward !== null ? [{ label: 'Medalhas de raide (defesa)', quantity: snap.defensiveReward, tier: 'free' as const }] : [])]
      : [{ label: 'Medalhas de raide', condition: 'quantidade definida pelo desempenho ofensivo e defensivo do clã ao final', tier: 'free' as const }];
    this.d.repo.applyEvent(
      { id: `clan_raid_${snap.key.replace(/[^A-Za-z0-9]/g, '')}`, category: 'raid_weekend', scope: 'clan', title: 'Fim de Semana de Raides', startAt: start, startPrecision: 'datetime', endAt: end, endPrecision: 'datetime', rewards, rewardsStatus: 'known', extra: { key: snap.key } },
      { origin: 'clan', now },
    );
  }
}

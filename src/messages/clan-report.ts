import { DateTime } from 'luxon';
import { displayDateTime, formatWhen } from '../domain/dates.js';
import type { ClashEvent } from '../domain/types.js';
import { pct, type ClanInfoSnapshot, type CwlGroupSnapshot, type RaidSnapshot, type WarLogEntry, type WarSnapshot } from './clan.js';
import { bold } from './format.js';

/** Estado do clã vindo da API oficial (clan_state), para a seção "Nosso clã" dos relatórios. */
export interface ClanReport {
  info: ClanInfoSnapshot | null;
  /** Última atualização bem-sucedida dos dados gerais do clã. */
  updatedAt: string | null;
  /** Guerra comum em preparação ou batalha. */
  currentWar: WarSnapshot | null;
  warLog: WarLogEntry[];
  cwl: { group: CwlGroupSnapshot; rounds: WarSnapshot[] } | null;
  /** Fim de semana de raides mais recente. */
  raid: RaidSnapshot | null;
}

/** Dados do clã mais velhos que isso aparecem com alerta (a coleta roda a cada poucos minutos). */
const STALE_MS = 30 * 60_000;
const DAY_MS = 24 * 3600_000;

const LEAGUE_PT: Record<string, string> = {
  bronze: 'Bronze',
  silver: 'Prata',
  gold: 'Ouro',
  crystal: 'Cristal',
  master: 'Mestre',
  champion: 'Campeão',
  titan: 'Titã',
  legend: 'Lenda',
};

/** "Gold League II" → "Ouro II"; nome desconhecido fica como a API devolveu. */
export function leagueName(name: string | null): string | null {
  if (!name) return null;
  if (/^unranked$/i.test(name)) return 'sem liga';
  const m = /^(\w+) League(?: (I{1,3}|IV|V))?$/i.exec(name.trim());
  const pt = m ? LEAGUE_PT[m[1]!.toLowerCase()] : undefined;
  return pt ? `${pt}${m![2] ? ` ${m![2]}` : ''}` : name;
}

function num(n: number): string {
  return n.toLocaleString('pt-BR');
}


function day(iso: string, tz: string): string {
  return displayDateTime(iso, 'datetime', tz).toFormat('dd/LL');
}

/** Mesmo critério do aviso de fim de guerra: estrelas, depois destruição. */
function outcome(w: WarSnapshot): 'win' | 'lose' | 'tie' | null {
  if (w.result) return w.result;
  const c = w.clan;
  const o = w.opponent;
  if (!c || !o) return null;
  if (c.stars !== o.stars) return c.stars > o.stars ? 'win' : 'lose';
  if (c.destructionPercentage !== o.destructionPercentage) return c.destructionPercentage > o.destructionPercentage ? 'win' : 'lose';
  return 'tie';
}

const OUTCOME_LABEL = { win: '✅ Vitória', lose: '❌ Derrota', tie: '🤝 Empate' } as const;

function score(c: { stars: number; destructionPercentage: number }, o: { stars: number; destructionPercentage: number }): string {
  return `${c.stars}⭐ x ${o.stars}⭐ (${pct(c.destructionPercentage)} x ${pct(o.destructionPercentage)})`;
}

function seasonMonthName(season: string, tz: string): string {
  const dt = DateTime.fromISO(`${season.slice(0, 7)}-01`, { zone: tz }).setLocale('pt-BR');
  return dt.isValid ? dt.toFormat('LLLL') : season;
}

function headerBlock(c: ClanReport): string[] | null {
  const i = c.info;
  if (!i) return null;
  const lines = [`⚔️ ${bold('NOSSO CLÃ')} · ${i.name}`];
  const basics = [i.level !== null ? `Nível ${i.level}` : null, i.members !== null ? `${i.members} membros` : null].filter(Boolean);
  if (basics.length) lines.push(`• ${basics.join(' · ')}`);
  const war = leagueName(i.warLeague);
  const capital = leagueName(i.capitalLeague);
  const leagues = [war ? `🏆 Liga de Guerra: ${war}` : null, capital ? `🏰 Capital: ${capital}${i.capitalHallLevel ? ` (Centro da Capital nível ${i.capitalHallLevel})` : ''}` : null].filter(Boolean);
  if (leagues.length) lines.push(`• ${leagues.join(' · ')}`);
  if (i.warWins !== null) {
    const record = [`${num(i.warWins)} vitórias`, i.warLosses !== null ? `${num(i.warLosses)} derrotas` : null, i.warTies !== null ? `${num(i.warTies)} empates` : null].filter(Boolean).join(' · ');
    const streak = i.warWinStreak ? ` · sequência atual: ${i.warWinStreak} ${i.warWinStreak === 1 ? 'vitória' : 'vitórias'}` : '';
    lines.push(`• 📊 Guerras: ${record}${streak}`);
  }
  return lines;
}

function roundLines(w: WarSnapshot, group: CwlGroupSnapshot, tz: string, now: Date): string[] {
  const opp = w.opponent;
  const level = opp ? group.clanDetails?.find((c) => c.tag === opp.tag)?.level : null;
  const size = w.teamSize ? ` · ${w.teamSize}x${w.teamSize}` : '';
  const head = `• Rodada ${w.cwlRound ?? '?'}${opp ? ` · vs ${opp.name}${level ? ` (nv. ${level})` : ''}` : ''}${size}`;
  if (w.state === 'preparation') {
    return [
      head,
      w.startTime ? `   ⏳ Preparação até ${formatWhen(w.startTime, 'datetime', tz)}` : null,
      w.startTime && w.endTime ? `   ⚔️ Batalha: ${formatWhen(w.startTime, 'datetime', tz)} → ${formatWhen(w.endTime, 'datetime', tz)}` : null,
    ].filter((l): l is string => !!l);
  }
  if (w.state === 'inWar') {
    const parts = [w.clan && opp ? `placar ${score(w.clan, opp)}` : null, w.clan && w.teamSize ? `ataques ${w.clan.attacks}/${w.teamSize * (w.attacksPerMember ?? 1)}` : null].filter(Boolean);
    const ends = w.endTime && new Date(w.endTime).getTime() > now.getTime() ? `   ⚔️ Em batalha até ${formatWhen(w.endTime, 'datetime', tz)}` : null;
    return [head, ...(ends ? [ends] : []), ...(parts.length ? [`   📈 Agora: ${parts.join(' · ')}`] : [])];
  }
  const res = outcome(w);
  return [`${head} · ${res ? OUTCOME_LABEL[res] : 'encerrada'}${w.clan && opp ? ` ${score(w.clan, opp)}` : ''}`];
}

function cwlBlock(cwl: NonNullable<ClanReport['cwl']>, tz: string, now: Date, period: ClashEvent | null): string[] {
  const { group, rounds } = cwl;
  const lines = [`🏆 ${bold(`LIGA DE GUERRA DE ${seasonMonthName(group.season, tz).toUpperCase()}`)}`];
  if (period?.startAt && period.endAt) {
    const s = displayDateTime(period.startAt, period.startPrecision, tz).toFormat('dd/LL');
    const e = displayDateTime(period.endAt, period.endPrecision, tz).toFormat('dd/LL');
    lines.push(`• Período: ${s} a ${e} (segundo a Supercell)`);
  }
  const clans = group.clanDetails?.length ? [...group.clanDetails].sort((a, b) => (b.level ?? 0) - (a.level ?? 0)) : group.clans.map((name) => ({ name, tag: '', level: null }));
  lines.push(`• Grupo com ${clans.length} clãs: ${clans.map((c) => `${c.name}${c.level ? ` (nv. ${c.level})` : ''}`).join(', ')}`);
  const sorted = [...rounds].sort((a, b) => (a.cwlRound ?? 0) - (b.cwlRound ?? 0));
  for (const w of sorted) lines.push(...roundLines(w, group, tz, now));
  const ended = sorted.filter((w) => w.state === 'warEnded' && w.clan);
  if (ended.length) {
    const wins = ended.filter((w) => outcome(w) === 'win').length;
    const stars = ended.reduce((acc, w) => acc + (w.clan?.stars ?? 0), 0);
    lines.push(`• ⭐ Até agora: ${wins} ${wins === 1 ? 'vitória' : 'vitórias'} em ${ended.length} ${ended.length === 1 ? 'rodada' : 'rodadas'}, ${stars} estrelas`);
  }
  const known = sorted.length ? Math.max(...sorted.map((w) => w.cwlRound ?? 0)) : 0;
  if (group.state !== 'ended' && known < group.rounds) {
    lines.push(`• ${known + 1 === group.rounds ? `Rodada ${group.rounds}` : `Rodadas ${known + 1} a ${group.rounds}`}: adversário e horário saem quando a rodada começar`);
  }
  return lines;
}

function warsBlock(c: ClanReport, tz: string, now: Date, sinceMs: number | null): string[] | null {
  const lines = [`⚔️ ${bold('GUERRAS COMUNS')}`];
  const w = c.currentWar;
  if (w && w.opponent) {
    const size = w.teamSize ? ` (${w.teamSize}x${w.teamSize})` : '';
    if (w.state === 'preparation') {
      lines.push(`• Agora: vs ${w.opponent.name}${size} · preparação; batalha ${w.startTime ? formatWhen(w.startTime, 'datetime', tz) : ''}${w.endTime ? ` → ${formatWhen(w.endTime, 'datetime', tz)}` : ''}`.trimEnd());
    } else {
      const live = w.clan ? ` · placar ${score(w.clan, w.opponent)}` : '';
      lines.push(`• Agora: vs ${w.opponent.name}${size} · em batalha${w.endTime ? ` até ${formatWhen(w.endTime, 'datetime', tz)}` : ''}${live}`);
    }
  } else if (c.info) {
    lines.push('• Agora: nenhuma guerra comum em andamento');
  }
  const recent = c.warLog.filter((e) => sinceMs === null || new Date(e.endTime).getTime() >= sinceMs).slice(0, 3);
  if (recent.length) {
    lines.push('• Últimos resultados:');
    for (const e of recent) lines.push(`   ${OUTCOME_LABEL[e.result]} vs ${e.opponent.name} (${day(e.endTime, tz)}) · ${score(e.clan, e.opponent)}`);
  } else if (c.info?.isWarLogPublic === false) {
    lines.push('• Histórico indisponível: o war log do clã está privado');
  }
  return lines.length > 1 ? lines : null;
}

function raidBlock(r: RaidSnapshot, tz: string, now: Date): string[] {
  const lines = [`🏰 ${bold('RAIDES DA CAPITAL')}`];
  const span = `${day(r.startTime, tz)} a ${day(r.endTime, tz)}`;
  const stats = [
    r.capitalTotalLoot !== null ? `${num(r.capitalTotalLoot)} de ouro da capital` : null,
    r.totalAttacks !== null ? `${r.totalAttacks} ataques` : null,
    r.raidsCompleted !== null ? `${r.raidsCompleted} ${r.raidsCompleted === 1 ? 'raide concluída' : 'raides concluídas'}` : null,
    r.enemyDistrictsDestroyed !== null ? `${r.enemyDistrictsDestroyed} distritos destruídos` : null,
  ].filter(Boolean);
  if (r.state === 'ongoing' && new Date(r.endTime).getTime() > now.getTime()) {
    lines.push(`• Em andamento até ${formatWhen(r.endTime, 'datetime', tz)}${stats.length ? ` · até agora: ${stats.join(' · ')}` : ''}`);
  } else {
    lines.push(`• Último fim de semana (${span}): ${stats.join(' · ') || 'sem dados'}`);
    const medals = [r.offensiveReward !== null ? `${r.offensiveReward} por membro (ataque)` : null, r.defensiveReward !== null ? `${r.defensiveReward} (defesa)` : null].filter(Boolean);
    if (medals.length) lines.push(`• 🎖️ Medalhas de raide: ${medals.join(' · ')}`);
  }
  return lines;
}

/**
 * Seção "Nosso clã" (dados reais da API oficial). No semanal, só o que é desta semana ou recente;
 * no mensal, a Liga de Guerra do mês e o panorama atual. Liga e guerras nunca têm horário inventado:
 * rodadas futuras aparecem como "saem quando a rodada começar".
 */
export function clanSection(c: ClanReport, opts: { tz: string; now: Date; kind: 'monthly' | 'weekly'; yearMonth?: string; cwlPeriod?: ClashEvent | null }): (string | string[])[] {
  const { tz, now } = opts;
  const nowMs = now.getTime();
  const blocks: (string | string[])[] = [];
  const header = headerBlock(c);
  if (header) blocks.push(header);
  if (c.updatedAt && nowMs - new Date(c.updatedAt).getTime() > STALE_MS) {
    blocks.push(`⚠️ Dados do clã de ${formatWhen(c.updatedAt, 'datetime', tz)}: a API do Clash não respondeu desde então.`);
  }
  if (c.cwl && showCwl(c.cwl, opts)) blocks.push(cwlBlock(c.cwl, tz, now, opts.cwlPeriod ?? null));
  const wars = warsBlock(c, tz, now, opts.kind === 'weekly' ? nowMs - 7 * DAY_MS : null);
  if (wars) blocks.push(wars);
  if (c.raid && (opts.kind === 'monthly' || c.raid.state === 'ongoing' || nowMs - new Date(c.raid.endTime).getTime() <= 7 * DAY_MS)) blocks.push(raidBlock(c.raid, tz, now));
  return blocks;
}

function showCwl(cwl: NonNullable<ClanReport['cwl']>, opts: { now: Date; kind: 'monthly' | 'weekly'; yearMonth?: string }): boolean {
  if (opts.kind === 'monthly') return !!opts.yearMonth && cwl.group.season.startsWith(opts.yearMonth);
  if (cwl.group.state !== 'ended') return true;
  // Liga encerrada: ainda aparece na semana em que terminou (resultado final).
  const lastEnd = Math.max(0, ...cwl.rounds.map((w) => (w.endTime ? new Date(w.endTime).getTime() : 0)));
  return opts.now.getTime() - lastEnd <= 7 * DAY_MS;
}

/** True quando a seção do clã cobre a Liga de Guerra desse mês (o item genérico do blog vira só "Período"). */
export function coversCwl(c: ClanReport | null | undefined, yearMonth: string): boolean {
  return !!c?.cwl && c.cwl.group.season.startsWith(yearMonth);
}

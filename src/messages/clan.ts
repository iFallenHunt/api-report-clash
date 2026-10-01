import { DateTime } from 'luxon';
import { formatWhen, humanDuration } from '../domain/dates.js';
import { FOOTER_TZ, bold, joinBlocks } from './format.js';

export interface WarSnapshot {
  key: string;
  state: 'preparation' | 'inWar' | 'warEnded' | 'notInWar';
  teamSize: number | null;
  attacksPerMember: number | null;
  preparationStartTime: string | null;
  startTime: string | null;
  endTime: string | null;
  clan: { name: string; tag: string; stars: number; destructionPercentage: number; attacks: number } | null;
  opponent: { name: string; tag: string; stars: number; destructionPercentage: number; attacks: number } | null;
  /** Rodada da Liga de Guerra (1..7) quando aplicável. */
  cwlRound?: number;
  cwlSeason?: string;
  /** Resultado oficial do war log (guerra comum encerrada enquanto o bot não acompanhava). */
  result?: 'win' | 'lose' | 'tie';
}

/** Dados gerais do clã (/clans/{tag}). */
export interface ClanInfoSnapshot {
  name: string;
  tag: string;
  level: number | null;
  members: number | null;
  warLeague: string | null;
  capitalLeague: string | null;
  capitalHallLevel: number | null;
  warWins: number | null;
  warLosses: number | null;
  warTies: number | null;
  warWinStreak: number | null;
  isWarLogPublic: boolean | null;
}

/** Guerra comum encerrada, como consta no war log oficial. */
export interface WarLogEntry {
  result: 'win' | 'lose' | 'tie';
  endTime: string;
  teamSize: number | null;
  opponent: { name: string; tag: string; stars: number; destructionPercentage: number };
  clan: { stars: number; destructionPercentage: number; attacks: number | null };
}

function label(w: WarSnapshot) {
  return w.cwlRound ? `Liga de Guerra · rodada ${w.cwlRound}` : 'Guerra de clãs';
}

export function warFound(w: WarSnapshot, tz: string): string {
  return joinBlocks([
    `⚔️ ${bold(`${label(w).toUpperCase()}: DIA DE PREPARAÇÃO`)}`,
    [
      w.opponent ? `🆚 Adversário: ${w.opponent.name}` : null,
      w.teamSize ? `👥 Tamanho: ${w.teamSize} x ${w.teamSize}` : null,
      w.startTime ? `📅 Batalha começa: ${formatWhen(w.startTime, 'datetime', tz)}` : null,
      w.endTime ? `🏁 Batalha termina: ${formatWhen(w.endTime, 'datetime', tz)}` : null,
    ].filter(Boolean) as string[],
    FOOTER_TZ,
  ]);
}

export function warStarted(w: WarSnapshot, tz: string): string {
  const dur = w.startTime && w.endTime ? humanDuration(DateTime.fromISO(w.endTime).toMillis() - DateTime.fromISO(w.startTime).toMillis()) : null;
  return joinBlocks([
    `⚔️ ${bold(`${label(w).toUpperCase()}: DIA DE BATALHA COMEÇOU`)}`,
    [
      w.opponent ? `🆚 Adversário: ${w.opponent.name}` : null,
      w.startTime ? `📅 Início: ${formatWhen(w.startTime, 'datetime', tz)}` : null,
      w.endTime ? `🏁 Término: ${formatWhen(w.endTime, 'datetime', tz)}` : null,
      dur ? `⏳ Duração: ${dur}` : null,
      w.attacksPerMember ? `🎯 Ataques por membro: ${w.attacksPerMember}` : null,
    ].filter(Boolean) as string[],
    FOOTER_TZ,
  ]);
}

export function warEnding(w: WarSnapshot, tz: string, now = new Date()): string {
  const left = w.endTime ? humanDuration(DateTime.fromISO(w.endTime).toMillis() - now.getTime()) : null;
  const c = w.clan;
  const o = w.opponent;
  return joinBlocks([
    `⏰ ${bold(`${label(w).toUpperCase()} TERMINA EM ${left ?? 'BREVE'}`)}`,
    [
      c && o ? `⭐ Placar: ${c.stars} x ${o.stars} (${pct(c.destructionPercentage)} x ${pct(o.destructionPercentage)})` : null,
      c && w.teamSize && w.attacksPerMember ? `🎯 Ataques usados: ${c.attacks}/${w.teamSize * w.attacksPerMember}` : null,
      w.endTime ? `🏁 Término: ${formatWhen(w.endTime, 'datetime', tz)}` : null,
      'Quem ainda não atacou, ataque agora!',
    ].filter(Boolean) as string[],
    FOOTER_TZ,
  ]);
}

export function warEnded(w: WarSnapshot, tz: string): string {
  const c = w.clan;
  const o = w.opponent;
  let result = 'Resultado indisponível';
  if (c && o) {
    if (c.stars > o.stars || (c.stars === o.stars && c.destructionPercentage > o.destructionPercentage)) result = '🏆 VITÓRIA';
    else if (c.stars < o.stars || c.destructionPercentage < o.destructionPercentage) result = '💔 DERROTA';
    else result = '🤝 EMPATE';
  }
  return joinBlocks([
    `🏁 ${bold(`${label(w).toUpperCase()} ENCERRADA: ${result}`)}`,
    [
      c && o ? `⭐ ${c.name} ${c.stars} x ${o.stars} ${o.name}` : null,
      c && o ? `💥 Destruição: ${pct(c.destructionPercentage)} x ${pct(o.destructionPercentage)}` : null,
      w.endTime ? `🕒 Encerrada em: ${formatWhen(w.endTime, 'datetime', tz)}` : null,
    ].filter(Boolean) as string[],
    FOOTER_TZ,
  ]);
}

/** Porcentagem em pt-BR com arredondamento "humano" (17,45 → 17,5%). */
export function pct(n: number): string {
  return `${(Math.round((n + Number.EPSILON) * 10) / 10).toFixed(1).replace('.', ',')}%`;
}

export interface CwlGroupSnapshot {
  season: string;
  state: string;
  rounds: number;
  clans: string[];
  /** Nível e escalação de cada clã do grupo (ausente em snapshots antigos). */
  clanDetails?: { name: string; tag: string; level: number | null; members: number | null }[];
}

export function cwlGroupFound(g: CwlGroupSnapshot): string {
  const month = DateTime.fromISO(`${g.season.slice(0, 7)}-01`).setLocale('pt-BR');
  const label = month.isValid ? `DE ${month.toFormat('LLLL').toUpperCase()}` : g.season;
  const clans = g.clanDetails?.length ? [...g.clanDetails].sort((a, b) => (b.level ?? 0) - (a.level ?? 0)).map((c) => `${c.name}${c.level ? ` (nv. ${c.level})` : ''}`) : g.clans;
  return joinBlocks([
    `🏆 ${bold(`LIGA DE GUERRA ${label}: GRUPO DEFINIDO`)}`,
    [`Rodadas: ${g.rounds}`, `Clãs no grupo (${clans.length}): ${clans.join(', ')}`],
    'Cada rodada tem 1 dia de preparação e 1 dia de batalha, com 1 ataque por membro.',
    FOOTER_TZ,
  ]);
}

export interface RaidSnapshot {
  key: string;
  state: 'ongoing' | 'ended';
  startTime: string;
  endTime: string;
  capitalTotalLoot: number | null;
  raidsCompleted: number | null;
  totalAttacks: number | null;
  enemyDistrictsDestroyed: number | null;
  offensiveReward: number | null;
  defensiveReward: number | null;
}

export function raidStarted(r: RaidSnapshot, tz: string): string {
  const dur = humanDuration(DateTime.fromISO(r.endTime).toMillis() - DateTime.fromISO(r.startTime).toMillis());
  return joinBlocks([
    `🏰 ${bold('FIM DE SEMANA DE RAIDES COMEÇOU')}`,
    [`📅 Início: ${formatWhen(r.startTime, 'datetime', tz)}`, `🏁 Término: ${formatWhen(r.endTime, 'datetime', tz)}`, `⏳ Duração: ${dur}`],
    ['🎁 *Recompensas*', '• Medalhas de raide: quantidade definida pelo desempenho ofensivo e defensivo do clã ao final do fim de semana', '• Condição: usar os ataques de raide antes do término'],
    FOOTER_TZ,
  ]);
}

export function raidEnding(r: RaidSnapshot, tz: string, now = new Date()): string {
  const left = humanDuration(DateTime.fromISO(r.endTime).toMillis() - now.getTime());
  return joinBlocks([
    `⏰ ${bold(`RAIDES TERMINAM EM ${left}`)}`,
    [
      r.capitalTotalLoot !== null ? `💰 Saque da capital até agora: ${r.capitalTotalLoot.toLocaleString('pt-BR')}` : null,
      r.totalAttacks !== null ? `🎯 Ataques usados: ${r.totalAttacks}` : null,
      `🏁 Término: ${formatWhen(r.endTime, 'datetime', tz)}`,
      'Use seus ataques de raide antes do fim!',
    ].filter(Boolean) as string[],
    FOOTER_TZ,
  ]);
}

export function raidEnded(r: RaidSnapshot, tz: string): string {
  return joinBlocks([
    `🏁 ${bold('FIM DE SEMANA DE RAIDES ENCERRADO')}`,
    [
      r.capitalTotalLoot !== null ? `💰 Saque total: ${r.capitalTotalLoot.toLocaleString('pt-BR')}` : null,
      r.raidsCompleted !== null ? `🏰 Raides concluídas: ${r.raidsCompleted}` : null,
      r.enemyDistrictsDestroyed !== null ? `💥 Distritos destruídos: ${r.enemyDistrictsDestroyed}` : null,
      r.offensiveReward !== null ? `🎖️ Medalhas (ofensiva): ${r.offensiveReward} por membro` : null,
      r.defensiveReward !== null ? `🛡️ Medalhas (defesa): ${r.defensiveReward}` : null,
      `🕒 Encerrado em: ${formatWhen(r.endTime, 'datetime', tz)}`,
    ].filter(Boolean) as string[],
    FOOTER_TZ,
  ]);
}

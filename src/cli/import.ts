import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { CalendarRepo } from '../calendar/repo.js';
import { rewardSchema } from '../domain/rewards.js';
import type { DatePrecision, EventInput } from '../domain/types.js';

const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/, 'use AAAA-MM-DD (só dia) ou ISO-8601 com fuso (ex.: 2026-10-01T08:00:00Z)');

export const importEventSchema = z.object({
  /** Id de evento existente para complementar (não cria cópia). */
  id: z.string().optional(),
  /** Chave canônica explícita para casar com evento coletado (ex.: "medal_event:2026-09-09..2026-09-22"). */
  canonicalKey: z.string().optional(),
  category: z.enum(['season', 'medal_event', 'special_event', 'challenge', 'clan_games', 'update', 'cwl', 'war', 'raid_weekend', 'cosmetic', 'other']),
  scope: z.enum(['global', 'clan']).default('global'),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  startAt: dateField.nullable().optional(),
  endAt: dateField.nullable().optional(),
  status: z.enum(['cancelled']).optional(),
  rewardsStatus: z.enum(['known', 'not_announced', 'unverified']).optional(),
  rewards: z.array(rewardSchema).optional(),
  sourceUrl: z.string().url().optional(),
  /** true trava todos os campos fornecidos; ou lista de campos a travar. */
  lock: z.union([z.boolean(), z.array(z.string())]).optional(),
});

export const importFileSchema = z.object({
  /** Marque como true apenas para dados fictícios de desenvolvimento. */
  demo: z.boolean().optional(),
  events: z.array(importEventSchema).min(1),
});

export type ImportEvent = z.infer<typeof importEventSchema>;

function toDate(v: string | null | undefined): { at: string | null; precision: DatePrecision } | undefined {
  if (v === undefined) return undefined;
  if (v === null) return { at: null, precision: 'unknown' };
  if (v.length === 10) return { at: v, precision: 'date' };
  return { at: new Date(v).toISOString().replace('.000Z', 'Z'), precision: 'datetime' };
}

export function toEventInput(e: ImportEvent): { input: EventInput; lockFields: string[] } {
  const start = toDate(e.startAt);
  const end = toDate(e.endAt);
  const input: EventInput = {
    ...(e.id ? { id: e.id } : {}),
    ...(e.canonicalKey ? { canonicalKey: e.canonicalKey } : {}),
    category: e.category,
    scope: e.scope,
    title: e.title,
    ...(e.description !== undefined ? { description: e.description } : {}),
    ...(start ? { startAt: start.at, startPrecision: start.precision } : {}),
    ...(end ? { endAt: end.at, endPrecision: end.precision } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.rewards !== undefined || e.rewardsStatus !== undefined
      ? { rewards: (e.rewards ?? []).map((r) => ({ ...r, tier: r.tier ?? 'unknown' })), rewardsStatus: e.rewardsStatus ?? (e.rewards?.length ? 'known' : 'unverified') }
      : {}),
    ...(e.sourceUrl ? { primarySourceUrl: e.sourceUrl } : {}),
  };
  const provided: string[] = [];
  if (start) provided.push('startAt', 'startPrecision');
  if (end) provided.push('endAt', 'endPrecision');
  if (e.rewards !== undefined || e.rewardsStatus !== undefined) provided.push('rewards', 'rewardsStatus');
  if (e.title) provided.push('title');
  const lockFields = e.lock === true ? provided : Array.isArray(e.lock) ? e.lock : [];
  return { input, lockFields };
}

export function importFromFile(path: string, repo: CalendarRepo, onApplied?: (res: ReturnType<CalendarRepo['applyEvent']>) => void) {
  const parsed = importFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const results = [];
  for (const e of parsed.events) {
    const { input, lockFields } = toEventInput(e);
    if (parsed.demo) input.extra = { ...(input.extra ?? {}), demo: true };
    const res = repo.applyEvent(input, { origin: 'manual', lockFields });
    onApplied?.(res);
    results.push(res);
  }
  return { demo: parsed.demo ?? false, results };
}

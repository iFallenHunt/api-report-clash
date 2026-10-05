import type { Logger } from './logger.js';

/** Estado do WhatsApp visto pelo monitoramento (null em DRY_RUN: não há envio a vigiar). */
export interface WaHealth {
  ready: boolean;
  needsQr: boolean;
  notReadyForMs: number;
}

export interface OverdueReport {
  kind: 'monthly' | 'weekly';
  key: string;
  scheduledAt: string;
  status: string;
}

/**
 * Problemas que impedem ou já impediram uma entrega. Lista vazia = tudo certo.
 * WhatsApp subindo (até `waGraceMs`) ainda não é problema; pedir QR é sempre (só se resolve pareando de novo).
 */
export function deliveryProblems(input: { wa: WaHealth | null; overdue: OverdueReport[]; waGraceMs: number }): string[] {
  const problems: string[] = [];
  const { wa } = input;
  if (wa?.needsQr) problems.push('whatsapp_precisa_de_qr: a sessão não vale mais; é preciso parear o número de novo (wa:auth)');
  else if (wa && !wa.ready && wa.notReadyForMs > input.waGraceMs) problems.push(`whatsapp_fora: sem conexão há ${Math.round(wa.notReadyForMs / 60_000)} min`);
  for (const r of input.overdue) problems.push(`relatorio_nao_entregue: ${r.key} (previsto ${r.scheduledAt}; ${r.status})`);
  return problems;
}

/** Reinício ordenado resolve WhatsApp fora; quando pede QR, reiniciar só repetiria o pedido. */
export function shouldRestartWhatsApp(wa: WaHealth | null, restartAfterMs: number): boolean {
  return !!wa && !wa.ready && !wa.needsQr && wa.notReadyForMs > restartAfterMs;
}

/**
 * Ping de "dead man's switch" (ex.: Healthchecks.io): só com tudo OK; com problema, `/fail` com a lista.
 * Sem pings no prazo (serviço, Docker ou VM fora), o serviço externo dispara o alerta. A URL é segredo: não é registrada.
 */
export async function pingMonitor(url: string, problems: string[], log: Logger, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = problems.length
      ? await fetchImpl(`${url.replace(/\/+$/, '')}/fail`, { method: 'POST', body: problems.join('\n'), signal: ctrl.signal })
      : await fetchImpl(url, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) log.warn({ status: res.status }, 'ping de monitoramento recusado');
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'ping de monitoramento falhou');
  }
}

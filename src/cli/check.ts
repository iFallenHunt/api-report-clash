import type { AppConfig } from '../config.js';
import { CocApiError, CocClient, type RawLeagueGroup } from '../collectors/coc/client.js';

/**
 * Diagnóstico somente leitura da configuração e da API do Clash. Não grava nada no banco,
 * não enfileira mensagens e nunca imprime o token.
 */
export async function runCheck(cfg: AppConfig, print: (s: string) => void = console.log): Promise<boolean> {
  let ok = true;
  const line = (status: 'OK' | 'FALHA' | 'AVISO' | 'INFO', msg: string) => print(`[${status}] ${msg}`);

  line('INFO', `DRY_RUN=${cfg.dryRun} ${cfg.dryRun ? '(nada será enviado)' : '(ENVIO REAL ATIVO)'}`);
  line(cfg.coc.token ? 'OK' : 'FALHA', `COC_API_TOKEN ${cfg.coc.token ? `definido (${cfg.coc.token.length} caracteres; valor não exibido)` : 'ausente'}`);
  line(cfg.coc.clanTag ? 'OK' : 'FALHA', `CLAN_TAG ${cfg.coc.clanTag ?? 'ausente'}`);
  if (cfg.wa.groupId) line('OK', `WHATSAPP_GROUP_ID definido (${cfg.wa.groupId.replace(/^(.{4}).*(@g\.us)$/, '$1…$2')})`);
  else line(cfg.dryRun ? 'AVISO' : 'FALHA', 'WHATSAPP_GROUP_ID ausente (obtenha com wa:chats)');
  line(cfg.wa.expectedGroupName ? 'OK' : 'AVISO', `WHATSAPP_EXPECTED_GROUP_NAME ${cfg.wa.expectedGroupName ? `"${cfg.wa.expectedGroupName}"` : 'ausente (recomendado para travar o grupo de testes)'}`);
  if (!cfg.dryRun && !cfg.wa.groupId) ok = false;

  if (!cfg.coc.token || !cfg.coc.clanTag) {
    line('INFO', 'consulta à API do clã pulada (faltam credenciais)');
    return false;
  }

  const client = new CocClient({ base: cfg.coc.base, token: cfg.coc.token, maxRetries: 1 });
  const tag = cfg.coc.clanTag;
  const explain = (err: unknown): string => {
    if (err instanceof CocApiError) {
      if (err.status === 403) return `HTTP 403 (${err.reason}): chave inválida, IP de saída não autorizado na chave, ou log de guerra privado. Detalhe da API: ${err.message}`;
      if (err.status === 404) return `HTTP 404 (${err.reason}): tag não encontrada`;
      return `HTTP ${err.status} (${err.reason}): ${err.message}`;
    }
    return err instanceof Error ? err.message : String(err);
  };

  try {
    const clan = await client.clan(tag);
    line('OK', `clã: ${clan.name} (${clan.tag}), membros: ${clan.members ?? '?'}, log de guerra público: ${clan.isWarLogPublic ?? '?'}`);
    if (clan.isWarLogPublic === false) line('AVISO', 'log de guerra privado: /currentwar responderá 403; torne-o público nas configurações do clã');
  } catch (err) {
    line('FALHA', `GET /clans/{tag}: ${explain(err)}`);
    return false;
  }
  try {
    const war = await client.currentWar(tag);
    line('OK', `guerra atual: ${war.state}${war.opponent?.name ? ` vs ${war.opponent.name}` : ''}`);
  } catch (err) {
    ok = false;
    line('FALHA', `GET /currentwar: ${explain(err)}`);
  }
  try {
    const g: RawLeagueGroup = await client.leagueGroup(tag);
    line('OK', `Liga de Guerra: temporada ${g.season}, estado ${g.state}, ${g.rounds?.length ?? 0} rodadas`);
  } catch (err) {
    if (err instanceof CocApiError && err.status === 404) line('OK', 'Liga de Guerra: clã fora da liga no momento (404 esperado)');
    else {
      ok = false;
      line('FALHA', `GET /currentwar/leaguegroup: ${explain(err)}`);
    }
  }
  try {
    const r = await client.capitalRaidSeasons(tag, 1);
    const cur = r.items?.[0];
    line('OK', cur ? `raides: último fim de semana ${cur.state} (${cur.startTime} → ${cur.endTime})` : 'raides: nenhum registro');
  } catch (err) {
    ok = false;
    line('FALHA', `GET /capitalraidseasons: ${explain(err)}`);
  }
  return ok;
}

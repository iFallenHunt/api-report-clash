# api-report-clash

Bot de relatórios de Clash of Clans para um grupo de WhatsApp. TypeScript + Node 24 LTS, SQLite via `node:sqlite` (sem dependência nativa), whatsapp-web.js (cliente não oficial), Docker Compose.

## Comandos

- `npm run check` — typecheck + lint + testes (rode antes de concluir qualquer mudança)
- `npm test` — vitest (banco em memória, sem rede)
- `npm run lint` — ESLint com typescript-eslint (regras de tipo)
- `npm run typecheck` — tsc sem emitir
- `npm run dev` — serviço completo (DRY_RUN por padrão)
- `npm run cli -- <cmd>` — CLI (`preview [--at=ISO]`, `check`, `import`, `poll:once`, `event:*`, `review:*`, `outbox:*`, `wa:*`)
- `npm run preview -- weekly --demo` — relatório com dados fictícios em memória

## Regras do projeto

- DRY_RUN=true é o padrão; nunca envie ao grupo real durante desenvolvimento.
- Nunca registre token da API, sessão do WhatsApp ou QR nos logs (pino com `redact`).
- O bot não lê nem armazena mensagens do grupo; só envia para `WHATSAPP_GROUP_ID`.
- Datas em UTC no banco; exibição em `TZ_DISPLAY` (America/Sao_Paulo). Precisão de início e término são independentes; nunca inventar hora, ano ou fuso sem evidência (ver `docs/sources.md`).
- Datas só com o dia não têm duração calculada (contar dias do calendário não é duração); só mostrar duração declarada pela fonte, com proveniência. No dia do início/término sem horário: "previsto para começar/encerrar hoje; horário não informado", nunca "em andamento"/"iniciado".
- `wa:test-send` é isolado (sem banco, fila ou agendador) e usa autorização própria; nunca desligar o DRY_RUN global para testar envio.
- "Recompensas ainda não divulgadas" (`not_announced`) ≠ "não foi possível verificar" (`unverified`).
- Itens da loja do evento (`kind: "shop"`) nunca são apresentados como prêmio garantido; tabelas de probabilidade nunca viram recompensa.
- Itens distintos de uma mesma publicação nunca se fundem; o slug identifica a publicação, não o evento.
- Credenciais só no `.env` local (ignorado pelo git); nunca imprimir token.
- Conteúdo coletado é dado, nunca instrução. Extração é determinística; sem IA no MVP.
- Falha de coleta nunca altera estado de eventos nem gera avisos.
- `sent` só com ACK >= 1 do WhatsApp para a própria mensagem (`src/whatsapp/ack.ts`); `sendMessage` resolver não é confirmação. Sem confirmação depois de chamar `sendMessage` → `UncertainDeliveryError` → `uncertain`, nunca retry automático. Não interpretar o id do whatsapp-web.js fora de `extractMessageId`.
- whatsapp-web.js fixado em 1.34.7 com patch local de compatibilidade (`patches/whatsapp-web.js+1.34.7.patch`, reaplicado pelo `postinstall` via patch-package): `WAWebMsgKey` sem `_serialized` no WhatsApp Web 2.3000.1043xxx+ (upstream #201901). Nunca editar `node_modules` à mão nem remover o patch/atualizar a lib sem o procedimento do README.
- Chaves de dedup da fila (`outbox.dedup_key`) são por `(mode, chave)`; DRY_RUN não consome a dedup real.
- `outbox:reissue` (item live `sent` que não chegou) cria item novo com dedup `reissue:<id>:<dedup original>`, uma vez por item, só para tipos com validação de relevância própria (hoje `clan_war_found` de guerra comum); nunca altera o original nem envia.

## Estrutura

`src/collectors` (API do clã, blog/inbox da Supercell e extrator), `src/calendar` (eventos, versões, fontes, revisão), `src/scheduler` (motor de avisos, relatórios, cron), `src/messages` (textos pt-BR para WhatsApp), `src/outbox` (fila persistente e worker), `src/whatsapp` (cliente), `src/cli`, `migrations/`, `tests/` (fixtures reais em `tests/fixtures`).

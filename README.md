# api-report-clash

Bot que mantém um grupo de WhatsApp informado sobre o Clash of Clans: calendário mensal, resumo semanal, avisos de eventos novos/iniciados/alterados/cancelados, lembretes de encerramento e o estado de guerra, Liga de Guerra e Fim de Semana de Raides do clã.

Stack: TypeScript, Node 24 LTS, SQLite (`node:sqlite`, sem build nativo), whatsapp-web.js, Docker Compose. Um único serviço; sem frontend, sem Redis.

- Fontes e cobertura real da coleta: [`docs/sources.md`](docs/sources.md)
- Exemplos de mensagens (fictícios): [`docs/messages-examples.md`](docs/messages-examples.md)
- Importação manual: [`docs/events.example.json`](docs/events.example.json)
- Homologação com dados reais (auditoria dos eventos e previews): [`docs/homologacao-2026-09-24.md`](docs/homologacao-2026-09-24.md)

## Como funciona

```
Supercell blog (pt) ──┐                              ┌─ relatório mensal (dia 1, 9h)
Supercell inbox (opc.)├─► extrator ─► calendário ────┤─ resumo semanal (segunda, 9h)
API oficial do clã ───┘   (datas,     (eventos,      │─ avisos extraordinários
                           prêmios)    versões,      │─ lembretes (24h globais / 2h clã)
                                       fontes)       └─► fila persistente ─► WhatsApp (grupo único)
```

- **Coleta**: anúncios a cada 60 min, clã a cada 5 min (configurável). A detecção depende desses intervalos e de quando a própria fonte publica.
- **Calendário**: cada evento tem id estável, categoria, escopo (global/clã), início e término com precisão independente (`datetime`/`date`/`unknown`), estado, recompensas (com `free`/`paid`/`unknown`, quantidade, condição e opções), fontes e histórico de versões. Só mudanças relevantes (datas, estado, título, recompensas) geram versão; `last_checked_at` nunca gera.
- **Fila de saída**: cada mensagem tem chave de deduplicação, horário de disparo e validade. Reinícios não reenviam; itens vencidos nunca são enviados; mudanças de data invalidam lembretes pendentes.
- **DRY_RUN** (padrão): tudo é gerado e gravado (`outbox` com `mode=dry_run` e arquivos em `data/previews/`), nada é enviado.

## Instalação local

```bash
npm install            # baixa o Chromium do Puppeteer (~150 MB); PUPPETEER_SKIP_DOWNLOAD=true pula
cp .env.example .env   # DRY_RUN=true já vem ligado
npm run check          # typecheck + lint (ESLint com regras de tipo) + 86 testes, sem rede
npm run preview -- weekly --demo     # relatório com dados FICTÍCIOS (banco em memória)
npm run preview -- monthly --demo
npm run preview -- notices --demo
npm run dev            # serviço completo em DRY_RUN
```

Coleta real do blog da Supercell sem credencial nenhuma:

```bash
npm run poll:once -- announcements   # popula o banco com os eventos reais publicados
npm run cli -- event:list
npm run cli -- review:list           # pendências (ex.: recompensas não verificadas)
npm run preview -- weekly            # texto exato, já dividido em partes
npm run preview -- weekly --at=2026-09-28T12:00:00Z   # simula a geração em outro instante
```

## Credenciais e identificadores que você precisa fornecer

| Variável | O que é | Como obter |
|---|---|---|
| `COC_API_TOKEN` | chave da API oficial do Clash | https://developer.clashofclans.com → *My Account* → *Create New Key*. Informe o **IP público de saída** do host que rodará o bot (a chave só funciona a partir desses IPs; faixas privadas são rejeitadas; até 5 IPs por chave). IP dinâmico = recriar a chave quando mudar. |
| `CLAN_TAG` | tag do clã (`#XXXXXXX`) | perfil do clã no jogo |
| `WHATSAPP_GROUP_ID` | id do grupo de destino (`...@g.us`) | `npm run wa:chats` após autenticar (lista nome e id de cada grupo) |
| `WHATSAPP_EXPECTED_GROUP_NAME` | nome exato do grupo | o bot recusa enviar se o ID apontar para um grupo com outro nome; use para travar o grupo de testes |
| `DRY_RUN=false` | ativa o envio real | só depois de validar previews |

Sem `COC_API_TOKEN`/`CLAN_TAG` o bot roda normalmente sem a parte do clã. Sem WhatsApp o bot roda em DRY_RUN.

### Requisitos e limites da API do Clash

- Token JWT por chave, vinculado a IPs públicos; limite de requisições não publicado, HTTP 429 ao exceder (o cliente respeita `Retry-After`, no máximo 2 novas tentativas).
- `currentwar` responde 403 se o log de guerra do clã estiver privado: torne-o público nas configurações do clã.
- Não há endpoint de calendário, Jogos do Clã, eventos ou recompensas; isso vem do blog oficial (ver `docs/sources.md`).

### Limitações da integração com WhatsApp (whatsapp-web.js 1.34.7)

- É um **cliente não oficial** que automatiza o WhatsApp Web em um Chromium headless. O WhatsApp não permite bots ou clientes não oficiais; **a conta pode ser bloqueada**. Use um número dedicado ao bot, nunca o seu pessoal.
- Precisa de sessão autenticada por QR code; a sessão fica em `WA_SESSION_PATH` (volume `wa-session`) e contém credenciais: não compartilhe nem commite.
- Atualizações do WhatsApp Web podem quebrar a biblioteca até sair uma nova versão.
- O bot só envia para o grupo configurado e não registra handlers de mensagens recebidas: não lê nem armazena conversas.

#### Patch local de compatibilidade (`patches/whatsapp-web.js+1.34.7.patch`)

O whatsapp-web.js 1.34.7 precisa de um patch para funcionar com o WhatsApp Web 2.3000.1043xxx+. Nessas versões a chave interna da mensagem (`WAWebMsgKey`) deixou de ter `_serialized` (o valor ficou no campo minificado `$1`, exposto por `toString()`). Por isso `Msg.get(newMsgKey._serialized)` virava `Msg.get(undefined)` e o `sendMessage` resolvia `undefined`, sem Message nem id para correlacionar o ACK.

- O patch segue o upstream: [wwebjs/whatsapp-web.js#201901](https://github.com/wwebjs/whatsapp-web.js/pull/201901) (getter `_serialized` → `toString()` no protótipo de `WAWebMsgKey`), mais uma linha em `getMessageModel` para o `id._serialized` chegar ao Node (a metade do Node da [#201840](https://github.com/wwebjs/whatsapp-web.js/pull/201840)). Só altera `src/util/Injected/Utils.js`.
- É reaplicado automaticamente pelo `postinstall` (`patch-package --error-on-fail --error-on-warn`) em todo `npm install`/`npm ci`, inclusive no build do Docker (o `Dockerfile` copia `patches/` antes do `npm ci`). Se o patch não aplicar, a instalação falha em vez de seguir sem a correção.
- A versão fica fixada em `"whatsapp-web.js": "1.34.7"`. **Não remova o patch nem atualize a biblioteca sem validar uma versão nova.**
- O patch não substitui a confirmação por ACK: `sent` continua exigindo ACK >= 1; sem ACK, `uncertain`.
- Para regenerar o patch depois de editar o pacote: `npm_config_allow_remote=root npx patch-package whatsapp-web.js` (o npm 12 bloqueia por padrão a instalação por URL de tarball que o patch-package usa para obter a cópia limpa; só vale para esse comando).
- `tests/whatsapp-wwebjs-patch.test.ts` roda o código injetado real contra módulos falsos no formato atual e falha se o patch não estiver aplicado.

Para verificar se uma versão nova já incorporou a correção e remover o patch:

1. Ler o changelog/release em https://github.com/wwebjs/whatsapp-web.js/releases.
2. Confirmar que a #201901 (ou commit equivalente) entrou: no `src/util/Injected/Utils.js` da versão nova, o `sendMessage` não pode mais depender de `newMsgKey._serialized` sem fallback, e `getMessageModel` precisa entregar `id._serialized` ao Node.
3. Numa branch: atualizar `whatsapp-web.js` no `package.json` e apagar `patches/whatsapp-web.js+1.34.7.patch` (e o `postinstall`/`patch-package` se não houver outros patches).
4. `rm -rf node_modules && npm ci`.
5. `npm run check`. O teste de `tests/whatsapp-wwebjs-patch.test.ts` que confere o patch no pacote instalado vai falhar de propósito: ajuste-o para a versão nova, mantendo os casos de MsgKey sem `_serialized`.
6. Um único `wa:test-send` controlado no grupo de testes: tem de terminar em "mensagem de teste confirmada pelo WhatsApp" com `ack: 1` e a mensagem aparecer no grupo.

## Docker Compose

```bash
cp .env.example .env         # edite credenciais; mantenha DRY_RUN=true no início
docker compose build
docker compose up -d
curl http://127.0.0.1:8080/health
docker compose logs -f
```

Volumes: `bot-data` (SQLite em `/app/data`) e `wa-session` (sessão do WhatsApp). A imagem usa Node 24 LTS com Chromium do sistema (~1,6 GB por causa do navegador e fontes).

### Autenticar o WhatsApp (uma vez)

```bash
docker compose run --rm bot node dist/cli/index.js wa:auth   # escaneie o QR com o número dedicado
docker compose run --rm bot node dist/cli/index.js wa:chats  # copie o id do grupo (…@g.us) para .env
```

Local: `npm run wa:auth` e `npm run wa:chats`.

### Teste com a API real do clã e um grupo de testes

As credenciais ficam só no arquivo `.env` na raiz do projeto (já criado a partir do `.env.example`, ignorado pelo git, permissão 600). Nunca cole o token em chats, issues ou commits.

1. **Chave da API**: em https://developer.clashofclans.com crie uma chave com o IP público de saída desta máquina (o mesmo vale para o Docker, que sai pelo IP do host). Descubra o IP por conta própria, por exemplo no painel do roteador ou com `curl https://api.ipify.org`.
2. Edite `.env` e preencha `COC_API_TOKEN` e `CLAN_TAG`. Mantenha `DRY_RUN=true`.
3. Rode o diagnóstico somente leitura (não grava nada, não imprime o token):
   ```bash
   npm run cli -- check
   ```
   Um 403 mostra o motivo retornado pela API (IP não autorizado, chave inválida ou log de guerra privado).
4. Coleta real em DRY_RUN: `npm run poll:once -- clan`. Os avisos gerados ficam na fila do modo `dry_run` e aparecem no terminal.
5. **WhatsApp**: crie um grupo exclusivo de testes com o número dedicado. Rode `npm run wa:auth` (escaneie o QR) e `npm run wa:chats`; copie o id `…@g.us` para `WHATSAPP_GROUP_ID` e o nome exato para `WHATSAPP_EXPECTED_GROUP_NAME`. `npm run cli -- check` confirma o que está configurado.
   Localmente o Chromium do Puppeteer não é baixado (o npm 12 bloqueia scripts de instalação); o `.env` local aponta `PUPPETEER_EXECUTABLE_PATH` para o Chrome instalado. No Docker a imagem traz o Chromium.
6. **Só depois de autorizado**, envie a mensagem de teste. O comando é isolado: não abre o banco, a fila ou o agendador, e envia exatamente uma mensagem fixa. Ele funciona com `DRY_RUN=true`, então o resto do bot continua sem enviar nada. A autorização é específica: `--confirm` mais o nome do grupo repetido, que precisa ser igual a `WHATSAPP_EXPECTED_GROUP_NAME`; o bot ainda confere o nome real do grupo antes de enviar.
   ```bash
   npm run cli -- wa:test-send --confirm --group="Nome exato do grupo de testes"
   ```
   Só imprime `mensagem de teste confirmada pelo WhatsApp` (com `id` e `ack`) quando o WhatsApp confirma o envio. Sem confirmação, imprime `ENVIO NÃO CONFIRMADO` com o motivo e sai com código 3: a mensagem pode ou não ter chegado, então confira o grupo antes de tentar de novo.

### Ativar o envio real no serviço

1. Confirme os previews (`preview weekly`, `preview monthly`) e a fila (`outbox:list`).
2. Defina `DRY_RUN=false`, `WHATSAPP_GROUP_ID` e `WHATSAPP_EXPECTED_GROUP_NAME` no `.env`; `docker compose up -d`.
3. A fila do modo `dry_run` **não** é enviada ao mudar de modo: o modo real começa vazio e só recebe o que for atual e elegível a partir daí (relatório do período ainda não gerado no modo real, avisos de eventos dentro da validade). Nada antigo é despejado no grupo.

## Comandos da CLI

```
npm run cli -- preview monthly|weekly|monthly-update|notices [--demo] [--at=ISO]
npm run cli -- check                     # diagnóstico somente leitura (config + API real do clã)
npm run cli -- wa:test-send --confirm --group="<nome>"   # uma mensagem de teste isolada; não precisa DRY_RUN=false
npm run cli -- import <arquivo.json>     # cria ou complementa eventos (schema validado)
npm run cli -- event:list [--all] | event:show <id> | event:cancel <id> "motivo" | event:lock <id> campo,campo
npm run cli -- review:list | review:resolve <id>
npm run cli -- outbox:list [status] | outbox:resend <id> | outbox:run
npm run cli -- outbox:reissue <id> [--confirm]  # reemite um item live `sent` que não chegou (ver abaixo)
npm run cli -- report:run weekly [--confirm]     # gera o semanal agora e o enfileira em live (ver abaixo)
npm run cli -- poll:once announcements|clan
npm run cli -- wa:auth | wa:chats
npm run cli -- demo:seed                 # grava eventos FICTÍCIOS no banco configurado (só dev)
```

### Importação manual (eventos sem coleta automática viável)

`docs/events.example.json` mostra o formato. Regras:

- `startAt`/`endAt`: `AAAA-MM-DD` (só dia, sem inventar horário) ou ISO-8601 com fuso (`2026-10-01T08:00:00Z`).
- `rewards[]`: `label`, `quantity`, `condition`, `tier` (`free`|`paid`|`unknown`), `choiceGroup` para opções ("escolha 1 entre").
- `rewardsStatus`: `known` | `not_announced` ("ainda não divulgadas") | `unverified` ("não foi possível verificar").
- Para **complementar** um evento já coletado sem criar cópia: informe `id` (de `event:list`) ou `canonicalKey`, ou apenas o mesmo título/datas (o casamento é por categoria+datas, datas+título semelhante, ou título na mesma categoria).
- `lock: true` (ou lista de campos) trava os campos informados: o coletor não os sobrescreve; divergências vão para `review:list` como `field_conflict`.
- `demo: true` marca o arquivo como fictício.

## Agendamentos, lembretes e validade (padrões)

| Item | Padrão | Variável |
|---|---|---|
| Relatório mensal | dia 1, 09:00 (America/Sao_Paulo) | `REPORT_MONTHLY_CRON` |
| Resumo semanal | segunda, 09:00 | `REPORT_WEEKLY_CRON` |
| Atualização do calendário | diária às 12:00, só se algo mudou desde o mensal (só o que mudou) | fixo |
| Lembrete de eventos globais | 24h antes do **término** (`REMINDER_ANCHORS=start,end` para incluir início) | `REMINDER_LEAD_GLOBAL_HOURS` |
| Lembrete de guerra/raide | 2h antes do término | `REMINDER_LEAD_CLAN_HOURS` |
| Validade de avisos / relatórios | 6h / 12h | `NOTICE_TTL_HOURS`, `REPORT_TTL_HOURS` |
| Relatório perdido (bot fora do ar) | gerado só se o horário previsto foi há menos de 6h | `REPORT_CATCHUP_HOURS` |
| Tentativas de envio | 5, backoff 30s → 8min | `SEND_MAX_ATTEMPTS` |
| Tamanho máximo por mensagem | 3000 caracteres, partes numeradas | `MESSAGE_MAX_CHARS` |

Regras anti-redundância: evento com duração menor que 2× a antecedência não recebe lembrete; lembrete de início só se o evento era conhecido antes do ponto de disparo; lembrete a ±1h do resumo semanal é suprimido; evento cancelado/encerrado nunca recebe lembrete; correção de descrição/recompensa não repete "evento iniciado".

## Entrega, falhas e recuperação (comportamento real)

- **Não há garantia de entrega.** Cada item tem no máximo `SEND_MAX_ATTEMPTS` tentativas e uma validade; ao esgotar, fica `failed`; ao vencer, `expired`. Nenhum dos dois é reenviado automaticamente.
- **Confirmação de envio**: um item só vira `sent` quando o WhatsApp devolve ACK ≥ 1 (`ACK_SERVER`: o servidor aceitou a mensagem) para a própria mensagem, correlacionada pelo id da chave (`id`, `remote`, `fromMe`) dentro de `WA_ACK_TIMEOUT_SECONDS` (padrão 30 s por parte). Não se espera entrega no aparelho nem leitura. `sendMessage` resolver sem erro **não** é confirmação.
- **Entrega incerta** (`uncertain`, sem reenvio automático) quando `sendMessage` já foi chamado e não houve confirmação: retorno sem Message ID correlacionável, prazo do ACK esgotado, ACK de erro (-1), erro lançado pelo próprio `sendMessage` ou encerramento durante a espera. Numa mensagem dividida em partes, se alguma parte já foi confirmada, qualquer falha posterior deixa o item inteiro `uncertain` (o `last_error` diz qual parte falhou), porque reenviar duplicaria as partes que chegaram. Erros antes de chamar `sendMessage` (WhatsApp não pronto, grupo não verificado) seguem o retry normal.
- **Queda durante o envio**: se o processo cair entre o envio e a gravação do resultado, o item fica preso em `sending`; na recuperação ele vira `uncertain` e **não é reenviado** (o WhatsApp pode ter aceitado a mensagem). Reenvio é decisão humana: `outbox:resend <id>`.
- **Reemissão manual** (`outbox:reissue <id>`): para um item live registrado como `sent` que sabidamente não chegou ao grupo (ex.: marcado pela versão antiga do fluxo, antes da confirmação por ACK). Exige `DRY_RUN=false`; sem `--confirm` só mostra o item, a validação e o que seria criado. Nesta versão só aceita `clan_war_found` de guerra comum: consulta a API na hora e exige a mesma guerra (`preparationStartTime` = chave do aviso), ainda em `preparation`, com o mesmo adversário de `clan_state` e citado no corpo, e batalha ainda não iniciada. Cria um NOVO item `pending` com o corpo, `kind` e `event_id` originais, `fire_at` = agora, expiração = min(agora + `NOTICE_TTL_HOURS`, início da batalha) e dedup `reissue:<id original>:<dedup original>`; o original fica intacto. Uma única reemissão por item (qualquer status da reemissão bloqueia outra); a própria reemissão não é reemitível. Nunca envia: o envio é pelo `outbox:run`.
- **Relatório semanal manual** (`report:run weekly`): gera o semanal agora com a mesma lógica do agendador (`Engine.runReport`): mesmo corpo do `preview weekly`, `report_mark` e item `report_weekly` na fila live com dedup `report:weekly:<AAAA-Wnn>` e validade `REPORT_TTL_HOURS`. Exige `DRY_RUN=false`; sem `--confirm` só mostra (nada é gravado). Se o semanal da semana já foi gerado em live (pelo agendador ou manualmente), recusa. Como consome a semana, rodá-lo antes do horário do agendador faz o agendado daquela semana ser pulado. Nunca envia: o envio é pelo `outbox:run`.
- **Duplicatas**: a deduplicação é por chave persistida (`(mode, dedup_key)`), então reinícios e consultas repetidas não duplicam. A única fonte possível de duplicata é o reenvio manual de um item `uncertain`.
- **WhatsApp desconectado**: o worker pausa; itens pendentes esperam até vencer.
- **Fonte indisponível** (timeout, 429, 5xx, estrutura mudou): registrada em `collector_runs`; nenhum evento muda de estado; o rodapé dos relatórios avisa. Falha nunca vira "evento encerrado/cancelado".
- **Depois de longa indisponibilidade**: nada é despejado. Avisos só saem se ainda forem atuais (início/publicação dentro de `NOTICE_TTL_HOURS`); relatório perdido só dentro de `REPORT_CATCHUP_HOURS`; no máximo 5 envios por ciclo de 15s com intervalo mínimo entre eles.

## Segurança

- Logs com redação de `token`, `authorization`, `session`, `qr` (pino `redact`). Não há log do conteúdo da sessão.
- `.env`, `data/`, `wa-session/` estão no `.gitignore`. O `.env.example` não contém segredos.
- Destino restrito a um único `WHATSAPP_GROUP_ID` (validado como grupo `@g.us`).
- Conteúdo coletado é tratado como dados: a extração é determinística, sem IA, e nada incerto é publicado como fato.

## Testes

`npm run check` roda typecheck, lint (ESLint + typescript-eslint com regras de tipo, incluindo promessas soltas) e `npm test` (vitest, 86 testes, sem rede, banco em memória). Os testes cobrem: datas/fuso/duração e precisão independente; recompensas desconhecidas vs. não verificadas e gratuito/pago/opções; evento novo após o semanal; anunciado ≠ iniciado; correção de recompensa sem repetir "iniciado"; mudança de horário invalidando lembrete; cancelamento; lembretes (curto, tardio, encerrado, ±1h do semanal); dedup, reinício, falha de envio com backoff, queda durante o envio (`uncertain`), WhatsApp desconectado, divisão de mensagens; DRY_RUN → real; fonte indisponível/estrutura inesperada sem informação falsa; publicação antiga sem aviso; um anúncio com vários eventos; mesmo evento em blog e inbox; calendário mensal não rebaixando precisão; coleta parcial preservando revisão manual; máquina de estados de guerra/raide com API falhando; cliente HTTP com 429/403; relatórios mensal/semanal e avisos individuais; inferência de ano (dezembro↔janeiro, eventos futuros, janela de evidência, término antes do início); auditoria das publicações reais (24 itens do calendário em PT e EN, itens do mesmo artigo sem fusão, fusão entre artigos em qualquer ordem, tabela da loja, tabelas de probabilidade ignoradas, publicação sem evento); diagnóstico sem vazar token. As fixtures em `tests/fixtures` são páginas reais da Supercell salvas em 2026-09-24.

## O que foi validado e o que ainda depende de credenciais

Validado localmente (2026-09-24):
- `npm run check`: typecheck, lint sem erros e 86 testes passando; `docker compose build`, imagem executando CLI, `GET /health` e Chromium presente.
- Coleta real do blog PT: 6 publicações → 26 eventos, auditados um a um contra o texto (ver `docs/homologacao-2026-09-24.md`); previews semanal e mensal com dados reais cabem em uma mensagem cada.
- A primeira coleta não enfileirou nenhum aviso: publicações antigas não viram "novo anúncio".

Depende de credenciais/integração real (não testado de ponta a ponta):
- Consulta ao clã (`COC_API_TOKEN` + `CLAN_TAG`): cliente, diagnóstico e máquina de estados testados com respostas simuladas no formato da API; não executados contra a API real.
- WhatsApp: `wa:auth`, `wa:chats`, verificação do nome do grupo e envio real dependem de um número dedicado, do QR e de autorização para sair do DRY_RUN; o envio foi testado com um sender simulado.

## Limitações conhecidas

- **Recompensas**: a extração automática reconhece lista sob título de recompensas, tabela de loja (item/preço/limite) e tabela de caminho (nível + grátis/pago). Nas publicações atuais os prêmios dos eventos estão em prosa e as tabelas são de probabilidade de baús, então nenhum evento real tem prêmios verificados automaticamente; só a loja do evento Fascinante foi extraída. Ter uma CLI de importação **não** significa que o calendário com prêmios está completo: exige revisão humana recorrente (`review:list`).
- **Ano das datas**: inferido só dentro da janela de 90 dias antes a 200 dias depois da publicação; fora dela a data fica pendente.
- **Idioma**: o mesmo evento em dois idiomas é reconhecido por categoria+datas; sem datas, só pelo título no mesmo idioma.
- **Classificação** por palavras-chave do título (`medal_event`, `season`, `clan_games`, `cwl`, `challenge`, `cosmetic`, `update`, `other`); itens de loja/cosméticos aparecem agrupados numa linha compacta.
- **Cancelamentos**: a Supercell raramente publica cancelamento estruturado; use `event:cancel`.
- **Inbox do jogo**: fonte não documentada; desligada por padrão.
- **Liga de Guerra**: uma requisição por rodada a cada ciclo de 5 min (até 7 rodadas) enquanto a liga está ativa.
- **Mudança de IP** do servidor invalida a chave da API até ser recriada.

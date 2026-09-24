# Fontes de dados: o que existe, o que é coletado e o que exige intervenção

Validado em 2026-09-24 contra as fontes reais. Tudo o que está aqui foi verificado por requisição direta; nada foi presumido.

## 1. API oficial do Clash of Clans (dados do clã)

- Base: `https://api.clashofclans.com/v1`. Portal e chaves: `https://developer.clashofclans.com`.
- Autenticação: token JWT (`Authorization: Bearer ...`) criado no portal. **Cada chave é vinculada a uma lista de IPs públicos** (o portal rejeita faixas privadas; até 5 entradas por chave). Se o IP de saída do servidor mudar, a chave para de funcionar (HTTP 403 `accessDenied`). Em host com IP dinâmico, recrie a chave ou use um IP fixo.
- Limite de requisições: **não publicado**. O portal diz apenas que o token "is bound to rate limitations and specified IP addresses"; ao exceder, a API responde HTTP 429. O cliente respeita `Retry-After` e faz no máximo 2 novas tentativas com backoff.
- A especificação (swagger) só é visível logado no portal; os endpoints abaixo foram confirmados contra a documentação e wrappers mantidos.

| Endpoint | Uso no bot | Observação |
|---|---|---|
| `GET /clans/{tag}` | validação da tag (`poll:once clan`) | |
| `GET /clans/{tag}/currentwar` | guerra atual: preparação, batalha, encerrada | HTTP 403 se o log de guerra do clã for privado |
| `GET /clans/{tag}/currentwar/leaguegroup` | grupo da Liga de Guerra (temporada, rodadas) | HTTP 404 fora da Liga |
| `GET /clanwarleagues/wars/{warTag}` | cada guerra da Liga em que o clã participa | |
| `GET /clans/{tag}/capitalraidseasons?limit=1` | Fim de Semana de Raides atual (`ongoing`/`ended`, saque, medalhas) | |

**Não existe** endpoint de calendário mensal, Jogos do Clã, eventos especiais, temporadas ou recompensas. Esses dados só saem dos anúncios oficiais (seção 2).

Frequência: `POLL_CLAN_MINUTES` (padrão 5). A detecção de início/fim de guerra e raide depende desse intervalo e da própria atualização da API; um aviso pode sair até 5 minutos depois do fato.

## 2. Anúncios oficiais da Supercell (calendário global, eventos, recompensas)

### 2a. Blog oficial (fonte primária, habilitada por padrão)

- `https://supercell.com/en/games/clashofclans/pt/blog/` (PT) e `https://supercell.com/en/games/clashofclans/blog/` (EN). Outros idiomas em `/{de,es,fr,...}/blog/`.
- **Não há RSS/Atom** (`/rss`, `/feed`, `rss.xml` respondem 404).
- O site é Next.js com renderização estática: cada página embute um JSON em `<script id="__NEXT_DATA__">`. O coletor lê esse JSON, não o HTML visual:
  - listagem: `props.pageProps.articles[]` com `title`, `linkUrl`, `publishDate` (ISO);
  - post: `props.pageProps.bodyCollection[].text.json` (rich-text do Contentful) e `alternateHrefs` (mesmo artigo em outros idiomas).
- Se a estrutura mudar, a coleta falha explicitamente (registrada em `collector_runs`) e nada é inventado.

### 2b. Inbox do jogo (fonte secundária, desligada por padrão)

- `https://clashofclans.inbox.supercell.com/data/{pt|en}/news/content.json`: é o conteúdo que o próprio app carrega. Hospedado pela Supercell, mas **não documentado nem aberto**; pode mudar ou ser bloqueado sem aviso.
- Mesmo conteúdo do blog, com ids estáveis e HTML simples. Ative com `SOURCE_INBOX_ENABLED=true` se quiser redundância. Não é usado como link de fonte nas mensagens (o link vai para o blog).

## 3. Cobertura real da extração automática

A extração é determinística (sem IA, sem regex genérica sobre prosa). Só reconhece informação explícita:

| Conteúdo | Formato reconhecido | Resultado |
|---|---|---|
| Datas de evento | linha rotulada: `Início do evento: 9 de setembro, às 8h (UTC)` / `Event starts: September 9 at 08:00 UTC` (também `Início:`, `Fim:`, `Término`, `Starts:`, `Ends:`) | `start_at`/`end_at` com precisão `datetime` (só quando há hora **e** UTC/GMT explícitos) |
| Data sem horário | `24 de setembro`, `September 24` | precisão `date`; nenhum horário é inventado |
| Horário sem fuso | `September 9 at 8am` | precisão `date` + pendência `date_without_tz` |
| Ano | nunca vem no texto; é inferido da data de publicação **só** se a data cair entre 90 dias antes e 200 dias depois dela (registrado como `year_inferred_from_publish_date`) | fora da janela: data pendente + pendência `year_ambiguous`; término antes do início passa ao ano seguinte só se ficar a até 200 dias do início |
| Calendário mensal (post de temporada) | um item por linha: `September 22-28: Clan Games - ...` / `De 22 a 28 de setembro: Jogos do Clã. ...` / `15 de setembro: ...` | um evento por item (precisão `date`) + um evento "temporada"; o término da temporada vem da frase explícita ("terminar em 1º de outubro" / "ends on October 1st") quando existir, senão do intervalo dos itens (marcado `end_at_derived_from_calendar_items`) |
| Vários eventos num artigo | seções com título (h2/h3) contendo suas próprias linhas de início/término, ou itens de calendário | eventos distintos, todos ligados à mesma publicação (`event_sources.segment_key`); segmentos da mesma publicação **nunca** se fundem entre si |
| Prêmios em lista | itens de lista abaixo de um título com "Recompensa(s)"/"Reward(s)"/"Prêmio(s)" que **não** seja de loja. `label` (+ `condition` após ":"), quantidade só com `N x`/`x N`, `tier=paid` só com Passe Ouro/Gold Pass/bilhete de evento/pago/preço em dinheiro, `free` só com "grátis/free"; senão `unknown` | `rewards_status = known` |
| Prêmios em tabela de caminho | tabela com coluna de nível (Nível/Level/Tier) e colunas grátis/pago (ou coluna de recompensa) | prêmios com `condition = "Nível N"` e tier pela coluna |
| Loja do evento | tabela com colunas item + preço (+ limite), ou lista sob título de loja/Comerciante se não houver tabela | itens `kind: "shop"` com preço e limite; exibidos em seção própria, nunca como prêmio garantido |
| Tabelas de probabilidade (baús, drops) | cabeçalho ou parágrafo anterior com "Probabilidade/Chance/%" | **ignoradas** sempre |
| Recompensas em prosa, imagens/vídeos | não são interpretados | `rewards_status = unverified` + pendência `rewards_unverified` |

O que **exige intervenção manual** (importação JSON via `npm run import`):
- recompensas quando a fonte não tem lista estruturada sob um título de recompensas (é o caso mais comum nos posts de evento de medalhas: os prêmios estão em prosa e tabelas de probabilidade);
- separar gratuito/pago quando o texto não diz explicitamente;
- eventos anunciados só por imagem, vídeo ou redes sociais;
- cancelamentos e adiamentos (a Supercell raramente publica um post dedicado; use `event:cancel`).

Estado real observado em 2026-09-24 com a coleta do blog PT (auditoria completa em `docs/homologacao-2026-09-24.md`): 6 publicações, 26 eventos, todos com datas confirmadas. Nenhum evento tem prêmios verificados automaticamente: os prêmios estão em prosa e as tabelas são de probabilidade. A loja do evento Fascinante foi extraída (28 itens com preço e limite). 3 publicações sem evento viram pendência `no_events`.

## 4. O que os relatórios dizem quando a fonte falha

- Falha de coleta nunca altera eventos: `last_checked_at` não avança, `collector_runs.ok = 0`.
- Relatórios trazem no rodapé a última verificação bem-sucedida ou o aviso "A fonte oficial de anúncios não pôde ser consultada".
- Falha de consulta do clã nunca é interpretada como fim de guerra/raide: o estado anterior é mantido até uma resposta válida.

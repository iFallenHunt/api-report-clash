# Homologação de 2026-09-24

Registro da conferência feita com dados **reais** coletados do blog oficial da Supercell (PT) em 2026-09-24. Reproduza com:

```bash
npm run poll:once -- announcements
npm run cli -- preview weekly --at=2026-09-28T12:00:00Z    # próxima segunda, 09:00 de Brasília
npm run cli -- preview monthly --at=2026-10-01T12:00:00Z   # próximo dia 1, 09:00 de Brasília
npm run cli -- review:list
```

`--at` simula o instante de geração com os dados já coletados. O preview imprime o texto exatamente como seria enviado, já dividido pelo limite de `MESSAGE_MAX_CHARS`.

## Problemas encontrados e corrigidos

| # | Problema | Efeito antes | Correção |
|---|---|---|---|
| 1 | Itens diferentes do mesmo artigo, com as mesmas datas, eram fundidos pela chave canônica ou por semelhança de título | 4 eventos sumiram: "Bilhete dourado" e "Tropas temporárias" viraram fontes de "Baús da WWE"; "Figurinhas" entrou em "Visuais de herói"; "Desafio do John Cena" foi absorvido pela temporada | Segmentos de uma mesma publicação nunca se fundem; fusão por datas exige categoria compatível; itens `other`/`cosmetic` incluem o título na chave canônica |
| 2 | Término da temporada derivado dos itens (30/09) | Divergia da frase explícita "terminar em 1º de outubro" | Frase explícita de término tem prioridade; intervalo derivado fica marcado em `event_sources.confirmed_fields` |
| 3 | Lista "Recompensas da loja do Comerciante" tratada como prêmios | 5 itens de loja apresentados como recompensas garantidas | Itens de loja têm `kind: "shop"` e seção própria; a tabela da loja (item, limite, preço) é extraída com preço e limite |
| 4 | "comprá-lo" marcava item como pago | Risco de classificar item da loja como pago | Pago só com passe/bilhete pago ou preço em dinheiro explícitos |
| 5 | Publicação sem evento só gerava log de debug | Omissões invisíveis ("Retrospectiva do Chefe") | Pendência `no_events` por publicação |
| 6 | Sublistas do rich-text coladas ("Equipamentos épicosÉ possível") | Texto corrompido | Sublistas unidas por ": " e "; " |
| 7 | Ano inferido sem limite (jan↔dez por heurística solta) | Datas distantes da publicação recebiam ano por palpite | Janela de evidência: 90 dias antes a 200 dias depois da publicação; fora dela, data pendente com motivo (`year_ambiguous`) |
| 8 | "Corrida do Clã" classificada como `other` | Sem linha de recompensas | Classificada como `special_event` |
| 10 | Datas só com o dia mostravam "7 dias" (22/09–28/09) e "31 dias" (01/09–01/10) | Contagem inclusiva de datas apresentada como duração | Duração omitida para datas sem horário; só aparece a duração declarada pela fonte ("por cinco dias" → "5 dias, segundo a fonte") |
| 11 | Estado de datas sem horário mudava à meia-noite UTC (21h em Brasília) | "Em andamento" na véspera e no dia do término; "EVENTO INICIADO" sem horário conhecido | Estado de exibição no fuso de Brasília: "previsto para começar/encerrar hoje; horário não informado"; sem aviso de início sem horário |
| 12 | Títulos redundantes ("Jogos do Clã · Jogos do Clã") e seções vazias | Ruído no WhatsApp | Categoria omitida quando o título já a contém; seções vazias omitidas |
| 9 | Semanal real em 2 mensagens, link repetido em cada item | Leitura ruim no WhatsApp | Itens menores em lista compacta; links únicos no rodapé; datas só-dia em formato curto |

## Auditoria dos eventos

Fonte "temporada" = `WWE: Em Busca do John Cena entra no ringue!` (publicado 01/09, calendário item a item). Datas conferidas uma a uma contra o texto PT e EN (teste automatizado compara os dois idiomas).

| # | Evento | Categoria | Fonte | Início | Término | Precisão | Recompensas | Pendência |
|---|---|---|---|---|---|---|---|---|
| 1 | O evento de medalhas Fascinante está na área | medal_event | post do evento | 2026-08-12T08:00:00Z | 2026-08-31T08:00:00Z | datetime/datetime | só loja (28 itens com preço e limite) | rewards_unverified |
| 2 | Baús da WWE | other | temporada | 2026-09-01 | 2026-09-30 | date/date | não verificadas | - |
| 3 | Bilhete dourado | other | temporada | 2026-09-01 | 2026-09-30 | date/date | não verificadas | - |
| 4 | Corrida do Clã Money in the Bank | special_event | temporada | 2026-09-01 | 2026-09-05 | date/date | não verificadas | rewards_unverified |
| 5 | Desafio do John Cena | challenge | temporada | 2026-09-01 | 2026-09-30 | date/date | não verificadas | rewards_unverified |
| 6 | Figurinhas da WWE para o bate-papo global | cosmetic | temporada | 2026-09-01 | 2026-09-30 | date/date | não verificadas | - |
| 7 | Liga das Guerras de Clãs | cwl | temporada | 2026-09-01 | 2026-09-11 | date/date | não verificadas | - |
| 8 | Opções de batalha | other | temporada | 2026-09-01 | 2026-09-06 | date/date | não verificadas | - |
| 9 | Tropas temporárias | other | temporada | 2026-09-01 | 2026-09-30 | date/date | não verificadas | - |
| 10 | Visuais de herói e paisagem da WWE | cosmetic | temporada | 2026-09-01 | 2026-09-30 | date/date | não verificadas | - |
| 11 | WWE: Em Busca do John Cena entra no ringue | season | temporada | 2026-09-01 | 2026-10-01 | date/date | não verificadas | rewards_unverified |
| 12 | Paisagem Money in the Bank | cosmetic | temporada | 2026-09-02 | 2026-09-30 | date/date | não verificadas | - |
| 13 | Visual de herói Cody Rhodes (Rei Bárbaro) | cosmetic | temporada | 2026-09-03 | 2026-09-30 | date/date | não verificadas | - |
| 14 | Visual de herói Alexa Bliss (Rainha Arqueira) | cosmetic | temporada | 2026-09-05 | 2026-09-30 | date/date | não verificadas | - |
| 15 | Acampamentos Amigo ou Inimigo | other | temporada | 2026-09-06 | 2026-09-09 | date/date | não verificadas | - |
| 16 | Visual de herói Iyo Sky (Campeã Real) | cosmetic | temporada | 2026-09-07 | 2026-09-30 | date/date | não verificadas | - |
| 17 | Visual de herói Kane (Duque Dracônico) | cosmetic | temporada | 2026-09-08 | 2026-09-30 | date/date | não verificadas | - |
| 18 | O retorno das opções de batalha | other | temporada | 2026-09-09 | 2026-09-22 | date/date | não verificadas | - |
| 19 | Evento de medalhas Explosão de Espólios da WWE | medal_event | post do evento + temporada | 2026-09-09T08:00:00Z | 2026-09-22T08:00:00Z | datetime/datetime | não verificadas | rewards_unverified |
| 20 | Visual de herói: American Badass Undertaker (Grande Guardião) | cosmetic | temporada | 2026-09-10 | 2026-09-30 | date/date | não verificadas | - |
| 21 | Aceleração dos coletores de recursos | other | temporada | 2026-09-12 | 2026-09-14 | date/date | não verificadas | - |
| 22 | O retorno da personalização Mistur-A-Rama | cosmetic | temporada | 2026-09-15 | 2026-09-15 | date/date | não verificadas | - |
| 23 | Aceleração dos equipamentos | other | temporada | 2026-09-16 | 2026-09-21 | date/date | não verificadas | - |
| 24 | Jogos do Clã | clan_games | temporada | 2026-09-22 | 2026-09-28 | date/date | não verificadas | rewards_unverified |
| 25 | Aceleração dos coletores de recursos | other | temporada | 2026-09-26 | 2026-09-28 | date/date | não verificadas | - |
| 26 | Acampamentos Amigo ou Inimigo | other | temporada | 2026-09-28 | 2026-09-30 | date/date | não verificadas | - |

Contagem: 24 itens do calendário da temporada + a própria temporada + 2 posts de evento de medalhas = 27 menções, das quais 1 é o mesmo evento em dois artigos (Explosão de Espólios), resultando em **26 eventos**. Não há duplicatas: os dois "Aceleração dos coletores de recursos" e os dois "Acampamentos Amigo ou Inimigo" são ocorrências distintas publicadas em datas diferentes.

Publicações sem evento (pendência `no_events`):
- **A Retrospectiva do Chefe chegou!**: disponibilidade escrita em prosa ("a partir das 8h (UTC) de 8 a 31 de agosto"), fora dos formatos rotulados. Já encerrada. Se for relevante, importar manualmente.
- **A ATUALIZAÇÃO DA FÚRIA ANIME CHEGOU!** e **Atualização de agosto**: notas de atualização sem eventos datados. A "jornada do herói" é um recurso permanente, não um evento.

Classificação: itens de loja/cosméticos → `cosmetic`; ajustes e boosts ("Opções de batalha", "Aceleração…", "Acampamentos…", "Baús", "Bilhete dourado", "Tropas temporárias") → `other`, listados de forma compacta. "Bilhete dourado" é o Passe Ouro (pago); fica em `other` porque a fonte não traz a lista de prêmios em formato estruturado.

## Recompensas: o que ficou sem prêmio e por quê

| Evento | Por quê | Ação |
|---|---|---|
| Evento de medalhas Explosão de Espólios da WWE | Prêmios do caminho do evento só em prosa; as 10 tabelas do post são de **probabilidade** dos baús (ignoradas de propósito) | importar manualmente |
| Evento de medalhas Fascinante | Tabela da loja extraída (28 itens com preço e limite); prêmios do caminho do evento não aparecem em lista ou tabela | importar os prêmios do caminho, se desejado |
| WWE: Em Busca do John Cena (temporada) | Passe Ouro e visuais descritos em prosa ("resgate o visual de herói exclusivo desta temporada") | importar manualmente |
| Desafio do John Cena | Condição e prêmio em prosa | importar manualmente |
| Jogos do Clã | "resgate os prêmios do caminho junto do clã", sem lista | importar manualmente |
| Corrida do Clã Money in the Bank | prosa | importar manualmente |

Formatos agora extraídos automaticamente: lista sob título de recompensas; tabela de loja (item + preço [+ limite]); tabela de caminho (coluna de nível + colunas grátis/pago ou recompensa). Nenhuma publicação atual usa lista de prêmios ou tabela de caminho; os dois formatos estão cobertos por testes com conteúdo sintético.

## Previews reais

Regenerados após as correções 10 a 12.

### Semanal (segunda 28/09, 09:00)

```
📋 *RESUMO DA SEMANA* · 28/09 a 05/10

*▶️ Em andamento*

🎯 *Desafio do John Cena*
   📅 ter., 01/09 a qua., 30/09 · horário não divulgado
   🎁 Recompensas não verificadas (veja a fonte)

🗓️ *WWE: Em Busca do John Cena entra no ringue* · Temporada
   📅 ter., 01/09 a qui., 01/10 · horário não divulgado
   🎁 Recompensas não verificadas (veja a fonte)

*⏰ Encerram nesta semana*
• Jogos do Clã — previsto para encerrar hoje; horário não informado
• Desafio do John Cena — qua., 30/09 (horário não informado)
• WWE: Em Busca do John Cena entra no ringue — qui., 01/10 (horário não informado)

*🧩 Também nesta semana (ajustes, baús e ofertas)*
• Aceleração dos coletores de recursos (26/09 a 28/09 · 48 horas, segundo a fonte)
• Acampamentos Amigo ou Inimigo (28/09 a 30/09)
• Baús da WWE (01/09 a 30/09)
• Bilhete dourado (01/09 a 30/09)
• Tropas temporárias (01/09 a 30/09)

*🎨 Cosméticos e ofertas na loja*
• Figurinhas da WWE para o bate-papo global (01/09 a 30/09)
• Paisagem Money in the Bank (02/09 a 30/09)
• Visuais de herói e paisagem da WWE (01/09 a 30/09)
• Visual de herói Alexa Bliss (Rainha Arqueira) (05/09 a 30/09)
• Visual de herói Cody Rhodes (Rei Bárbaro) (03/09 a 30/09)
• Visual de herói Iyo Sky (Campeã Real) (07/09 a 30/09)
• Visual de herói Kane (Duque Dracônico) (08/09 a 30/09)
• Visual de herói: American Badass Undertaker (Grande Guardião) (10/09 a 30/09)

🎁 Recompensas marcadas como "não verificadas" ainda dependem de revisão manual; confira na fonte oficial.
ℹ️ Anúncios oficiais verificados em 24/09 às 16:14.

🔗 Fonte oficial:
https://supercell.com/en/games/clashofclans/pt/blog/news/wwe-em-busca-do-john-cena-entra-no-ringue

🕒 Horário de Brasília
```

### Mensal de setembro (como seria gerado hoje)

```
📆 *CALENDÁRIO DE SETEMBRO DE 2026*

*Eventos confirmados*

🎉 *Corrida do Clã Money in the Bank* · Evento especial
   📅 ter., 01/09 a sáb., 05/09 · horário não divulgado
   🎁 Recompensas não verificadas (veja a fonte)

🎯 *Desafio do John Cena*
   📅 ter., 01/09 a qua., 30/09 · horário não divulgado
   🎁 Recompensas não verificadas (veja a fonte)

🏆 *Liga das Guerras de Clãs*
   📅 ter., 01/09 a sex., 11/09 · horário não divulgado

🗓️ *WWE: Em Busca do John Cena entra no ringue* · Temporada
   📅 ter., 01/09 a qui., 01/10 · horário não divulgado
   🎁 Recompensas não verificadas (veja a fonte)

🏅 *Evento de medalhas Explosão de Espólios da WWE*
   📅 qua., 09 de set. às 05:00 → ter., 22 de set. às 05:00
   ⏳ 13 dias
   🎁 Recompensas não verificadas (veja a fonte)

🎮 *Jogos do Clã*
   📅 ter., 22/09 a seg., 28/09 · horário não divulgado
   🎁 Recompensas não verificadas (veja a fonte)

*🧩 Também no mês (ajustes, baús e ofertas)*
• Baús da WWE (01/09 a 30/09)
• Bilhete dourado (01/09 a 30/09)
• Opções de batalha (01/09 a 06/09)
• Tropas temporárias (01/09 a 30/09)
• Acampamentos Amigo ou Inimigo (06/09 a 09/09)
• O retorno das opções de batalha (09/09 a 22/09)
• Aceleração dos coletores de recursos (12/09 a 14/09 · 48 horas, segundo a fonte)
• Aceleração dos equipamentos (16/09 a 21/09 · 5 dias, segundo a fonte)
• Aceleração dos coletores de recursos (26/09 a 28/09 · 48 horas, segundo a fonte)
• Acampamentos Amigo ou Inimigo (28/09 a 30/09)

*🎨 Cosméticos e ofertas na loja*
• Figurinhas da WWE para o bate-papo global (01/09 a 30/09)
• Visuais de herói e paisagem da WWE (01/09 a 30/09)
• Paisagem Money in the Bank (02/09 a 30/09)
• Visual de herói Cody Rhodes (Rei Bárbaro) (03/09 a 30/09)
• Visual de herói Alexa Bliss (Rainha Arqueira) (05/09 a 30/09)
• Visual de herói Iyo Sky (Campeã Real) (07/09 a 30/09)
• Visual de herói Kane (Duque Dracônico) (08/09 a 30/09)
• Visual de herói: American Badass Undertaker (Grande Guardião) (10/09 a 30/09)
• O retorno da personalização Mistur-A-Rama (15/09)

📌 Calendário parcial: a Supercell divulga eventos ao longo do mês. Novidades relevantes serão avisadas separadamente.
🎁 Recompensas marcadas como "não verificadas" ainda dependem de revisão manual; confira na fonte oficial.
ℹ️ Anúncios oficiais verificados em 24/09 às 16:14.

🔗 Fontes oficiais:
https://supercell.com/en/games/clashofclans/pt/blog/news/wwe-em-busca-do-john-cena-entra-no-ringue
https://supercell.com/en/games/clashofclans/pt/blog/news/evento-de-medalhas-explosao-de-espolios-da-wwe

🕒 Horário de Brasília
```

### Mensal de outubro (01/10, 09:00, se nada novo for publicado até lá)

```
📆 *CALENDÁRIO DE OUTUBRO DE 2026*

*Eventos confirmados*

🗓️ *WWE: Em Busca do John Cena entra no ringue* · Temporada
   📅 ter., 01/09 a qui., 01/10 · horário não divulgado
   ⚠️ previsto para encerrar hoje; horário não informado
   🎁 Recompensas não verificadas (veja a fonte)

📌 Calendário parcial: a Supercell divulga eventos ao longo do mês. Novidades relevantes serão avisadas separadamente.
🎁 Recompensas marcadas como "não verificadas" ainda dependem de revisão manual; confira na fonte oficial.
ℹ️ Anúncios oficiais verificados em 24/09 às 16:14.

🔗 Fonte oficial:
https://supercell.com/en/games/clashofclans/pt/blog/news/wwe-em-busca-do-john-cena-entra-no-ringue

🕒 Horário de Brasília
```


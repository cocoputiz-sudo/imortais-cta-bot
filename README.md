# 🛡️ IMORTAIS CTA Bot

Bot de Discord para organização de conteúdo de guerra do Albion Online, feito para a guild **IMORTAIS**. Automatiza a montagem de parties (PTs) para CTA, Bomb, Roaming e Castelo, com controle de presença, ranking por temporada e divisão de loot.

Stack: **Node.js + discord.js v14 + PostgreSQL**, hospedado no Railway.

---

## ⚔️ Funcionalidades

### CTA (Call to Arms)
- Postar no canal `#cta-mandatório` dispara um painel de horários (UTC / horário do jogo).
- Horários disponíveis: **15:20, 17:20, 19:20, 21:20, 00:00, 01:20**.
- Cada horário cria uma **thread** com a planilha ao vivo e uma sala de contagem.
- **Inscrição por botão** (papel → arma → presença) ou **por texto na thread** (escrever "healer", "galatinas", ou o número da vaga).
- **Engine de realocação automática**: recalcula a comp inteira a cada mudança, encaixando por arma exata > afinidade de família > reserva. PT1 tem prioridade.
- **Montagem progressiva**: o CTA começa mostrando só a **PT1**. Quem não cabe fica em "⏳ Aguardando PT". O caller abre mais PTs sob demanda com `/cta_show` (flex ou press comp).
- Regras especiais: teto de armas únicas (Ursinas/Cravadas), desempate por IP, vaga dinâmica de Shadow Caller/G.A, prioridade mínima do Looter.
- Lembretes automáticos (30 e 10 min antes) e avisos de consolidação (25/20/15/10 min antes da saída).
- Vaga vazia mostra as armas possíveis; ao ser preenchida, mostra a arma escolhida e o nome do jogador.

### Bomb
- Aviso automático no `#bomb-ping` por horário; só o cargo Bomb responde.
- Contagem de confirmados ao vivo.
- Montagem de comp de bomb (Invi ou Melee) pelo Líder do Bomb.

### Roaming
- `/roaming <nome> <vagas>` cria um roaming (12, 16 ou 20 vagas), com sala de voz própria e post no `#ping-de-conteúdos`.
- Contagem de presença por tempo na sala.
- **Divisão de prata proporcional ao tempo** de presença (elegível quem pingou função e ficou ≥10 min).

### Castelo
- `/castelo <horário>` cria um evento de castelo com 3 PTs (Press Comp + PT1 + PT2 do CTA).
- Sala de voz própria, contagem de presença e divisão de prata (igual roaming).
- Reconhecimento de inscrição por botão e por texto na thread.

### War Room · Guild Presence (experimental)

- recebe probes limitados dos eventos Photon de guilda observados pelo IMORTAIS Combat Client;
- armazena os probes na telemetria existente, sem inferir online/offline antes de validar o protocolo real;
- endpoint restrito a editor em `/api/telemetry/guild-presence-probes` resume códigos, chaves, tipos e amostras recentes; aceita `?player=NomeExato` para isolar o histórico de um membro e, nesse modo, devolve até o `limit` solicitado (máximo 1000) em `recent`;
- esta etapa serve para mapear com segurança `GuildUpdate`, `GuildPlayerUpdated`, `GuildMemberWorldUpdate` e `GuildMemberTerritoryUpdate`;
- depois da validação, o War Room poderá cruzar presença no Albion com ping, Discord e Party real.

### Attendance & Temporadas
- Mede presença pelo tempo real na call (não depende de ping).
- Relatórios em HTML com drill-down: `/attendance_daily`, `/attendance_week`, `/attendance_monthly`.
- Sistema de temporadas: `/cta_start_temporada`, `/cta_finish_temporada`.
- Ranking: `/cta_rank` (placar geral) e `/cta_meurank` (pessoal).

---

## 📋 Comandos

### CTA — gestão (staff / Mestre de Guerra)
| Comando | O que faz |
|---|---|
| `/cta_show` | Abre mais uma PT (flex ou press comp) |
| `/cta_move` | Move um jogador para outra vaga |
| `/cta_remove` | Remove do CTA (por @ ou por PT+vaga se saiu do servidor) |
| `/cta_add` | Adiciona um jogador numa vaga |
| `/cta_clean` | Esvazia uma PT inteira |
| `/cta_change_time` | Muda o horário de um CTA |
| `/cta_consolidar` | Amontoa os participantes nas PTs da frente |
| `/cta_finish` | Encerra um CTA |

### Temporadas & Rank
| Comando | O que faz |
|---|---|
| `/cta_start_temporada <n>` | Inicia uma temporada |
| `/cta_finish_temporada` | Encerra a temporada atual |
| `/cta_rank` | Placar de presença da temporada |
| `/cta_meurank` | Tua pontuação na temporada |

### Attendance
| Comando | O que faz |
|---|---|
| `/attendance_daily` | Relatório de presença — hoje |
| `/attendance_week` | Relatório — últimos 7 dias |
| `/attendance_monthly` | Relatório — últimos 30 dias |

### Roaming (caller)
| Comando | O que faz |
|---|---|
| `/roaming <nome> <vagas>` | Cria um roaming |
| `/roaming_start` | Começa a contar presença |
| `/roaming_value` | Informa a prata arrecadada |
| `/roaming_finish` | Encerra e calcula a divisão |
| `/roaming_saldo` / `/roaming_meu_saldo` | Consulta a divisão |
| `/roaming_remove` / `/roaming_fill` | Gestão de participantes |
| `/roaming_pago` | Marca como pago |

### Castelo (caller)
| Comando | O que faz |
|---|---|
| `/castelo <horário>` | Cria um castelo |
| `/castelo_start` | Começa a contar presença |
| `/castelo_value` | Informa a prata |
| `/castelo_finish` | Encerra e divide a prata |
| `/castelo_saldo` / `/castelo_meu_saldo` | Consulta a divisão |
| `/castelo_remove` | Remove alguém |
| `/castelo_pago` / `/castelo_cancel` | Marca pago / cancela |

---

## 🗂️ Estrutura do projeto

```
src/
├── index.js        # lógica principal, handlers, eventos do Discord
├── commands.js     # definição dos slash commands
├── comps.js        # composições das PTs, catálogo de armas, famílias
├── roster.js       # engine de atribuição e realocação
├── attendance.js   # cálculo de presença e relatórios
├── roaming.js      # comps e divisão de prata do roaming
├── castelo.js      # mapeamento de PTs e divisão do castelo
├── bomb.js         # comps do bomb
└── db.js           # camada de banco (PostgreSQL)
assets/
├── roaming.png     # arte do post de roaming
└── castelo.png     # arte do post de castelo
```

---

## ⚙️ Configuração (variáveis de ambiente)

| Variável | Descrição |
|---|---|
| `DISCORD_TOKEN` | Token do bot |
| `DATABASE_URL` | Conexão PostgreSQL |
| `CTA_CHANNEL_ID` | Canal `#cta-mandatório` |
| `IMORTAL_ROLE_ID` | Cargo Imortal (menções) |
| `STAFF_ROLE_ID` | Cargo Mestre de Guerra |
| `CALLER_TAG_ID` | Cargo de caller (roaming/castelo) |
| `BOMB_PING_CHANNEL_ID`, `BOMB_ROLE_ID`, `BOMB_LEADER_ROLE_ID` | Configuração do bomb |
| `PREP_VOICE_ID`, `BOMB_VOICE_ID` | Salas de voz monitoradas |
| `CONTENT_PING_CHANNEL_ID` | Canal `#ping-de-conteúdos` |
| `ROAMING_CATEGORY_ID` | Categoria onde as salas são criadas |
| `PRESET_TIMES` | Horários dos CTAs (sobrescreve o padrão) |

---

## 🚀 Deploy

O projeto roda no Railway com deploy automático a partir do GitHub. As tabelas do banco são criadas automaticamente no boot (`CREATE TABLE IF NOT EXISTS`).

```bash
# instalar dependências
npm install

# rodar
node src/index.js
```

---

*Feito para a guild IMORTAIS · Albion Online*

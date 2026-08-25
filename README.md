# Bot CTA — IMORTAIS (Fase 0)

Automatiza a montagem de CTA da guild: detecta o ping no `#cta-mandatório`,
abre a thread **Planilha CTA**, deixa a galera se inscrever com 1 clique e
monta a **PT pronta** pro caller — replicando a planilha que vocês já usam.

## O que a Fase 0 faz
1. Detecta post novo no `#cta-mandatório`.
2. Mostra pro caller um painel de **horários pré-setados** (toggle + confirmar).
3. Abre a thread **Planilha CTA** e menciona `@Imortal`.
4. Cada membro escolhe **papel → arma → presença** (já ON / entra no horário).
5. O bot encaixa na primeira vaga aberta (Party 1 → 2 → 3) por **arma exata**.
6. Planilha ao vivo na thread; caller clica **Montar PT** e publica a lista.

> Ainda **não** faz: troca por peso/família de arma (maça pesada → pétrea),
> recompensa de 50k travada por voz. Isso é Fase 1 e Fase 2.

## Editar as comps
Tudo em **`src/comps.js`** — as três parties transcritas da planilha.
Mudou a comp? Edita só esse arquivo.

## Rodar local
```bash
npm install
cp .env.example .env   # preencha os valores
npm start
```

## Deploy no Railway (Hobby, ~US$5/mês)
1. Suba o repo no GitHub e conecte no Railway.
2. Adicione um **Postgres** no projeto (o Railway injeta `DATABASE_URL`).
3. Em Variables, preencha `DISCORD_TOKEN`, `CTA_CHANNEL_ID`, `IMORTAL_ROLE_ID`
   (e `PT_PRONTA_CHANNEL_ID` se quiser).
4. Deploy. O bot mantém WebSocket com o Discord aberto, então **não dorme**
   por inatividade — o que consome crédito é o uso real, coberto pelos US$5.

## Antes de subir, no Discord Developer Portal
- Ative o **MESSAGE CONTENT INTENT** (Bot → Privileged Gateway Intents).
- Convide o bot com permissões: Ver Canais, Enviar Mensagens,
  Criar Threads Públicas, Enviar em Threads, Mencionar @everyone/cargos.

## Como pegar os IDs
Ative o Modo Desenvolvedor no Discord (Config → Avançado), aí clica com o
botão direito no canal/cargo → **Copiar ID**.

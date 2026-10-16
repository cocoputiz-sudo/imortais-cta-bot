# Discord IMORTAIS: homologação isolada do PR #89

Estado verificado em 2026-10-16, 14:52 UTC.

## Implantação ativa

- Projeto MackNa: `imortais-discord-homologacao`, privado, sem deploy automático.
- Código executável: `81dfcd46647334b7a9cb254e2d104169e4992b5b`.
- Bot: implantação `dfd8b5a0ce0`, online como **CTA IMORTAIS BOT TESTE#7078**.
- PostgreSQL 16: implantação `d00e558feeb`, instância `postgres-imortais-discord-ho`, 42 tabelas da aplicação.
- Banco exclusivo e vazio na primeira inicialização. Preview anterior permanece em outro projeto.
- Token validado por GET /users/@me: aplicativo `1560656423107432548`.
- GET /users/@me/guilds confirmou uma única guilda: **imortais server teste**, `1560656943486345298`.
- 51 comandos consultados na API após registro na guilda de testes.
- GET /api/health interno: HTTP 200, `ok=true, database=true, discord=true`.
- Intents exigidas pelo cliente aceitas; conexão Gateway concluída.
- CI do commit executável: AMD64 preview, Scout regression e navegador concluídos com sucesso.
- Serviço temporário `discord-inspect` parado após consultas de leitura. Nenhuma mensagem de teste enviada nesta etapa.

## Canais e cargos configurados

IDs obtidos diretamente da guilda de testes.

| Configuração | Destino | ID |
| --- | --- | --- |
| CTA_CHANNEL_ID | cta-mandatório | 1560665420447481966 |
| STAFF_LOG_CHANNEL_ID / RANKING_CHANNEL_ID | general, compartilhado nesta etapa de testes | 1560656944786575433 |
| CONTENT_PING_CHANNEL_ID | ping-de-conteúdos | 1560657754991886346 |
| PREP_VOICE_ID | PREPARAÇÃO | 1560657392449097728 |
| BOMB_VOICE_ID | BOMB SQUAD | 1560657458639413359 |
| ROAMING_CATEGORY_ID | CONTEÚDOS E EVENTOS | 1560657702823133346 |
| IMORTAL_ROLE_ID | Imortal | 1560658000748871802 |
| STAFF_ROLE_ID / MASTER_OF_WAR_ROLE_ID / CALLER_TAG_ID | Mestre de Guerra | 1560658086857810023 |
| OFFICER_ROLE_IDS | Officer | 1560658125089148928 |

**Permissões pendentes:** GET do membro do bot retornou somente o cargo automático `1560665150879699038`. As categorias privadas negam View Channel a @everyone e não concedem acesso a esse cargo. O cargo manual **BOT**, `1560658377531457576`, existe e tem Administrador, mas ainda não está atribuído ao bot. O responsável pelo servidor de testes precisa ajustar seu acesso antes dos testes nesses canais. Gerenciar cargos e canais também está ausente no cargo automático; não foi tentada elevação pelo próprio bot.

## Inicialização e OAuth

Comando do serviço:

```sh
node scripts/mackna-discord-staging-preflight.cjs && npm start
```

A checagem valida projeto, banco exclusivo, IDs necessários e bloqueia guilda/aplicativo conhecidos de produção. A consulta prévia da API comprova a identidade real; a checagem local não substitui essa consulta.

O modo atual é `MACKNA_STAGING_OAUTH=disabled`, com DISCORD_CLIENT_SECRET ausente e `OAUTH_REDIRECT=https://discord-staging.invalid/auth/callback`. O domínio reservado evita o fallback de produção. SESSION_SECRET exclusivo foi gerado e cadastrado. GET /auth/login retorna 503 e /auth/me retorna logged=false, conforme esperado. O login web ainda não foi homologado.

Para habilitar OAuth posteriormente: configurar HTTPS da homologação, registrar seu callback no aplicativo de testes, cadastrar seu segredo e definir MACKNA_STAGING_OAUTH=enabled. O preflight exige HTTPS fora do Railway com caminho /auth/callback. Em disabled, rejeita segredo OAuth presente e qualquer outro redirect.

## Próximos testes

1. Ajustar acesso do bot aos canais e a hierarquia de cargos no servidor de testes.
2. Exercitar CTA, perfis, caller, transferência, presença em voz e roaming com contas de testes.
3. Homologar login web após configurar HTTPS e OAuth.
4. Exercitar vínculos, recusa/revogação, baixa manual e persistência. Mensagens privadas somente para contas que autorizaram esse teste.

Os testes visuais existentes usam sessões e respostas simuladas; as evidências desta etapa comprovam conexão real, registro de comandos, PostgreSQL e saúde HTTP, não a execução de todos os comandos.

Railway, Discord de produção e Apache não foram modificados. Nenhuma porta pública foi aberta. PR permanece sem merge.

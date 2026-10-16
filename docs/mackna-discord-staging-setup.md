# Discord IMORTAIS: homologação isolada do PR #89

Estado verificado em 2026-10-16, 15:22 UTC.

## Implantação ativa

- Projeto MackNa: `imortais-discord-homologacao`, sem deploy automático; domínio homolog.macknacloud.com.br cadastrado, HTTPS externo ainda pendente.
- Código executável: `128a92f7b477b76f27cafad67376aebc7ab3c7de`.
- Bot: implantação `dd0b0516d70`, online como **CTA IMORTAIS BOT TESTE#7078**.
- PostgreSQL 16: implantação `d00e558feeb`, instância `postgres-imortais-discord-ho`, 43 tabelas da aplicação, incluindo cta_caller_recoveries.
- Banco exclusivo e vazio na primeira inicialização. Preview anterior permanece em outro projeto.
- Token validado por GET /users/@me: aplicativo `1560656423107432548`.
- GET /users/@me/guilds confirmou uma única guilda: **imortais server teste**, `1560656943486345298`.
- 52 comandos consultados na API após registro na guilda de testes.
- GET /api/health interno: HTTP 200, `ok=true, database=true, discord=true`.
- Intents exigidas pelo cliente aceitas; conexão Gateway concluída.
- CI do commit executável: AMD64 preview, Scout regression e navegador concluídos com sucesso.
- Serviço temporário `discord-inspect` parado após consultas de leitura. O usuário validou criação dos seis CTAs, escolha de arma e caller da PT1, conforme imagens de 15:02 UTC; o inspetor não envia mensagens.

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

**Permissões verificadas:** o membro do bot recebeu BOT e Mestre de Guerra e os canais privados concedem acesso. O usuário concluiu criação de CTA e inscrição de caller no servidor de testes.

## Inicialização e OAuth

Comando do serviço:

```sh
node scripts/mackna-discord-staging-preflight.cjs && npm start
```

A checagem valida projeto, banco exclusivo, IDs necessários e bloqueia guilda/aplicativo conhecidos de produção. A consulta prévia da API comprova a identidade real; a checagem local não substitui essa consulta.

O modo atual é `MACKNA_STAGING_OAUTH=disabled`, com DISCORD_CLIENT_SECRET ausente e `OAUTH_REDIRECT=https://discord-staging.invalid/auth/callback`. O domínio reservado evita o fallback de produção. SESSION_SECRET exclusivo foi gerado e cadastrado. GET /auth/login retorna 503 e /auth/me retorna logged=false, conforme esperado. O login web ainda não foi homologado.

Para habilitar OAuth posteriormente: configurar HTTPS da homologação, registrar seu callback no aplicativo de testes, cadastrar seu segredo e definir MACKNA_STAGING_OAUTH=enabled. O preflight exige HTTPS fora do Railway com caminho /auth/callback. Em disabled, rejeita segredo OAuth presente e qualquer outro redirect.

## Próximos testes

1. Exercitar a substituição administrativa de caller ausente pelo novo comando.
2. Exercitar CTA, perfis, caller, transferência, presença em voz e roaming com contas de testes.
3. Homologar login web após configurar HTTPS e OAuth.
4. Exercitar vínculos, recusa/revogação, baixa manual e persistência. Mensagens privadas somente para contas que autorizaram esse teste.

Os testes visuais existentes usam sessões e respostas simuladas; as evidências desta etapa comprovam conexão real, registro de comandos, PostgreSQL e saúde HTTP, não a execução de todos os comandos.

Railway, Discord de produção e Apache não foram modificados. Nenhuma porta pública foi aberta. PR permanece sem merge.

## Recuperação de caller ausente

O bloqueio relatado na imagem de 15:13 UTC foi corrigido no commit executável acima e implantado somente nesta homologação.

Use `/cta_substituir_caller cta:15:20 usuario:@novo arma:MARTELO DE BATALHA motivo:Caller ausente`.
Dono do servidor, Administrador, Gerenciar Servidor ou os cargos configurados de staff/Mestre de Guerra podem executar. Caller comum não recebe essa permissão por liderar o CTA. O sucessor deve ser um membro humano da guilda e pode ainda não estar inscrito.

A transação trava o CTA, confere o caller esperado, reserva o antigo, fixa o sucessor na PT1 vaga 1, transfere caller_id e persiste ator, motivo, arma, anterior e sucessor em cta_caller_recoveries. Contas semelhantes permanecem intactas. O anterior pode ser retirado com /cta_remove e não pode reassumir usando o menu antigo.

Validação: npm test na CI com PostgreSQL 16, incluindo recuperação com sucessor não inscrito, bloqueio de membro comum, motivo inválido, guilda errada, caller já trocado, rollback por falha na auditoria, pedidos concorrentes e perda da antiga liderança. Os três workflows do commit executável passaram: AMD64 38923151821, Scout 38923151662, navegador 38923151615.

Após o deploy: API Discord confirmou o comando entre 52 comandos; health interno retornou HTTP 200 com database=true e discord=true. Os 6 CTAs, a inscrição existente e seus respectivos caller_id foram preservados. A tabela de auditoria está vazia, pois nenhuma substituição foi executada nos CTAs do usuário. A operação SQL foi exercitada somente em tabelas TEMP da CI. O teste interativo do novo comando fica para o usuário.

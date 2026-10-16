# Discord IMORTAIS: homologação isolada do PR #89

Estado revisado em 2026-10-16, 21:16 UTC (18:16 de Brasília).

## Implantação ativa

- Projeto MackNa: `imortais-discord-homologacao`, sem deploy automático; acesso em https://homolog.macknacloud.com.br.
- Código executável: `128a92f7b477b76f27cafad67376aebc7ab3c7de`.
- Bot: implantação `d926b376bbc`, online como **CTA IMORTAIS BOT TESTE#7078**. A reimplantação de 21:04 UTC aplicou somente as variáveis OAuth, preservando o mesmo código executável.
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

O modo atual é `MACKNA_STAGING_OAUTH=enabled`, com Client Secret do aplicativo de testes cadastrado somente nas variáveis do serviço e `OAUTH_REDIRECT=https://homolog.macknacloud.com.br/auth/callback`. SESSION_SECRET permanece exclusivo. Nenhum segredo é incluído neste documento.

A checagem de boot confirmou `oauthEnabled=true`, a guilda `1560656943486345298` e o aplicativo `1560656423107432548`. O responsável registrou o callback no aplicativo de testes e confirmou o acesso ao War Room pelo navegador após a ativação.

Na consulta automatizada de 21:16 UTC: TLS autorizado com certificado Let's Encrypt, válido até 14/01/2027 19:43:20 UTC; `/api/health` HTTP 200 com banco e Discord prontos; `/auth/login` HTTP 302 para discord.com com client_id e callback de testes, escopos `identify guilds.members.read` e state presente. Sem cookies de usuário, `/auth/me` retornou `logged=false`; callback sem code/state retornou HTTP 400. Esta consulta não reutilizou nem acessou a sessão autenticada do usuário.

O modo anterior bot-only (`disabled`, sem Client Secret e callback reservado) permanece suportado pelo preflight. Para voltar a ele, alterar as três variáveis em conjunto e reimplantar; alterar somente a flag impede o boot de propósito.

## Rede e HTTPS concluídos

- DNS A de `homolog.macknacloud.com.br`: `179.174.166.157`, conferido em 20:34 UTC.
- Apache padrão do Debian foi desativado pelo responsável para liberar a porta 80; Caddy passou a operar nas portas 80/443.
- Modem: TCP 80 externo → 192.168.15.16:80; TCP 443 externo → 192.168.15.16:443. Regras conferidas na imagem de 20:33 UTC.
- Reserva DHCP do dispositivo `server` para `192.168.15.16`, confirmada na imagem de 21:13 UTC.
- HTTP redireciona para HTTPS; handshake TLS validado em 21:16 UTC. O responsável confirmou que o site e o login funcionam. A rede usada pelo navegador do responsável não foi documentada como 4G/5G.
- O IP reservado é o endereço local do Debian. O registro DNS usa o IP público e pode precisar de atualização se esse endereço público mudar.
- A porta interna 3000, o painel 8090 e o PostgreSQL não receberam novas regras de encaminhamento neste procedimento.

## Próximos testes

1. Exercitar a substituição administrativa de caller ausente pelo novo comando.
2. Exercitar CTA, perfis, caller, transferência, presença em voz e roaming com contas de testes.
3. Login web: concluído por confirmação do responsável; redirecionamento e HTTPS também verificados automaticamente.
4. Exercitar vínculos, recusa/revogação, baixa manual e persistência. Mensagens privadas somente para contas que autorizaram esse teste.

Os testes visuais existentes usam sessões e respostas simuladas; as evidências desta etapa comprovam conexão real, registro de comandos, PostgreSQL e saúde HTTP, não a execução de todos os comandos.

Railway e Discord de produção não foram modificados. Apache e encaminhamento de portas foram ajustados somente no servidor Debian de testes e em seu modem, conforme descrito acima. PR permanece sem merge, sem publicação ou migração de produção.

## Recuperação de caller ausente

O bloqueio relatado na imagem de 15:13 UTC foi corrigido no commit executável acima e implantado somente nesta homologação.

Use `/cta_substituir_caller cta:15:20 usuario:@novo arma:MARTELO DE BATALHA motivo:Caller ausente`.
Dono do servidor, Administrador, Gerenciar Servidor ou os cargos configurados de staff/Mestre de Guerra podem executar. Caller comum não recebe essa permissão por liderar o CTA. O sucessor deve ser um membro humano da guilda e pode ainda não estar inscrito.

A transação trava o CTA, confere o caller esperado, reserva o antigo, fixa o sucessor na PT1 vaga 1, transfere caller_id e persiste ator, motivo, arma, anterior e sucessor em cta_caller_recoveries. Contas semelhantes permanecem intactas. O anterior pode ser retirado com /cta_remove e não pode reassumir usando o menu antigo.

Validação: npm test na CI com PostgreSQL 16, incluindo recuperação com sucessor não inscrito, bloqueio de membro comum, motivo inválido, guilda errada, caller já trocado, rollback por falha na auditoria, pedidos concorrentes e perda da antiga liderança. Os três workflows do commit executável passaram: AMD64 38923151821, Scout 38923151662, navegador 38923151615.

Após o primeiro deploy da correção: API Discord confirmou o comando entre 52 comandos; health interno retornou HTTP 200 com database=true e discord=true. Os 6 CTAs, a inscrição existente e seus respectivos caller_id foram preservados.

Revisão somente leitura em 21:16 UTC: 43 tabelas, 6 CTAs, todos da guilda de testes, 1 inscrição e **0 registros em cta_caller_recoveries**. A aprovação do acesso ao site não comprova a execução deste comando. A operação SQL passou nas tabelas TEMP da CI; o teste interativo ainda está pendente.

### Roteiro para encerrar a pendência do caller

1. Em um CTA aberto do servidor de testes, usar uma segunda conta humana como sucessor, diferente do caller atual. O anterior não precisa estar online nem consentir.
2. Executar `/cta_substituir_caller`, selecionar CTA, sucessor, arma válida e motivo de 5 a 300 caracteres.
3. Conferir caller_id e sucessor na PT1 vaga 1 no Discord e no War Room; anterior na reserva e passível de remoção por `/cta_remove`; conta secundária preservada. Verificar que o menu antigo não devolve a liderança ao anterior.
4. Consultar a auditoria somente leitura e confirmar ator, anterior, sucessor e motivo. Registrar o horário e o CTA no resultado da homologação.

```sql
SELECT event_id, actor_id, previous_caller_id, new_caller_id, weapon, reason, created_at
FROM cta_caller_recoveries
ORDER BY id DESC LIMIT 5;
```

### Resultado da revisão final

- Três workflows do executável passaram; nenhum comentário de revisão pendente no PR na consulta de 21:15 UTC.
- O HEAD documental `705489e1807026833b546f6bb06d01fa3a53ba7c` não difere do executável em src, test, scripts, package.json, package-lock.json e workflows.
- Não foi identificado novo bloqueio de código nesta revisão de isolamento, permissões, transação e integração do comando. Isto não substitui a pendência interativa acima.
- Fluxos reais de roaming, perfis, presença em voz e contribuintes (vínculos, recusa/revogação e baixa manual) não foram integralmente certificados nesta sessão. Os testes automatizados existentes e sua cobertura permanecem registrados separadamente.
- Não houve merge, migração, publicação de produção nem mudança nos serviços de produção.

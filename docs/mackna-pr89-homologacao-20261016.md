# Homologação isolada IMORTAIS, PR #89

## Resultado em 16/10/2026

A etapa técnica interna passou. Isto não autoriza merge, migração ou publicação em produção.

- Projeto: `imortais-homologacao`, MackNa Cloud v3, Debian AMD64.
- Código executável validado: `29b7665d2d043c006036e7ad913592b7f339b443`.
- Commits posteriores de documentação apenas preservam estas evidências.
- Aplicação: `bot-preview`, porta interna 3000, sem domínio público e auto-deploy desligado.
- Banco do preview: `postgres`, PostgreSQL 16.15, volume persistente.
- Banco descartável independente: `postgres-qa`.
- Executor: `qa-runner`, Node v18.20.8, x64.
- CI: Node 22, workflows preview e Scout regression concluídos com sucesso.

## Provas executadas

| Verificação | Resultado |
| --- | --- |
| Saúde HTTP com banco pronto, Discord falso e modo preview | Passou |
| HTML do War Room, script do navegador e marcador mobile | Passou; não substitui inspeção visual |
| Login OAuth bloqueado e callback inválido rejeitado | Passou |
| GET e POST protegidos sem sessão | HTTP 401 em todas as rotas verificadas |
| Sessão falsificada | Rejeitada |
| 50 consultas de saúde, concorrência 5 | Todas passaram; p50 4 ms, p95 9 ms, máximo 25 ms |
| npm test no próprio Debian | Passou |
| Cobranças, consentimento, dívidas, idempotência | Passou com usuários/cliente Discord simulados |
| Ranking por temporada, autenticação e revogação | Passou |
| Capturas parciais, sweep Might e worker PostgreSQL | Passou |
| Fixtures Photon e reparo legado em quarentena | Passou |
| Registro sintético após reinício do PostgreSQL | Preservado |
| Backup, checksum e restauração em banco novo | 43 tabelas, zero erros |
| Registro sintético no banco restaurado | Lido e validado em conexão somente leitura |
| Rollback da aplicação e retorno à candidata | Ambos ativos; registro preservado |

O teste curto de latência mede somente saúde na rede interna e não dimensiona capacidade de produção.

Evidência estruturada: [mackna-pr89-evidence-20261016.json](mackna-pr89-evidence-20261016.json).
O resumo completo também aparece nos logs do executor com o prefixo `QA_SUMMARY`.

## Executor e isolamento

`test/mackna-runtime-qa.js` consulta o preview por DNS interno e executa regressões com dados fictícios em outro PostgreSQL.
Ele recusa inicializar sem `MACKNA_QA_DISPOSABLE=1`, sem `MACKNA_PREVIEW=1`, com credenciais Discord ou se o banco de testes não for exatamente `postgres-qa.imortais-homologacao.internal`.
As suítes destrutivas passam por loopback até esse banco exclusivo, mantendo suas proteções localhost.
O schema public desse banco QA é recriado antes de cada grupo de testes. Nunca executar com o banco do preview ou de produção.

Variáveis do executor:

- `DATABASE_URL=${{postgres-qa.DATABASE_URL}}`
- `MACKNA_QA_DISPOSABLE=1`
- `MACKNA_PREVIEW=1`
- `GUILD_ID=guild-test`
- `NODE_ENV=test`
- `PGSSL=disable`
- `SESSION_SECRET`: valor exclusivo fictício do executor
- `MACKNA_PREVIEW_READONLY_URL=${{postgres.DATABASE_URL}}`
- `MACKNA_RESTORE_DATABASE=app_restore_20261016044841`

A conexão de validação do restore força `default_transaction_read_only=on` e `BEGIN READ ONLY`.
A aplicação preview não recebe as variáveis exclusivas do executor.
Após validar, os serviços `qa-runner` e `postgres-qa` são parados, preservando configurações e volume para retomada.

## Pendências delimitadas

1. Integração autenticada real via OAuth. A inspeção visual com sessões e APIs simuladas foi concluída conforme a continuação abaixo.
2. Integração com uma aplicação e uma guilda Discord de testes separadas: OAuth, intents, cargos, slash commands, canais, eventos e CTAs.
3. HTTPS público: Apache ocupa a porta 80. Não foi parado nem reconfigurado.
4. Aprovação específica antes de qualquer migração ou publicação de produção.

Railway, credenciais e guilda Discord de produção permaneceram intactos. Sem merge do PR.

## Continuação: navegador e preparação Discord, 16/10/2026

Código executável: `5db0a16e6979c6272eef14555fbf04e49f3c6f1e`.
Preview atualizado exclusivamente no MackNa; sem publicação de produção.

- 42 telas em 12 contextos: larguras 1440, 390 e 320 px; visitante, conta externa, membro e administrador fictícios.
- Navegação entre 11 módulos de administração, busca por nome no Guild Might e geração simulada de pareamento.
- Sem exceções JavaScript ou overflow horizontal da página nos cenários cobertos.
- Menu móvel oculto antes do login/para não membros.
- Ambas as cópias do menu Dispositivos respeitam permissão.
- Campos de pareamento empilhados em celular e tabela de dispositivos com rolagem própria.
- Falha do PostgreSQL mostra banco indisponível antes de diagnosticar Discord desconectado.
- Novo workflow de navegador preserva capturas e relatório JSON por 14 dias.
- Preview, Scout regression e navegador: SUCCESS no commit acima.
- A inicialização de um workflow anterior falhou por cota de download do espelho ECR antes dos testes. A branch passou a usar a mesma imagem PostgreSQL 16 do workflow de preview; as regressões passaram novamente.

[Capturas e execução de navegador](https://github.com/cocoputiz-sudo/imortais-cta-bot/actions/runs/38911874135).

As APIs e sessões nesses testes são simuladas. Não houve login Discord, envio de mensagem nem pareamento real. As capturas não substituem teste com aplicação/guilda Discord de homologação.

### Projeto Discord separado preparado

`imortais-discord-homologacao` contém definições de PostgreSQL 16 e bot, ambos parados e sem implantação executada.
Auto-deploy desligado, sem domínio e sem segredos Discord. A checagem de configuração bloqueia inicialização incompleta e IDs conhecidos de produção.
É uma checagem de configuração, não prova de propriedade do token ou dos canais.

[Roteiro e variáveis pendentes](mackna-discord-staging-setup.md).

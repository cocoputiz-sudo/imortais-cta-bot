# Discord IMORTAIS: próxima etapa isolada do PR #89

## Recursos preparados, sem execução

Projeto MackNa: `imortais-discord-homologacao`.

- `postgres`: modelo PostgreSQL 16, sem implantação executada.
- `bot-discord-staging`: branch do PR #89, sem implantação executada.
- Ambos parados, sem domínio público e sem deploy automático.
- Nenhum token, segredo OAuth, ID de aplicativo ou de guilda foi copiado da produção.
- O preview anterior permanece em outro projeto: `imortais-homologacao`.

O comando configurado é:

```sh
node scripts/mackna-discord-staging-preflight.cjs && npm start
```

A checagem é somente de configuração: não consulta nem envia mensagens ao Discord.
Ela rejeita o projeto errado, a guilda e o aplicativo conhecidos de produção, banco diferente do PostgreSQL exclusivo, segredo de sessão curto, IDs ausentes e OAuth apontando para Railway.
Ela **não comprova** que o token pertence ao aplicativo informado nem que canais e cargos pertencem à guilda de testes. Essas identidades devem ser verificadas por consultas de leitura antes da primeira implantação.

## Informações ainda necessárias

Use um aplicativo/bot NOVO e um servidor Discord separado. Se já existirem, forneça apenas seus IDs para identificação. Cadastre segredos diretamente nas variáveis do serviço no MackNa, sem prints ou envio no chat.

| Variável | Origem |
| --- | --- |
| `DISCORD_CLIENT_ID` | Aplicativo de testes |
| `DISCORD_TOKEN` | Token do bot de testes; cadastrar no MackNa |
| `DISCORD_CLIENT_SECRET` | Segredo OAuth do aplicativo de testes; cadastrar no MackNa |
| `GUILD_ID` | Servidor Discord de testes |
| `CTA_CHANNEL_ID` | Canal textual de CTAs de testes |
| `IMORTAL_ROLE_ID` | Cargo de membros de testes |
| `STAFF_LOG_CHANNEL_ID` | Canal de staff de testes |
| `PREP_VOICE_ID` | Canal de voz de preparação de testes |
| `CONTENT_PING_CHANNEL_ID` | Canal de conteúdo de testes |
| `RANKING_CHANNEL_ID` | Canal de ranking de testes |
| `ROAMING_CATEGORY_ID` | Categoria de canais de testes |
| `SESSION_SECRET` | Novo valor aleatório exclusivo, pelo menos 32 caracteres |
| `OAUTH_REDIRECT` | URL HTTPS da homologação, terminando em `/auth/callback` |

As variáveis de isolamento e a referência ao novo PostgreSQL já estão configuradas. O proxy HTTPS continua pendente; Apache não foi modificado.
Cargos adicionais de caller, oficiais, bomb e Mestre de Guerra devem ser mapeados para cargos de testes antes de exercitar essas funções. Revise também quaisquer IDs fixos relevantes à função testada.

## Roteiro após disponibilizar o aplicativo e a guilda de testes

1. Verificar por leitura a identidade do bot/aplicativo, sua participação somente no servidor de testes e a propriedade dos canais/cargos informados.
2. Confirmar intents privilegiadas exigidas pelo código, inclusive Server Members Intent, e permissões mínimas no servidor de testes.
3. Resolver acesso HTTPS e cadastrar exatamente a URL OAuth da homologação no aplicativo de testes.
4. Implantar o PostgreSQL novo e vazio; validar acesso e schemas.
5. Executar a checagem e implantar somente `bot-discord-staging`.
6. Exercitar login, comandos de CTA, caller com arma livre, transferência de caller, pings, voz e atualização de formação.
7. Testar solicitações de vínculo, recusa/revogação, baixa manual com justificativa e persistência.
8. Mensagens privadas somente para contas de testes que tenham autorizado expressamente o envio. A automação deve iniciar desligada.
9. Confirmar ausência de alterações no Railway, no banco e no Discord de produção; manter o PR sem merge até revisão.

Os testes de navegador existentes usam respostas simuladas. Eles validam a interface e não substituem esta integração real.

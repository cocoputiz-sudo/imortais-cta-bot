# MackNa Cloud v3.0 – homologação IMORTAIS no Debian 13 AMD64

## Estado
Branch de testes isolada, baseada na `main` atual da IMORTAIS. **Não fazer merge na main e não substituir o Railway sem revisão.** Alternativa AMD64 do piloto BTV11 do PR #84; não executar os scripts ARM64 daquele PR neste servidor.

## Garantias do preview
- A variável `MACKNA_PREVIEW=1` desativa o login do bot Discord e bloqueia o login OAuth do War Room.
- O modo só inicia sem `DISCORD_TOKEN` e sem `DISCORD_CLIENT_SECRET`, e exige PostgreSQL local ou no DNS interno `.internal`.
- Não utilize `DATABASE_URL` do Railway, dados reais ou tokens de produção.
- O health check `/api/health` devolve `{"ok":true,"mode":"preview","discord":false}` se o banco de testes estiver saudável.
- Sem a flag, o comportamento da `main` original é preservado.

## Implantação pelo painel do MackNa
1. Manter Railway operando normalmente.
2. No espaço principal, criar um projeto `imortais-homologacao`.
3. Adicionar **PostgreSQL 16** chamado `postgres` no mesmo projeto, com volume persistente (banco NOVO e vazio).
4. Adicionar serviço web **GitHub** apontando para `cocoputiz-sudo/imortais-cta-bot`, branch `test/mackna-cloud-amd64-preview-20261016`.
5. Para o serviço Node.js, usar build automático, comando `npm start`, porta interna `3000`, health check `/api/health`. Não usar o Dockerfile `mackna-btv/Dockerfile` do PR #84.
6. Adicionar SOMENTE estas variáveis ao serviço web:
   - `MACKNA_PREVIEW=1`
   - `NODE_ENV=production`
   - `PORT=3000`
   - `PGSSL=disable`
   - `DATABASE_URL=${{postgres.DATABASE_URL}}`
7. Confirmar que `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET` e quaisquer segredos ou URLs do Railway NÃO estão definidos.
8. Implantar inicialmente sem domínio público ou roteamento via proxy externo.
9. Confirmar em logs a mensagem `Preview isolado` e conferir `/api/health` com HTTP 200, banco ativo, Discord falso e `mode:preview`. Conferir logs, métricas, reinício, persistência e reimplantação.
10. Se alguma verificação falhar, coletar logs e interromper a homologação; não migrar dados de produção.

## Escopo
O modo preview valida o código da aplicação, inicialização de schemas PostgreSQL, processo Node, endpoints públicos, health, containerização, logs e monitoramento. **Não prova** o login Discord, permissões de staff, OAuth real do War Room nem o funcionamento das CTAs com jogadores. Validar essas integrações somente com aplicação e guilda Discord de testes separadas.

A ativação do MCP do MackNa no ChatGPT é uma etapa independente: só prosseguir com ferramentas administrativas após confirmar que o plugin aparece no chat e que a primeira consulta `server_status` funciona.

# Auditoria Photon Guild Might / Challenge — Season 34 (09/10/2026)

## Escopo da evidência

Captura local privada: `guild-probes-20261009-00(1).ndjson`, 1.824 linhas (699 requests e 698 responses de GetGuildMightCategoryContribution, 128/127 Overview, 86/86 Challenge). Somente fixtures mínimas de regressão são adicionadas ao repositório; **não enviar o dump privado completo** ao GitHub.

## Mapeamento das categorias

A resposta de `GetGuildMightCategoryOverview` fornece códigos, não nomes visuais. O líder da guilda confirmou no jogo as **14 correspondências** em 09/10/2026. As outras 11 foram inicialmente sugeridas por semântica técnica, contexto das atividades ou tradução do código, mas agora têm confirmação independente por inspeção visual da interface. Esta confirmação é do usuário, não uma string localizada enviada pelo Photon.

| Código | Nome apresentado | Evidência / confiança |
|---|---|---|
| CASTLE | Castelos e Postos Avançados | Semântica do identificador, confrontar no jogo; ainda não validado por nome na resposta |
| CORRUPTED | Masmorras Corrompidas | Semântica direta; ainda não validado por nome na resposta |
| DRAGON_AREA | Terras Ancestrais | **Confirmado pelo usuário no jogo**. Líder JnK1, 3.950.331.000 |
| DRAGON_HUNT | Caça aos Dragões | Semântica direta; ainda não validado por nome na resposta |
| ENERGYCRYSTAL | Cristais de Território | Inferência contextual; requer comparação visual |
| GATHERING | Coleta | Tradução direta |
| GVGSEASON | Magos Engarrafadores | **Confirmado pelo usuário no jogo**, apesar de nomenclatura técnica surpreendente. Líder N1Demon, 21.838.565 |
| HELLDUNGEON | As Profundezas | **Confirmado pelo usuário no jogo**. Líder Vendocorsa98, 2.106.831.265 |
| HELLGATE | Hellgates | Identidade textual direta |
| POWERCORE | Núcleos de Esconderijo | Inferência semântica de Power Core; requer conferência visual |
| PVE | PvE (Outlands e Roads) | Rótulo PvE direto; detalhe geográfico da UI |
| SMUGGLERS | Contrabandistas | Tradução direta |
| SPIDERS | Criaturas de Cristal | Inferência contextual envolvendo criaturas/aracnídeos; requer prova visual |
| TREASURES | Tesouros das Outlands | Tradução contextual; detalhe geográfico da UI |

**Todas as 14 correspondências foram confirmadas pelo usuário no jogo.** O protocolo, isoladamente, ainda não fornece o rótulo localizado.

## Overview: 127 respostas, inspeção campo a campo

Todas as 127 respostas usam exatamente as chaves `0,1,2,3,253,255`:
- `0`: objeto `kind:bytes`, 16 bytes em Base64, valor constante na captura. Provável identificador de guilda, não comprovado.
- `1`: inteiro longo, variável (127 valores distintos nas 127 respostas). Semântica não confirmada; **não** afirmar que seja temporada, nível ou SP.
- `2`: lista de 14 strings, a mesma ordem de códigos técnicos em todas as respostas.
- `3`: lista de 14 números inteiros, emparelhados por índice com `2`; totais acumulados de Might da guilda por categoria (101 conjuntos distintos).
- `253`: inteiro `450`, código Photon para GetGuildMightCategoryOverview.
- `255`: inteiro de correlação da solicitação, variável (119 valores distintos).

Nenhum campo confirmado de **nível Guild Challenge 62, nível por classe, meta de próximo nível ou Season Points** nessas 127 respostas. Não inferir níveis de inteiros desconhecidos, nem reutilizar números de screenshots em produção.

A última página de Challenge (offset 478 de 483, cinco jogadores) traz `6` como 5 bytes zerados em Base64 em vez de array de inteiros: o parser trata somente essa forma inequívoca, sem supor que outros binários codifiquem pontuações.

## Outras operações do protocolo que ainda não estão no diagnóstico destas três operações

- Guilda / classificação: `GetGvgSeasonRankings`, `GetGvgSeasonRank`, `GetGvgSeasonHistoryRankings`, `GetGvgSeasonGuildMemberHistory`, `QueryGuildPlayerStats`, `GuildGetOptionalStats`.
- Contribuição por temporada/atividade: `GetGvgSeasonContributionByActivity`, `GetGvgSeasonContributionByCrystalLeague`, `GetTerritorySeasonPoints`, `GetCrystalLeagueDailySeasonPoints`.
- Progresso pessoal / Might / recompensas: `GetPersonalMightStats`, `GetPersonalSeasonTrackerData`, `GetPersonalSeasonPastRewardData`, `GetPvpChallengeData`, `GetPvpChallengeSeasonRewards`, `GetPvpChallengeSeasonRewardItems`, `DailyMightBonus`.
- Guild Challenge: apenas `GetGuildChallengePoints` foi observado no diagnóstico local até agora; não prova nível 62.

**Primeiro candidato para investigar SP:** `GetGvgSeasonContributionByActivity`, seguido de `GetGvgSeasonRankings`. Para nível da guilda e metas, testar também as operações de classificação e estatísticas quando abertas nas telas correspondentes. Trata-se de hipótese, não confirmação.

## Cobertura e frescor

Critério: último timestamp por jogador e janela de duas horas relativa à última resposta **daquela operação/categoria**. Pontuação mais recente prevalece, não o offset de página. Recalcular o rank de jogadores recentes; não misturar jogadores capturados somente no histórico. Mostrar timestamp da observação individual. Histórico pode utilizar janela separada de 24h na consulta SQL.

Segundo dump: Challenge **473/483 recente**, **483/483 histórico**, dez apenas históricos; todas as 14 categorias Might completas na janela de duas horas. Esses números dependem da referência temporal do arquivo e não são alegações de disponibilidade permanente em tempo real.

## Plano de homologação ponta a ponta sem publicar

1. Criar Railway de homologação separado + PostgreSQL temporário; implantar branch do PR #66 **somente** ali, sem alterar ambiente/feed de produção.
2. Gerar credencial temporária vinculada a um dispositivo de teste e uma allowlist; testar explicitamente 401 com token ausente, inválido, revogado e DeviceId divergente.
3. Em build experimental do PR #34, adicionar opção explícita de **enviar somente para a URL de homologação**; a versão atual mantém dumps locais e bloqueia upload de Challenge, logo não se deve afirmar que já existe envio funcional.
4. Capturar requests/responses reais, enviar lote assinado/autenticado ao homolog e verificar resposta HTTP, persistência e rastreio de correlationId; não armazenar segredos nos dumps.
5. Repetir evento/id e pacote igual em dispositivos distintos; verificar índices idempotentes, cobertura, horários, stale, páginas e ranking por nome.
6. Abrir o painel homolog e confrontar 14 cards + Challenge com dumps/prints; exportar HTML/CSV e validar status/horários de cada jogador; nunca inferir níveis/SP.
7. Desligar envio experimental, revogar credenciais, encerrar homolog; **pedir aprovação expressa para merge, deploy e release**.

Este documento é uma auditoria do estado do PR, não uma autorização de publicação.

## Campo 1 do Overview: hipótese de timestamp

Os 127 inteiros podem ser interpretados como ticks de 100 nanossegundos desde 01/01/0001 UTC (formato associado ao .NET). Ao converter os 127 registros, a data resultante fica **36,14–41,74 segundos anterior** a `capturedAtUtc` (mediana: **39,65 segundos antes**). Isso é forte evidência de um relógio/marcador temporal, mas não prova que seja o instante exato da resposta. Usar `capturedAtUtc` para exibir hora de coleta; preservar o valor bruto `1` no registro de telemetria.

## Execução Fase A em Railway

Ambiente de homologação `imortais-might-homolog-20261009` / `homologacao`, com PostgreSQL e credenciais isoladas, executando o código do PR #66 em um entrypoint **sem Discord**. Replay do segundo dump via `POST /api/telemetry/ingest`: **1.824 eventos**, usando device de homologação e credencial separada. Teste: token inválido recebeu HTTP 401; 100 eventos na primeira remessa resultaram em 100 inserções; repetição dos mesmos 100 resultou em zero inserções e 100 duplicados. Materialização: 698 respostas de Might geraram 660 snapshots de Might distintos, 86 respostas de Challenge geraram 86 snapshots/páginas. API do site verificou 14 categorias de Might e 473/483 jogadores recentes de Challenge, 483/483 no histórico e 10 apenas históricos.

A rotina temporária de replay já foi excluída do Railway; o ambiente de leitura deve ser mantido até a aprovação do usuário e a futura Fase B. Ao fim dos testes autorizados, excluir aplicativo/banco temporários e credenciais, sem tocar na produção.

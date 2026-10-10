# IMORTAIS — plano de reparo de snapshots legados (Guild Might)

**Status:** procedimento proposto. **Não autorizado em produção.** A Etapa 1 e o merge do PR #66 permanecem bloqueados.

## Objetivo
Os snapshots do parser antigo podem estar `members_complete=true` sem `layout.code`, e não devem contar como categoria oficial até uma reconstrução verificável. Nenhum registro deve ser apagado para corrigir nomes de categoria.

## Responsabilidades
- **Autorizador:** responsável pela guilda e por produção (BadMack), após revisar o relatório integral do plano, a simulação em homologação e o backup restaurado.
- **Operador:** mantenedor com acesso legítimo ao PostgreSQL de produção, executando a rotina sob aprovação explícita para os IDs de snapshots aprovados.
- **Revisor:** confirma totais/14 categorias e audit log; operador não decide os códigos ou aprova alterações por conta própria.

## Fase A: relatório somente leitura
1. Congelar a revisão do commit do PR, confirmar GUILD_SEASON_START_AT e GUILD_RANKING_ALLOWED_DEVICE_IDS. Sem a allowlist, todos os dispositivos são negados.
2. Conferir backup consistente e **restauração verificada em banco isolado**. Fazer novo backup antes da operação.
3. Executar `planLegacyRepair(pool,{limit:...})` em modo somente leitura sobre uma conexão explicitamente autenticada no PostgreSQL de produção. Não inicializar schemas, não chamar `applyLegacyRepair`. Preferir transação `READ ONLY` ou usuário de leitura.
4. Exportar para arquivo privado um manifesto **integral**, sem tokens ou dados pessoais desnecessários: snapshotId, responseEventId, deviceId, categoria antiga, código Photon proposto, quantidade de jogadores, motivo de quarentena e condições de elegibilidade. Relatório com data UTC, SHA do código e hash SHA-256.
5. Mostrar ao responsável o manifesto **ANTES** da execução, junto das contagens: analisados, elegíveis, quarantinados por motivo, códigos distintos, impacto estimado em registros e duplicidade esperada (deve ser zero). O endpoint `/api/homolog/legacy-plan` é apenas da homologação; **não existe rota pública de aplicação em produção**.

## Fase B: simulação e autorização
1. Restaurar um clone do banco em isolamento, aplicar SOMENTE os registros elegíveis e validar idempotência (duas execuções, sem duplicação), tabelas de membros, vínculos `response_event_id`, integridade dos 14 códigos, Might por jogador e logs de auditoria.
2. Gerar relatório de diferenças antes/depois, com avisos de conflitos. Manter quaisquer linhas ambíguas em quarentena, sem atualização.
3. Solicitar aprovação expressa do responsável citando **SHA-256 do plano, IDs aprovados, SHA do commit, janela e plano de rollback**. Sem aprovação expressa, encerrar em modo leitura.

## Fase C: aplicação futura, expressamente autorizada
1. O operador valida que o plano recalculado corresponde exatamente ao manifesto aprovado. Se mudou, parar e pedir nova autorização.
2. Chamar a rotina de reparo apenas na seleção aprovada. Cada registro exige transação dedicada, `SELECT ... FOR UPDATE`, cópia de snapshot e membros para `guild_might_reprocess_audit`, reconstrução da categoria verificada, conservação do identificador original de evento e regravação de membros/ranks. Abortá-la em qualquer inconsistência.
3. Sem `DELETE` de snapshots e sem `TRUNCATE` no banco de produção. A regravação transacional de **membros do snapshot aprovado** não deve eliminar outros snapshots.
4. Conferir saída: reparados, ignorados, falhos, quarantinados, 14 categorias e variação do ranking. Relatório privado entregue para revisão; remover acesso temporário de operação.

## Retorno e recuperação
Uma falha no código da aplicação permite rollback do deployment, mas **rollback de deploy NÃO reverte alterações do PostgreSQL**. Para reparo do banco, usar o histórico `guild_might_reprocess_audit` e a restauração validada, em procedimento separado, autorizado e com análise das gravações posteriores para não perder novos dados.

**Importante:** a função `applyLegacyRepair` existente é interna e protegida por `allowApply=false`; antes da aplicação real, exige revisão do manifesto integral, seleção de IDs, comparação do hash e testes de restauração. O procedimento deste documento **não concede autorização de execução**.

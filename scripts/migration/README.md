# Preparação da migração IMORTAIS para Debian

Esta etapa prepara recursos e coleta diagnóstico. Não inicia o bot real,
não altera o Railway/Discord e não copia dados automaticamente.

## Estado conferido em 17/10/2026

- Produção: commit `42877561d6b655f2bd0c35f3ee5b6e65458bc283`, deployment
  `00c04fee-75be-4d29-a59e-e8bd451a7c87`, PostgreSQL **18**.
- Guilda real `683411304408416285`; app Discord `1541617852056862801`.
- URL atual `https://cta-imortais.up.railway.app`; callback `/auth/callback`.
- Projeto Debian reservado `imortais-producao` (`p7a1de62d78`), separado das duas
  homologações. Serviço novo permanece sem token e com comando de espera.
- Homologação validou backup Drive, restauração e reinicialização. Essa rotina
  está limitada à instância/guilda PG16 de testes; **ainda não protege produção**.
- MackNa instalado usa template PostgreSQL16. Não criar destino com esse template
  para receber a produção18 e não reaproveitar volume dos bancos de homologação.
  O destino18 com volume persistente precisa ser provisionado e validado antes
  de qualquer cópia. O instalador de destino descrito abaixo cria um container18
  separado e o registra no PostgreSQL Manager, sem alterar os templates instalados.

## Próxima ação no terminal Debian

```bash
git clone --depth 1 --branch prep/debian-production-migration-20261017 https://github.com/cocoputiz-sudo/imortais-cta-bot.git ~/imortais-migracao-20261017
sudo apt-get update
sudo apt-get install -y postgresql-client-18
sudo python3 ~/imortais-migracao-20261017/scripts/migration/inspect_railway.py
```

No Railway, serviço Postgres da produção, Variables, copiar `DATABASE_PUBLIC_URL`.
Colar apenas no prompt oculto do script, no terminal SSH interativo. Não passar
URL por argumento, histórico do shell, chat ou arquivo do repositório. A conexão
OAuth do plugin Railway não retorna os valores das variáveis.

O diagnóstico faz uma transação REPEATABLE READ READ ONLY, exige TLS e confere
PostgreSQL18 e guilda real. Não executa DDL/DML, pg_dump, restauração, alterações
de usuários, deploy ou Discord. Grava credencial root0600 em
`/etc/imortais-migration/railway-source.json`; relatório sem senha em
`/var/lib/imortais-migration/source-inventory.json`. Em repetição usa a configuração
local; `--refresh-source` solicita outra URL. Tabelas de telemetria usam estimativas,
não contagens completas. A contagem de CTAs é exata. TLS `require` cifra a conexão;
validação do certificado/hostname exige `verify-full` e CA correspondente.

## Preparar o destino PostgreSQL18 vazio

Após o diagnóstico da origem ter concluído com sucesso, no Debian:

```bash
cd ~/imortais-migracao-20261017
git pull --ff-only
sudo python3 scripts/migration/prepare_pg18.py --apply
```

Sem `--apply`, apenas confere capacidade. Exige disco livre de pelo menos quatro
vezes o tamanho da origem mais5GiB, com piso15% do filesystem Docker, e2GiB de
memória disponível. Essa margem é uma condição inicial, não uma garantia sobre
o crescimento futuro. O comando imprime os valores antes de criar recursos.

Cria somente `imortais-prod-pg18`, imagem oficial `postgres:18.6-bookworm` resolvida
para um ID local e preservada, limite1GiB, volume próprio
`imortais-prod-pg18-data` montado em `/var/lib/postgresql`, PGDATA18/docker,
restart `unless-stopped`. Publica apenas `127.0.0.1:55436`, sem domínio ou porta
do modem. O alias privado é `postgres18.imortais-producao.internal`, na rede do
projeto reservado. Nunca monta um volume de homologação.

As novas credenciais aleatórias ficam root0600 em
`/etc/imortais-migration/target18.json`; a aplicação usa `imortais_app` sem
superusuário. `mackna_reader` só recebe leitura e `mackna_admin` administra o
destino. A instância `postgres-imortais-producao` aparece na **aba PostgreSQL**
do MackNa. Este container é administrado pelo terminal Docker, não pelo ciclo
de deploy dos serviços Cloud: não aparece como serviço Postgres no cartão do
projeto. O serviço `bot-imortais` continua parado e sem credenciais.

O instalador não lê a credencial da origem nem acessa o Railway. Pode repetir:
preserva container, volume, senhas e dados existentes que pertençam à preparação;
recusa recursos com identidade, imagem, porta ou montagem divergentes. Nunca
apaga recursos. Em falha parcial, preserva os recursos para diagnóstico.
Sucesso imprime `DESTINO_PG18_OK`. Após a primeira execução espera-se0 tabelas.
Essa etapa não copia o banco, não habilita backups de produção e não inicia bot.

## Cópia de ensaio e restauração separada

Após autorização para o ensaio com o banco real, no terminal Debian:

```bash
cd ~/imortais-migracao-20261017
git pull --ff-only
sudo python3 scripts/migration/rehearse.py
```

Usa as configurações root0600 já gravadas, não pede novamente as credenciais.
Na origem abre uma transação REPEATABLE READ READ ONLY, exporta o snapshot e
mantém essa sessão até o pg_dump18 com `--snapshot` terminar. A lista de tabelas,
contagens e conferência de conteúdo usam o **mesmo snapshot** da cópia: novas
escritas do bot no Railway continuam normalmente e ficam fora desse ensaio.
As consultas de conferência leem todas as linhas e consomem CPU/I/O na origem;
há limites de tempo e de espera por locks. Não há DDL/DML de origem nem segunda
instância do bot/Discord. Este snapshot é para ensaio, não para trocar produção
depois que novas escritas ocorrerem no Railway.

pg_dump em formato custom é encaminhado diretamente ao age. A cópia cifrada e
manifesto ficam root-only em `/var/lib/imortais-migration/rehearsals/<nome>/`.
A chave é a mesma já guardada fora do servidor para os backups; o script confere
que ela corresponde ao recipient instalado. SHA-256 e autenticação age são
verificados antes de restaurar. O dump descriptografado existe só no diretório
temporário root-only e é removido ao sair; a cópia cifrada é preservada.

Cria somente um banco novo `imortais_rehearsal_<data>_<aleatorio>` no PG18 local,
com locale/encoding da origem e CONNECT público revogado. Não recebe nome de banco
por argumento, não usa --clean/--create e nunca restaura em `app`. A restauração
usa mackna_admin, sem owner/ACL da origem; é ensaio de dados e não uma validação
final do runtime, permissões funcionais ou aplicação. Não inicia o bot.

Confere lista de tabelas, contagens e duas somas dos hashes MD5 das linhas,
independentes da ordem, contra o snapshot; detecta diferenças acidentais sem
materializar todas as linhas em memória. Essa conferência de conteúdo não é
uma assinatura criptográfica. O arquivo tem SHA-256 e autenticação age.
Também confere guilda, CTAs, extensões, large objects (inclusive páginas) e
metadados das sequências. Para sequências ligadas a colunas, confere que não
ficaram atrás dos IDs restaurados; o valor da sequência pode avançar na origem
durante o pg_dump, pois sequências não seguem o snapshot MVCC das linhas.

Sucesso imprime `ENSAIO_RESTAURACAO_OK` e grava `report.json`. Falhas preservam
o banco de ensaio já criado e artefatos concluídos, sem excluir dados. Logs do
pg_restore são locais root-only. Esta etapa mantém o banco real/bot no Railway,
o banco `app` do destino e a homologação. **Não envia ao Drive e não habilita
o backup automático de produção.** O envio externo e a restauração dessa cópia
externa continuam sendo requisitos antes da troca definitiva.

CI usa dois PostgreSQL18 descartáveis e clientes18 reais: escreve na origem após
fixar o snapshot para demonstrar consistência, testa dados UTF8/NULL/numéricos,
sequências vazias/avançadas, large objects, criptografia, recusa de corrupção e
diferença de conteúdo com a mesma contagem de linhas. Não usa credenciais reais.

## Ordem antes da troca

1. Conferir relatório, tamanho, extensões e CTAs não encerradas; escolher uma janela
   sem CTA em andamento. Reconfirmar commit/deployment imediatamente antes da troca.
2. Provisionar PostgreSQL18 dedicado no projeto reservado, com volume próprio,
   acesso privado, limite de memória e clientes18. Não atualizar PG16 em seu volume.
3. Transferir as variáveis reais diretamente ao Debian/MackNa. Preservar
   `SESSION_SECRET`, `TELEMETRY_INGEST_KEY`, token Discord e configurações de canais,
   cargos e temporada. Ajustar DATABASE_URL apenas para o destino18. Não substituir
   valores ocultos/sealed por novos. A identidade de teste nunca entra em produção.
4. Fazer cópia de ensaio somente após autorização para copiar o banco real;
   restaurar em banco novo18 e validar tabelas, dados, sequências, extensões,
   dispositivos, períodos e encerramentos. Não iniciar o bot usando esse ensaio.
5. Adaptar backup pós-CTA para configuração/fila/prefixo de **produção** separados
   e cliente18. Validar upload e restauração do banco18 antes da troca. O instalador
   de homologação do PR91 não deve ser apontado ao banco real.
6. Preparar HTTPS do destino `imortais.macknacloud.com.br`. Validar bridge com esse
   destino, callback/login Discord, cookies, POST de telemetria autenticado, SSE,
   limites por IP e desconexão. Testes locais do bridge não comprovam esse trajeto.
7. Registrar autorização da troca. Interromper o bot Railway e bloquear entradas
   com 503/Retry-After, aguardar conexões em andamento e congelar todos os escritores.
   Confirmar ausência de escrita antes do dump final consistente. Nunca executar
   duas instâncias ativas com o token real.
8. Copiar dump final para banco NOVO18 e conferir dados da cópia final. Guardar o
   dump cifrado fora do servidor. Só então configurar e iniciar um único bot Debian.
9. Trocar o serviço Railway para o bridge e só habilitar `IMORTAIS_BRIDGE_MODE=forward`
   após health do destino confirmar DB e Discord; verificar callbacks e Combat Client.
   Monitorar, guardar origem e artefatos; não apagar Railway na mesma janela.

## Continuidade do endereço e retorno

O hostname `*.up.railway.app` pertence ao Railway e não pode ser movido por DNS
próprio. O candidato a bridge em `railway-bridge/` permite preservar esse endereço
como entrada HTTP enquanto bot e banco rodam no Debian. O Railway continuará
necessário para essa entrada enquanto clientes usarem a URL antiga.

O bridge não importa código do bot e não acessa banco/Discord. Por padrão retorna
503 e só encaminha quando configurado explicitamente. Destino é fixo e validado;
TLS verifica certificado, corpo/SSE usam streams, credenciais/cookies e query são
encaminhados sem log. Falha do destino resulta em 502/Retry-After, nunca em sucesso
fictício para ingestão. WebSocket upgrade não é suportado; a War Room usa SSE.
`/health` do serviço em espera só informa `migration-hold`, não prontidão do bot.

Antes de qualquer nova escrita no Debian, o retorno pode reativar o deployment
original com o banco original. **Depois de novas escritas no Debian, não basta
religar o banco antigo:** parar os escritores do Debian, copiar o estado atual
para banco18 separado no Railway, conferir e apontar o único bot ativo a esse
banco. Reativar o banco antigo perderia os dados gravados após a troca. O retorno
com cópia inversa precisa ser ensaiado antes de chamar a migração de pronta.

## Validação desta preparação

```bash
python3 -m unittest discover -s scripts/migration -p 'test_*.py' -v
node scripts/migration/test_bridge.cjs
```

Testes cobrem recusa de destino/TLS/versão/guilda incorretos e proxy HTTP real local
com POST, autenticação, cookies, query e SSE; modo de espera, erro do destino e
caminhos que tentem trocar o host. CI também constrói a imagem do bridge.
Não há teste com credenciais reais ou conexão ao banco de produção nesta CI.

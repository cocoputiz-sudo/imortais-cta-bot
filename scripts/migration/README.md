# Preparação da migração IMORTAIS para Debian

Estas rotinas preparam recursos, copiam/restauram dados em bancos isolados e
instalam backups host-side quando executadas pelo proprietário. Não iniciam o
bot real nem fazem a troca do Railway/Discord.

## Estado conferido em 17/10/2026

- Produção: commit `42877561d6b655f2bd0c35f3ee5b6e65458bc283`, deployment
  `00c04fee-75be-4d29-a59e-e8bd451a7c87`, PostgreSQL **18**.
- Guilda real `683411304408416285`; app Discord `1541617852056862801`.
- URL atual `https://cta-imortais.up.railway.app`; callback `/auth/callback`.
- Projeto Debian reservado `imortais-producao` (`p7a1de62d78`), separado das duas
  homologações. Serviço novo permanece sem token e com comando de espera.
- Homologação validou backup Drive, restauração e reinicialização. Sua rotina
  continua limitada à instância/guilda PG16 de testes. O backup de produção18
  usa conta/configuração/fila próprias, já instaladas no Debian com envio inicial
  conferido em17/10/2026. A recuperação manual de produção pelo Drive real foi
  validada com54tabelas/187CTAs/32sequências. Primeiro disparo pós-CTA real ainda
  precisa ser observado, sem forçar encerramentos na aplicação.
- Serviço de espera publicado em `imortais.macknacloud.com.br`, sem credenciais.
  DNS público confirmou179.174.166.157; TLS local com SNI/certificado validado
  retornou HTTP/2 200 em17/10/2026 às18:54BRT. Isso não valida ainda login,
  telemetria, SSE ou acesso pela entrada pública Railway.
- MackNa instalado usa template PostgreSQL16. Não criar destino com esse template
  para receber a produção18 e não reaproveitar volume dos bancos de homologação.
  O destino18 com volume persistente precisa ser provisionado e validado antes
  de qualquer cópia. O instalador de destino descrito abaixo cria um container18
  separado e o registra no PostgreSQL Manager, sem alterar os templates instalados.
- Captura real das variáveis concluída no Debian em17/10/2026 às19:20BRT:
  `VARIAVEIS_PRODUCAO_PREPARADAS`, sessão/telemetria preservadas, arquivos root0600,
  `applied_to_mackna=false`, `bot_started=false`. Valores não foram publicados.

## Ensaio da camada de banco com o usuário do bot e Node22

Depois da captura das variáveis, executar no Debian:

```bash
cd ~/imortais-migracao-20261017
git pull --ff-only
sudo python3 scripts/migration/runtime_rehearsal.py --rehearsal imortais_rehearsal_20261017202749_a1f6e1
```

Usa somente o dump local cifrado do ensaio aprovado, com SHA-256/tamanho e age
conferidos. Não acessa a origem Railway nem inicia o bot. Cria outro banco com
nome aleatório `imortais_rehearsal_*`, propriedade de `imortais_app`, e restaura
como esse usuário sem superpoderes, usando `--no-owner --no-acl` em transação.
Compara fingerprints e sequências antes da inicialização. O `app` reservado
continua intacto, conferido por fingerprints antes/depois.

Constrói uma imagem separada `node:22-bookworm-slim`, registrando commit e image ID.
O contexto contém somente package.json/lock, src e o probe; exige esses arquivos
sem mudanças locais. Nenhuma variável real, arquivo .env, token ou chave OAuth
entra no build/probe. O container não publica portas nem monta diretórios do host;
roda como usuário node, filesystem somente leitura, sem capabilities, sem novos
privilégios e limite512MiB. Somente a credencial do banco de ensaio entra pelo stdin.
Não faz deploy/reconfigura serviço MackNa nem troca a imagem do serviço em espera.

O probe importa somente `src/db.js`, bloqueia import de Discord/index/web e roda
`db.init()` duas vezes no clone. Confere ownership/privilégios de tabelas e
sequências, testa DDL e INSERT/UPDATE/DELETE na tabela CTA dentro de transação
desfeita. A sequência do clone pode avançar, pois nextval não é transacional.
Não agenda tarefas, autentica no Discord ou envia mensagens. A inicialização
real pode normalizar dados apenas no clone; fingerprints são comparados antes
dela. Isso valida a camada de banco, não login/OAuth/web/telemetria/SSE completos.

Sucesso: `RUNTIME_BANCO_OK`. Evidências root0600 em
`/var/lib/imortais-migration/runtime-rehearsals/<execução>/report.json`, build.log,
restore.stderr e probe.stderr. O container temporário é removido; banco de ensaio
e imagem permanecem para revisão. Em falha não apaga bancos ou arquivos aprovados.
Uma repetição cria outro banco, sem reutilizar/apagar os anteriores. Execução
real concluída no Debian em17/10/2026 às19:34BRT: RUNTIME_BANCO_OK, Node22.23.3,
54tabelas/32sequências/187CTAs, nenhuma permissão negada ou owner externo.
Banco imortais_rehearsal_20261017223329_17b76c, owner imortais_app confirmado
também por MCP. App permaneceu com0tabelas, serviço ainda held.cjs/vars=[].

## Ensaio HTTP, telemetria e SSE com login simulado

```bash
cd ~/imortais-migracao-20261017
git pull --ff-only
sudo python3 scripts/migration/runtime_rehearsal.py --rehearsal imortais_rehearsal_20261017202749_a1f6e1 --web
```

Repete a restauração como app em OUTRO banco de ensaio e o teste de inicialização;
depois executa os handlers HTTP reais do War Room/telemetria, por um bridge HTTP
local descartável dentro do container. O contexto da imagem agora inclui também
assets e o código do bridge, sem nenhuma credencial real. Não publica porta,
domínio, callback ou rota, e não altera os serviços MackNa/Railway/Discord.

Confere página/logo, health honesto503 com database=true e discord=false,
autorização401/403, fluxo OAuth com provedor SIMULADO, state de uso único, HMAC e
atributos do cookie, pareamento de uso único e limitação de tentativas. Uma
credencial de agente criada apenas no clone envia heartbeat; verifica persistência
e deduplicação. Roster e telemetria percorrem SSE pelo bridge real, incluindo o
heartbeat de25s. Os testes usam identidade, session secret e chave de ingestão
sintéticos. Não enviam código/token para Discord ou qualquer API externa.
O módulo discord.js e o entrypoint do bot são bloqueados. O worker de materialização
do Guild Might pode trabalhar apenas no clone após telemetry.initSchema.

Dados sintéticos ficam exclusivamente nesse clone para revisão, junto às cópias
dos dados restaurados; não apaga/reinicializa tabelas copiadas. Sucesso final:
`WEB_ENSAIO_OK`. Relatório root0600 `web-report.json` e log `web-probe.stderr` no
mesmo diretório de evidências impresso pelo comando. O `RUNTIME_BANCO_OK` anterior
confirma só a parte DB; aguarde também `WEB_ENSAIO_OK` nesta execução.

**Limites:** provedor OAuth live, comportamento do cookie no navegador, cadeia
HTTPS pública Railway/Caddy e IP real por cliente ainda NÃO são validados. O bridge
local usa socket127.0.0.1 e substitui X-Forwarded-For, então o teste de limite local
não comprova separação de clientes reais atrás dos proxies. O endereço Railway
continua inalterado e não há autorização de troca implícita. `cutover_allowed=false`.
Execução real desta nova etapa HTTP no Debian ainda pendente.

### Recuperar índice Git criado por versão anterior do ensaio

A versão inicial consultava git status com sudo e umask077; a atualização
opcional do índice podia deixá-lo root0600 e impedir o git pull do proprietário.
A rotina agora usa `git --no-optional-locks`, sem atualizar o índice. A CI confere
conteúdo, dono, grupo e modo de .git/index antes/depois do build sob sudo/umask077.
Se o proprietário receber `index file open failed: Permissão negada`, executar no
seu terminal SSH normal, somente para o checkout desta preparação:

```bash
cd ~/imortais-migracao-20261017 &&
sudo chown -R "$(id -u):$(id -g)" .git &&
git pull --ff-only
```

Isso devolve os metadados Git ao proprietário conectado; não muda configurações
ou credenciais protegidas fora do checkout, bancos, containers ou produção.

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

## Cópia externa e recuperação a partir do Drive

Depois de `ENSAIO_RESTAURACAO_OK`, executar no Debian, informando o nome exato
do banco de ensaio que consta no relatório:

```bash
cd ~/imortais-migracao-20261017 &&
git pull --ff-only &&
sudo python3 scripts/migration/drive_recovery.py --rehearsal imortais_rehearsal_20261017202749_a1f6e1
```

`drive_recovery.py` não acessa a origem Railway nem faz um dump novo. Exige
manifesto/relatório aprovados do ensaio, checksum local intacto e o mesmo
destino18 reservado e chave de recuperação. Reutiliza a autorização existente
do Drive através de cópia temporária root0600 do rclone.conf, sem disputar a
atualização de tokens no arquivo do worker de homologação.

Envia somente o dump cifrado e manifesto para a pasta privada
`IMORTAIS-CTA-BOT-BACKUPS`, prefixo
`producao/ensaios/<nome-do-ensaio>/`. Usa `copyto --immutable --checksum` e
confere MD5 informado pelo Drive. Não apaga nem sincroniza diretórios.

Baixa manifesto e dump em arquivos novos, confere o SHA-256 do manifesto
contra o manifesto local aprovado, e tamanho/SHA-256 do dump baixado. Autentica
age antes de criar banco. Restaura somente essa cópia baixada em outro banco
novo `imortais_rehearsal_<data>_<aleatorio>`; nunca usa o dump original como
fallback. Confere todos os fingerprints, locale/encoding, CTAs, guilda,
extensões, sequências e large objects. O dump em claro é temporário e removido
mesmo em falha; cópias cifradas e bancos concluídos são preservados.

Sucesso imprime `DRIVE_PRODUCAO_RESTAURACAO_OK` após enviar/conferir também um
relatório JSON com nome único no Drive. Evidências locais ficam em
`/var/lib/imortais-migration/drive-recovery/<data>_<aleatorio>/` e uma cópia do
relatório no diretório do ensaio original. Nova execução reutiliza os mesmos
arquivos remotos imutáveis e cria outro banco/relatório; não repetir sem motivo.

Esta é uma cópia manual do snapshot do ensaio, não o backup automático após
cada CTA de produção, nem o snapshot final da migração. O bot novo continua
parado e o banco `app` não é alterado. O worker pós-CTA de produção continua
pendente e precisa usar configuração/fila próprias com cliente18.

CI testa rclone real com um alias de armazenamento local descartável, age e
PostgreSQL18 reais. Valida upload/checksum/download independente/restauração,
inclusive large objects, e recusa download corrompido antes de criar banco.
Não usa Google Drive real ou credenciais do usuário; a confirmação de acesso
Google e recuperação externa depende desta execução no Debian.

## Backup automático de produção, ainda com a origem Railway

Depois da recuperação real pelo Drive aprovada, instalar no Debian:

```bash
cd ~/imortais-migracao-20261017 &&
git pull --ff-only &&
sudo python3 scripts/migration/install_production_backup.py
```

O instalador reutiliza a conexão salva em
`/etc/imortais-migration/railway-source.json`, a autorização Google já validada
e a chave de recuperação existente. Não pede novo token nem gera outra chave.
Exige relatório de recuperação aprovada pelo Drive, verifica dependências18,
conexão de leitura/TLS e autorização antes de instalar. Não cria roles nem faz
escritas no PostgreSQL Railway; usa a credencial já fornecida com a sessão
configurada como somente leitura. Não configura ou inicia o bot.

Instala somente estes recursos de produção:

- Conta `imortais-prod-backup`, sem login, worker em
  `/opt/imortais-cta-backup-producao/production_backup.py`.
- Configuração root:grupo0640 em `/etc/imortais-cta-backup-producao/config.json`.
- Estado/fila SQLite e cópia própria da autorização OAuth, protegidos em
  `/var/lib/imortais-cta-backup-producao/`.
- Serviço/timer `imortais-cta-backup-producao`, execução a cada minuto,
  persistente após reboot. O timer só é habilitado depois da cópia inicial
  enviada e conferida. Sucesso: `BACKUP_PRODUCAO_INSTALADO`.
- Drive: `IMORTAIS-CTA-BOT-BACKUPS/producao/automatico/AAAA/MM/DD/`.

A cópia inicial inclui o banco completo. A fila passa a observar as CTAs
encerradas/canceladas depois de sua ativação; o histórico anterior não gera
centenas de cópias repetidas. Cada CTA detectada gera um dump completo18
criptografado diretamente pelo age, com espera mínima de120s após `closed_at`
e verificação por minuto, normalmente dois a três minutos mais o tempo de
transferência. Não usa evento Discord, webhook ou escrita na aplicação.

Fila SQLite durável, chave única por CTA e lock de execução evitam duplicação.
Falhas de upload preservam o mesmo dump/manifesto para nova tentativa com
backoff de60s a1h. Um arquivo é marcado enviado somente após dump e manifesto
conferidos no Drive por checksum. Reinstalação preserva fila, baseline, chave
e autorização; aceita rotação de senha, mas recusa troca silenciosa de origem,
guilda, pasta ou destinatário. `--refresh-oauth` atualiza somente a cópia da
autorização de produção quando isso for necessário.

Se o Debian ficar desligado, ao voltar a fila procura também as CTAs encerradas
durante a parada. As cópias representam o estado disponível quando o dump é
feito; não recriam um snapshot histórico do instante em que o servidor estava
desligado. Cópias concluídas não são apagadas automaticamente. Falta de espaço
adia a criação de novos dumps preservando os já existentes.

```bash
sudo -u imortais-prod-backup python3 /opt/imortais-cta-backup-producao/production_backup.py --status
sudo systemctl status imortais-cta-backup-producao.timer --no-pager
sudo journalctl -u imortais-cta-backup-producao.service -n20 --no-pager
```

Esta versão segue a origem Railway allowlisted com TLS e cliente18. A mudança
da origem do backup para o Debian deve ser feita junto ao plano de migração;
não apontar a configuração ao banco vazio `app` ou a um ensaio. Antes da janela,
parar somente este timer/serviço, preservar fila e configurar a continuidade
para o destino real validado. O backup da homologação permanece independente.

Testes cobrem espera, closed/cancelled, retorno após reinício, indisponibilidade
e upload parcial, reuso exato do snapshot, corrupção e recusa de mudança de
identidade. CI usa PG18/age/rclone reais com armazenamento local descartável;
restaura uma cópia baixada novamente, verifica os dados anteriores a alterações
na origem e large objects, preserva app e verifica as units com
`systemd-analyze verify`. Não usa produção ou credenciais Google reais.

## Capturar variáveis reais, sem aplicá-las ao serviço

No terminal SSH, executar primeiro:

```bash
cd ~/imortais-migracao-20261017 &&
git pull --ff-only &&
sudo python3 scripts/migration/prepare_production_env.py
```

Quando o prompt oculto estiver esperando, abrir o serviço `imortais-cta-bot`
do projeto Railway85680aee-6959-4cec-bf50-f7b9a33c359d, ambiente production
c73b0773-673e-4566-8aaa-4af3c50ec013, aba Variables, RAW Editor. Copiar o bloco
completo e colar diretamente no terminal. Aceita `.env` ou objeto JSON de
strings. Pressionar Enter, digitar `FIM_IMORTAIS` e pressionar Enter novamente.
O bloco e o marcador não aparecem durante a entrada. A importação não executa
expressões de shell nem expande variáveis. Ctrl+C restaura o terminal.

O inventário Railway OAuth confirmado nesta preparação fornece os nomes das
variáveis, com valores ocultos e nenhuma variável sealed; por isso a leitura
dos valores existentes depende do proprietário no painel. A captura valida
as17variáveis de aplicação presentes, mais DATABASE_URL quando exportada.
Recusa duplicatas, máscaras, referências não resolvidas fora de DATABASE_URL,
metadados de outro serviço e identidade do bot de testes. Confere localmente
o app ID codificado no primeiro segmento do token; **não autentica o token na
API Discord e não abre conexão Gateway**.

Preserva exatamente SESSION_SECRET e TELEMETRY_INGEST_KEY. O callback existente
continua `https://cta-imortais.up.railway.app/auth/callback`. No candidato local,
DATABASE_URL é substituída pelo endereço privado do destino18 reservado e
`PGSSL=disable`, conforme a configuração esperada por src/db.js. Esse banco
`app` ainda está vazio; o arquivo não pode ser ativado antes da cópia final,
teste de permissões/runtime e autorização da janela.

Arquivos root0600, fora do checkout:

- `/etc/imortais-migration/production-source-env.json`: exportação original e
  IDs do projeto/ambiente/serviço para preservar a origem.
- `/etc/imortais-migration/production-prepared-env.json`: envelope
  `prepared-only`, `activation_allowed=false` e `runtime_variables` candidatas.
- `/var/lib/imortais-migration/production-env-preparation.json`: relatório sem
  valores de segredos, com nomes e condições ainda pendentes.

Sucesso: `VARIAVEIS_PRODUCAO_PREPARADAS`. Reexecução reutiliza a origem salva;
não solicita outra cópia nem substitui silenciosamente chaves diferentes.
`--status` imprime apenas o relatório. A rotina não usa subprocessos, rede,
MCP, API Railway/Discord ou Docker; não aplica variáveis, faz deploy ou inicia
o bot. Testes PTY reais verificam ausência de eco, entrada maior que4096bytes
e restauração do terminal após sucesso/Ctrl+C; testes de arquivos conferem
permissões, preservação literal de chaves e recusa de troca da exportação.

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

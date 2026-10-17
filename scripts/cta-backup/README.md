# Backups após cada CTA no Debian

Esta primeira versão atende somente o PostgreSQL da homologação isolada
`postgres-imortais-discord-ho`, banco `app`, `127.0.0.1:55435`, guilda
`1560656943486345298`. A allowlist recusa a guilda real e qualquer outro host,
porta, banco ou pasta. Não altera código do bot, Discord, Railway ou registros
da aplicação. Lê o banco com o `reader_dsn` já configurado no MackNa.

## Comportamento

- Gera uma cópia inicial completa durante a instalação.
- Consulta CTAs encerradas ou canceladas a cada minuto, aguardando pelo menos
  120 segundos após `closed_at`. O bot agenda uma segunda passagem de scout em
  45 segundos; o atraso de backup dá uma margem, mas não garante a conclusão de
  qualquer ingestão externa que chegue posteriormente.
- Cada CTA futura recebe um `pg_dump` completo em formato custom, criptografado
  com age, mais um manifesto com SHA-256, MD5, horário da captura e número de
  tabelas. Upload em `IMORTAIS-CTA-BOT-BACKUPS/homologacao/AAAA/MM/DD/`.
- O dump usa transação somente leitura e tem visão consistente do PostgreSQL.
  Não inclui código-fonte, arquivos de mídia externos, variáveis do bot nem
  roles globais do PostgreSQL. É a cópia do banco `app` inteiro.
- A fila SQLite persiste eventos, tentativas e confirmações. Rede indisponível
  mantém o mesmo arquivo local e repete o envio com intervalo crescente de
  1 até 60 minutos. O sucesso só é gravado após confirmar os MD5 no destino.
- Após reiniciar o servidor, descobre também CTAs encerradas durante a parada.
  Se ainda não havia dump, essa cópia refletirá o estado no momento da retomada,
  e não reconstrói retrospectivamente o banco no instante do encerramento.
- Duas CTAs atrasadas por execução, nenhuma duplicação por ID. Arquivos remotos
  são imutáveis. Uma reinstalação conserva a chave e o início da observação.
- Não apaga backups locais ou remotos automaticamente nesta versão. Monitorar
  o uso de disco/Drive; a rotina recusa novo dump se faltar tamanho do banco +
  256 MiB livres. Definir retenção é uma etapa posterior, antes de produção.

## OAuth antes do uso contínuo

No projeto Google Cloud que contém o cliente OAuth usado pelo rclone (nesta
configuração, **My First Project**), concluir **Google Auth Platform → Branding**
e depois **Público-alvo → Publicar app**. O modo **Testing** emite refresh tokens
com validade de sete dias para o escopo Drive. A publicação remove essa regra
específica, mas não torna tokens imunes a revogação/expiração por outras causas.
Publicação e verificação Google são estados diferentes. Não usar dados ou URLs
fictícios em Branding. Caso a interface exija campos adicionais, concluir essa
configuração antes de considerar o backup autônomo.

Depois da publicação, autorizar de novo para emitir a credencial fora de Testing.
No **PowerShell do Windows**, com prompt `PS C:\...>`:

```powershell
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:53682:127.0.0.1:53682 macknaadmin@192.168.15.16
```

Já conectado ao Debian:

```bash
rclone config reconnect imortais-drive:
```

Responder `y`, abrir no navegador Windows o endereço novo indicado pelo comando,
concluir a autorização na conta `iamperiniadv@gmail.com` e responder `n` para
Shared Drive. Não executar outro `ssh -L` dentro do Debian. Não abrir porta no
modem. O túnel SSH só é necessário para autorizar; o timer funciona sem terminal.

Referências: <https://developers.google.com/identity/protocols/oauth2#expiration>
e <https://rclone.org/remote_setup/#configuring-using-ssh-tunnel>.

## Instalar

Usar uma cópia revisada desta branch/commit, no Debian, na conta `macknaadmin`:

```bash
sudo bash scripts/cta-backup/install.sh
```

O instalador lê `~/.config/rclone/rclone.conf` dessa conta e
`/etc/mackna/postgres.json`, extrai apenas o remote `imortais-drive` e o reader
da instância permitida. Não imprime senhas nem tokens. Copia a autorização para
uma conta de sistema exclusiva `imortais-backup`, que pode renovar seu token no
próprio diretório de estado. Instala `age`, `rclone` e `postgresql-client-16` pelos
repositórios APT já configurados. Não adiciona repositórios.

Cria `/opt/imortais-cta-backup`, `/etc/imortais-cta-backup`,
`/var/lib/imortais-cta-backup` e duas unidades `imortais-cta-backup` de systemd.
O serviço é sem privilégios root, não tem acesso ao Docker nem à chave privada
de recuperação, e só escreve no seu diretório de estado. Confere PostgreSQL e
Drive e envia o backup inicial antes de habilitar o timer. Se essa etapa falhar,
a instalação informa erro e o timer permanece parado; a fila local é preservada.

Após uma nova autorização no rclone de `macknaadmin`, repetir o instalador com
`--refresh-oauth` para atualizar a cópia de credenciais do serviço:

```bash
sudo bash scripts/cta-backup/install.sh --refresh-oauth
```

## Guardar a chave fora do servidor

O instalador cria uma única chave privada age, preservada nas reinstalações, e
exporta uma cópia com permissão 0600 para a home de `macknaadmin`. Ela é necessária
para restaurar os arquivos criptografados. Não é enviada para a pasta de dumps.

Em **outra janela PowerShell do Windows**, baixar:

```powershell
scp macknaadmin@192.168.15.16:IMORTAIS-CTA-BOT-RECUPERACAO.agekey "$env:USERPROFILE\Downloads\IMORTAIS-CTA-BOT-RECUPERACAO.agekey"
```

Guardar esse arquivo em local privado e durável fora do Debian e fora da pasta
de backups criptografados. Não apagar o servidor antes de guardar a chave e
validar ao menos uma restauração. Credenciais Google podem ser reautorizadas;
uma chave age perdida não pode ser reconstituída a partir do dump.

## Operação

```bash
sudo systemctl status imortais-cta-backup.timer --no-pager
sudo journalctl -u imortais-cta-backup.service -n 30 --no-pager
sudo -u imortais-backup python3 /opt/imortais-cta-backup/worker.py --status
```

`BACKUP_ENVIADO initial` confirma a primeira cópia. Depois de encerrar uma CTA
de testes, aguardar aproximadamente dois a três minutos e procurar
`BACKUP_ENVIADO cta-ID`. Confirmar também `.dump.age` e `.json` no Drive. O prazo
pode ser maior em caso de fila, rede lenta ou uma gravação longa.

Para interromper somente esta automação, conservando fila, arquivos e chave:

```bash
sudo systemctl disable --now imortais-cta-backup.timer
sudo systemctl stop imortais-cta-backup.service
```

## Restaurar em um banco NOVO

Baixar um par `.dump.age` / `.json` pelo Drive. Conferir SHA-256 do criptografado
com o manifesto. Descriptografar com age (disponível em Linux e Windows):

```bash
age -d -i IMORTAIS-CTA-BOT-RECUPERACAO.agekey -o restore.dump ARQUIVO.dump.age
pg_restore --list restore.dump
```

Criar um banco vazio separado e restaurar com `pg_restore --no-owner --no-acl
--exit-on-error --dbname NOVO_BANCO restore.dump` usando cliente compatível com
PG16 ou mais novo e usuário autorizado a criar objetos nesse banco. Nunca
selecionar `app` para esse teste. Comparar tabelas, CTA e dados esperados antes
de qualquer migração. O instalador não executa restauração no Debian.

## Validação de desenvolvimento

`python3 -m unittest discover -s scripts/cta-backup -p 'test_*.py' -v`
testa deduplicação, atraso, falha parcial de upload, arquivo corrompido, nova
tentativa persistida, eventos durante parada, mudança de chave e recusa de
produção. O workflow `.github/workflows/cta-backup.yml` acrescenta PostgreSQL16
descartável, `pg_dump` real com reader, age, rclone para pasta temporária,
restauração em um banco novo e rejeição de arquivo criptografado adulterado.
Essa CI não usa acesso ao Google Drive real nem credenciais do Debian.

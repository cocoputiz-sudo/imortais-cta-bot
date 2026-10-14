# MackNa Cloud – piloto BTV11 S905X3
**Estado:** piloto para Debian 13 ARM64. Nao eh deploy de producao. **Railway e bot principal continuam ativos.**

Esta pasta empacota o aplicativo REAL `imortais-cta-bot` (CTA Bot, War Room e telemetria, mesmo processo Node.js) com um PostgreSQL **novo e isolado**. Sem token do Discord, iniciamos a API/War Room em **modo preview**. Isso prova arquitetura, inicializacao de schemas, containers e memoria, mas NAO equivale a validar as funcionalidades autenticadas ou os dados da guilda em producao.

## Regras obrigatorias
- **Nao continuar se `dpkg` estiver em estado `D`**, se o USB continuar com erros I/O/EXT4, ou se `docker info` falhar. Corrigir disco primeiro, e so entao instalar Docker Engine oficial.
- Nao conectar o banco do Railway nem copiar seus segredos.
- Nao inserir `DISCORD_TOKEN` de producao. O preview define `MACKNA_BTV_PREVIEW=1`, portanto **nao faz login no Discord**.
- Nao expor a porta 8088 na internet. Restringir acesso somente a LAN de testes.
- O pendrive de 32 GB pode falhar novamente e nao eh adequado a bancos duraveis. Recomenda-se SSD.
- BTV11 tem aproximadamente 1,8 GiB de RAM utilizavel; imagem e Postgres foram limitados a 512 MiB + 384 MiB, mas isso nao garante desempenho.
- O Combat Client Windows/Linux continua instalado nos PCs dos jogadores: aqui executa apenas o backend/War Room.

## 1. Recuperar armazenamento ANTES de tentar Docker
Na BTV11, por SSH, checar:
```bash
ps -eo pid,stat,etime,cmd | grep -E 'dpkg|apt|install.sh'
dmesg | tail -n 40
df -h /
```
Se houver `D` persistente ou `I/O error`, interrompa o plano; desligamento/recuperacao de filesystem exige procedimento separado, preferencialmente verificacao OFFLINE. Nao execute `fsck` na raiz montada.

## 2. Instalar Docker somente apos armazenamento saudavel
Siga as instrucoes oficiais para Debian arm64: https://docs.docker.com/engine/install/debian/
Valide o suporte do kernel adaptado do Amlogic a namespaces, cgroups, overlayfs e rede.
```bash
docker version
docker compose version
docker info
```
Se nao funcionar, capture os erros e nao continue.

## 3. Preparar e executar o piloto
A imagem Docker ARM64 e construida no GitHub Actions APOS o PR ser validado/mergeado na main. Esse fluxo nao faz deploy de producao nem altera o Railway.

Na BTV11:
```bash
git clone https://github.com/cocoputiz-sudo/imortais-cta-bot.git
cd imortais-cta-bot
cp mackna-btv/.env.btv.example mackna-btv/.env.btv
# Substitua a senha placeholder por um valor hexadecimal aleatorio no .env.btv.
# Exemplo de geracao: openssl rand -hex 24
bash mackna-btv/update.sh
docker compose --env-file mackna-btv/.env.btv -f mackna-btv/compose.yml logs --tail=80
```
A imagem GHCR deve estar publica ou o host deve autenticar com credencial de somente leitura. Nunca cole tokens no chat.

Rotas LAN (IP pode mudar): `http://192.168.15.11:8088/api/health` e `http://192.168.15.11:8088/`.
O War Room autenticado requer uma aplicacao OAuth Discord de testes e dados de testes. No modo preview o Discord Bot NAO conecta e nao sao simulados membros.

## 4. Diagnosticar recursos
```bash
docker stats --no-stream
free -h
df -h
docker compose --env-file mackna-btv/.env.btv -f mackna-btv/compose.yml ps
```
**Critérios de aceite:** PostgreSQL healthy; app healthy; `/api/health` devolvendo 200; sem OOM nem erros de armazenamento por pelo menos 30 minutos; RAM suficiente para SO; sem qualquer mensagem no Discord de producao.

## 5. Para provar TODAS as funcoes, sem riscos
Proximo estagio: token e aplicacao Discord DE TESTES, guild e canais de testes, OAuth separado, dados sinteticos ou copia anonima do banco, testes de endpoints do War Room e telemetria, e medicao durante pico. Nunca ligar o bot principal em duplicidade.

## Atualizacao automatica (quando a estabilidade estiver comprovada)
`update.sh` faz pull da tag de homologacao e recria apenas containers quando necessario. Pode ser agendado por um timer systemd controlado, em outra PR, apos homologacao. **Nesta primeira entrega o deploy e manual**, pois ainda nao sabemos se o kernel e o disco suportam operacao continua.

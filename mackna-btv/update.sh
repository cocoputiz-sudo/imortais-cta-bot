#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env.btv"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERRO: copie $DIR/.env.btv.example para $ENV_FILE e configure senha de testes." >&2
  exit 1
fi
if grep -Eq '^MACKNA_DB_PASSWORD=SUBSTITUA' "$ENV_FILE"; then
  echo "ERRO: configure uma senha de testes antes de executar." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERRO: Docker nao esta disponivel. Verifique armazenamento e kernel primeiro." >&2
  exit 1
fi
if [ "$(uname -m)" != "aarch64" ]; then
  echo "ERRO: este roteiro BTV11 exige CPU ARM64 (aarch64)." >&2
  exit 1
fi
echo "Atualizando MackNa BTV preview (Discord DESATIVADO, banco ISOLADO)..."
docker compose --env-file "$ENV_FILE" -f "$DIR/compose.yml" pull
docker compose --env-file "$ENV_FILE" -f "$DIR/compose.yml" up -d --no-build
docker compose --env-file "$ENV_FILE" -f "$DIR/compose.yml" ps
echo "War Room de testes: http://192.168.15.11:8088/"
echo "Health: http://192.168.15.11:8088/api/health"

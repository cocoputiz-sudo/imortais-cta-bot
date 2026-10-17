#!/bin/bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
  echo 'Execute com sudo bash install.sh' >&2
  exit 1
fi
command -v python3 >/dev/null || apt-get install -y python3
exec python3 "$(dirname -- "$(readlink -f -- "$0")")/setup.py" "$@"

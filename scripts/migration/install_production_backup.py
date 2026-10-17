#!/usr/bin/env python3
"""Install a separate host-side production backup timer, never the Discord bot."""
import argparse
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from drive_recovery import AUTH, BACKUP_CONFIG, validated_auth
from inspect_railway import SOURCE
from rehearse import IDENTITY, ROOT as REHEARSALS
from production_backup import Backend, FOLDER, GUILD, INSTANCE, PG_BIN, atomic_json, validate_config

ACCOUNT = "imortais-prod-backup"
ETC = Path("/etc/imortais-cta-backup-producao")
STATE = Path("/var/lib/imortais-cta-backup-producao")
APP = Path("/opt/imortais-cta-backup-producao")
SERVICE = "imortais-cta-backup-producao.service"
TIMER = "imortais-cta-backup-producao.timer"

UNIT = """[Unit]
Description=IMORTAIS production CTA backups to Google Drive (Railway read only)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=imortais-prod-backup
Group=imortais-prod-backup
ExecStart=/usr/bin/python3 /opt/imortais-cta-backup-producao/production_backup.py
UMask=0077
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/imortais-cta-backup-producao
InaccessiblePaths=/etc/imortais-migration /etc/imortais-cta-backup
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictSUIDSGID=yes
CapabilityBoundingSet=
TimeoutStartSec=2h
MemoryMax=512M
"""
TIMER_UNIT = """[Unit]
Description=Check completed IMORTAIS production CTAs every minute

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
AccuracySec=5s
Unit=imortais-cta-backup-producao.service

[Install]
WantedBy=timers.target
"""


def run(args, *, optional=False):
    result = subprocess.run(args, capture_output=True, timeout=7500)
    if result.returncode and not optional:
        raise RuntimeError(Path(args[0]).name + " falhou; consulte o journal do backup de produção.")
    return result


def approved_recovery(root=REHEARSALS):
    for path in Path(root).glob("imortais_rehearsal_*/drive-report.json"):
        report = json.loads(path.read_text())
        if (report.get("status") == "ok" and report.get("restored_from_fresh_download") is True and
            report.get("fingerprints_match") is True and report.get("bot_started") is False and
            report.get("folder_id") == FOLDER and report.get("source_rehearsal") == path.parent.name):
            return report
    raise ValueError("Conclua a recuperação de produção pelo Drive antes de habilitar o backup automático.")


def compare_existing(previous, current):
    for key in ("instance", "guild_id", "folder_id", "remote", "recipient", "state_dir", "pg_bin", "rclone_config"):
        if previous.get(key) != current.get(key):
            raise ValueError("Configuração anterior difere; fila preservada sem substituição.")
    # Password rotation is allowed. Endpoint/identity changes need a migration plan.
    for key in ("host", "port", "database", "user", "sslmode"):
        if previous["db"].get(key) != current["db"].get(key):
            raise ValueError("Origem mudou; preserve a fila e prepare a mudança de endpoint.")


def owned_dir(path, uid, gid, mode):
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("Diretório de instalação inválido.")
    os.chown(path, uid, gid)
    path.chmod(mode)


def install_file(source, destination, uid, gid, mode):
    temporary = destination.with_suffix(destination.suffix + ".new")
    if temporary.is_symlink() or destination.is_symlink():
        raise ValueError("Arquivo de instalação inválido.")
    with Path(source).open("rb") as input_file, temporary.open("wb") as output:
        shutil.copyfileobj(input_file, output)
        output.flush()
        os.fsync(output.fileno())
    os.chown(temporary, uid, gid)
    temporary.chmod(mode)
    os.replace(temporary, destination)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-oauth", action="store_true", help="Atualizar apenas a cópia de autorização da produção")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo python3 scripts/migration/install_production_backup.py.")
    approved_recovery()
    backup_cfg = json.loads(BACKUP_CONFIG.read_text())
    validated_auth(backup_cfg, AUTH, IDENTITY)
    for path in (Path(PG_BIN)/"psql", Path(PG_BIN)/"pg_dump", Path("/usr/bin/age"), Path("/usr/bin/rclone")):
        if not path.is_file():
            raise ValueError("Dependência ausente: " + path.name)
    cfg = {"instance":INSTANCE, "guild_id":GUILD, "folder_id":FOLDER, "remote":"imortais-drive",
           "recipient":backup_cfg["recipient"], "db":json.loads(SOURCE.read_text()),
           "rclone_config":str(STATE/"auth/rclone.conf"), "state_dir":str(STATE), "pg_bin":PG_BIN}
    validate_config(cfg)
    config = ETC / "config.json"
    if config.exists():
        compare_existing(json.loads(config.read_text()), cfg)
    try:
        account = pwd.getpwnam(ACCOUNT)
    except KeyError:
        account = None
    if account and (account.pw_uid == 0 or account.pw_dir != str(STATE)):
        raise ValueError("Conta de serviço existente difere da conta reservada.")
    # Preflight reads both endpoints before stopping/replacing our own timer.
    # OAuth refresh writes to a private temporary copy, never staging's config.
    with tempfile.TemporaryDirectory(prefix="imortais-prod-backup-") as tmp:
        auth = Path(tmp) / "rclone.conf"
        shutil.copyfile(AUTH, auth)
        auth.chmod(0o600)
        Backend({**cfg, "rclone_config":str(auth)}).preflight()
    if account is None:
        run(["useradd", "--system", "--user-group", "--home-dir", str(STATE), "--shell", "/usr/sbin/nologin", ACCOUNT])
        account = pwd.getpwnam(ACCOUNT)
    uid, gid = account.pw_uid, account.pw_gid
    run(["systemctl", "stop", TIMER], optional=True)
    run(["systemctl", "stop", SERVICE], optional=True)
    owned_dir(ETC, 0, gid, 0o750)
    owned_dir(STATE, uid, gid, 0o700)
    owned_dir(STATE/"auth", uid, gid, 0o700)
    owned_dir(APP, 0, 0, 0o755)
    auth = STATE / "auth/rclone.conf"
    if not auth.exists() or args.refresh_oauth:
        install_file(AUTH, auth, uid, gid, 0o600)
    # Test the service's own preserved authorization too, including on reinstall.
    run(["runuser", "-u", ACCOUNT, "--", "/usr/bin/rclone", "--config", str(auth),
         "--drive-root-folder-id", FOLDER, "--contimeout", "15s", "--timeout", "2m", "lsf", "imortais-drive:", "--max-depth", "1"])
    atomic_json(config, cfg)
    os.chown(config, 0, gid)
    config.chmod(0o640)
    install_file(Path(__file__).with_name("production_backup.py"), APP/"production_backup.py", 0, 0, 0o755)
    for name, text in ((SERVICE, UNIT), (TIMER, TIMER_UNIT)):
        path = Path("/etc/systemd/system") / name
        temporary = path.with_suffix(path.suffix + ".new")
        temporary.write_text(text)
        temporary.chmod(0o644)
        os.replace(temporary, path)
    run(["systemctl", "daemon-reload"])
    run(["runuser", "-u", ACCOUNT, "--", "/usr/bin/python3", str(APP/"production_backup.py"), "--preflight"])
    print("Enviando/conferindo a cópia inicial de produção; aguarde...", flush=True)
    run(["systemctl", "start", SERVICE])
    with sqlite3.connect("file:" + str(STATE/"queue.sqlite3") + "?mode=ro", uri=True) as queue:
        initial = queue.execute("SELECT uploaded_at FROM jobs WHERE key='initial'").fetchone()
    if not initial or initial[0] is None:
        raise RuntimeError("Cópia inicial ainda pendente; confira o journal e execute novamente após a retomada.")
    run(["systemctl", "enable", "--now", TIMER])
    print("BACKUP_PRODUCAO_INSTALADO: cópia inicial enviada e conferida; timer ativo a cada minuto.")
    print("Novas CTAs closed/cancelled: cópia após espera mínima de120s; fila persistente e retomada automática.")
    print("Drive: IMORTAIS-CTA-BOT-BACKUPS/producao/automatico/; mesma chave de recuperação já guardada.")
    print("Status: sudo -u imortais-prod-backup python3 /opt/imortais-cta-backup-producao/production_backup.py --status")
    print("Log: sudo journalctl -u imortais-cta-backup-producao.service -n20 --no-pager")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Instalação interrompida; fila e cópias concluídas preservadas.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print("INSTALACAO_PRODUCAO_ERRO: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

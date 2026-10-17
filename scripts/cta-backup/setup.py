#!/usr/bin/env python3
"""Install the staging-only backup timer. Invoke through sudo bash install.sh."""
import argparse
import configparser
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlparse

from worker import FOLDER, GUILD, INSTANCE, atomic_json, validate_config

ACCOUNT = "imortais-backup"
ETC = Path("/etc/imortais-cta-backup")
STATE = Path("/var/lib/imortais-cta-backup")
APP = Path("/opt/imortais-cta-backup")


def run(args, **kwargs):
    kwargs.setdefault("check", True)
    return subprocess.run(args, **kwargs)


def owned_dir(path, uid, gid, mode):
    path.mkdir(parents=True, exist_ok=True)
    if path.is_symlink() or not path.is_dir():
        raise ValueError("Diretório inválido: " + str(path))
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def parse_reader(instances):
    matching = [i for i in instances if i["id"] == INSTANCE]
    if len(matching) != 1:
        raise ValueError("Instância de homologação não encontrada no MackNa.")
    parsed = urlparse(matching[0]["reader_dsn"])
    if parsed.scheme not in ("postgres", "postgresql"):
        raise ValueError("reader_dsn precisa usar URL PostgreSQL.")
    if any(k != "sslmode" for k in parse_qs(parsed.query)):
        raise ValueError("Parâmetros não reconhecidos no reader_dsn; revisar antes de instalar.")
    return {"host": parsed.hostname, "port": parsed.port or 5432,
            "database": unquote(parsed.path.lstrip("/")),
            "user": unquote(parsed.username or ""), "password": unquote(parsed.password or "")}


def export_recovery(identity, owner):
    destination = Path(owner.pw_dir) / "IMORTAIS-CTA-BOT-RECUPERACAO.agekey"
    data = identity.read_bytes()
    try:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        if destination.is_symlink() or destination.read_bytes() != data:
            raise ValueError("Arquivo de recuperação já existe e difere; preservar e revisar.")
    else:
        with os.fdopen(fd, "wb") as f:
            os.fchown(f.fileno(), owner.pw_uid, owner.pw_gid)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    return destination


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rclone-config")
    parser.add_argument("--mackna-config", default="/etc/mackna/postgres.json")
    parser.add_argument("--refresh-oauth", action="store_true", help="Copiar novamente a autorização atual de macknaadmin")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo bash install.sh.")
    invoking_user = os.environ.get("SUDO_USER", "")
    if not invoking_user or invoking_user == "root":
        raise ValueError("Execute sudo a partir da conta macknaadmin usada para autorizar o rclone.")
    owner = pwd.getpwnam(invoking_user)
    source = Path(args.rclone_config or str(Path(owner.pw_dir) / ".config/rclone/rclone.conf"))
    source_cfg = configparser.ConfigParser(interpolation=None)
    source_cfg.read_string(source.read_text())
    remote = "imortais-drive"
    if not source_cfg.has_section(remote) or source_cfg[remote].get("type") != "drive":
        raise ValueError("Remote imortais-drive não encontrado no arquivo de configuração indicado.")
    section = source_cfg[remote]
    token = json.loads(section.get("token", "{}"))
    if not token.get("refresh_token") or not section.get("client_id") or not section.get("client_secret"):
        raise ValueError("OAuth incompleto: autorize imortais-drive com seu próprio cliente Google.")
    if section.get("team_drive") or section.get("service_account_file"):
        raise ValueError("Este instalador atende o Drive pessoal autorizado, sem Shared Drive/service account.")
    db = parse_reader(json.loads(Path(args.mackna_config).read_text())["instances"])
    # Reject any other target before installing packages or changing systemd.
    validate_config({"db": db, "guild_id": GUILD, "instance": INSTANCE,
                     "folder_id": FOLDER, "remote": remote, "recipient": "age1placeholder"})
    run(["apt-get", "install", "-y", "age", "rclone", "postgresql-client-16"])
    pg_bin = Path("/usr/lib/postgresql/16/bin")
    for binary in (pg_bin / "psql", pg_bin / "pg_dump", Path("/usr/bin/age"), Path("/usr/bin/rclone")):
        if not binary.is_file():
            raise ValueError("Dependência ausente: " + str(binary))
    try:
        service_user = pwd.getpwnam(ACCOUNT)
    except KeyError:
        run(["useradd", "--system", "--user-group", "--home-dir", str(STATE),
             "--shell", "/usr/sbin/nologin", ACCOUNT])
        service_user = pwd.getpwnam(ACCOUNT)
    uid, gid = service_user.pw_uid, service_user.pw_gid
    owned_dir(ETC, 0, gid, 0o750)
    owned_dir(STATE, uid, gid, 0o700)
    owned_dir(STATE / "auth", uid, gid, 0o700)
    owned_dir(APP, 0, 0, 0o755)
    # Never replace an existing recovery key or initialized rclone config.
    identity = ETC / "recovery.agekey"
    if not identity.exists():
        run(["age-keygen", "-o", str(identity)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(identity, 0o600)
    os.chown(identity, 0, 0)
    recipient = run(["age-keygen", "-y", str(identity)], capture_output=True, text=True).stdout.strip()
    auth = STATE / "auth/rclone.conf"
    if args.refresh_oauth:
        run(["systemctl", "stop", "imortais-cta-backup.timer"], capture_output=True, check=False)
        run(["systemctl", "stop", "imortais-cta-backup.service"], capture_output=True, check=False)
    if not auth.exists() or args.refresh_oauth:
        destination_cfg = configparser.ConfigParser(interpolation=None)
        destination_cfg[remote] = dict(section)
        destination_cfg[remote]["root_folder_id"] = FOLDER
        auth_partial = auth.with_suffix(".conf.new")
        with auth_partial.open("w") as f:
            destination_cfg.write(f)
            f.flush()
            os.fsync(f.fileno())
        os.chown(auth_partial, uid, gid)
        os.chmod(auth_partial, 0o600)
        os.replace(auth_partial, auth)
    cfg = {"instance": INSTANCE, "guild_id": GUILD, "folder_id": FOLDER,
           "remote": remote, "recipient": recipient, "db": db,
           "rclone_config": str(auth), "state_dir": str(STATE), "pg_bin": str(pg_bin)}
    validate_config(cfg)
    config = ETC / "config.json"
    if config.exists():
        previous = json.loads(config.read_text())
        for key in ("instance", "guild_id", "folder_id", "remote", "recipient"):
            if previous.get(key) != cfg[key]:
                raise ValueError("Configuração existente difere: não sobrescrever uma fila ativa.")
    # Stop only our own previous timer while atomically replacing its worker/config.
    run(["systemctl", "stop", "imortais-cta-backup.timer"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    run(["systemctl", "stop", "imortais-cta-backup.service"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    atomic_json(config, cfg)
    os.chown(config, 0, gid)
    os.chmod(config, 0o640)
    worker = APP / "worker.py"
    temporary = APP / "worker.py.new"
    shutil.copyfile(Path(__file__).with_name("worker.py"), temporary)
    os.chmod(temporary, 0o755)
    os.replace(temporary, worker)
    exported = export_recovery(identity, owner)
    # Fail before enabling a timer if either PostgreSQL or Drive is unavailable.
    run(["runuser", "-u", ACCOUNT, "--", "/usr/bin/python3", str(worker), "--preflight"])
    unit = """[Unit]
Description=IMORTAIS CTA backups to Google Drive (homologacao)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=imortais-backup
Group=imortais-backup
ExecStart=/usr/bin/python3 /opt/imortais-cta-backup/worker.py
UMask=0077
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/imortais-cta-backup
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
TimeoutStartSec=30min
MemoryMax=512M
"""
    timer = """[Unit]
Description=Check completed IMORTAIS staging CTAs every minute

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true
AccuracySec=5s
Unit=imortais-cta-backup.service

[Install]
WantedBy=timers.target
"""
    for name, text in (("imortais-cta-backup.service", unit), ("imortais-cta-backup.timer", timer)):
        path = Path("/etc/systemd/system") / name
        path.write_text(text)
        os.chmod(path, 0o644)
    run(["systemctl", "daemon-reload"])
    # First snapshot must upload successfully before unattended scheduling is enabled.
    run(["systemctl", "start", "imortais-cta-backup.service"])
    run(["systemctl", "enable", "--now", "imortais-cta-backup.timer"])
    print("\nINSTALADO: homologação; cópia inicial enviada; fila verificada a cada minuto.")
    print("Arquivo de recuperação para copiar ao Windows: " + str(exported))
    print("Status: sudo -u imortais-backup python3 /opt/imortais-cta-backup/worker.py --status")
    print("Log: sudo journalctl -u imortais-cta-backup.service -n 30 --no-pager")
    print("IMPORTANTE: concluir publicação OAuth e autorizar novamente para remover o prazo de 7 dias do modo Testing.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("INSTALAÇÃO INTERROMPIDA: " + (str(exc) if isinstance(exc, ValueError) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

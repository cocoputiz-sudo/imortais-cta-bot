#!/usr/bin/env python3
"""Upload an approved encrypted rehearsal, then restore a fresh Drive download."""
import argparse
import configparser
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

from inspect_railway import GUILD, private_json
import prepare_pg18 as target
import rehearse as rehearsal

FOLDER = "1VvtvhfnXMoTWbd7cu7643icDbMPJiurn"
REMOTE = "imortais-drive"
AUTH = Path("/var/lib/imortais-cta-backup/auth/rclone.conf")
BACKUP_CONFIG = Path("/etc/imortais-cta-backup/config.json")
ROOT = Path("/var/lib/imortais-migration/drive-recovery")
NAME = r"imortais_rehearsal_[0-9]{14}_[0-9a-f]{6}"


def md5(path):
    value = hashlib.md5(usedforsecurity=False)
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            value.update(chunk)
    return value.hexdigest()


def load_rehearsal(directory, *, require_source_tls=True):
    directory = Path(directory)
    if not re.fullmatch(NAME, directory.name) or directory.is_symlink():
        raise ValueError("Selecione o nome exato de um ensaio, sem caminhos externos.")
    for name in ("manifest.json", "report.json", "source.dump.age"):
        path = directory / name
        if not path.is_file() or path.is_symlink():
            raise ValueError("Ensaio incompleto; não há artefatos locais aprovados.")
    manifest = json.loads((directory / "manifest.json").read_text())
    report = json.loads((directory / "report.json").read_text())
    if (report.get("status") != "ok" or report.get("fingerprints_match") is not True or
        report.get("source_read_only") is not True or report.get("bot_started") is not False or
        manifest.get("database") != directory.name or report.get("database") != directory.name or
        manifest.get("guild_id") != GUILD or manifest.get("file") != "source.dump.age" or
        manifest.get("sha256") != report.get("encrypted_sha256") or
        not re.fullmatch(r"[0-9a-f]{64}", manifest.get("sha256", "")) or
        manifest["source"].get("major") != 18 or manifest["source"].get("other_guilds") != 0 or
        manifest["source"].get("ctas") != report.get("ctas") or
        manifest["source"].get("read_only") != "on" or (require_source_tls and manifest["source"].get("tls") is not True)):
        raise ValueError("Manifesto/relatório não comprovam ensaio de produção aprovado.")
    encrypted = directory / manifest["file"]
    if encrypted.stat().st_size != manifest.get("bytes") or rehearsal.digest(encrypted) != manifest["sha256"]:
        raise ValueError("Cópia local mudou desde a validação; envio recusado.")
    return manifest


class Drive:
    def __init__(self, config, *, remote=REMOTE):
        self.config, self.remote = Path(config), remote

    def run(self, args):
        result = subprocess.run(["/usr/bin/rclone", "--config", str(self.config),
                                 "--drive-root-folder-id", FOLDER,
                                 "--retries", "3", "--low-level-retries", "5",
                                 "--contimeout", "15s", "--timeout", "2m", "--stats", "0", *args],
                                env={"PATH":"/usr/bin:/bin", "LC_ALL":"C.UTF-8"},
                                capture_output=True, timeout=1800)
        if result.returncode:
            raise RuntimeError("Transferência Google Drive/rclone falhou; código " + str(result.returncode) +
                               ". Arquivos concluídos foram preservados; não houve troca do bot.")
        return result.stdout.decode()

    def path(self, relative):
        # Relative paths are generated internally from a strictly validated name.
        if not re.fullmatch(r"producao/ensaios/" + NAME + r"/(source\.dump\.age|manifest\.json|drive-report-[0-9]{8}T[0-9]{6}Z_[0-9a-f]{6}\.json)", relative):
            raise ValueError("Destino fora do prefixo reservado de produção.")
        return self.remote + ":" + relative

    def verify(self, local, relative):
        values = self.run(["md5sum", self.path(relative)]).split()
        if len(values) != 2 or values[0].lower() != md5(local):
            raise RuntimeError("Checksum do arquivo no Drive diverge; etapa interrompida.")

    def upload(self, local, relative):
        self.run(["copyto", str(local), self.path(relative), "--immutable", "--checksum"])
        self.verify(local, relative)

    def download(self, relative, local):
        if Path(local).exists():
            raise ValueError("Download precisa de arquivo novo; cópia local anterior não será usada.")
        self.run(["copyto", self.path(relative), str(local), "--immutable", "--checksum"])


def restore_download(destination, identity, directory, manifest):
    encrypted = directory / "source.dump.age"
    if encrypted.stat().st_size != manifest["bytes"] or rehearsal.digest(encrypted) != manifest["sha256"]:
        raise RuntimeError("SHA-256/tamanho da cópia baixada divergem; nenhum banco criado.")
    info = manifest["source"]
    name = "imortais_rehearsal_" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)
    statement = rehearsal.create_statement(name, info)
    with tempfile.TemporaryDirectory(prefix=".plaintext-", dir=directory) as tmp:
        plain = Path(tmp) / "source.dump"
        with plain.open("xb") as output:
            result = subprocess.run(["/usr/bin/age", "-d", "-i", str(identity), str(encrypted)],
                                    stdout=output, stderr=subprocess.PIPE, timeout=1800)
        if result.returncode:
            raise RuntimeError("Autenticação age da cópia baixada falhou; nenhum banco criado.")
        destination.execute(statement, read_only=False)
        print("BANCO_RESTAURADO_DO_DRIVE: " + name, flush=True)
        destination.execute("REVOKE CONNECT ON DATABASE " + rehearsal.ident(name) + " FROM PUBLIC;", read_only=False)
        with (directory / "restore.stderr").open("wb") as errors, plain.open("rb") as input_dump:
            result = subprocess.run([str(destination.bin / "pg_restore"), "--dbname="+name, "--no-password",
                                     "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error"],
                                    env=destination.env(name, read_only=False), stdin=input_dump,
                                    stdout=subprocess.DEVNULL, stderr=errors, timeout=1800)
        if result.returncode:
            raise RuntimeError("Restauração do Drive falhou; banco e log privado preservados em " + str(directory))
    query = lambda sql: destination.query(sql, name)
    actual_info = query(rehearsal.INFO_SQL)
    for key in ("major", "other_guilds", "ctas", "extensions", "large_objects", "encoding", "provider", "collate", "ctype", "locale"):
        if actual_info[key] != info[key]:
            raise RuntimeError("Banco restaurado do Drive diverge do manifesto: " + key)
    tables = query(rehearsal.TABLES_SQL)
    checked = tables + ([{"schema":"pg_catalog", "table":"pg_largeobject"}] if info["large_objects"] else [])
    rehearsal.compare_fingerprints(manifest["fingerprints"], rehearsal.fingerprints(query, checked, "Drive"))
    count = rehearsal.check_sequences(destination, name, manifest["sequences"])
    return {"database":name, "tables":len(tables), "ctas":info["ctas"], "sequences_checked":count,
            "large_objects":info["large_objects"], "fingerprints_match":True}


def transfer_and_restore(source_dir, destination, identity, drive, root, *, target_storage=None, require_source_tls=True):
    source_dir, root = Path(source_dir), Path(root)
    manifest = load_rehearsal(source_dir, require_source_tls=require_source_tls)
    expected_manifest_hash = rehearsal.digest(source_dir / "manifest.json")
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    required = 4 * manifest["source"]["bytes"] + 5 * 1024**3
    for path in (root, target_storage or root):
        if shutil.disk_usage(path).free < required:
            raise ValueError("Espaço insuficiente para download e nova restauração; envio não iniciado.")
    if destination.query("SELECT to_jsonb(current_setting('server_version_num')::int/10000);") != 18:
        raise ValueError("Destino precisa ser PostgreSQL18.")
    directory = root / (dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "_" + secrets.token_hex(3))
    directory.mkdir(mode=0o700)
    relative = "producao/ensaios/" + source_dir.name + "/"
    print("Enviando cópia criptografada e manifesto ao Google Drive...", flush=True)
    for name in ("source.dump.age", "manifest.json"):
        drive.upload(source_dir / name, relative + name)
    print("Uploads conferidos. Baixando novamente do Drive, sem usar o dump local...", flush=True)
    for name in ("manifest.json", "source.dump.age"):
        drive.download(relative + name, directory / name)
    if rehearsal.digest(directory / "manifest.json") != expected_manifest_hash:
        raise RuntimeError("Manifesto baixado difere do manifesto validado; nenhum banco criado.")
    downloaded_manifest = json.loads((directory / "manifest.json").read_text())
    restored = restore_download(destination, identity, directory, downloaded_manifest)
    report = {"status":"ok", **restored, "source_rehearsal":source_dir.name,
              "encrypted_sha256":manifest["sha256"], "folder_id":FOLDER, "drive_path":relative,
              "restored_from_fresh_download":True, "bot_started":False,
              "source_contacted":False, "automatic_production_backup_enabled":False,
              "local_directory":str(directory)}
    private_json(directory / "drive-report.json", report)
    drive.upload(directory / "drive-report.json", relative + "drive-report-" + directory.name + ".json")
    private_json(source_dir / "drive-report.json", report)
    print("DRIVE_PRODUCAO_RESTAURACAO_OK: " + json.dumps(report, ensure_ascii=False), flush=True)
    return report


def validated_auth(backup, auth, identity):
    if backup.get("folder_id") != FOLDER or backup.get("remote") != REMOTE or Path(backup.get("rclone_config", "")) != AUTH:
        raise ValueError("Autorização do Drive fora da pasta/remote já configurados.")
    config = configparser.ConfigParser(interpolation=None)
    config.read_string(Path(auth).read_text())
    if not config.has_section(REMOTE) or config[REMOTE].get("type") != "drive" or config[REMOTE].get("root_folder_id") != FOLDER:
        raise ValueError("Remote do Drive inválido; não altere a autorização da homologação.")
    recipient = subprocess.run(["/usr/bin/age-keygen", "-y", str(identity)],
                               check=True, capture_output=True, text=True).stdout.strip()
    if recipient != backup.get("recipient"):
        raise ValueError("Chave de recuperação difere da chave já guardada fora do servidor.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rehearsal", required=True, help="Nome exato do ensaio aprovado")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo python3 scripts/migration/drive_recovery.py.")
    if not re.fullmatch(NAME, args.rehearsal):
        raise ValueError("Nome do ensaio inválido.")
    directory = rehearsal.ROOT / args.rehearsal
    load_rehearsal(directory)
    cfg = json.loads(target.CONFIG.read_text())
    target.validate_config(cfg)
    item = target.inspect("container", target.CONTAINER)
    if not cfg.get("provisioned") or item is None or not item["State"]["Running"]:
        raise ValueError("Destino18 reservado não está pronto.")
    target.validate_container(item, cfg)
    validated_auth(json.loads(BACKUP_CONFIG.read_text()), AUTH, rehearsal.IDENTITY)
    for binary in (rehearsal.PG_BIN / "psql", rehearsal.PG_BIN / "pg_restore", Path("/usr/bin/rclone")):
        if not binary.is_file():
            raise ValueError("Dependência ausente: " + binary.name)
    destination = rehearsal.Postgres({"host":"127.0.0.1", "port":target.PORT, "database":"app",
                                      "user":"mackna_admin", "password":cfg["admin_password"], "sslmode":"disable"})
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (rehearsal.ROOT.parent / "rehearsal.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        storage = json.loads(target.run(["docker", "info", "--format", "{{json .}}"]))["DockerRootDir"]
        with tempfile.TemporaryDirectory(prefix=".auth-", dir=ROOT) as tmp:
            # Private copy allows OAuth refresh without racing the staging worker's config.
            auth_copy = Path(tmp) / "rclone.conf"
            shutil.copyfile(AUTH, auth_copy)
            auth_copy.chmod(0o600)
            transfer_and_restore(directory, destination, rehearsal.IDENTITY, Drive(auth_copy), ROOT, target_storage=storage)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Etapa interrompida; cópias cifradas e bancos concluídos foram preservados.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print("DRIVE_PRODUCAO_ERRO: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

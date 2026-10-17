#!/usr/bin/env python3
"""Download an uploaded CTA backup and restore ONLY into a new staging database."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, unquote, urlparse

from worker import Backend, FOLDER, GUILD, INSTANCE, atomic_json, digest


def checked(args, **kwargs):
    result = subprocess.run(args, stderr=subprocess.PIPE, timeout=600, **kwargs)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + " falhou; código " + str(result.returncode))
    return result


def admin_environment(instances):
    matches = [item for item in instances if item["id"] == INSTANCE]
    if len(matches) != 1 or matches[0].get("protected") or not matches[0].get("allow_write"):
        raise ValueError("Instância de homologação sem administração autorizada.")
    parsed = urlparse(matches[0].get("admin_dsn", ""))
    if (parsed.scheme not in ("postgres", "postgresql") or
        (parsed.hostname, parsed.port, unquote(parsed.path.lstrip("/"))) != ("127.0.0.1", 55435, "app") or
        any(key != "sslmode" for key in parse_qs(parsed.query)) or
        not parsed.username or not parsed.password or unquote(parsed.username) == "postgres"):
        raise ValueError("admin_dsn fora do destino de homologação autorizado.")
    return {"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8", "PGHOST": "127.0.0.1",
            "PGPORT": "55435", "PGDATABASE": "app", "PGUSER": unquote(parsed.username),
            "PGPASSWORD": unquote(parsed.password), "PGSSLMODE": "disable",
            "PGCONNECT_TIMEOUT": "10", "PGAPPNAME": "imortais-restore-test"}


def validate_manifest(manifest, job):
    date = dt.datetime.fromtimestamp(job["closed_at"], dt.timezone.utc)
    name = job["key"] + "-" + date.strftime("%Y%m%dT%H%M%SZ")
    if (manifest.get("format"), manifest.get("environment"), manifest.get("instance"),
        manifest.get("database"), manifest.get("guild_id"), manifest.get("cta_id"),
        manifest.get("status"), manifest.get("file")) != (
        "pg_dump-custom+age-v1", "homologacao", INSTANCE, "app", GUILD,
        job["event_id"], job["status"], name + ".dump.age"):
        raise ValueError("Manifesto não corresponde à CTA enviada da homologação.")
    if (not re.fullmatch(r"[0-9a-f]{64}", manifest.get("sha256", "")) or
        not isinstance(manifest.get("tables"), int) or manifest["tables"] < 1 or
        not isinstance(manifest.get("bytes"), int) or manifest["bytes"] < 1):
        raise ValueError("Manifesto com tamanho/checksum/tabelas inválidos.")
    return "homologacao/" + date.strftime("%Y/%m/%d/"), name


def select_uploaded(cfg, cta):
    # Read-only connection: this test must never re-arm or modify the backup queue.
    queue = Path(cfg["state_dir"]) / "queue.sqlite3"
    with sqlite3.connect(queue.as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        job = db.execute("""SELECT * FROM jobs WHERE event_id=? AND uploaded_at IS NOT NULL
                          AND status IN ('closed','cancelled')""", (cta,)).fetchone()
    if job is None:
        raise ValueError("CTA ainda não consta como enviada na fila de backups.")
    date = dt.datetime.fromtimestamp(job["closed_at"], dt.timezone.utc)
    name = job["key"] + "-" + date.strftime("%Y%m%dT%H%M%SZ")
    path = Path(cfg["state_dir"]) / "spool" / (name + ".json")
    manifest = json.loads(path.read_text())
    prefix, name = validate_manifest(manifest, job)
    return manifest, prefix, name


def restore_archive(cfg, admin, dump, manifest):
    # No caller-supplied database name, --create, --clean, DROP or rename.
    Backend(cfg).inspect()
    if any(admin.get(key) != value for key, value in
           {"PGHOST": "127.0.0.1", "PGPORT": "55435", "PGDATABASE": "app"}.items()):
        raise ValueError("Administração fora da homologação recusada.")
    pg = Path(cfg["pg_bin"])
    name = "app_drive_test_" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)

    def query(sql, database="app", read_only=True):
        options = "-c statement_timeout=300000 -c lock_timeout=5000"
        if read_only:
            options += " -c default_transaction_read_only=on"
        result = checked([str(pg / "psql"), "-XAtw", "-v", "ON_ERROR_STOP=1", "-c", sql],
                         env={**admin, "PGDATABASE": database, "PGOPTIONS": options}, stdout=subprocess.PIPE)
        return result.stdout.decode().strip()

    checked([str(pg / "pg_restore"), "--list", str(dump)], stdout=subprocess.DEVNULL)
    query('CREATE DATABASE "' + name + '" TEMPLATE template0', read_only=False)
    print("BANCO_NOVO: " + name, flush=True)
    # Keep the restored copy private to its administrative owner.
    query('REVOKE CONNECT ON DATABASE "' + name + '" FROM PUBLIC', read_only=False)
    checked([str(pg / "pg_restore"), "--dbname=" + name, "--no-password", "--no-owner", "--no-acl",
             "--exit-on-error", "--single-transaction", str(dump)],
            env={**admin, "PGDATABASE": name, "PGOPTIONS": "-c lock_timeout=5000"}, stdout=subprocess.DEVNULL)
    cta = str(manifest["cta_id"])
    if not cta.isdigit():
        raise ValueError("ID de CTA inválido.")
    report = json.loads(query("""SELECT json_build_object(
      'database', current_database(),
      'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
      'ctas', (SELECT count(*) FROM public.cta_events),
      'other_guilds', (SELECT count(*) FROM public.cta_events WHERE guild_id IS DISTINCT FROM '""" + GUILD + """'),
      'cta_status', (SELECT status FROM public.cta_events WHERE id=""" + cta + """),
      'cta_closed_at', (SELECT extract(epoch FROM closed_at)::double precision FROM public.cta_events WHERE id=""" + cta + "))", name))
    closed = dt.datetime.fromisoformat(manifest["closed_at"]).timestamp()
    if (report["tables"] != manifest["tables"] or report["other_guilds"] != 0 or
        report["cta_status"] != manifest["status"] or report["cta_closed_at"] is None or
        abs(report["cta_closed_at"] - closed) > 0.01):
        raise RuntimeError("Restauração criada, mas conferência de tabelas/CTA/guilda falhou.")
    return {**report, "status": "ok", "cta_id": cta, "source": "Google Drive",
            "file": manifest["file"], "encrypted_sha256": manifest["sha256"]}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cta", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not args.cta.isdigit():
        raise ValueError("Execute com sudo python3 restore_test.py --cta ID_NUMERICO.")
    cfg = json.loads(Path("/etc/imortais-cta-backup/config.json").read_text())
    backend = Backend(cfg)
    info = backend.inspect()
    admin = admin_environment(json.loads(Path("/etc/mackna/postgres.json").read_text())["instances"])
    identity = Path("/etc/imortais-cta-backup/recovery.agekey")
    recipient = checked(["/usr/bin/age-keygen", "-y", str(identity)], stdout=subprocess.PIPE).stdout.decode().strip()
    if recipient != cfg["recipient"]:
        raise ValueError("Chave de recuperação não corresponde ao backup instalado.")
    # Avoid simultaneous OAuth token refreshes without changing timer configuration.
    with (Path(cfg["state_dir"]) / "worker.lock").open("r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Backup em execução; aguarde um minuto e repita.") from None
        manifest, prefix, name = select_uploaded(cfg, args.cta)
        if shutil.disk_usage("/var/tmp").free < info["bytes"] * 3 + 512 * 1024 * 1024:
            raise RuntimeError("Espaço insuficiente para a restauração temporária.")
        with tempfile.TemporaryDirectory(prefix="imortais-drive-restore-", dir="/var/tmp") as tmp:
            root = Path(tmp)

            def download(relative, target):
                # rclone runs under its existing service account; root owns output.
                with target.open("xb") as output:
                    checked(["/usr/sbin/runuser", "-u", "imortais-backup", "--", "/usr/bin/rclone",
                             "--config", cfg["rclone_config"], "--drive-root-folder-id", FOLDER,
                             "--contimeout", "15s", "--timeout", "2m", "--retries", "2",
                             "cat", cfg["remote"] + ":" + relative], stdout=output,
                            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"})

            remote_manifest = root / "manifest.json"
            download(prefix + name + ".json", remote_manifest)
            if json.loads(remote_manifest.read_text()) != manifest:
                raise ValueError("Manifesto do Drive difere da referência local enviada.")
            artifact = root / manifest["file"]
            download(prefix + manifest["file"], artifact)
            if artifact.stat().st_size != manifest["bytes"] or digest(artifact) != manifest["sha256"]:
                raise ValueError("Arquivo baixado não confere com o checksum registrado.")
            print("DOWNLOAD_DRIVE_OK: " + manifest["file"], flush=True)
            dump = root / "restore.dump"
            with dump.open("xb") as output:
                checked(["/usr/bin/age", "-d", "-i", str(identity), str(artifact)], stdout=output)
            report = restore_archive(cfg, admin, dump, manifest)
            report_path = Path(cfg["state_dir"]) / (report["database"] + ".json")
            atomic_json(report_path, report)
            print("RESTAURACAO_OK: " + json.dumps(report, ensure_ascii=False), flush=True)
            print("Relatório: " + str(report_path))
            print("Banco de teste preservado; arquivos temporários removidos ao sair.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("RESTAURACAO_ERRO: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

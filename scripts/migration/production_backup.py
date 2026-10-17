#!/usr/bin/env python3
"""Durable PostgreSQL18 production backups from the allowlisted Railway source.

Host-side, TLS, read-only queries/pg_dump; no Discord or application writes.
A separate systemd account, queue and Drive prefix preserve staging backups.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

GUILD = "683411304408416285"
FOLDER = "1VvtvhfnXMoTWbd7cu7643icDbMPJiurn"
INSTANCE = "railway-imortais-producao"
HOST = "ballast.proxy.rlwy.net"
PORT = 34114
PG_BIN = "/usr/lib/postgresql/18/bin"
DELAY = 120


def digest(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path, data):
    path = Path(path)
    partial = path.with_suffix(path.suffix + ".partial")
    with partial.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(partial, path)
    fsync_dir(path.parent)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def validate_config(cfg):
    db = cfg["db"]
    if (db["host"], int(db["port"]), cfg["guild_id"], cfg["instance"], cfg["folder_id"]) != (
        HOST, PORT, GUILD, INSTANCE, FOLDER
    ) or db.get("sslmode") not in ("require", "verify-ca", "verify-full"):
        raise ValueError("Destino recusado: somente a origem de produção Railway com TLS.")
    if not db.get("database") or not db.get("user") or not db.get("password") or cfg.get("pg_bin") != PG_BIN:
        raise ValueError("Conexão de produção/cliente18 incompletos.")
    if cfg.get("remote") != "imortais-drive":
        raise ValueError("Nome do remote inválido.")
    if not re.fullmatch(r"age1[a-z0-9]+", cfg["recipient"]):
        raise ValueError("Chave pública age inválida.")


class Backend:
    def __init__(self, cfg, *, transport=None, pg_bin=None, require_tls=True):
        validate_config(cfg)
        self.cfg = cfg
        # Transport overrides are for disposable integration tests, never CLI options.
        self.transport = transport or cfg["db"]
        self.pg_bin = Path(pg_bin or cfg["pg_bin"])
        self.require_tls = require_tls

    def pg_env(self):
        db = self.transport
        return {"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8",
                "PGHOST": db["host"], "PGPORT": str(db["port"]),
                "PGDATABASE": db["database"], "PGUSER": db["user"],
                "PGPASSWORD": db["password"], "PGSSLMODE": db["sslmode"],
                "PGCONNECT_TIMEOUT": "10", "PGAPPNAME": "imortais-cta-backup-producao",
                "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=600000 -c lock_timeout=5000"}

    def sql(self, sql):
        result = subprocess.run([str(self.pg_bin / "psql"),
                                 "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
                                env=self.pg_env(), capture_output=True, timeout=35)
        if result.returncode:
            # Never log DSNs, passwords or full subprocess stderr.
            raise RuntimeError("Consulta PostgreSQL falhou; código " + str(result.returncode))
        return json.loads(result.stdout)

    def inspect(self):
        info = self.sql("""SELECT json_build_object(
          'database', current_database(), 'bytes', pg_database_size(current_database()),
          'server_version', current_setting('server_version'),
          'major', current_setting('server_version_num')::int/10000,
          'read_only', current_setting('transaction_read_only'),
          'tls', (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),
          'tables', (SELECT count(*) FROM information_schema.tables
                     WHERE table_schema='public' AND table_type='BASE TABLE'),
          'guilds', (SELECT COALESCE(json_agg(guild_id), '[]'::json)
                    FROM (SELECT DISTINCT guild_id FROM public.cta_events) g))""")
        if (info["database"] != self.transport["database"] or any(g != GUILD for g in info["guilds"]) or
            info["major"] != 18 or info["read_only"] != "on" or (self.require_tls and info["tls"] is not True)):
            raise RuntimeError("Banco/guilda/versão18/TLS/leitura fora da produção esperada; backup interrompido.")
        return info

    def events(self, armed_at):
        return self.sql("""SELECT COALESCE(json_agg(e), '[]'::json) FROM (
          SELECT id::text AS id, status,
                 extract(epoch FROM closed_at)::double precision AS closed_at
          FROM public.cta_events WHERE guild_id='""" + GUILD + """'
            AND status IN ('closed', 'cancelled')
            AND closed_at >= to_timestamp(""" + str(float(armed_at)) + """ )
          ORDER BY closed_at, id) e""")

    def rclone(self, args):
        result = subprocess.run(["/usr/bin/rclone", "--config", self.cfg["rclone_config"],
                                 "--drive-root-folder-id", FOLDER,
                                 "--contimeout", "15s", "--timeout", "2m",
                                 "--retries", "2", "--low-level-retries", "3", *args],
                                capture_output=True, timeout=1800,
                                env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"})
        if result.returncode:
            raise RuntimeError("Google Drive/rclone falhou; código " + str(result.returncode))
        return result.stdout.decode("utf-8")

    def preflight(self):
        info = self.inspect()
        self.rclone(["lsf", self.cfg["remote"] + ":", "--max-depth", "1"])
        return info

    def snapshot(self, target):
        info = self.inspect()
        usage = shutil.disk_usage(target.parent)
        if usage.free < max(2 * info["bytes"] + 1024**3, usage.total * 10 // 100):
            raise RuntimeError("Espaço local insuficiente; cópias concluídas preservadas e nova tentativa adiada.")
        partial = Path(str(target) + ".partial")
        partial.unlink(missing_ok=True)
        producer = None
        try:
            with tempfile.TemporaryFile() as errors, partial.open("xb") as encrypted:
                producer = subprocess.Popen([
                    str(self.pg_bin / "pg_dump"), "--format=custom",
                    "--no-owner", "--no-acl", "--no-password", "--lock-wait-timeout=5s"],
                    env=self.pg_env(), stdout=subprocess.PIPE, stderr=errors)
                try:
                    result = subprocess.run(["/usr/bin/age", "-r", self.cfg["recipient"]],
                                            stdin=producer.stdout, stdout=encrypted,
                                            stderr=subprocess.PIPE, timeout=1800)
                finally:
                    producer.stdout.close()
                code = producer.wait(timeout=30)
                if result.returncode or code:
                    raise RuntimeError("Falha no pg_dump ou na criptografia age; arquivo parcial descartado.")
                encrypted.flush()
                os.fsync(encrypted.fileno())
            os.replace(partial, target)
            fsync_dir(target.parent)
        finally:
            if producer is not None and producer.poll() is None:
                producer.kill()
                producer.wait()
            partial.unlink(missing_ok=True)
        return info

    def upload(self, source, relative):
        remote = self.cfg["remote"] + ":" + relative
        self.rclone(["copyto", str(source), remote, "--immutable", "--checksum"])
        hashes = self.rclone(["md5sum", remote]).split()
        if not hashes or hashes[0].lower() != digest(source, "md5"):
            raise RuntimeError("Checksum do arquivo no Drive não confere.")


class Worker:
    def __init__(self, state_dir, backend, clock=time.time):
        self.state = Path(state_dir)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.spool = self.state / "spool"
        self.spool.mkdir(exist_ok=True, mode=0o700)
        self.backend, self.clock = backend, clock
        self.db = sqlite3.connect(self.state / "queue.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS jobs (
            key TEXT PRIMARY KEY, event_id TEXT, status TEXT NOT NULL,
            closed_at REAL NOT NULL, due_at REAL NOT NULL,
            uploaded_at REAL, attempts INTEGER NOT NULL DEFAULT 0,
            next_try REAL NOT NULL DEFAULT 0, error TEXT);
        """)
        self.db.commit()

    def initialize(self):
        # Validate online target before arming a new queue. Never reset a baseline.
        self.backend.inspect()
        target = json.dumps({k: self.backend.cfg[k] for k in
                             ("instance", "guild_id", "folder_id", "remote", "recipient")}, sort_keys=True)
        target = json.dumps({"identity": json.loads(target), "source": {key: self.backend.cfg["db"][key]
                             for key in ("host", "port", "database", "user", "sslmode")}}, sort_keys=True)
        identity = self.db.execute("SELECT value FROM meta WHERE key='target'").fetchone()
        if identity and identity[0] != target:
            raise RuntimeError("Destino/chave mudou: use fila separada e preserve a configuração anterior.")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO meta VALUES ('target', ?)", (target,))
            self.db.execute("INSERT OR IGNORE INTO meta VALUES ('armed_at', ?)", (str(self.clock()),))
            baseline = float(self.db.execute("SELECT value FROM meta WHERE key='armed_at'").fetchone()[0])
            self.db.execute("INSERT OR IGNORE INTO jobs (key,status,closed_at,due_at) VALUES (?,?,?,?)",
                            ("initial", "initial", baseline, baseline))
        return baseline

    def discover(self, baseline):
        events = self.backend.events(baseline)
        with self.db:
            for event in events:
                if event["status"] not in ("closed", "cancelled") or not str(event["id"]).isdigit():
                    raise RuntimeError("Evento inválido retornado pelo PostgreSQL.")
                closed = float(event["closed_at"])
                if closed < baseline:
                    continue
                self.db.execute("""INSERT OR IGNORE INTO jobs
                  (key,event_id,status,closed_at,due_at) VALUES (?,?,?,?,?)""",
                  ("cta-" + str(event["id"]), str(event["id"]), event["status"], closed, closed + DELAY))

    def bundle(self, job):
        date = dt.datetime.fromtimestamp(job["closed_at"], dt.timezone.utc)
        name = job["key"] + "-" + date.strftime("%Y%m%dT%H%M%SZ")
        target = self.spool / (name + ".dump.age")
        manifest = self.spool / (name + ".json")
        if target.exists() and manifest.exists():
            info = json.loads(manifest.read_text())
            if digest(target) != info["sha256"] or target.stat().st_size != info["bytes"]:
                raise RuntimeError("Cópia local corrompida; preservada para inspeção.")
        else:
            # An interrupted, uncommitted snapshot is never uploaded.
            target.unlink(missing_ok=True)
            manifest.unlink(missing_ok=True)
            source = self.backend.snapshot(target)
            info = {"format": "pg_dump-custom+age-v1", "environment": "producao",
                    "instance": INSTANCE, "database": self.backend.cfg["db"]["database"], "guild_id": GUILD,
                    "cta_id": job["event_id"], "status": job["status"],
                    "closed_at": date.isoformat(),
                    "snapshot_at": dt.datetime.fromtimestamp(self.clock(), dt.timezone.utc).isoformat(),
                    "file": target.name, "bytes": target.stat().st_size,
                    "sha256": digest(target), "md5": digest(target, "md5"),
                    "server_version": source["server_version"], "tables": source["tables"],
                    "source_tls": source["tls"], "source_read_only": source["read_only"] == "on"}
            atomic_json(manifest, info)
        prefix = "producao/automatico/" + date.strftime("%Y/%m/%d/")
        return ((target, prefix + target.name), (manifest, prefix + manifest.name))

    def run(self):
        baseline = self.initialize()
        self.discover(baseline)
        failures = 0
        jobs = self.db.execute("""SELECT * FROM jobs WHERE uploaded_at IS NULL
          AND due_at<=? AND next_try<=? ORDER BY closed_at,key LIMIT 2""",
          (self.clock(), self.clock())).fetchall()
        for job in jobs:
            try:
                for path, relative in self.bundle(job):
                    self.backend.upload(path, relative)
                with self.db:
                    self.db.execute("UPDATE jobs SET uploaded_at=?, error=NULL WHERE key=?",
                                    (self.clock(), job["key"]))
                print("BACKUP_PRODUCAO_ENVIADO " + job["key"], flush=True)
            except Exception as exc:
                attempts = job["attempts"] + 1
                retry = min(3600, 60 * (2 ** min(attempts - 1, 6)))
                # Exception text is generated here, never arbitrary tool stderr.
                error = str(exc)[:300] if isinstance(exc, RuntimeError) else type(exc).__name__
                with self.db:
                    self.db.execute("UPDATE jobs SET attempts=?, next_try=?, error=? WHERE key=?",
                                    (attempts, self.clock() + retry, error, job["key"]))
                print("BACKUP_PENDENTE " + job["key"] + ": " + error, flush=True)
                failures += 1
        pending = self.db.execute("SELECT count(*) FROM jobs WHERE uploaded_at IS NULL").fetchone()[0]
        print("Fila: " + str(pending) + " pendente(s).", flush=True)
        return int(failures > 0)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/imortais-cta-backup-producao/config.json")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    cfg = json.loads(Path(args.config).read_text())
    backend = Backend(cfg)
    state = Path(cfg["state_dir"])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("Outra execução já está ativa.")
            return 0
        if args.preflight:
            info = backend.preflight()
            print("PREFLIGHT_PRODUCAO_OK: TLS/leitura, Drive e PostgreSQL18; " + str(info["tables"]) + " tabelas.")
            return 0
        worker = Worker(state, backend)
        if args.status:
            rows = worker.db.execute("SELECT key,status,uploaded_at,attempts,error FROM jobs ORDER BY closed_at DESC LIMIT 12")
            print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
            return 0
        return worker.run()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # No traceback/config leakage in the system journal.
        print("BACKUP_ERRO: " + (str(exc) if isinstance(exc, (RuntimeError, ValueError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)


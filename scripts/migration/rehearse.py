#!/usr/bin/env python3
"""Copy a read-only exported source snapshot into a NEW Debian rehearsal DB."""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import shutil
import subprocess
import sys
import tempfile
import time

from inspect_railway import HOST, PORT, GUILD, SOURCE, private_json
import prepare_pg18 as target

PG_BIN = Path("/usr/lib/postgresql/18/bin")
IDENTITY = Path("/etc/imortais-cta-backup/recovery.agekey")
ROOT = Path("/var/lib/imortais-migration/rehearsals")


def ident(value):
    return '"' + value.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b""):
            result.update(chunk)
    return result.hexdigest()


class Postgres:
    def __init__(self, db, bin_dir=PG_BIN):
        self.db, self.bin = db, Path(bin_dir)

    def env(self, database=None, read_only=True):
        options = "-c statement_timeout=600000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=1800000 -c TimeZone=UTC -c DateStyle=ISO -c extra_float_digits=3 -c bytea_output=hex -c standard_conforming_strings=on"
        if read_only:
            options += " -c default_transaction_read_only=on"
        return {"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8", "PGHOST": self.db["host"],
                "PGPORT": str(self.db["port"]), "PGDATABASE": database or self.db["database"],
                "PGUSER": self.db["user"], "PGPASSWORD": self.db["password"],
                "PGSSLMODE": self.db["sslmode"], "PGCONNECT_TIMEOUT": "10",
                "PGAPPNAME": "imortais-migration-rehearsal", "PGOPTIONS": options}

    def execute(self, sql, database=None, read_only=True):
        result = subprocess.run([str(self.bin / "psql"), "-XAtqw", "-v", "ON_ERROR_STOP=1", "-c", sql],
                                env=self.env(database, read_only), capture_output=True, timeout=900)
        if result.returncode:
            raise RuntimeError("Consulta da etapa de ensaio falhou; código " + str(result.returncode))
        return result.stdout

    def query(self, sql, database=None):
        return json.loads(self.execute(sql, database))


class SnapshotSession:
    """Keep the exporting transaction alive until pg_dump has consumed it."""
    def __init__(self, postgres):
        self.postgres = postgres

    def __enter__(self):
        self.errors = tempfile.TemporaryFile()
        self.process = subprocess.Popen([str(self.postgres.bin / "psql"), "-XAtqw", "-v", "ON_ERROR_STOP=1"],
                                        env=self.postgres.env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.errors, bufsize=0)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.buffer = b""
        return self

    def query(self, sql):
        marker = ("END_" + secrets.token_hex(16)).encode()
        self.process.stdin.write(sql.encode() + b"\n\\echo " + marker + b"\n")
        deadline = time.monotonic() + 900
        while True:
            token = marker + b"\n"
            position = self.buffer.find(token)
            if position >= 0:
                raw, self.buffer = self.buffer[:position], self.buffer[position + len(token):]
                return json.loads(raw.strip())
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Tempo esgotado na conferência do snapshot de origem.")
            if not self.selector.select(min(remaining, 5)):
                continue
            data = os.read(self.process.stdout.fileno(), 65536)
            if not data:
                raise RuntimeError("Sessão do snapshot de origem foi encerrada; ensaio interrompido.")
            self.buffer += data

    def __exit__(self, *_):
        try:
            if self.process.poll() is None:
                self.process.stdin.write(b"ROLLBACK;\n\\q\n")
                self.process.stdin.close()
                self.process.wait(timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            self.process.kill()
            self.process.wait()
        finally:
            self.selector.close()
            if not self.process.stdin.closed:
                self.process.stdin.close()
            self.process.stdout.close()
            self.errors.close()


INFO_SQL = """SELECT jsonb_build_object(
 'major',current_setting('server_version_num')::int/10000,
 'database',current_database(), 'bytes',pg_database_size(current_database()),
 'read_only',current_setting('transaction_read_only'),
 'tls',(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),
 'other_guilds',(SELECT count(*) FROM public.cta_events WHERE guild_id IS DISTINCT FROM '683411304408416285'),
 'ctas',(SELECT count(*) FROM public.cta_events),
 'encoding',pg_encoding_to_char(d.encoding),'collate',d.datcollate,'ctype',d.datctype,
 'provider',d.datlocprovider,'locale',to_jsonb(d)->>'datlocale',
 'extensions',(SELECT jsonb_agg(extname ORDER BY extname) FROM pg_extension),
 'large_objects',(SELECT count(*) FROM pg_largeobject_metadata))
 FROM pg_database d WHERE d.datname=current_database();"""

TABLES_SQL = """SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname)
 ORDER BY n.nspname,c.relname),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema';"""

SEQUENCES_SQL = """SELECT coalesce(jsonb_agg(jsonb_build_object('schema',sn.nspname,'sequence',s.relname,
 'table_schema',tn.nspname,'table',t.relname,'column',a.attname,'increment',q.seqincrement::text)
 ORDER BY sn.nspname,s.relname),'[]'::jsonb)
 FROM pg_class s JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_sequence q ON q.seqrelid=s.oid
 LEFT JOIN pg_depend dep ON dep.classid='pg_class'::regclass AND dep.refclassid='pg_class'::regclass AND dep.objid=s.oid AND dep.deptype IN ('a','i')
 LEFT JOIN pg_class t ON t.oid=dep.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace
 LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=dep.refobjsubid
 WHERE sn.nspname !~ '^pg_';"""


def fingerprints(query, tables, label):
    output = []
    for index, table in enumerate(tables, 1):
        relation = ident(table["schema"]) + "." + ident(table["table"])
        # Counts plus two order-independent numeric sums of per-row MD5 halves.
        # These detect accidental data differences; age/SHA256 protect the file.
        value = query("SELECT jsonb_build_object('count',count(*)::text,"
                      "'sum1',coalesce(sum(('x'||substr(h,1,16))::bit(64)::bigint),0)::text,"
                      "'sum2',coalesce(sum(('x'||substr(h,17,16))::bit(64)::bigint),0)::text)"
                      " FROM (SELECT md5(to_jsonb(t)::text) AS h FROM " + relation + " t) sample_rows;")
        output.append({**table, **value})
        if index % 10 == 0:
            print(label + ": " + str(index) + "/" + str(len(tables)) + " tabelas conferidas.", flush=True)
    return output


def compare_fingerprints(expected, actual):
    if expected != actual:
        raise RuntimeError("Tabelas/contagens/conteúdo restaurados diferem do snapshot; banco de ensaio preservado.")


def create_statement(name, info):
    if not re.fullmatch(r"imortais_rehearsal_[0-9]{14}_[0-9a-f]{6}", name):
        raise ValueError("Nome do banco de ensaio recusado.")
    if info["encoding"] != "UTF8" or info["provider"] not in ("c", "i", "b"):
        raise ValueError("Encoding/locale da origem ainda não suportado pelo ensaio.")
    statement = "CREATE DATABASE " + ident(name) + " TEMPLATE template0 ENCODING 'UTF8'"
    if info["provider"] == "c":
        statement += " LC_COLLATE " + literal(info["collate"]) + " LC_CTYPE " + literal(info["ctype"]) + " LOCALE_PROVIDER libc"
    else:
        if not info.get("locale"):
            raise ValueError("Locale da origem ausente.")
        statement += " LOCALE_PROVIDER " + ("icu ICU_LOCALE " if info["provider"] == "i" else "builtin BUILTIN_LOCALE ") + literal(info["locale"])
    return statement + ";"


def encrypt_dump(source, snapshot, recipient, path):
    if not re.fullmatch(r"[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+", snapshot):
        raise ValueError("Identificador de snapshot inválido.")
    producer = None
    partial = path.with_suffix(".partial")
    try:
        with tempfile.TemporaryFile() as errors, partial.open("xb") as output:
            producer = subprocess.Popen([str(source.bin / "pg_dump"), "--format=custom", "--no-owner", "--no-acl",
                                         "--no-password", "--lock-wait-timeout=5s", "--snapshot="+snapshot],
                                        env=source.env(), stdout=subprocess.PIPE, stderr=errors)
            try:
                result = subprocess.run(["/usr/bin/age", "-r", recipient], stdin=producer.stdout,
                                        stdout=output, stderr=subprocess.PIPE, timeout=1800)
            finally:
                producer.stdout.close()
            code = producer.wait(timeout=30)
            if result.returncode or code:
                raise RuntimeError("pg_dump ou criptografia falhou; arquivo parcial descartado.")
            output.flush()
            os.fsync(output.fileno())
        os.replace(partial, path)
    finally:
        if producer is not None and producer.poll() is None:
            producer.kill()
            producer.wait()
        partial.unlink(missing_ok=True)


def check_sequences(postgres, database, expected):
    actual = postgres.query(SEQUENCES_SQL, database)
    if actual != expected:
        raise RuntimeError("Definições de sequências diferem da origem.")
    checked = 0
    for seq in actual:
        if not seq["column"]:
            continue
        state = postgres.query("SELECT jsonb_build_object('value',last_value::text,'called',is_called) FROM " + ident(seq["schema"]) + "." + ident(seq["sequence"]) + ";", database)
        aggregate = "max" if int(seq["increment"]) > 0 else "min"
        bound = postgres.query("SELECT coalesce(to_jsonb(" + aggregate + "(" + ident(seq["column"]) + ")),'null'::jsonb) FROM " + ident(seq["table_schema"]) + "." + ident(seq["table"]) + ";", database)
        if bound is not None:
            difference = (int(state["value"]) - int(bound)) * (1 if int(seq["increment"]) > 0 else -1)
            if difference < 0 or (difference == 0 and not state["called"]):
                raise RuntimeError("Sequência restaurada está atrás dos dados existentes.")
        checked += 1
    return checked


def rehearse(source, destination, identity, root, *, require_source_tls=True, after_snapshot=None, target_storage=None):
    recipient = subprocess.run(["/usr/bin/age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout.strip()
    name = "imortais_rehearsal_" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)
    root = Path(root) / name
    root.mkdir(parents=True, mode=0o700)
    encrypted = root / "source.dump.age"
    with SnapshotSession(source) as session:
        snapshot = session.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT to_jsonb(pg_export_snapshot());")
        info = session.query(INFO_SQL)
        if info["major"] != 18 or info["read_only"] != "on" or info["other_guilds"] != 0 or (require_source_tls and info["tls"] is not True):
            raise RuntimeError("Origem fora da versão/guilda/TLS/leitura esperada.")
        target_major = destination.query("SELECT to_jsonb(current_setting('server_version_num')::int/10000);")
        if target_major != 18:
            raise RuntimeError("Destino precisa ser PostgreSQL18.")
        available = destination.query("SELECT jsonb_agg(name ORDER BY name) FROM pg_available_extensions;")
        if set(info["extensions"] or []) - set(available):
            raise RuntimeError("Há extensões da origem indisponíveis no destino18; revisar imagem antes da cópia.")
        required = 4 * info["bytes"] + 5 * 1024**3
        for path in (root, target_storage or root):
            if shutil.disk_usage(path).free < required:
                raise RuntimeError("Espaço insuficiente para dump e restauração; nenhum banco criado.")
        tables = session.query(TABLES_SQL)
        seqs = session.query(SEQUENCES_SQL)
        checked_tables = tables + ([{"schema":"pg_catalog","table":"pg_largeobject"}] if info["large_objects"] else [])
        print("Conferindo origem no snapshot consistente...", flush=True)
        expected = fingerprints(session.query, checked_tables, "Origem")
        if after_snapshot:
            after_snapshot()
        print("Copiando snapshot com pg_dump e criptografia age...", flush=True)
        encrypt_dump(source, snapshot, recipient, encrypted)
    manifest = {"database": name, "source_database": info["database"], "snapshot": snapshot,
                "guild_id": GUILD, "file": encrypted.name, "bytes": encrypted.stat().st_size,
                "sha256": digest(encrypted), "source": info, "fingerprints": expected, "sequences": seqs}
    private_json(root / "manifest.json", manifest)
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=root) as tmp:
        plain = Path(tmp) / "source.dump"
        if digest(encrypted) != manifest["sha256"]:
            raise RuntimeError("Checksum criptografado divergente; restauração recusada.")
        with plain.open("xb") as output:
            result = subprocess.run(["/usr/bin/age", "-d", "-i", str(identity), str(encrypted)], stdout=output, stderr=subprocess.PIPE, timeout=1800)
        if result.returncode:
            raise RuntimeError("Autenticação/descriptografia age falhou; nenhum banco criado.")
        destination.execute(create_statement(name, info), read_only=False)
        print("BANCO_ENSAIO: " + name, flush=True)
        destination.execute("REVOKE CONNECT ON DATABASE " + ident(name) + " FROM PUBLIC;", read_only=False)
        with (root / "restore.stderr").open("wb") as errors, plain.open("rb") as input_dump:
            restored = subprocess.run([str(destination.bin / "pg_restore"), "--dbname="+name, "--no-password",
                                       "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error"],
                                      env=destination.env(name, read_only=False), stdin=input_dump, stdout=subprocess.DEVNULL, stderr=errors, timeout=1800)
        if restored.returncode:
            raise RuntimeError("pg_restore falhou; banco/criptografado/log privado preservados em " + str(root))
    query = lambda sql: destination.query(sql, name)
    restored_tables = query(TABLES_SQL)
    if restored_tables != tables:
        raise RuntimeError("Lista de tabelas restauradas diverge do snapshot.")
    restored_info = query(INFO_SQL)
    if (restored_info["other_guilds"] != 0 or restored_info["ctas"] != info["ctas"] or
        restored_info["large_objects"] != info["large_objects"] or restored_info["extensions"] != info["extensions"]):
        raise RuntimeError("Conferência de guilda/CTA/large objects/extensões falhou.")
    actual = fingerprints(query, checked_tables, "Destino")
    compare_fingerprints(expected, actual)
    sequence_count = check_sequences(destination, name, seqs)
    report = {"status":"ok", "database":name, "tables":len(tables), "ctas":info["ctas"],
              "fingerprints_match":True, "sequences_checked":sequence_count, "large_objects":info["large_objects"],
              "snapshot":snapshot, "encrypted_sha256":manifest["sha256"], "local_directory":str(root),
              "source_read_only":True, "bot_started":False, "uploaded_to_drive":False}
    private_json(root / "report.json", report)
    print("ENSAIO_RESTAURACAO_OK: " + json.dumps(report, ensure_ascii=False), flush=True)
    return report


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo python3 scripts/migration/rehearse.py.")
    source_db = json.loads(SOURCE.read_text())
    if (source_db.get("host"), source_db.get("port")) != (HOST, PORT) or source_db.get("sslmode") not in ("require","verify-ca","verify-full"):
        raise ValueError("Configuração da origem fora do Railway esperado.")
    cfg = json.loads(target.CONFIG.read_text())
    target.validate_config(cfg)
    if not cfg.get("provisioned"):
        raise ValueError("Execute prepare_pg18.py --apply antes do ensaio.")
    item = target.inspect("container", target.CONTAINER)
    if item is None or not item["State"]["Running"]:
        raise ValueError("Container de destino18 não está em execução.")
    target.validate_container(item, cfg)
    backup_cfg = json.loads(Path("/etc/imortais-cta-backup/config.json").read_text())
    recipient = subprocess.run(["/usr/bin/age-keygen","-y",str(IDENTITY)], check=True, capture_output=True, text=True).stdout.strip()
    if recipient != backup_cfg.get("recipient"):
        raise ValueError("Chave de recuperação difere da chave já guardada fora do servidor.")
    for binary in ("psql","pg_dump","pg_restore"):
        if not (PG_BIN / binary).is_file():
            raise ValueError("Cliente PostgreSQL18 ausente.")
    destination = Postgres({"host":"127.0.0.1","port":target.PORT,"database":"app", "user":"mackna_admin",
                            "password":cfg["admin_password"],"sslmode":"disable"})
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT.parent / "rehearsal.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        storage = json.loads(target.run(["docker","info","--format","{{json .}}"]))["DockerRootDir"]
        rehearse(Postgres(source_db), destination, IDENTITY, ROOT, target_storage=storage)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Ensaio interrompido; banco e cópia criptografada existentes foram preservados.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print("ENSAIO_ERRO: " + (str(exc) if isinstance(exc, (ValueError,RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

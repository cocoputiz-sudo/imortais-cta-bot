#!/usr/bin/env python3
"""Read-only inventory of the allowlisted production database before migration."""
import argparse
import datetime as dt
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, unquote, urlparse

HOST = "ballast.proxy.rlwy.net"
PORT = 34114
GUILD = "683411304408416285"
PG = Path("/usr/lib/postgresql/18/bin/psql")
STATE = Path("/var/lib/imortais-migration")
SOURCE = Path("/etc/imortais-migration/railway-source.json")


def parse_source(raw):
    try:
        parsed = urlparse(raw.strip())
        query = parse_qs(parsed.query, keep_blank_values=True)
        if (parsed.scheme not in ("postgres", "postgresql") or parsed.hostname != HOST or
            parsed.port != PORT or parsed.fragment or not parsed.username or not parsed.password or
            not parsed.path.startswith("/") or not parsed.path[1:] or
            any(key != "sslmode" for key in query) or
            query.get("sslmode", ["require"]) not in (["require"], ["verify-ca"], ["verify-full"])):
            raise ValueError()
        return {"host": HOST, "port": PORT, "database": unquote(parsed.path[1:]),
                "user": unquote(parsed.username), "password": unquote(parsed.password),
                "sslmode": query.get("sslmode", ["require"])[0]}
    except (ValueError, TypeError):
        raise ValueError("Use DATABASE_PUBLIC_URL do Postgres real no Railway; destino/URL recusado.") from None


def environment(db):
    return {"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8", "PGHOST": db["host"],
            "PGPORT": str(db["port"]), "PGDATABASE": db["database"], "PGUSER": db["user"],
            "PGPASSWORD": db["password"], "PGSSLMODE": db["sslmode"], "PGCONNECT_TIMEOUT": "10",
            "PGAPPNAME": "imortais-migration-readonly",
            "PGOPTIONS": "-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=3000"}


def inventory(db):
    sql = """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
    SELECT json_build_object(
      'database', current_database(), 'server_version', current_setting('server_version'),
      'major', current_setting('server_version_num')::int/10000,
      'transaction_read_only', current_setting('transaction_read_only'),
      'tls', (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),
      'bytes', pg_database_size(current_database()),
      'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
      'ctas', (SELECT count(*) FROM public.cta_events),
      'ctas_not_terminal', (SELECT count(*) FROM public.cta_events WHERE status NOT IN ('closed','cancelled')),
      'other_guilds', (SELECT count(*) FROM public.cta_events WHERE guild_id IS DISTINCT FROM '683411304408416285'),
      'extensions', (SELECT json_agg(extname ORDER BY extname) FROM pg_extension),
      'relation_estimates', (SELECT coalesce(json_agg(t ORDER BY t.relname),'[]'::json)
        FROM (SELECT relname, n_live_tup AS estimated_rows FROM pg_stat_user_tables WHERE schemaname='public') t));
    COMMIT;"""
    result = subprocess.run([str(PG), "-XAtw", "-v", "ON_ERROR_STOP=1", "-c", sql],
                            env=environment(db), capture_output=True, timeout=75)
    if result.returncode:
        raise RuntimeError("Consulta de leitura falhou; código " + str(result.returncode) + ". Verifique conexão, TLS e URL no Railway.")
    # psql transaction command tags may share stdout with the single JSON result.
    records = [json.loads(line) for line in result.stdout.decode().splitlines() if line.startswith("{")]
    if len(records) != 1:
        raise RuntimeError("Resposta de diagnóstico inesperada.")
    report = records[0]
    if report["major"] != 18 or report["other_guilds"] != 0 or report["transaction_read_only"] != "on" or report["tls"] is not True:
        raise RuntimeError("Versão/guilda/TLS/leitura fora da produção esperada; preparação interrompida.")
    return report


def private_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or path.is_symlink():
        raise ValueError("Caminho de configuração inválido.")
    fd, temporary = tempfile.mkstemp(prefix=".imortais-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh-source", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo python3 scripts/migration/inspect_railway.py.")
    if not PG.is_file():
        raise ValueError("Instale o cliente compatível: sudo apt-get install postgresql-client-18")
    if SOURCE.exists() and not args.refresh_source:
        db = json.loads(SOURCE.read_text())
        if (db.get("host"), db.get("port")) != (HOST, PORT) or db.get("sslmode") not in ("require", "verify-ca", "verify-full"):
            raise ValueError("Configuração local fora do destino permitido.")
    else:
        if not sys.stdin.isatty():
            raise ValueError("Execute em terminal SSH interativo para manter a entrada da URL oculta.")
        db = parse_source(getpass.getpass("Cole DATABASE_PUBLIC_URL do Postgres real (entrada oculta): "))
    report = inventory(db)
    report.update({"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "guild_id": GUILD,
                   "railway_project_id": "85680aee-6959-4cec-bf50-f7b9a33c359d",
                   "production_commit": "42877561d6b655f2bd0c35f3ee5b6e65458bc283"})
    private_json(SOURCE, db)
    path = STATE / "source-inventory.json"
    private_json(path, report)
    summary = {key: report[key] for key in ("server_version", "tables", "ctas", "ctas_not_terminal", "bytes", "tls", "transaction_read_only")}
    print("ORIGEM_PRODUCAO_OK: " + json.dumps(summary, ensure_ascii=False))
    print("Relatório sem senha: " + str(path))
    print("Diagnóstico somente leitura concluído. Nenhuma cópia, restauração ou troca de bot executada.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("PREPARACAO_ERRO: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

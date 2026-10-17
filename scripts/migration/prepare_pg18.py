#!/usr/bin/env python3
"""Prepare a NEW private PG18 target; never contacts the Railway source."""
import argparse
import fcntl
import grp
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from inspect_railway import private_json

PROJECT = "p7a1de62d78"
INSTANCE = "postgres-imortais-producao"
CONTAINER = "imortais-prod-pg18"
VOLUME = "imortais-prod-pg18-data"
NETWORK = "mk-net-" + PROJECT
ALIAS = "postgres18.imortais-producao.internal"
IMAGE = "postgres:18.6-bookworm"
PORT = 55436
MOUNT = "/var/lib/postgresql"
PGDATA = MOUNT + "/18/docker"
LABEL = "imortais.pg18-target"
CONFIG = Path("/etc/imortais-migration/target18.json")
ENVFILE = CONFIG.with_name("target18.env")
MANAGER = Path("/etc/mackna/postgres.json")
INVENTORY = Path("/var/lib/imortais-migration/source-inventory.json")


def run(args, *, data=None, timeout=120):
    result = subprocess.run(args, input=data, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + " falhou; código " + str(result.returncode))
    return result.stdout.decode().strip()


def inspect(kind, name):
    # list distinguishes an absent resource from a failed Docker daemon request.
    names = run(["docker", kind, "ls", "--format", "{{.Names}}" if kind == "container" else "{{.Name}}",
                 *(["-a"] if kind == "container" else [])]).splitlines()
    if name not in names:
        return None
    return json.loads(run(["docker", kind, "inspect", name]))[0]


def capacity(inventory, total, free, memory_available):
    if (inventory.get("major") != 18 or inventory.get("guild_id") != "683411304408416285" or
        inventory.get("transaction_read_only") != "on" or inventory.get("tls") is not True or
        not isinstance(inventory.get("bytes"), int) or inventory["bytes"] <= 0):
        raise ValueError("Relatório de origem validada não encontrado; execute inspect_railway.py antes.")
    required = max(4 * inventory["bytes"] + 5 * 1024**3, total * 15 // 100)
    report = {"source_bytes": inventory["bytes"], "disk_free_bytes": free,
              "disk_required_bytes": required, "memory_available_bytes": memory_available,
              "memory_required_bytes": 2 * 1024**3}
    report["ok"] = free >= required and memory_available >= report["memory_required_bytes"]
    return report


def validate_config(cfg):
    if any(cfg.get(key) != value for key, value in {
        "project": PROJECT, "instance": INSTANCE, "container": CONTAINER, "volume": VOLUME,
        "network": NETWORK, "port": PORT, "image": IMAGE}.items()):
        raise ValueError("Configuração existente não corresponde ao destino18 reservado.")
    import re
    if any(not re.fullmatch(r"[0-9a-f]{64}", cfg.get(key, ""))
           for key in ("postgres_password", "app_password", "reader_password", "admin_password")):
        raise ValueError("Credenciais do destino inválidas; não regenerar sobre volume existente.")


def validate_container(item, cfg):
    host = item["HostConfig"]
    labels = item["Config"].get("Labels") or {}
    bindings = host.get("PortBindings", {}).get("5432/tcp")
    mounts = [m for m in item.get("Mounts", []) if m.get("Type") == "volume"]
    if (labels.get(LABEL) != INSTANCE or item["Image"] != cfg["image_id"] or
        bindings != [{"HostIp": "127.0.0.1", "HostPort": str(PORT)}] or
        host.get("NetworkMode") != NETWORK or host.get("RestartPolicy", {}).get("Name") != "unless-stopped" or
        host.get("Memory") != 1024**3 or
        len(mounts) != 1 or mounts[0].get("Name") != VOLUME or mounts[0].get("Destination") != MOUNT or
        "PGDATA=" + PGDATA not in item["Config"].get("Env", [])):
        raise ValueError("Container existente difere do destino reservado; preservado sem alterações.")


def dsn(cfg, role, internal=False):
    host, port = (ALIAS, 5432) if internal else ("127.0.0.1", PORT)
    key = {"mackna_reader": "reader_password", "mackna_admin": "admin_password", "imortais_app": "app_password"}[role]
    return f"postgresql://{role}:{cfg[key]}@{host}:{port}/app?sslmode=disable"


def register_manager(cfg, gid):
    original = MANAGER.read_bytes()
    document = json.loads(original)
    instances = document["instances"]
    entry = {"id": INSTANCE, "name": "PostgreSQL18 IMORTAIS (preparação)",
             "reader_dsn": dsn(cfg, "mackna_reader"), "admin_dsn": dsn(cfg, "mackna_admin"),
             "allow_write": True, "protected": False}
    previous = [item for item in instances if item.get("id") == INSTANCE]
    if previous:
        if len(previous) != 1 or previous[0] != entry:
            raise ValueError("Registro PostgreSQL18 já existe e difere; configuração preservada.")
        return
    instances.append(entry)
    fd, temporary = tempfile.mkstemp(prefix=".pg18-", dir=MANAGER.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o640)
            os.fchown(stream.fileno(), 0, gid)
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        if MANAGER.read_bytes() != original:
            raise RuntimeError("Configuração MackNa mudou durante a preparação; repita para preservar alterações.")
        os.replace(temporary, MANAGER)
    finally:
        Path(temporary).unlink(missing_ok=True)


def sql(statement):
    return run(["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "app",
                "-XAtqw", "-v", "ON_ERROR_STOP=1"], data=statement.encode())


def prepare(cfg, gid):
    # Never adopt a pre-existing, unlabelled volume or container.
    volume = inspect("volume", VOLUME)
    if volume and (volume.get("Labels") or {}).get(LABEL) != INSTANCE:
        raise ValueError("Volume de mesmo nome não pertence a esta preparação; preservado.")
    network = inspect("network", NETWORK)
    if network and (network.get("Driver") != "bridge" or
                    (network.get("Labels") or {}).get("mackna.managed") != "true"):
        raise ValueError("Rede existente não corresponde ao projeto MackNa esperado.")
    current = inspect("container", CONTAINER)
    if current:
        validate_container(current, cfg)
    else:
        with socket.socket() as check:
            try:
                check.bind(("127.0.0.1", PORT))
            except OSError:
                raise ValueError("Porta local55436 já está ocupada; nenhum serviço foi parado.") from None
    if not cfg.get("image_id"):
        run(["docker", "pull", IMAGE], timeout=600)
        cfg["image_id"] = json.loads(run(["docker", "image", "inspect", IMAGE]))[0]["Id"]
        private_json(CONFIG, cfg)
    if network is None:
        run(["docker", "network", "create", "--label", "mackna.managed=true", NETWORK])
    if volume is None:
        run(["docker", "volume", "create", "--label", LABEL + "=" + INSTANCE, VOLUME])
    if current is None:
        # Only this private, root-owned file contains the new superuser password.
        ENVFILE.write_text("POSTGRES_USER=postgres\nPOSTGRES_DB=app\nPGDATA=" + PGDATA +
                           "\nPOSTGRES_PASSWORD=" + cfg["postgres_password"] +
                           "\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n")
        os.chmod(ENVFILE, 0o600)
        run(["docker", "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
             "--memory", "1g", "--shm-size", "128m", "--pids-limit", "256",
             "--label", LABEL + "=" + INSTANCE, "--label", "imortais.project=" + PROJECT,
             "--network", NETWORK, "--network-alias", ALIAS,
             "--publish", "127.0.0.1:" + str(PORT) + ":5432",
             "--mount", "type=volume,source=" + VOLUME + ",target=" + MOUNT,
             "--env-file", str(ENVFILE), cfg["image_id"]])
    elif not current["State"]["Running"]:
        run(["docker", "start", CONTAINER])
    deadline = time.monotonic() + 120
    while True:
        result = subprocess.run(["docker", "exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "app"],
                                capture_output=True, timeout=10)
        if result.returncode == 0:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("PostgreSQL18 ainda não ficou pronto; container e volume preservados para diagnóstico.")
        time.sleep(2)
    version = int(sql("SELECT current_setting('server_version_num')::int/10000;"))
    if version != 18:
        raise RuntimeError("Servidor de destino não é PostgreSQL18; interrompido.")
    if not cfg.get("provisioned"):
        if sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';") != "0":
            raise ValueError("Destino contém tabelas e não foi provisionado por este script; preservar dados.")
        statements = "BEGIN;\n"
        for role, key, flags in (("imortais_app", "app_password", "NOCREATEDB NOCREATEROLE"),
                                 ("mackna_reader", "reader_password", "NOCREATEDB NOCREATEROLE"),
                                 ("mackna_admin", "admin_password", "CREATEDB CREATEROLE")):
            statements += f"DO $$BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role}; END IF; END$$;\n"
            statements += f"ALTER ROLE {role} WITH LOGIN NOSUPERUSER NOREPLICATION NOBYPASSRLS {flags} PASSWORD '{cfg[key]}';\n"
        statements += """ALTER DATABASE app OWNER TO imortais_app;
        ALTER SCHEMA public OWNER TO imortais_app;
        REVOKE CONNECT ON DATABASE app FROM PUBLIC;
        GRANT CONNECT ON DATABASE app TO imortais_app, mackna_admin, mackna_reader;
        GRANT pg_read_all_data, pg_monitor TO mackna_reader;
        ALTER ROLE mackna_reader SET default_transaction_read_only=on;
        ALTER ROLE mackna_reader SET statement_timeout='60s';
        GRANT pg_read_all_data, pg_write_all_data, pg_monitor TO mackna_admin;
        GRANT CREATE, TEMPORARY ON DATABASE app TO mackna_admin;
        GRANT CREATE, USAGE ON SCHEMA public TO mackna_admin;
        COMMIT;"""
        sql(statements)
        cfg["provisioned"] = True
        cfg["app_internal_dsn"] = dsn(cfg, "imortais_app", internal=True)
        private_json(CONFIG, cfg)
    register_manager(cfg, gid)
    info = json.loads(sql("SELECT json_build_object('server_version',current_setting('server_version'),'tables',"
                         "(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'));"))
    print("DESTINO_PG18_OK: " + json.dumps({**info, "instance": INSTANCE, "container": CONTAINER,
          "local_port": PORT, "volume": VOLUME, "memory_limit_mb": 1024}, ensure_ascii=False))
    print("Credenciais locais preservadas em /etc/imortais-migration/target18.json (root0600).")
    print("Registrado na aba PostgreSQL do MackNa. Bot continua parado; nenhuma conexão à origem foi feita.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Criar somente o destino privado após verificar capacidade")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo python3 prepare_pg18.py [--apply].")
    inventory = json.loads(INVENTORY.read_text())
    info = json.loads(run(["docker", "info", "--format", "{{json .}} "]))
    usage = shutil.disk_usage(info["DockerRootDir"])
    mem = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    report = capacity(inventory, usage.total, usage.free, int(mem["MemAvailable"].split()[0]) * 1024)
    print("CAPACIDADE_DEBIAN: " + json.dumps(report), flush=True)
    if not report["ok"]:
        raise ValueError("Disco ou memória disponível abaixo da margem de preparação; nenhum recurso criado.")
    if not args.apply:
        print("Somente conferência. Use --apply para preparar o destino18 vazio.")
        return
    gid = grp.getgrnam("mackna").gr_gid
    if not MANAGER.is_file() or MANAGER.is_symlink():
        raise ValueError("Configuração PostgreSQL Manager do MackNa não encontrada.")
    # Separate lock: the inspector uses a different file; no timer is stopped.
    with (CONFIG.parent / "target18.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if CONFIG.is_symlink() or ENVFILE.is_symlink():
            raise ValueError("Arquivo de destino inválido.")
        if CONFIG.exists():
            cfg = json.loads(CONFIG.read_text())
            validate_config(cfg)
        else:
            if inspect("volume", VOLUME) or inspect("container", CONTAINER):
                raise ValueError("Há recursos antigos sem configuração correspondente; preservar e revisar.")
            cfg = {"project": PROJECT, "instance": INSTANCE, "container": CONTAINER,
                   "volume": VOLUME, "network": NETWORK, "port": PORT, "image": IMAGE,
                   **{key: secrets.token_hex(32) for key in ("postgres_password", "app_password", "reader_password", "admin_password")}}
            private_json(CONFIG, cfg)
        prepare(cfg, gid)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Preparação interrompida; recursos existentes preservados.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print("DESTINO_PG18_ERRO: " + (str(exc) if isinstance(exc, (ValueError, RuntimeError)) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python3
"""Restore an approved LOCAL archive as the app role; run only db.init on Node22."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

import prepare_pg18 as target
import prepare_production_env as production
import rehearse as rehearsal
from drive_recovery import load_rehearsal
from inspect_railway import private_json

ROOT = Path("/var/lib/imortais-migration/runtime-rehearsals")
NAME = r"imortais_rehearsal_[0-9]{14}_[0-9a-f]{6}"


def fresh_name():
    return "imortais_rehearsal_" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)


def app_connection(cfg, database, *, internal=False):
    if not re.fullmatch(NAME, database):
        raise ValueError("Somente um banco novo de ensaio pode receber o runtime.")
    return {"host":target.ALIAS if internal else "127.0.0.1", "port":5432 if internal else target.PORT,
            "database":database, "user":"imortais_app", "password":cfg["app_password"], "sslmode":"disable"}


def image_build(repository, directory):
    repository = Path(repository).resolve()
    paths = ["package.json", "package-lock.json", "src", "scripts/migration/runtime"]
    # sudo reads the owner's checkout. Trust ONLY this exact directory for these
    # read calls; do not change global safe.directory or trust all repositories.
    git = ["git", "-c", "safe.directory="+str(repository), "-C", str(repository)]
    commit = target.run([*git, "rev-parse", "HEAD"])
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or target.run(
            [*git, "status", "--porcelain", "--untracked-files=all", "--", *paths]):
        raise ValueError("Arquivos do runtime precisam corresponder ao commit, sem mudanças locais.")
    # A minimal context prevents unrelated local files/credentials entering Docker.
    with tempfile.TemporaryDirectory(prefix=".build-", dir=directory) as tmp:
        context = Path(tmp)
        for path in paths:
            source, dest = repository/path, context/path
            if source.is_symlink() or (source.is_dir() and any(p.is_symlink() for p in source.rglob("*"))):
                raise ValueError("Link externo no contexto do runtime recusado.")
            dest.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, dest)
            else:
                shutil.copyfile(source, dest)
        # Host umask is077; image code must remain readable by USER node.
        # Only these allowlisted, nonsecret context files receive public read.
        for path in context.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
        tag = "imortais-migration-runtime:" + commit[:12]
        with (directory/"build.log").open("wb") as log:
            result = subprocess.run(["docker","build","-f","scripts/migration/runtime/Dockerfile","-t",tag,str(context)],
                                    stdout=log, stderr=subprocess.STDOUT, timeout=900)
        if result.returncode:
            raise RuntimeError("Construção Node22 falhou; veja build.log privado no diretório do ensaio.")
    image = target.run(["docker","image","inspect",tag,"--format","{{.Id}}"])
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
        raise RuntimeError("Identidade da imagem de ensaio inválida.")
    return image, commit


def node_probe(image, cfg, database, directory):
    app_connection(cfg, database, internal=True)
    url = target.dsn(cfg,"imortais_app",internal=True).replace("/app?", "/"+database+"?")
    name = "imortais-runtime-probe-" + secrets.token_hex(6)
    command = ["docker","run","--rm","-i","--name",name,"--network",target.NETWORK,
               "--read-only","--cap-drop=ALL","--security-opt=no-new-privileges",
               "--memory=512m","--pids-limit=128","--tmpfs","/tmp:rw,noexec,nosuid,size=32m",
               "--log-driver=none",image]
    try:
        result = subprocess.run(command, input=json.dumps({"database":database,"database_url":url}).encode(),
                                capture_output=True, timeout=300)
        (directory/"probe.stderr").write_bytes(result.stderr)
        if result.returncode:
            raise RuntimeError("Inicialização/CRUD como usuário do bot falhou; veja probe.stderr privado.")
        report = json.loads(result.stdout)
        if (report.get("status") != "ok" or report.get("database") != database or
            report.get("role") != "imortais_app" or report.get("db_init_runs") != 2 or
            report.get("crud_rollback") is not True or report.get("bot_started") is not False or
            report.get("discord_module_loaded") is not False or report.get("production_secrets_received") is not False):
            raise RuntimeError("Relatório Node22 incompleto.")
        return report
    finally:
        # Only the uniquely named, nonpersistent rehearsal container is removed.
        subprocess.run(["docker","rm","-f",name],capture_output=True,timeout=30)


def restore_and_probe(cfg, admin, archive_dir, identity, directory, image, commit, *, require_source_tls=True):
    manifest = load_rehearsal(archive_dir, require_source_tls=require_source_tls)
    if admin.query("SELECT to_jsonb(current_setting('server_version_num')::int/10000);") != 18:
        raise ValueError("Destino de ensaio deve ser PostgreSQL18.")
    name = fresh_name()
    # Fingerprint the reserved app as an additional check that it stays unchanged.
    app_tables = admin.query(rehearsal.TABLES_SQL,"app")
    app_before = rehearsal.fingerprints(lambda sql:admin.query(sql,"app"),app_tables,"App reservado")
    with tempfile.TemporaryDirectory(prefix=".plaintext-", dir=directory) as tmp:
        plain = Path(tmp)/"source.dump"
        with plain.open("xb") as output:
            decrypt = subprocess.run(["/usr/bin/age","-d","-i",str(identity),str(Path(archive_dir)/"source.dump.age")],
                                     stdout=output,stderr=subprocess.PIPE,timeout=1800)
        if decrypt.returncode:
            raise RuntimeError("Arquivo age não autenticado; nenhum banco criado.")
        statement = rehearsal.create_statement(name,manifest["source"])
        admin.execute(statement[:-1]+" OWNER imortais_app;",read_only=False)
        print("BANCO_RUNTIME_ISOLADO: " + name,flush=True)
        admin.execute("REVOKE CONNECT ON DATABASE "+rehearsal.ident(name)+" FROM PUBLIC;",read_only=False)
        connection = app_connection(cfg,name)
        connection.update({key:admin.db[key] for key in ("host","port")})
        app = rehearsal.Postgres(connection,admin.bin)
        with plain.open("rb") as stream, (directory/"restore.stderr").open("wb") as errors:
            result = subprocess.run([str(app.bin/"pg_restore"),"--dbname="+name,"--no-password","--no-owner",
                                     "--no-acl","--single-transaction","--exit-on-error"],
                                    env=app.env(read_only=False),stdin=stream,stdout=subprocess.DEVNULL,stderr=errors,timeout=1800)
        if result.returncode:
            raise RuntimeError("Restauração como imortais_app falhou; banco isolado e log privado preservados.")
    # Use admin for possible pg_largeobject content reads; all restored objects
    # were nevertheless created by the NON-superuser app session above.
    query = lambda sql:admin.query(sql,name)
    tables = query(rehearsal.TABLES_SQL)
    expected_tables = [{"schema":r["schema"],"table":r["table"]} for r in manifest["fingerprints"] if r["schema"]!="pg_catalog"]
    if tables != expected_tables:
        raise RuntimeError("Tabelas restauradas como app divergem do manifesto.")
    checked = tables + ([{"schema":"pg_catalog","table":"pg_largeobject"}] if manifest["source"]["large_objects"] else [])
    rehearsal.compare_fingerprints(manifest["fingerprints"],rehearsal.fingerprints(query,checked,"Runtime restaurado"))
    rehearsal.check_sequences(admin,name,manifest["sequences"])
    probe = node_probe(image,cfg,name,directory)
    app_after = rehearsal.fingerprints(lambda sql:admin.query(sql,"app"),admin.query(rehearsal.TABLES_SQL,"app"),"App reservado")
    rehearsal.compare_fingerprints(app_before,app_after)
    report = {"status":"ok","database":name,"archive":Path(archive_dir).name,
              "encrypted_sha256":manifest["sha256"],"fingerprints_before_init_match":True,
              "app_database_unchanged":True,"source_contacted":False,"bot_started":False,
              "image":image,"commit":commit,"probe":probe,
              "full_web_oauth_telemetry_tested":False,"cutover_allowed":False,
              "checked_at":dt.datetime.now(dt.timezone.utc).isoformat()}
    private_json(directory/"report.json",report)
    print("RUNTIME_BANCO_OK: "+json.dumps(report,ensure_ascii=False),flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rehearsal",required=True,help="Nome exato do ensaio local aprovado")
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid()!=0 or not re.fullmatch(NAME,args.rehearsal):
        raise ValueError("Execute com sudo e o nome exato do ensaio local aprovado.")
    cfg = json.loads(target.CONFIG.read_text())
    target.validate_config(cfg)
    if not cfg.get("provisioned"):
        raise ValueError("Destino18 ainda não provisionado.")
    item = target.inspect("container",target.CONTAINER)
    if not item or not item["State"]["Running"]:
        raise ValueError("Destino18 parado; nenhum serviço será iniciado automaticamente.")
    target.validate_container(item,cfg)
    prepared = json.loads(production.PREPARED.read_text())
    if (prepared.get("mode")!="prepared-only" or prepared.get("activation_allowed") is not False or
        prepared.get("project_id")!=target.PROJECT or prepared.get("service_id")!="sca714da427"):
        raise ValueError("Captura das variáveis reais precisa estar preparada e ainda não ativada.")
    archive = rehearsal.ROOT/args.rehearsal
    manifest = load_rehearsal(archive)
    ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (ROOT/"runtime.lock").open("a") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        storage = json.loads(target.run(["docker","info","--format","{{json .}}"]))["DockerRootDir"]
        required = 4*manifest["source"]["bytes"]+5*1024**3
        if any(shutil.disk_usage(p).free<required for p in (ROOT,storage)):
            raise ValueError("Sem margem de disco para outra restauração isolada e imagem Node22.")
        directory = ROOT/(dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ_")+secrets.token_hex(3))
        directory.mkdir(mode=0o700)
        print("EVIDENCIAS_RUNTIME: "+str(directory),flush=True)
        print("Construindo imagem Node22 sem credenciais; esta etapa pode levar alguns minutos...",flush=True)
        image,commit = image_build(Path(__file__).resolve().parents[2],directory)
        admin = rehearsal.Postgres({"host":"127.0.0.1","port":target.PORT,"database":"app",
            "user":"postgres","password":cfg["postgres_password"],"sslmode":"disable"})
        restore_and_probe(cfg,admin,archive,rehearsal.IDENTITY,directory,image,commit)


if __name__=="__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Ensaio interrompido; banco isolado e evidências existentes preservados.",file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print("RUNTIME_BANCO_ERRO: "+(str(exc) if isinstance(exc,(ValueError,RuntimeError)) else type(exc).__name__),file=sys.stderr)
        sys.exit(1)

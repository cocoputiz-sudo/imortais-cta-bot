"""Database-layer runtime exercise, called ONLY by disposable target CI."""
import json
import os
from pathlib import Path
import subprocess

import prepare_pg18 as target
import rehearse as rehearsal
import runtime_rehearsal as runtime


def exercise(cfg, bins, root, identity):
    if os.environ.get("CTA_MIGRATION_DISPOSABLE_CI")!="yes" or os.environ.get("GITHUB_ACTIONS")!="true":
        raise RuntimeError("Disposable CI required.")
    directory = root/"runtime"
    directory.mkdir()
    repository = Path(__file__).resolve().parents[2]
    index = repository/".git/index"
    index_before = (index.read_bytes(),index.stat().st_uid,index.stat().st_gid,index.stat().st_mode)
    original_umask = os.umask(0o077)
    try:
        image,commit = runtime.image_build(repository,directory)
    finally:
        os.umask(original_umask)
    assert (index.read_bytes(),index.stat().st_uid,index.stat().st_gid,index.stat().st_mode)==index_before
    admin = rehearsal.Postgres({"host":"127.0.0.1","port":5432,"database":"app","user":"postgres",
                                "password":cfg["postgres_password"],"sslmode":"disable"},bins)
    fixture = runtime.fresh_name()
    admin.execute("CREATE DATABASE "+rehearsal.ident(fixture)+" OWNER imortais_app TEMPLATE template0;",read_only=False)
    seed = runtime.node_probe(image,cfg,fixture,directory)
    assert seed["status"]=="ok" and seed["ctas"]==0 and seed["db_init_runs"]==2
    app_db = runtime.app_connection(cfg,fixture)
    app_db["port"] = 5432
    source = rehearsal.Postgres(app_db,bins)
    source.execute("INSERT INTO cta_events(guild_id,channel_id,caller_id,time_label) VALUES('683411304408416285','111111111111111111','222222222222222222','CI real schema');",read_only=False)
    archive = rehearsal.rehearse(source,admin,identity,directory/"archives",require_source_tls=False)
    restored = runtime.restore_and_probe(cfg,admin,Path(archive["local_directory"]),identity,directory,image,commit,require_source_tls=False)
    assert restored["app_database_unchanged"] and restored["fingerprints_before_init_match"]
    assert restored["probe"]["ctas"]==1 and restored["probe"]["permissions"]["foreign_owners"]==0
    assert admin.query("SELECT to_jsonb(note) FROM sentinel WHERE id=1;","app")=="IMORTAIS çã"
    assert not list(directory.glob(".plaintext-*"))
    assert not list(directory.glob(".build-*"))
    report = json.loads((directory/"report.json").read_text())
    assert report["source_contacted"] is False and report["bot_started"] is False
    try:
        web = runtime.node_probe(image,cfg,restored["database"],directory,web=True)
    except Exception:
        # Synthetic CI fixtures only, never real credentials or real source data.
        print((directory/"web-probe.stderr").read_text(),flush=True)
        raise
    assert web["oauth_provider_live"] is False and web["public_https_path_tested"] is False
    assert web["telemetry_ingest_persisted"] and web["sse_heartbeat"]
    assert admin.query("SELECT to_jsonb(note) FROM sentinel WHERE id=1;","app")=="IMORTAIS çã"
    print("NODE22_WEB_REHEARSAL_OK: real HTTP bridge/War Room/logo, OAuth provider mock, cookies and denied auth, paired ingest persisted/deduplicated, roster+telemetry SSE with25s heartbeat; app unchanged; live provider/public path NOT tested.")
    # A restored relation with the wrong owner must fail the real init/owner probe.
    admin.execute("ALTER TABLE cta_events OWNER TO postgres;",restored["database"],read_only=False)
    try:
        runtime.node_probe(image,cfg,restored["database"],directory)
    except RuntimeError:
        pass
    else:
        raise AssertionError("Runtime accepted restored tables not owned by app")
    assert not subprocess.run(["docker","ps","-aq","--filter","name=imortais-runtime-probe-"],capture_output=True,check=True).stdout.strip()
    print("NODE22_APP_RUNTIME_OK: real db.init twice, PG18 restore as non-superuser app, fingerprints, CRUD/rollback, sequences; wrong owner rejected; app unchanged; no Discord secrets/module.")

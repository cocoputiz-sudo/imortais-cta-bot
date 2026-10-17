"""Called by the root-only disposable target CI, never directly on a user host."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import prepare_pg18 as target
from rehearse import Postgres, rehearse, fingerprints, compare_fingerprints, TABLES_SQL, digest


def exercise(cfg):
    source_id = os.environ.get("CTA_MIGRATION_CI_CONTAINER", "")
    if os.environ.get("CTA_MIGRATION_DISPOSABLE_CI") != "yes" or os.environ.get("GITHUB_ACTIONS") != "true" or not re.fullmatch(r"[0-9a-f]{12,64}", source_id):
        raise RuntimeError("Disposable CI source is required.")
    source_info = json.loads(subprocess.run(["docker","inspect",source_id],check=True,capture_output=True).stdout)[0]
    network, connection = next(iter(source_info["NetworkSettings"]["Networks"].items()))
    subprocess.run(["docker","network","connect",network,target.CONTAINER], check=True,capture_output=True)

    def source_sql(sql):
        return subprocess.run(["docker","exec","-i",source_id,"psql","-U","postgres","-d","app","-XAtqw","-v","ON_ERROR_STOP=1"],input=sql.encode(),check=True,capture_output=True).stdout

    source_sql("""CREATE TABLE rehearsal_sentinel(id bigserial PRIMARY KEY, note text, amount numeric, moment timestamptz);
    INSERT INTO rehearsal_sentinel(note,amount,moment) VALUES('IMORTAIS çã',12.30,'2026-10-17 12:00:00+00'),(NULL,NULL,NULL);
    CREATE TABLE empty_sentinel(id bigserial PRIMARY KEY);
    SELECT lo_from_bytea(0,decode('010203aabbcc','hex'));""")
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        bins = root / "bin"
        bins.mkdir()
        variables = " ".join("-e " + key for key in ("PGHOST","PGPORT","PGDATABASE","PGUSER","PGPASSWORD","PGSSLMODE","PGCONNECT_TIMEOUT","PGAPPNAME","PGOPTIONS"))
        for binary in ("psql","pg_dump","pg_restore"):
            script = bins / binary
            script.write_text("#!/bin/sh\nexec /usr/bin/docker exec -i " + variables + " " + target.CONTAINER + " /usr/lib/postgresql/18/bin/" + binary + ' "$@"\n')
            script.chmod(0o755)
        identity = root / "key.age"
        subprocess.run(["age-keygen","-o",str(identity)],check=True,capture_output=True)
        source = Postgres({"host":connection["IPAddress"],"port":5432,"database":"app","user":"postgres","password":"ci-disposable-password","sslmode":"disable"},bins)
        destination = Postgres({"host":"127.0.0.1","port":5432,"database":"app","user":"mackna_admin","password":cfg["admin_password"],"sslmode":"disable"},bins)
        def concurrent_write():
            # The source advances after validation. Its exported snapshot must not.
            source_sql("INSERT INTO cta_events VALUES(2,'683411304408416285','open'); INSERT INTO rehearsal_sentinel(note) VALUES('arrived after snapshot');")
        report = rehearse(source,destination,identity,root,require_source_tls=False,after_snapshot=concurrent_write)
        assert report["ctas"] == 1 and report["fingerprints_match"] and report["sequences_checked"] == 2
        assert report["large_objects"] == 1
        name = report["database"]
        assert source_sql("SELECT count(*) FROM cta_events;").strip() == b"2"
        assert destination.query("SELECT to_jsonb(count(*)) FROM public.cta_events;",name) == 1
        assert destination.query("SELECT to_jsonb(note) FROM public.sentinel WHERE id=1;") == "IMORTAIS çã"
        directory = Path(report["local_directory"])
        assert not list(directory.glob(".restore-*"))
        encrypted = directory / "source.dump.age"
        assert digest(encrypted) == report["encrypted_sha256"]
        assert encrypted.read_bytes().startswith(b"age-encryption.org/v1")
        damaged = directory / "damaged.age"
        content = bytearray(encrypted.read_bytes())
        content[-10] ^= 1
        damaged.write_bytes(content)
        failed = subprocess.run(["age","-d","-i",str(identity),str(damaged)],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        assert failed.returncode != 0
        manifest = json.loads((directory/"manifest.json").read_text())
        destination.execute("UPDATE rehearsal_sentinel SET note='changed' WHERE id=1;",name,read_only=False)
        actual = fingerprints(lambda sql: destination.query(sql,name),destination.query(TABLES_SQL,name)+[{"schema":"pg_catalog","table":"pg_largeobject"}],"CI")
        try:
            compare_fingerprints(manifest["fingerprints"],actual)
        except RuntimeError:
            pass
        else:
            raise AssertionError("Changed content with same counts was accepted")
    print("PG18_REHEARSAL_OK: consistent snapshot during concurrent writes; age; new DB; full row fingerprints, owned sequences, LOs and tamper detection; app unchanged.")

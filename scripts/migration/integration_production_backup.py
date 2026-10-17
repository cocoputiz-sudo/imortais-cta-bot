"""Disposable PG18/rclone/age backup queue and downloaded archive restoration."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time

from production_backup import Backend, Worker, FOLDER, GUILD, INSTANCE, HOST, PORT, PG_BIN, digest
from rehearse import INFO_SQL, create_statement
from install_production_backup import UNIT, TIMER_UNIT


def exercise(destination, identity, bins, connection, root, source_sql):
    if os.environ.get("CTA_MIGRATION_DISPOSABLE_CI") != "yes" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Disposable CI only")
    source_sql("ALTER TABLE cta_events ADD COLUMN closed_at timestamptz;")
    drive_dir = root / "automatic-drive"
    drive_dir.mkdir()
    auth = root / "automatic-rclone.conf"
    auth.write_text("[imortais-drive]\ntype=alias\nremote=" + str(drive_dir) + "\n")
    recipient = subprocess.run(["age-keygen", "-y", str(identity)], check=True, capture_output=True, text=True).stdout.strip()
    cfg = {"instance":INSTANCE, "guild_id":GUILD, "folder_id":FOLDER, "remote":"imortais-drive", "recipient":recipient,
           "db":{"host":HOST, "port":PORT, "database":"app", "user":"postgres", "password":"ci-disposable-password", "sslmode":"require"},
           "state_dir":str(root/"automatic-state"), "rclone_config":str(auth), "pg_bin":PG_BIN}
    transport = {**cfg["db"], "host":connection["IPAddress"], "port":5432, "sslmode":"disable"}
    class PartialUpload(Backend):
        fail_once = False
        def upload(self, path, relative):
            if self.fail_once and path.suffix == ".json":
                self.fail_once = False
                raise RuntimeError("Injected Drive outage after encrypted upload")
            super().upload(path, relative)
    backend = PartialUpload(cfg, transport=transport, pg_bin=bins, require_tls=False)
    backend.preflight()
    try:
        backend.sql("INSERT INTO players VALUES(999) RETURNING to_jsonb(id);")
    except RuntimeError:
        pass
    else:
        raise AssertionError("Source session unexpectedly accepted a write")
    # PostgreSQL timestamps round to microseconds; use whole seconds for an
    # exact 120-second boundary assertion shared with SQLite/Python floats.
    baseline = float(int(time.time()))
    now = [baseline]
    worker = Worker(cfg["state_dir"], backend, lambda:now[0])
    try:
        assert worker.run() == 0
        assert worker.db.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1, "Old history must not be replayed"
        source_sql("UPDATE cta_events SET status='closed', closed_at=to_timestamp(" + str(baseline+1) + ") WHERE id=2;")
        now[0] = baseline+120
        worker.run()
        assert worker.db.execute("SELECT uploaded_at FROM jobs WHERE key='cta-2'").fetchone()[0] is None
        now[0] = baseline+121
        backend.fail_once = True
        assert worker.run() == 1
        old_file = next((Path(cfg["state_dir"])/"spool").glob("cta-2-*.dump.age"))
        old_digest = digest(old_file)
        worker.db.close()
        # A later source change must not cause retry to regenerate its snapshot.
        source_sql("INSERT INTO cta_events VALUES(3,'683411304408416285','cancelled',to_timestamp(" + str(baseline+130) + ")); INSERT INTO rehearsal_sentinel(note) VALUES('after encrypted snapshot');")
        backend = Backend(cfg, transport=transport, pg_bin=bins, require_tls=False)
        worker = Worker(cfg["state_dir"], backend, lambda:now[0])
        now[0] = baseline+500
        assert worker.run() == 0
        assert digest(old_file) == old_digest
        assert worker.run() == 0
        assert worker.db.execute("SELECT count(*) FROM jobs WHERE uploaded_at IS NOT NULL").fetchone()[0] == 3
        manifests = list(drive_dir.rglob("*.json"))
        assert len(manifests) == 3 and len(list(drive_dir.rglob("*.age"))) == 3
        assert all("producao/automatico/" in str(path) for path in manifests)
        manifest_path = next(path for path in manifests if path.name.startswith("cta-2-"))
        manifest = json.loads(manifest_path.read_text())
        assert manifest["environment"] == "producao" and manifest["cta_id"] == "2" and manifest["source_read_only"]
        assert "ci-disposable-password" not in manifest_path.read_text()
        relative = str(manifest_path.relative_to(drive_dir).with_name(manifest["file"]))
        with tempfile.TemporaryDirectory(dir=root) as downloaded:
            encrypted = Path(downloaded) / "from-drive.age"
            backend.rclone(["copyto", "imortais-drive:"+relative, str(encrypted), "--immutable", "--checksum"])
            assert digest(encrypted) == manifest["sha256"] == old_digest
            plain = Path(downloaded) / "snapshot.dump"
            with plain.open("xb") as output:
                subprocess.run(["age", "-d", "-i", str(identity), str(encrypted)], stdout=output, check=True, capture_output=False)
            name = "imortais_rehearsal_" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "_" + secrets.token_hex(3)
            destination.execute(create_statement(name, backend.sql(INFO_SQL)), read_only=False)
            with plain.open("rb") as input_dump:
                result = subprocess.run([str(bins/"pg_restore"), "--dbname="+name, "--no-owner", "--no-acl", "--single-transaction", "--exit-on-error"],
                                        env=destination.env(name, read_only=False), stdin=input_dump, capture_output=True, timeout=300)
            assert result.returncode == 0
            assert destination.query("SELECT to_jsonb(count(*)) FROM cta_events;", name) == 2
            assert destination.query("SELECT to_jsonb(status) FROM cta_events WHERE id=2;", name) == "closed"
            assert destination.query("SELECT to_jsonb(count(*)) FROM rehearsal_sentinel;", name) == 3
            assert destination.query("SELECT to_jsonb(count(*)) FROM pg_largeobject_metadata;", name) == 1
            assert destination.query("SELECT to_jsonb(note) FROM sentinel WHERE id=1;") == "IMORTAIS çã"
    finally:
        worker.db.close()
    units = root / "units"
    units.mkdir()
    (units/"imortais-cta-backup-producao.service").write_text(UNIT)
    (units/"imortais-cta-backup-producao.timer").write_text(TIMER_UNIT)
    checked = subprocess.run(["systemd-analyze", "verify", str(units/"imortais-cta-backup-producao.service"), str(units/"imortais-cta-backup-producao.timer")], capture_output=True)
    assert checked.returncode == 0, checked.stderr.decode()
    print("PG18_PRODUCTION_BACKUP_OK: readonly source, 120s delay, closed/cancelled detection, durable restart/partial-upload retry without regenerating, real rclone fresh download, age and PG18 restore with sentinel/LO; app unchanged; systemd units verified. No Google credentials or production used.")

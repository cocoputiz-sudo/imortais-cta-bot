"""Real PostgreSQL/age/rclone round trip. ONLY for a disposable CI database.

The GitHub Actions service binds 127.0.0.1:55435 and provisions the database.
No Google credentials are used; rclone's alias backend exercises upload/checksum.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from worker import Backend, Worker, FOLDER, GUILD, INSTANCE, digest


def main():
    if os.environ.get("CTA_BACKUP_DISPOSABLE_CI") != "yes":
        raise SystemExit("Refusing: this integration test requires a disposable CI PostgreSQL.")
    admin = {"PATH": "/usr/bin:/bin", "PGHOST": "127.0.0.1", "PGPORT": "55435",
             "PGUSER": "postgres", "PGPASSWORD": "ci-disposable-password", "PGDATABASE": "app"}
    pg = Path("/usr/lib/postgresql/16/bin")

    def query(sql, database="app"):
        return subprocess.run([str(pg / "psql"), "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql],
                              env={**admin, "PGDATABASE": database}, check=True,
                              capture_output=True, text=True).stdout.strip()

    query("""
      CREATE ROLE backup_reader LOGIN PASSWORD 'ci-reader-password';
      GRANT pg_read_all_data TO backup_reader;
      CREATE TABLE cta_events (id bigint PRIMARY KEY, guild_id text, status text, closed_at timestamptz);
      CREATE TABLE backup_sentinel (id integer PRIMARY KEY, note text);
      INSERT INTO backup_sentinel VALUES (1, 'IMORTAIS çã'), (2, 'restauração confirmada');
      INSERT INTO cta_events VALUES (1, '1560656943486345298', 'open', NULL);
    """)
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        identity = root / "recovery.agekey"
        subprocess.run(["/usr/bin/age-keygen", "-o", str(identity)], check=True, capture_output=True)
        recipient = subprocess.run(["/usr/bin/age-keygen", "-y", str(identity)],
                                   check=True, capture_output=True, text=True).stdout.strip()
        drive = root / "drive"
        drive.mkdir()
        auth = root / "rclone.conf"
        auth.write_text("[imortais-drive]\ntype = alias\nremote = " + str(drive) + "\n")
        cfg = {"instance": INSTANCE, "guild_id": GUILD, "folder_id": FOLDER,
               "remote": "imortais-drive", "recipient": recipient,
               "state_dir": str(root / "state"), "rclone_config": str(auth), "pg_bin": str(pg),
               "db": {"host": "127.0.0.1", "port": 55435, "database": "app",
                      "user": "backup_reader", "password": "ci-reader-password"}}
        backend = Backend(cfg)
        backend.preflight()
        try:
            backend.sql("INSERT INTO backup_sentinel VALUES (99, 'must fail') RETURNING row_to_json(backup_sentinel)")
        except RuntimeError:
            pass
        else:
            raise AssertionError("Backup connection unexpectedly permits writes")
        worker = Worker(cfg["state_dir"], backend)
        try:
            assert worker.run() == 0
            query("UPDATE cta_events SET status='closed', closed_at=now() WHERE id=1")
            worker.clock = lambda: time.time() + 180
            assert worker.run() == 0
            assert worker.run() == 0
            assert worker.db.execute("SELECT count(*) FROM jobs WHERE uploaded_at IS NOT NULL").fetchone()[0] == 2
            manifests = list(drive.rglob("cta-1-*.json"))
            assert len(manifests) == 1
            manifest = json.loads(manifests[0].read_text())
            artifact = manifests[0].with_name(manifest["file"])
            assert digest(artifact) == manifest["sha256"]
            assert "ci-reader-password" not in manifests[0].read_text()
            assert artifact.read_bytes().startswith(b"age-encryption.org/v1")
            dump = root / "restore.dump"
            with dump.open("wb") as output:
                subprocess.run(["/usr/bin/age", "-d", "-i", str(identity), str(artifact)],
                               stdout=output, check=True)
            assert dump.read_bytes().startswith(b"PGDMP")
            listing = subprocess.run([str(pg / "pg_restore"), "--list", str(dump)],
                                     check=True, capture_output=True, text=True).stdout
            assert "backup_sentinel" in listing and "cta_events" in listing
            query("CREATE DATABASE backup_restore_ci")
            subprocess.run([str(pg / "pg_restore"), "--dbname", "backup_restore_ci", "--no-owner",
                            "--no-acl", "--exit-on-error", str(dump)], env=admin, check=True,
                           capture_output=True)
            assert query("SELECT count(*) FROM backup_sentinel", "backup_restore_ci") == "2"
            assert query("SELECT note FROM backup_sentinel WHERE id=1", "backup_restore_ci") == "IMORTAIS çã"
            assert query("SELECT status FROM cta_events WHERE id=1", "backup_restore_ci") == "closed"
            damaged = bytearray(artifact.read_bytes())
            damaged[-10] ^= 1
            bad = root / "damaged.age"
            bad.write_bytes(damaged)
            result = subprocess.run(["/usr/bin/age", "-d", "-i", str(identity), str(bad)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            assert result.returncode != 0, "Encrypted corruption must fail authentication"
        finally:
            worker.db.close()
    print("ROUNDTRIP_OK: read-only pg_dump, age, rclone, checksum, new-database restore and tamper rejection")


if __name__ == "__main__":
    main()

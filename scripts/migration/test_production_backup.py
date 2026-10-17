import json
from pathlib import Path
import tempfile
import unittest

from production_backup import Worker, Backend, GUILD, FOLDER, INSTANCE, HOST, PORT, PG_BIN, validate_config
from install_production_backup import compare_existing


class FakeBackend:
    def __init__(self):
        self.cfg = {"instance": INSTANCE, "guild_id": GUILD, "folder_id": FOLDER,
                    "remote": "imortais-drive", "recipient": "age1test", "pg_bin": PG_BIN,
                    "db": {"host": HOST, "port": PORT, "database": "railway", "user": "postgres",
                           "password": "test-credential", "sslmode": "require"}}
        self.closed = []
        self.dumps = 0
        self.uploads = {}
        self.offline = False
        self.fail_manifest_once = False

    def inspect(self):
        return {"server_version": "18.6", "tables": 54, "tls": True, "read_only": "on"}

    def events(self, baseline):
        return self.closed

    def snapshot(self, target):
        self.dumps += 1
        target.write_bytes(b"encrypted-snapshot-" + str(self.dumps).encode())
        return self.inspect()

    def upload(self, path, relative):
        if self.offline:
            raise RuntimeError("Google Drive/rclone falhou; código 1")
        if self.fail_manifest_once and path.suffix == ".json":
            self.fail_manifest_once = False
            raise RuntimeError("Google Drive/rclone falhou; código 1")
        existing = self.uploads.get(relative)
        content = path.read_bytes()
        if existing is not None and existing != content:
            raise AssertionError("An immutable backup was overwritten")
        self.uploads[relative] = content


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = FakeBackend()
        self.now = 1000.0
        self.worker = self.open_worker()

    def open_worker(self):
        worker = Worker(self.temp.name, self.backend, lambda: self.now)
        self.addCleanup(worker.db.close)
        return worker

    def add_event(self, id="7", closed=1001.0, status="closed"):
        self.backend.closed.append({"id": id, "closed_at": closed, "status": status})

    def test_initial_backup_and_no_duplicates_on_repeated_scans(self):
        self.assertEqual(self.worker.run(), 0)
        self.add_event()
        self.now = 1120
        self.worker.run()
        self.assertEqual(self.backend.dumps, 1, "wait at least 120 seconds")
        self.now = 1121
        self.worker.run()
        self.worker.run()
        self.assertEqual(self.backend.dumps, 2)
        self.assertEqual(len(self.backend.uploads), 4)

    def test_drive_outage_restart_reuses_exact_snapshot_and_recovers(self):
        self.worker.run()
        self.add_event()
        self.backend.offline = True
        self.now = 1121
        self.assertEqual(self.worker.run(), 1)
        self.assertEqual(self.backend.dumps, 2)
        self.worker.db.close()
        restarted = self.open_worker()
        self.backend.offline = False
        self.now = 1180
        restarted.run()
        self.assertEqual(self.backend.dumps, 2)
        self.now = 1181
        restarted.run()
        self.assertEqual(self.backend.dumps, 2, "retry must preserve the original snapshot")
        self.assertIsNotNone(restarted.db.execute("SELECT uploaded_at FROM jobs WHERE key='cta-7'").fetchone()[0])

    def test_ctas_closed_during_shutdown_are_discovered_after_restart(self):
        self.worker.run()
        self.worker.db.close()
        self.add_event("8", 1050, "cancelled")
        self.add_event("9", 1060)
        self.now = 2000
        restarted = self.open_worker()
        restarted.run()
        self.assertEqual(self.backend.dumps, 3)
        self.assertEqual(restarted.db.execute("SELECT count(*) FROM jobs").fetchone()[0], 3)

    def test_partial_remote_upload_does_not_regenerate_dump(self):
        self.backend.fail_manifest_once = True
        self.assertEqual(self.worker.run(), 1)
        self.now = 1060
        self.assertEqual(self.worker.run(), 0)
        self.assertEqual(self.backend.dumps, 1)
        self.assertEqual(len(self.backend.uploads), 2)

    def test_local_corruption_never_replaces_uploaded_backup(self):
        self.backend.fail_manifest_once = True
        self.worker.run()
        next(Path(self.temp.name).glob("spool/*.age")).write_bytes(b"corrupt")
        self.now = 1060
        self.assertEqual(self.worker.run(), 1)
        self.assertEqual(self.backend.dumps, 1)
        self.assertEqual(len(self.backend.uploads), 1)

    def test_changed_recipient_refuses_existing_queue(self):
        self.worker.run()
        self.backend.cfg["recipient"] = "age1different"
        with self.assertRaisesRegex(RuntimeError, "Destino/chave mudou"):
            self.open_worker().run()

    def test_old_history_not_replayed_and_reinstall_preserves_baseline(self):
        self.worker.run()
        self.add_event("1", 900)
        self.now = 2000
        restarted = self.open_worker()
        self.assertEqual(restarted.initialize(), 1000)
        restarted.run()
        self.assertEqual(self.backend.dumps, 1)

    def test_invalid_event_not_uploaded(self):
        self.worker.run()
        self.add_event(status="open")
        with self.assertRaises(RuntimeError):
            self.worker.run()
        self.assertEqual(self.backend.dumps, 1)

    def test_backoff_is_persistent_and_bounded(self):
        self.backend.offline = True
        for attempt in range(10):
            self.worker.run()
            row = self.worker.db.execute("SELECT attempts,next_try FROM jobs WHERE key='initial'").fetchone()
            self.assertEqual(row["attempts"], attempt + 1)
            self.assertLessEqual(row["next_try"] - self.now, 3600)
            self.now = row["next_try"]
        self.assertEqual(self.backend.dumps, 1)

    def test_allowlist_refuses_staging_local_destinations_and_plaintext(self):
        good = self.backend.cfg
        validate_config(good)
        for key, value in (("host", "127.0.0.1"), ("port", 55436), ("sslmode", "disable")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_config({**good, "db": {**good["db"], key: value}})
        for key, value in (("guild_id", "1560656943486345298"), ("folder_id", "other"), ("pg_bin", "/usr/lib/postgresql/16/bin")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_config({**good, key: value})

    def test_queue_source_changes_are_refused_but_password_rotation_is_allowed(self):
        self.worker.run()
        self.backend.cfg["db"]["password"] = "rotated-secret"
        self.worker.run()
        self.backend.cfg["db"]["database"] = "different"
        with self.assertRaisesRegex(RuntimeError, "Destino/chave mudou"):
            self.open_worker().run()

    def test_install_reuse_cannot_retarget_existing_queue(self):
        current = {**self.backend.cfg, "state_dir":"/state", "rclone_config":"/auth"}
        previous = {**current, "db":{**current["db"], "password":"old-secret"}}
        compare_existing(previous, current)
        for field in ("host", "port", "database", "user", "sslmode"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "Origem mudou"):
                compare_existing(previous, {**current, "db":{**current["db"], field:"changed"}})

    def test_backend_uses_tls_and_readonly_without_inheriting_environment(self):
        env = Backend(self.backend.cfg).pg_env()
        self.assertEqual(env["PGSSLMODE"], "require")
        self.assertIn("default_transaction_read_only=on", env["PGOPTIONS"])
        self.assertNotIn("PGSERVICE", env)
        self.assertNotIn("DISCORD_TOKEN", env)


if __name__ == "__main__":
    unittest.main()


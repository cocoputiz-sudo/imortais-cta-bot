import datetime as dt
import unittest
from unittest.mock import patch

from restore_test import admin_environment, validate_manifest, restore_archive
from worker import GUILD, INSTANCE


class RestoreGuards(unittest.TestCase):
    def test_admin_refuses_other_host_database_port_or_superuser(self):
        def instance(dsn):
            return [{"id": INSTANCE, "allow_write": True, "protected": False, "admin_dsn": dsn}]
        valid = "postgres://mackna_admin:pw%40word@127.0.0.1:55435/app?sslmode=disable"
        self.assertEqual(admin_environment(instance(valid))["PGPASSWORD"], "pw@word")
        for bad in (valid.replace("127.0.0.1", "example.com"), valid.replace("55435", "55433"),
                    valid.replace("/app?", "/production?"), valid.replace("mackna_admin", "postgres"),
                    valid + "&options=unsafe"):
            with self.subTest(dsn=bad), self.assertRaises(ValueError):
                admin_environment(instance(bad))
        config = instance(valid)
        config[0]["protected"] = True
        with self.assertRaises(ValueError):
            admin_environment(config)

    def test_manifest_cannot_change_target_or_paths(self):
        job = {"closed_at": 1792245150, "key": "cta-6", "event_id": "6", "status": "closed"}
        date = dt.datetime.fromtimestamp(job["closed_at"], dt.timezone.utc)
        name = "cta-6-" + date.strftime("%Y%m%dT%H%M%SZ")
        manifest = {"format": "pg_dump-custom+age-v1", "environment": "homologacao", "instance": INSTANCE,
                    "database": "app", "guild_id": GUILD, "cta_id": "6", "status": "closed",
                    "file": name + ".dump.age", "sha256": "a" * 64, "tables": 43, "bytes": 100}
        self.assertEqual(validate_manifest(manifest, job)[1], name)
        for key, value in (("file", "../../other.dump.age"), ("guild_id", "production"),
                           ("cta_id", "5"), ("database", "other"), ("sha256", "bad")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_manifest({**manifest, key: value}, job)

    def test_no_database_creation_for_wrong_admin_endpoint(self):
        with patch("restore_test.Backend") as backend, patch("restore_test.checked") as command:
            with self.assertRaises(ValueError):
                restore_archive({}, {"PGHOST": "remote"}, None, {})
            command.assert_not_called()
            backend.return_value.inspect.assert_called_once()


if __name__ == "__main__":
    unittest.main()

import unittest
from unittest.mock import patch

from inspect_railway import parse_source, environment, inventory, read_inventory_output


class SourceGuards(unittest.TestCase):
    def test_allowlist_and_no_injected_libpq_settings(self):
        good = "postgresql://reader:pw%40word@ballast.proxy.rlwy.net:34114/railway"
        db = parse_source(good)
        self.assertEqual(db["password"], "pw@word")
        self.assertEqual(db["sslmode"], "require")
        for raw in (good.replace("ballast.proxy.rlwy.net", "127.0.0.1"),
                    good.replace(":34114/", ":5432/"), good + "?sslmode=disable",
                    good + "?options=unsafe", good + "#fragment", good + "?sslmode=require&sslmode=disable"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_source(raw)
        env = environment(db)
        self.assertIn("default_transaction_read_only=on", env["PGOPTIONS"])
        self.assertEqual(env["PGSSLMODE"], "require")

    def test_inventory_rejects_wrong_major_guild_tls_or_transaction(self):
        import json
        from types import SimpleNamespace
        good = {"major": 18, "other_guilds": 0, "transaction_read_only": "on", "tls": True}
        db = parse_source("postgres://reader:pw@ballast.proxy.rlwy.net:34114/railway")
        for changes in ({}, {"major": 16}, {"other_guilds": 1}, {"tls": False}, {"transaction_read_only": "off"}):
            report = {**good, **changes}
            result = SimpleNamespace(returncode=0, stdout=(json.dumps(report, indent=2) + "\n").encode())
            with patch("inspect_railway.subprocess.run", return_value=result) as run:
                if changes:
                    with self.assertRaises(RuntimeError):
                        inventory(db)
                else:
                    self.assertEqual(inventory(db), report)
                sql = run.call_args.args[0][-1]
                self.assertIn("REPEATABLE READ READ ONLY", sql)
                self.assertIn("q", run.call_args.args[0][1])

    def test_multiline_json_array_and_invalid_extra_output(self):
        raw = b'{"major":18,"relation_estimates":[{"relname":"cta_events"},\n {"relname":"players"},\n {"relname":"seasons"}]}\n'
        report = read_inventory_output(raw)
        self.assertEqual(len(report["relation_estimates"]), 3)
        for bad in (raw + b'{}', b'BEGIN\n' + raw, b'[]', b'{"broken":'):
            with self.subTest(raw=bad), self.assertRaises(RuntimeError):
                read_inventory_output(bad)


if __name__ == "__main__":
    unittest.main()

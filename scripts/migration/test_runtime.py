import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import runtime_rehearsal as runtime


class RuntimeGuards(unittest.TestCase):
    def test_runtime_connection_refuses_app_and_arbitrary_names(self):
        for name in ("app","postgres","imortais_rehearsal_../../app","imortais_rehearsal_20261017202749_a1f6e1;DROP DATABASE app"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                runtime.app_connection({"app_password":"disposable"},name)
        value = runtime.app_connection({"app_password":"disposable"},"imortais_rehearsal_20261017202749_a1f6e1",internal=True)
        self.assertEqual(value["user"],"imortais_app")
        self.assertEqual(value["host"],"postgres18.imortais-producao.internal")
        self.assertEqual(value["port"],5432)

    def test_bad_archive_never_creates_database(self):
        class Admin:
            def execute(self,*args,**kwargs):
                raise AssertionError("No DDL before valid archive")
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ValueError):
            runtime.restore_and_probe({},Admin(),Path(tmp),Path(tmp)/"unused",Path(tmp),"unused","unused")

    def test_dirty_sources_never_start_docker(self):
        def git(args):
            if "rev-parse" in args:
                return "a"*40
            if "status" in args:
                return " M src/db.js"
            raise AssertionError("Only git reads allowed")
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime.target,"run",side_effect=git), patch.object(runtime.subprocess,"run") as docker:
            with self.assertRaisesRegex(ValueError,"sem mudanças locais"):
                runtime.image_build(Path(tmp),Path(tmp))
            docker.assert_not_called()

    def test_node_refuses_real_database_before_launch(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runtime.subprocess,"run") as docker:
            with self.assertRaises(ValueError):
                runtime.node_probe("unused",{},"app",Path(tmp))
            docker.assert_not_called()

    def test_web_report_cannot_claim_live_oauth_or_skip_checks(self):
        database="imortais_rehearsal_20261017202749_a1f6e1"
        report={"status":"ok","database":database,"role":"imortais_app","db_init_runs":2,
                "bot_started":False,"discord_module_loaded":False,"production_secrets_received":False,
                "oauth_provider_live":False,"public_https_path_tested":False}
        checks=("war_room_html","static_logo","http_bridge_local","oauth_mock_flow","cookie_flags",
                "invalid_state_rejected","nonmember_rejected","forged_cookie_rejected","roster_sse",
                "telemetry_ingest_persisted","telemetry_deduplicated","telemetry_sse","sse_heartbeat",
                "pairing_single_use","pairing_rate_limited","health_no_discord_503")
        report.update({key:True for key in checks})
        runtime.validate_probe_report(report,database,web=True)
        for key in checks:
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                runtime.validate_probe_report({**report,key:False},database,web=True)
        for key in ("oauth_provider_live","public_https_path_tested"):
            with self.subTest(key=key),self.assertRaises(RuntimeError):
                runtime.validate_probe_report({**report,key:True},database,web=True)


if __name__=="__main__":
    unittest.main()

import base64
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time
import unittest

import prepare_production_env as env
import prepare_pg18 as target


def variables(application=env.APP_ID):
    source = {key:"fixture-value" for key in env.REQUIRED}
    for key in source:
        if key.endswith("_ID"):
            source[key] = "123456789012345678"
    source["PREP_VOICE_ID"] = "123456789012345678,223456789012345678"
    source["DISCORD_TOKEN"] = base64.urlsafe_b64encode(application.encode()).decode().rstrip("=") + ".synthetic.fixture"
    source["SESSION_SECRET"] = "same-session-literal-$()-do-not-expand"
    source["TELEMETRY_INGEST_KEY"] = "same-telemetry-secret"
    source["DATABASE_URL"] = "${{Postgres.DATABASE_URL}}"
    source["RAILWAY_SERVICE_ID"] = env.SERVICE
    return source


def target_config():
    return {"project":target.PROJECT, "instance":target.INSTANCE, "container":target.CONTAINER,
            "volume":target.VOLUME, "network":target.NETWORK, "port":target.PORT,
            "image":target.IMAGE, "provisioned":True,
            **{key:"a"*64 for key in ("postgres_password", "app_password", "reader_password", "admin_password")}}


class ProductionEnvironment(unittest.TestCase):
    def test_json_and_quoted_env_preserve_literals_and_multiline_values(self):
        source = variables()
        source["PRESET_TIMES"] = "15:20,17:20"
        source["DISCORD_CLIENT_SECRET"] = 'literal#secret"with\\escapes\nand newline'
        raw = "\n".join(key+"="+json.dumps(value) for key, value in source.items())
        self.assertEqual(env.parse_export(raw), source)
        self.assertEqual(env.parse_export(json.dumps(source)), source)
        self.assertEqual(env.parse_export("#comment\nexport SESSION_SECRET='$(touch /must-not-execute)'"),
                         {"SESSION_SECRET":"$(touch /must-not-execute)"})
        self.assertEqual(env.parse_export('SESSION_SECRET="line1\nline2"'), {"SESSION_SECRET":"line1\nline2"})

    def test_rejects_duplicate_keys_and_invalid_exports_without_values_in_errors(self):
        for raw in ('{"SESSION_SECRET":"private-fixture", "SESSION_SECRET":"duplicate"}',
                    'SESSION_SECRET=private-fixture\nSESSION_SECRET=duplicate',
                    'SESSION_SECRET="private-fixture', 'private-fixture is not an assignment', '\x00private-fixture'):
            with self.subTest(raw=raw), self.assertRaises(ValueError) as error:
                env.parse_export(raw)
            self.assertNotIn("private-fixture", str(error.exception))

    def test_rejects_staging_identity_masked_unresolved_and_wrong_service(self):
        good = variables()
        env.validate_export(good)
        cases = [variables("1560656423107432548"), {**good, "GUILD_ID":"1560656943486345298"},
                 {**good, "DISCORD_CLIENT_ID":"1560656423107432548"}, {**good, "SESSION_SECRET":"******"},
                 {**good, "TELEMETRY_INGEST_KEY":"${{shared.SECRET}}"},
                 {**good, "RAILWAY_SERVICE_ID":"wrong-service"}, {**good, "NODE_OPTIONS":"--require /untrusted"},
                 {**good, "OAUTH_REDIRECT":"https://homolog.macknacloud.com.br/auth/callback"},
                 {**good, "CTA_CHANNEL_ID":"not-an-id"}, {**good, "DISCORD_TOKEN":"not-a-token"}]
        for source in cases:
            with self.subTest(keys=list(source)), self.assertRaises(ValueError):
                env.validate_export(source)

    def test_prepared_document_preserves_keys_and_cannot_be_an_activation_map(self):
        original = variables()
        source, prepared, report = env.documents(original, target_config())
        runtime = prepared["runtime_variables"]
        self.assertEqual(source["variables"], original)
        self.assertEqual(runtime["SESSION_SECRET"], original["SESSION_SECRET"])
        self.assertEqual(runtime["TELEMETRY_INGEST_KEY"], original["TELEMETRY_INGEST_KEY"])
        self.assertNotIn("RAILWAY_SERVICE_ID", runtime)
        self.assertIn(target.ALIAS, runtime["DATABASE_URL"])
        self.assertEqual(runtime["PGSSL"], "disable")
        self.assertEqual(runtime["OAUTH_REDIRECT"], env.CALLBACK)
        self.assertFalse(prepared["activation_allowed"])
        self.assertTrue(prepared["requires_final_database_copy"])
        self.assertFalse(report["applied_to_mackna"] or report["bot_started"])
        self.assertNotIn(original["TELEMETRY_INGEST_KEY"], json.dumps(report))
        self.assertNotIn(original["DISCORD_TOKEN"], json.dumps(report))

    def test_root_only_persistence_reuses_source_and_refuses_changed_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            paths = [root/"private/source.json", root/"private/prepared.json", root/"reports/status.json"]
            env.persist(variables(), target_config(), *paths)
            initial = paths[0].read_bytes()
            env.persist(variables(), target_config(), *paths)
            self.assertEqual(paths[0].read_bytes(), initial)
            for path in paths:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaisesRegex(ValueError, "Exportação anterior difere"):
                env.persist({**variables(), "SESSION_SECRET":"changed-key"}, target_config(), *paths)
            self.assertEqual(paths[0].read_bytes(), initial)


class HiddenTerminal(unittest.TestCase):
    def capture(self, *, cancel=False):
        master, slave = pty.openpty()
        before = termios.tcgetattr(slave)
        directory = str(Path(env.__file__).parent)
        code = "import sys; sys.path.insert(0," + repr(directory) + "); from prepare_production_env import read_hidden\n"
        code += "try:\n value=read_hidden(); print('CAPTURE_OK:'+str(len(value)))\nexcept KeyboardInterrupt:\n print('CAPTURE_CANCELLED')\n"
        process = subprocess.Popen([sys.executable, "-c", code], stdin=slave, stdout=slave, stderr=slave)
        output = bytearray()
        def until(token):
            deadline = time.monotonic() + 10
            while token not in output:
                if time.monotonic() >= deadline:
                    self.fail("Timed out waiting for hidden terminal capture")
                if select.select([master], [], [], 0.1)[0]:
                    output.extend(os.read(master, 16384))
        try:
            until(b"FIM_IMORTAIS")
            self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
            if cancel:
                os.kill(process.pid, signal.SIGINT)
                until(b"CAPTURE_CANCELLED")
            else:
                # Exceeds Linux's canonical line limit; no truncation or echo.
                secret = b"PRIVATE-TERMINAL-FIXTURE-" + b"x"*6000
                os.write(master, secret+b"\nFIM_IMORTAIS\n")
                until(b"CAPTURE_OK:"+str(len(secret)).encode())
                self.assertNotIn(secret[:24], output)
            process.wait(timeout=5)
            self.assertEqual(termios.tcgetattr(slave), before)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)

    def test_large_paste_is_hidden_and_terminal_restored(self):
        self.capture()

    def test_ctrl_c_restores_terminal_echo(self):
        self.capture(cancel=True)


if __name__ == "__main__":
    unittest.main()

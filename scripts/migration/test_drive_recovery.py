import json
from pathlib import Path
import shutil
import tempfile
import unittest

import drive_recovery as recovery
from rehearse import digest


class DriveRecoveryGuards(unittest.TestCase):
    def fixture(self, root):
        directory = root / "imortais_rehearsal_20261017202749_a1f6e1"
        directory.mkdir()
        encrypted = directory / "source.dump.age"
        encrypted.write_bytes(b"encrypted-test-fixture")
        manifest = {"database":directory.name, "guild_id":recovery.GUILD, "file":encrypted.name,
                    "sha256":digest(encrypted), "bytes":encrypted.stat().st_size,
                    "source":{"major":18, "other_guilds":0, "ctas":187, "read_only":"on", "tls":True, "bytes":100},
                    "fingerprints":[], "sequences":[]}
        report = {"status":"ok", "database":directory.name, "encrypted_sha256":manifest["sha256"],
                  "fingerprints_match":True, "source_read_only":True, "bot_started":False, "ctas":187}
        (directory / "manifest.json").write_text(json.dumps(manifest))
        (directory / "report.json").write_text(json.dumps(report))
        return directory

    def test_refuses_local_change_and_unapproved_rehearsal(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = self.fixture(Path(tmp))
            recovery.load_rehearsal(directory)
            encrypted = directory / "source.dump.age"
            encrypted.write_bytes(b"changed-test-fixture!!")
            with self.assertRaisesRegex(ValueError, "Cópia local mudou"):
                recovery.load_rehearsal(directory)
            report = json.loads((directory / "report.json").read_text())
            report["fingerprints_match"] = False
            (directory / "report.json").write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "não comprovam"):
                recovery.load_rehearsal(directory)

    def test_remote_is_confined_to_encrypted_artifacts(self):
        drive = recovery.Drive("/unused")
        prefix = "producao/ensaios/imortais_rehearsal_20261017202749_a1f6e1/"
        self.assertTrue(drive.path(prefix+"source.dump.age").startswith("imortais-drive:producao/"))
        for path in ("homologacao/test", prefix+"../../key.age", prefix+"source.dump", prefix+"rclone.conf"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                drive.path(path)

    def test_bad_download_cannot_fall_back_to_local_or_create_database(self):
        class Destination:
            def query(self, sql):
                return 18
            def execute(self, *args, **kwargs):
                raise AssertionError("No database may be created")
        class Remote:
            def __init__(self, source, damage):
                self.source, self.damage = source, damage
            def upload(self, *args):
                pass
            def download(self, relative, local):
                shutil.copyfile(self.source / Path(relative).name, local)
                if Path(relative).name == self.damage:
                    with Path(local).open("ab") as out:
                        out.write(b"corrupted in transit")
        for damage, message in (("manifest.json", "Manifesto baixado"), ("source.dump.age", "SHA-256/tamanho")):
            with self.subTest(damage=damage), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                directory = self.fixture(root)
                with self.assertRaisesRegex(RuntimeError, message):
                    recovery.transfer_and_restore(directory, Destination(), root/"unused-key", Remote(directory, damage), root/"downloads")
                self.assertTrue((directory/"source.dump.age").exists())
                self.assertFalse((directory/"drive-report.json").exists())
                self.assertFalse(list((root/"downloads").glob("*/.plaintext-*")))


if __name__ == "__main__":
    unittest.main()

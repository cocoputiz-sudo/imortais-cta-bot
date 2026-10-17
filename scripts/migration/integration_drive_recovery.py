"""Real rclone transfers via disposable local alias; real age and PostgreSQL18."""
import json
from pathlib import Path

from drive_recovery import Drive, transfer_and_restore


def exercise(destination, identity, source_dir, root):
    store = root / "fake-drive-storage"
    store.mkdir()
    config = root / "rclone.conf"
    config.write_text("[imortais-drive]\ntype = alias\nremote = " + str(store) + "\n")
    config.chmod(0o600)
    drive = Drive(config)
    report = transfer_and_restore(source_dir, destination, identity, drive, root/"drive-downloads", require_source_tls=False)
    assert report["status"] == "ok" and report["fingerprints_match"]
    assert report["restored_from_fresh_download"] and not report["source_contacted"] and not report["bot_started"]
    assert report["database"] != source_dir.name
    assert report["tables"] == 5 and report["ctas"] == 1 and report["sequences_checked"] == 2 and report["large_objects"] == 1
    assert destination.query("SELECT to_jsonb(note) FROM public.sentinel WHERE id=1;") == "IMORTAIS çã"
    assert not list(Path(report["local_directory"]).glob(".plaintext-*"))
    uploaded = sorted(path for path in store.rglob("*") if path.is_file())
    assert len(uploaded) == 3
    assert {path.suffix for path in uploaded} == {".age", ".json"}
    assert json.loads((source_dir / "drive-report.json").read_text()) == report

    # After an otherwise successful upload, corrupted fresh downloads must fail
    # before CREATE DATABASE. This also proves the original dump is not reused.
    before = destination.query("SELECT to_jsonb(count(*)) FROM pg_database;")
    class CorruptDownload(Drive):
        def download(self, relative, local):
            super().download(relative, local)
            if relative.endswith("source.dump.age"):
                with Path(local).open("ab") as output:
                    output.write(b"not-the-downloaded-snapshot")
    try:
        transfer_and_restore(source_dir, destination, identity, CorruptDownload(config), root/"corrupt-downloads", require_source_tls=False)
    except RuntimeError as error:
        assert "SHA-256/tamanho" in str(error)
    else:
        raise AssertionError("Corrupt download accepted")
    assert destination.query("SELECT to_jsonb(count(*)) FROM pg_database;") == before
    print("PG18_DRIVE_RECOVERY_OK: real rclone upload/hash/fresh download via disposable alias, age auth, full restore/fingerprints/seqs/LO; corrupt download cannot create DB; app unchanged. No Google credentials used in CI.")

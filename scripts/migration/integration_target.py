"""Disposable CI ONLY: create PG18, check roles, rerun and restart persistence."""
import grp
import json
import os
from pathlib import Path
import subprocess
import sys

import prepare_pg18 as target
from inspect_railway import private_json


def execute(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, timeout=600, **kwargs)


def main():
    if os.environ.get("CTA_MIGRATION_DISPOSABLE_CI") != "yes" or os.environ.get("GITHUB_ACTIONS") != "true" or os.geteuid() != 0:
        raise SystemExit("Only a root process in disposable GitHub CI may run this test.")
    # Refuse existing targets BEFORE entering any cleanup block.
    if target.CONFIG.exists() or target.inspect("container", target.CONTAINER) or target.inspect("volume", target.VOLUME):
        raise SystemExit("Refusing existing target; nothing changed.")
    try:
        grp.getgrnam("mackna")
    except KeyError:
        execute(["groupadd", "--system", "mackna"])
    target.MANAGER.parent.mkdir(parents=True, exist_ok=True)
    original = {"instances": [{"id": "existing-staging", "protected": True}], "unrelated": "preserve"}
    private_json(target.MANAGER, original)
    private_json(target.INVENTORY, {"major": 18, "guild_id": "683411304408416285",
                 "transaction_read_only": "on", "tls": True, "bytes": 64*1024**2})
    target.CONFIG.parent.mkdir(parents=True, exist_ok=True)
    # If target preparation accidentally reads the Railway credentials, it fails.
    (target.CONFIG.parent / "railway-source.json").write_text("must never read Railway credentials here")
    command = [sys.executable, str(Path(target.__file__)), "--apply"]
    try:
        result = execute(command)
        assert b"DESTINO_PG18_OK" in result.stdout
        cfg_bytes = target.CONFIG.read_bytes()
        cfg = json.loads(cfg_bytes)
        before = target.inspect("container", target.CONTAINER)
        target.validate_container(before, cfg)
        manager_bytes = target.MANAGER.read_bytes()
        manager = json.loads(manager_bytes)
        assert manager["instances"][0] == original["instances"][0] and manager["unrelated"] == "preserve"
        assert len(manager["instances"]) == 2
        assert target.CONFIG.stat().st_mode & 0o777 == 0o600
        assert target.MANAGER.stat().st_mode & 0o777 == 0o640

        def role_sql(role, password, sql, *, expected_success=True, writable=False):
            args = ["docker", "exec", "-i", "-e", "PGPASSWORD="+password]
            if writable:
                args += ["-e", "PGOPTIONS=-c default_transaction_read_only=off"]
            args += [target.CONTAINER, "psql", "-h", "127.0.0.1", "-U", role, "-d", "app", "-XAtqw", "-v", "ON_ERROR_STOP=1"]
            output = subprocess.run(args, input=sql.encode(), capture_output=True, timeout=30)
            assert (output.returncode == 0) == expected_success
            return output.stdout.decode().strip()

        role_sql("imortais_app", cfg["app_password"], "CREATE TABLE sentinel(id int, note text); INSERT INTO sentinel VALUES(1,'IMORTAIS çã');")
        assert role_sql("mackna_reader", cfg["reader_password"], "SELECT note FROM sentinel;") == "IMORTAIS çã"
        role_sql("mackna_reader", cfg["reader_password"], "INSERT INTO sentinel VALUES(2,'must fail');", expected_success=False, writable=True)
        assert role_sql("imortais_app", cfg["app_password"], "SELECT rolsuper FROM pg_roles WHERE rolname=current_user;") == "f"
        execute(command)
        assert target.CONFIG.read_bytes() == cfg_bytes and target.MANAGER.read_bytes() == manager_bytes
        assert target.inspect("container", target.CONTAINER)["Id"] == before["Id"]
        execute(["docker", "restart", target.CONTAINER])
        execute(command)
        assert role_sql("imortais_app", cfg["app_password"], "SELECT note FROM sentinel;") == "IMORTAIS çã"
        print("PG18_TARGET_OK: isolated volume/port, least-privilege roles, unchanged credentials/config, restart persistence; no Railway connection.")
        if os.environ.get("CTA_MIGRATION_CI_CONTAINER"):
            from integration_rehearsal import exercise
            exercise(cfg)
    finally:
        for args in (["docker", "rm", "-f", target.CONTAINER], ["docker", "volume", "rm", target.VOLUME], ["docker", "network", "rm", target.NETWORK]):
            subprocess.run(args, capture_output=True, timeout=60)


if __name__ == "__main__":
    main()

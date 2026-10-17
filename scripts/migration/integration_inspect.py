"""Exercise the real inventory SQL and multiline psql output in disposable PG18."""
import os
import re
import subprocess

from inspect_railway import inventory_sql, read_inventory_output


def main():
    container = os.environ.get("CTA_MIGRATION_CI_CONTAINER", "")
    if os.environ.get("CTA_MIGRATION_DISPOSABLE_CI") != "yes" or not re.fullmatch(r"[0-9a-f]{12,64}", container):
        raise SystemExit("Disposable CI container is required.")
    base = ["docker", "exec", container, "psql", "-U", "postgres", "-d", "app", "-XAtqw", "-v", "ON_ERROR_STOP=1", "-c"]
    setup = """CREATE TABLE cta_events (id bigint, guild_id text, status text);
    CREATE TABLE players (id bigint); CREATE TABLE seasons (id bigint);
    INSERT INTO cta_events VALUES (1, '683411304408416285', 'closed');"""
    subprocess.run(base + [setup], check=True, capture_output=True, timeout=30)
    result = subprocess.run(base + [inventory_sql()], check=True, capture_output=True, timeout=30)
    report = read_inventory_output(result.stdout)
    assert report["major"] == 18 and report["tables"] == 3
    assert report["ctas"] == 1 and report["ctas_not_terminal"] == 0
    assert report["other_guilds"] == 0 and report["transaction_read_only"] == "on"
    assert len(report["relation_estimates"]) == 3
    assert b"\n" in result.stdout.rstrip(), "Exercise real multiline JSON, not a single-line fixture"
    print("PG18_INVENTORY_OK: actual SQL in read-only transaction; multiline JSON parsed intact.")


if __name__ == "__main__":
    main()

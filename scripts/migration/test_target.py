import unittest
from copy import deepcopy

from prepare_pg18 import capacity, validate_config, validate_container, PROJECT, INSTANCE, CONTAINER, VOLUME, NETWORK, IMAGE, PORT, MOUNT, PGDATA, LABEL


class TargetGuards(unittest.TestCase):
    def test_capacity_refuses_low_disk_memory_and_wrong_source(self):
        g = 1024**3
        source = {"major": 18, "guild_id": "683411304408416285", "transaction_read_only": "on", "tls": True, "bytes": 9*g}
        self.assertTrue(capacity(source, 100*g, 60*g, 4*g)["ok"])
        self.assertFalse(capacity(source, 100*g, 40*g, 4*g)["ok"])
        self.assertFalse(capacity(source, 100*g, 60*g, g)["ok"])
        with self.assertRaises(ValueError):
            capacity({**source, "major": 16}, 100*g, 60*g, 4*g)

    def test_cannot_adopt_other_project_storage_or_public_port(self):
        cfg = {"project": PROJECT, "instance": INSTANCE, "container": CONTAINER, "volume": VOLUME,
               "network": NETWORK, "port": PORT, "image": IMAGE, "image_id": "sha256:ci",
               **{key: "a"*64 for key in ("postgres_password", "app_password", "reader_password", "admin_password")}}
        validate_config(cfg)
        for key, value in (("port", 55435), ("volume", "homologacao"), ("project", "other")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_config({**cfg, key: value})
        item = {"Image": cfg["image_id"], "Config": {"Labels": {LABEL: INSTANCE}, "Env": ["PGDATA="+PGDATA]},
                "HostConfig": {"PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(PORT)}]},
                               "NetworkMode": NETWORK, "RestartPolicy": {"Name": "unless-stopped"}, "Memory": 1024**3},
                "Mounts": [{"Type": "volume", "Name": VOLUME, "Destination": MOUNT}]}
        validate_container(item, cfg)
        bad = deepcopy(item)
        bad["HostConfig"]["PortBindings"]["5432/tcp"][0]["HostIp"] = "0.0.0.0"
        with self.assertRaises(ValueError):
            validate_container(bad, cfg)
        bad = deepcopy(item)
        bad["Mounts"][0]["Name"] = "homologacao"
        with self.assertRaises(ValueError):
            validate_container(bad, cfg)


if __name__ == "__main__":
    unittest.main()

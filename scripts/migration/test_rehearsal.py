import unittest

from rehearse import compare_fingerprints, create_statement, ident, literal, Postgres


class RehearsalGuards(unittest.TestCase):
    def test_same_counts_with_changed_contents_are_rejected(self):
        expected = [{"schema":"public","table":"players","count":"7","sum1":"123","sum2":"456"}]
        compare_fingerprints(expected, expected)
        with self.assertRaises(RuntimeError):
            compare_fingerprints(expected, [{**expected[0], "sum2":"457"}])

    def test_cannot_select_app_or_inject_database_name(self):
        info = {"encoding":"UTF8","provider":"c","collate":"C.UTF-8","ctype":"C.UTF-8"}
        for name in ("app", "postgres", 'imortais_rehearsal_20261017200000_abcd12";DROP DATABASE app'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                create_statement(name, info)
        statement = create_statement("imortais_rehearsal_20261017200000_abcd12", info)
        self.assertIn("TEMPLATE template0", statement)
        self.assertNotIn("DROP", statement)
        self.assertEqual(ident('odd"table'), '"odd""table"')
        self.assertEqual(literal("x'y"), "'x''y'")

    def test_source_env_never_inherits_libpq_or_shell_options(self):
        db = {"host":"source","port":1,"database":"source","user":"reader","password":"sensitive","sslmode":"require"}
        env = Postgres(db).env()
        self.assertEqual(env["PGSSLMODE"], "require")
        self.assertIn("default_transaction_read_only=on", env["PGOPTIONS"])
        self.assertNotIn("PGSERVICE", env)


if __name__ == "__main__":
    unittest.main()

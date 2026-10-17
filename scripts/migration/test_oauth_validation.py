from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import install_oauth_validation as install


class OAuthValidationGuards(unittest.TestCase):
    def test_never_grants_a_role_on_reserved_or_arbitrary_database(self):
        with patch.object(install,'private_sql') as sql:
            for name in ('app','postgres','imortais_rehearsal_../../app','imortais_rehearsal_20261017202749_a1f6e1;DROP DATABASE app'):
                with self.subTest(name=name),self.assertRaises(ValueError):
                    install.make_reader(None,name,{})
            sql.assert_not_called()

    def test_only_read_permissions_and_independent_session_secret(self):
        with patch.object(install,'private_sql') as sql:
            first=install.make_reader(None,'imortais_rehearsal_20261017202749_a1f6e1',{})
            second=install.make_reader(None,'imortais_rehearsal_20261017202749_a1f6e1',{})
        self.assertNotEqual(first['role'],second['role'])
        self.assertNotEqual(first['session_secret'],second['session_secret'])
        self.assertNotIn('DISCORD_TOKEN',first)
        statements='\n'.join(call.args[1] for call in sql.call_args_list)
        self.assertIn('NOBYPASSRLS NOINHERIT',statements)
        self.assertIn('default_transaction_read_only=on',statements)
        self.assertIn('GRANT SELECT ON ALL TABLES',statements)
        self.assertNotIn('GRANT INSERT',statements)
        self.assertNotIn('GRANT ALL',statements)

    def test_role_password_sql_never_in_process_arguments(self):
        class Admin:
            bin=Path('/fake')
            def env(self,*args,**kwargs):return {}
        with patch.object(install.subprocess,'run') as run:
            run.return_value.returncode=0
            install.private_sql(Admin(),"PRIVATE PASSWORD 'synthetic';")
        args,kwargs=run.call_args
        self.assertNotIn('synthetic',' '.join(args[0]))
        self.assertEqual(kwargs['input'],b"PRIVATE PASSWORD 'synthetic';")

    def test_secrets_only_in_one_readonly_file_not_container_env_or_argv(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(install.target,'inspect',return_value=None),patch.object(install.target,'run') as docker:
            install.launch('sha256:'+'a'*64,Path(tmp)/'config.json')
        command=docker.call_args.args[0]
        self.assertNotIn('--env',command);self.assertNotIn('--env-file',command)
        self.assertNotIn('--privileged',command);self.assertNotIn('-p',command)
        self.assertIn('--read-only',command)
        self.assertEqual(command[-2:],['node','oauth-web.cjs'])
        self.assertTrue(command[command.index('--mount')+1].endswith(',readonly'))

    def test_existing_container_never_removed_or_replaced(self):
        with patch.object(install.target,'inspect',return_value={'Id':'existing'}),patch.object(install.target,'run') as docker:
            with self.assertRaises(ValueError):install.launch('sha256:'+'a'*64,Path('/fake'))
            docker.assert_not_called()


if __name__=='__main__':unittest.main()

#!/usr/bin/env python3
"""Install a private Node22 browser-login rehearsal over a NEW local DB clone."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time

import inspect_oauth as oauth
import prepare_pg18 as target
import prepare_production_env as production
import rehearse as rehearsal
import runtime_rehearsal as runtime
from inspect_railway import private_json

ROOT = Path('/var/lib/imortais-migration/oauth-validation')
CONFIG = ROOT/'config.json'
REPORT = ROOT/'report.json'
CONTAINER = 'imortais-oauth-validation'
LABEL = 'imortais.oauth-validation'


def private_sql(admin, sql, database=None):
    # Role passwords travel on stdin, never argv/logs.
    result = subprocess.run([str(admin.bin/'psql'),'-XAtqw','-v','ON_ERROR_STOP=1'],
        env=admin.env(database,read_only=False),input=sql.encode(),capture_output=True,timeout=120)
    if result.returncode:
        raise RuntimeError('Preparação da conta de consulta falhou; conteúdo privado não exibido.')


def make_reader(admin, database, cfg):
    if not re.fullmatch(runtime.NAME,database):
        raise ValueError('A conta de consulta só pode acessar um clone isolado.')
    role, password = 'imortais_oauth_'+secrets.token_hex(6), secrets.token_hex(32)
    role_id, db_id = rehearsal.ident(role), rehearsal.ident(database)
    private_sql(admin,f"CREATE ROLE {role_id} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '{password}';\n"
        f"ALTER ROLE {role_id} SET default_transaction_read_only=on;\n"
        f"ALTER ROLE {role_id} SET statement_timeout='15s';\n"
        f"ALTER ROLE {role_id} SET idle_in_transaction_session_timeout='30s';\n"
        f"REVOKE TEMPORARY ON DATABASE {db_id} FROM PUBLIC;\n"
        f"GRANT CONNECT ON DATABASE {db_id} TO {role_id};")
    private_sql(admin,f"REVOKE CREATE ON SCHEMA public FROM PUBLIC;\n"
        f"REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;\n"
        f"GRANT USAGE ON SCHEMA public TO {role_id};\nGRANT SELECT ON ALL TABLES IN SCHEMA public TO {role_id};",database)
    url=f'postgresql://{role}:{password}@{target.ALIAS}:5432/{database}?sslmode=disable'
    return {'database':database,'database_url':url,'role':role,'session_secret':secrets.token_hex(32)}


def save_config(path, value):
    private_json(path,value)
    # Only the mounted FILE is readable by the unprivileged container UID.
    # The enclosing host directory stays root0700; no host-wide readable secret.
    os.chown(path,1000,1000)
    path.chmod(0o400)


def launch(image, config_path):
    if not re.fullmatch(r'sha256:[a-f0-9]{64}',image) or target.inspect('container',CONTAINER):
        raise ValueError('Imagem inválida ou container já existente; nenhum recurso substituído.')
    target.run(['docker','run','-d','--name',CONTAINER,'--label',LABEL+'=v1','--network',target.NETWORK,
        '--network-alias',CONTAINER,'--restart','unless-stopped','--user','1000:1000','--read-only',
        '--cap-drop=ALL','--security-opt=no-new-privileges','--memory=768m','--pids-limit=128',
        '--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--log-driver=none',
        '--mount',f'type=bind,src={config_path.resolve()},dst=/run/imortais-oauth/config.json,readonly',
        image,'node','oauth-web.cjs'])


def validate_container(item, report):
    host, config = item['HostConfig'], item['Config']
    mounts = [m for m in item.get('Mounts',[]) if m.get('Type')!='tmpfs']
    if (config.get('Labels',{}).get(LABEL)!='v1' or item['Image']!=report['image'] or
        config.get('Cmd')!=['node','oauth-web.cjs'] or config.get('User')!='1000:1000' or
        host.get('NetworkMode')!=target.NETWORK or host.get('PortBindings') or host.get('Privileged') or
        not host.get('ReadonlyRootfs') or host.get('RestartPolicy',{}).get('Name')!='unless-stopped' or
        host.get('Memory')!=768*1024**2 or host.get('PidsLimit')!=128 or host.get('CapDrop')!=['ALL'] or
        'no-new-privileges' not in host.get('SecurityOpt',[]) or len(mounts)!=1 or
        mounts[0].get('Type')!='bind' or mounts[0].get('Source')!=str(CONFIG) or
        mounts[0].get('Destination')!='/run/imortais-oauth/config.json' or mounts[0].get('RW')):
        raise ValueError('Container existente diverge da validação reservada; preservado sem alterações.')


def local_check():
    result=target.run(['docker','exec',CONTAINER,'node','oauth-check.cjs'],timeout=60)
    report=json.loads(result)
    if (report.get('mode')!='oauth-validation' or report.get('readOnly') is not True or
        report.get('botStarted') is not False or report.get('localChecksPassed') is not True or
        report.get('discordModuleLoaded') is not False or report.get('oauthBrowserFlowTested') is not False):
        raise RuntimeError('Verificação local incompleta.')
    return report


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rehearsal',required=True)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    os.umask(0o077)
    if os.geteuid()!=0 or not args.apply or not re.fullmatch(runtime.NAME,args.rehearsal):
        raise ValueError('Execute com sudo, --apply e o nome exato do arquivo local aprovado.')
    cfg=json.loads(target.CONFIG.read_text());target.validate_config(cfg)
    pg=target.inspect('container',target.CONTAINER)
    if not cfg.get('provisioned') or not pg or not pg['State']['Running']:
        raise ValueError('Destino PostgreSQL18 precisa estar provisionado e ativo.')
    target.validate_container(pg,cfg)
    source_path=production.SOURCE
    if source_path.is_symlink() or source_path.stat().st_uid!=0 or source_path.stat().st_mode & 0o077:
        raise ValueError('Exportação original precisa permanecer privada root0600.')
    saved=json.loads(source_path.read_text())
    if (saved.get('project_id'),saved.get('environment_id'),saved.get('service_id'))!=(production.PROJECT,production.ENVIRONMENT,production.SERVICE):
        raise ValueError('Exportação pertence a outro serviço.')
    values=production.validate_export(saved['variables'])
    # GET only; the user's approved portal addition must be present, with old URL retained.
    inspection=oauth.inspect(values['DISCORD_TOKEN'])
    private_json(oauth.REPORT,inspection)
    if inspection.get('old_callback_registered') is not True or inspection.get('new_callback_registered') is not True:
        raise ValueError('Confirmar no Discord o callback novo e a preservação do callback antigo.')
    ROOT.mkdir(mode=0o700,parents=True,exist_ok=True)
    if ROOT.is_symlink() or ROOT.stat().st_uid!=0 or ROOT.stat().st_mode & 0o077:
        raise ValueError('Diretório da validação precisa permanecer root0700.')
    with (ROOT/'install.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        existing=target.inspect('container',CONTAINER)
        if REPORT.exists():
            report=json.loads(REPORT.read_text())
            if not existing or not CONFIG.exists() or CONFIG.is_symlink():
                raise ValueError('Estado anterior incompleto; preservar arquivos e banco para diagnóstico.')
            config=json.loads(CONFIG.read_text())
            if (report.get('archive')!=args.rehearsal or config.get('database')!=report.get('database') or
                CONFIG.stat().st_uid!=1000 or CONFIG.stat().st_mode & 0o777!=0o400):
                raise ValueError('Configuração anterior diverge; não substituir conta/sessão/banco.')
            validate_container(existing,report)
            if not existing['State']['Running']:
                raise ValueError('Validação existente parada; não reiniciar automaticamente.')
            print('OAUTH_WEB_LOCAL_OK: '+json.dumps(local_check(),ensure_ascii=False),flush=True)
            return
        if existing or CONFIG.exists():
            raise ValueError('Instalação anterior incompleta; nada será sobrescrito.')
        archive=rehearsal.ROOT/args.rehearsal
        manifest=runtime.load_rehearsal(archive)
        storage=json.loads(target.run(['docker','info','--format','{{json .}}']))['DockerRootDir']
        if any(shutil.disk_usage(p).free<4*manifest['source']['bytes']+5*1024**3 for p in (ROOT,storage)):
            raise ValueError('Sem margem de disco para um novo clone e a imagem Node22.')
        directory=ROOT/('install-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ_')+secrets.token_hex(3))
        directory.mkdir(mode=0o700)
        print('Preparando imagem Node22 e uma cópia nova do arquivo local. Aguarde alguns minutos...',flush=True)
        image,commit=runtime.image_build(Path(__file__).resolve().parents[2],directory)
        admin=rehearsal.Postgres({'host':'127.0.0.1','port':target.PORT,'database':'app','user':'postgres',
            'password':cfg['postgres_password'],'sslmode':'disable'})
        restored=runtime.restore_and_probe(cfg,admin,archive,rehearsal.IDENTITY,directory,image,commit)
        config=make_reader(admin,restored['database'],cfg)
        config.update({'client_secret':values['DISCORD_CLIENT_SECRET'],'staff_role_id':values['STAFF_ROLE_ID'],
            'bomb_leader_role_id':values['BOMB_LEADER_ROLE_ID'],'challenge_ui':values['IMORTAIS_CHALLENGE_UI']})
        save_config(CONFIG,config)
        launch(image,CONFIG)
        report={'mode':'oauth-validation','database':config['database'],'role':config['role'],'image':image,'commit':commit,
            'archive':args.rehearsal,'container':CONTAINER,'bot_started':False,'source_contacted':False,
            'real_client_secret_used':True,'real_bot_token_passed_to_container':False,'new_session_secret':True,
            'public_route_configured_by_installer':False,'cutover_allowed':False,
            'created_at':dt.datetime.now(dt.timezone.utc).isoformat()}
        private_json(REPORT,report)
        validate_container(target.inspect('container',CONTAINER),report)
        for attempt in range(20):
            try:
                check=local_check();break
            except RuntimeError:
                if attempt==19: raise
                time.sleep(2)
        if check.get('databaseName')!=config['database']:
            raise RuntimeError('Prontidão respondeu de outro banco.')
        report['local_check']=check;private_json(REPORT,report)
        print('OAUTH_WEB_LOCAL_OK: '+json.dumps(check,ensure_ascii=False),flush=True)
        print('Próxima etapa: encaminhar o domínio no MackNa para esta validação; login no navegador ainda não testado.',flush=True)


if __name__=='__main__':
    try: main()
    except KeyboardInterrupt:
        print('Validação interrompida; recursos isolados existentes preservados.',file=sys.stderr);sys.exit(130)
    except Exception as exc:
        print('OAUTH_WEB_ERRO: '+(str(exc) if isinstance(exc,(ValueError,RuntimeError)) else type(exc).__name__),file=sys.stderr)
        sys.exit(1)

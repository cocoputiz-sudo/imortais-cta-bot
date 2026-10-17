"""Exercise the exact readonly OAuth bootstrap in disposable PG18/Node22 CI."""
import json
import os
import subprocess

import install_oauth_validation as install
import prepare_pg18 as target
import rehearse as rehearsal


def exercise(cfg, admin, directory, image, database):
    if os.environ.get('CTA_MIGRATION_DISPOSABLE_CI')!='yes' or os.environ.get('GITHUB_ACTIONS')!='true':
        raise RuntimeError('Disposable CI only.')
    if target.inspect('container',install.CONTAINER):
        raise RuntimeError('Refusing existing OAuth container.')
    before=rehearsal.fingerprints(lambda sql:admin.query(sql,database),admin.query(rehearsal.TABLES_SQL,database),'Before readonly OAuth')
    config=install.make_reader(admin,database,cfg)
    config.update({'client_secret':'synthetic-oauth-secret','staff_role_id':'111111111111111111',
        'bomb_leader_role_id':'','challenge_ui':'0'})
    path=directory/'oauth-config.json';install.save_config(path,config)
    # The production launch runs oauth-web.cjs. Only this disposable invocation
    # runs a CI driver, installing the provider mock before the same bootstrap.
    result=subprocess.run(['docker','run','--rm','--name',install.CONTAINER,'--network',target.NETWORK,
        '--user','1000:1000','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
        '--memory=768m','--pids-limit=128','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
        '-e','GITHUB_ACTIONS=true','-e','CTA_MIGRATION_DISPOSABLE_CI=yes',
        '--mount',f'type=bind,src={path.resolve()},dst=/run/imortais-oauth/config.json,readonly',
        image,'node','oauth-ci.cjs'],capture_output=True,timeout=120)
    if result.returncode:
        print(result.stderr.decode(),flush=True)
        raise RuntimeError('Readonly OAuth CI failed.')
    assert b'OAUTH_VALIDATION_CI_OK' in result.stdout
    print(result.stdout.decode(),flush=True)
    rehearsal.compare_fingerprints(before,rehearsal.fingerprints(lambda sql:admin.query(sql,database),admin.query(rehearsal.TABLES_SQL,database),'After readonly OAuth'))
    assert admin.query("SELECT to_jsonb(note) FROM sentinel WHERE id=1;",'app')=='IMORTAIS çã'
    # Real default entrypoint, file permissions, fixed container and readiness.
    try:
        install.launch(image,path)
        import time
        for attempt in range(20):
            try:check=install.local_check();break
            except RuntimeError:
                if attempt==19:raise
                time.sleep(1)
        assert check['databaseName']==database and check['oauthCallbackAt'] is None
        item=target.inspect('container',install.CONTAINER)
        original_config=install.CONFIG
        try:
            install.CONFIG=path
            install.validate_container(item,{'image':image})
        finally:install.CONFIG=original_config
        # Stopped/restarted candidate keeps its private config/session/clone.
        target.run(['docker','restart',install.CONTAINER])
        for attempt in range(20):
            try:assert install.local_check()['databaseName']==database;break
            except RuntimeError:
                if attempt==19:raise
                time.sleep(1)
    finally:
        subprocess.run(['docker','rm','-f',install.CONTAINER],capture_output=True,timeout=30)
    print('OAUTH_VALIDATION_CONTAINER_OK: unprivileged Node22 with private readonly config mount, local readiness, restart persistence; no public route or live OAuth tested.')

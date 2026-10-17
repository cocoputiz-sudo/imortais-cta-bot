#!/usr/bin/env python3
"""GET-only inspection of Discord app callbacks and Debian's HTTPS domain path."""
import datetime as dt
import json
import os
from pathlib import Path
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

import prepare_production_env as production
from inspect_railway import private_json

APPLICATION = "https://discord.com/api/v10/applications/@me"
HEALTH = "https://imortais.macknacloud.com.br/health"
CALLBACK = "https://imortais.macknacloud.com.br/auth/callback"
REPORT = Path("/var/lib/imortais-migration/oauth-inspection.json")
LIMIT = 128*1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None


def request_json(url, token=None):
    if (url not in (APPLICATION,HEALTH) or (token is not None and url!=APPLICATION)):
        raise ValueError("Consulta fora dos dois destinos permitidos.")
    headers={"Accept":"application/json","User-Agent":"DiscordBot (https://github.com/cocoputiz-sudo/imortais-cta-bot, migration-inspection)"}
    if token is not None:
        headers["Authorization"]="Bot "+token
    request=urllib.request.Request(url,headers=headers,method="GET")
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(request,timeout=20) as response:
            raw=response.read(LIMIT+1)
            if response.status!=200 or len(raw)>LIMIT:
                raise RuntimeError("Resposta HTTP inesperada ou grande demais.")
    except urllib.error.HTTPError as exc:
        raise RuntimeError("Consulta GET respondeu HTTP "+str(exc.code)+"; resposta privada não exibida.") from None
    except urllib.error.URLError:
        raise RuntimeError("Consulta HTTPS não concluiu; verificar DNS/rede/certificado pelo Debian.") from None
    try:
        value=json.loads(raw)
    except (ValueError,UnicodeError):
        raise ValueError("Resposta JSON inválida; conteúdo não exibido.") from None
    if not isinstance(value,dict):
        raise ValueError("Resposta JSON não corresponde a um objeto.")
    return value


def application_report(value):
    if value.get("id")!=production.APP_ID:
        raise ValueError("Resposta não corresponde ao app real IMORTAIS.")
    redirects=value.get("redirect_uris")
    if redirects is not None and (not isinstance(redirects,list) or
            any(not isinstance(v,str) for v in redirects)):
        raise ValueError("Lista de callbacks inválida; não inferir cadastro ausente.")
    sanitized=[]
    for raw in redirects or []:
        parts=urllib.parse.urlsplit(raw)
        # A callback may itself contain credentials/query secrets. Never print
        # those; the exact membership checks below operate on the private list.
        sanitized.append(urllib.parse.urlunsplit((parts.scheme,parts.hostname or "",parts.path,"","")))
    return {"app_id":production.APP_ID,"name":str(value.get("name",""))[:120],
        "bot_token_authenticated_for_get":True,"redirect_list_available":redirects is not None,
        "old_callback_registered":None if redirects is None else production.CALLBACK in redirects,
        "new_callback_registered":None if redirects is None else CALLBACK in redirects,
        "registered_callback_paths":sanitized}


def inspect(token, fetch=request_json):
    result=application_report(fetch(APPLICATION,token))
    try:
        value=fetch(HEALTH)
        result["https_from_debian"]={"status":"ok","certificate_verified":True,
            "mode":str(value.get("mode","unknown"))[:80],"bot_started":value.get("botStarted")}
    except (ValueError,RuntimeError):
        result["https_from_debian"]={"status":"not_confirmed","external_client_status":"unknown"}
    return {"status":"inspected",**result,"candidate_callback":CALLBACK,
        "vantage":"debian-host","outside_network_https_tested":False,
        "oauth_browser_flow_tested":False,"gateway_connected":False,
        "discord_configuration_changed":False,"railway_changed":False,"bot_started":False,
        "checked_at":dt.datetime.now(dt.timezone.utc).isoformat()}


def main():
    os.umask(0o077)
    if os.geteuid()!=0:
        raise ValueError("Execute com sudo python3 scripts/migration/inspect_oauth.py.")
    path=production.SOURCE
    if path.is_symlink() or path.stat().st_uid!=0 or path.stat().st_mode & 0o077:
        raise ValueError("Exportação original precisa ser arquivo privado root0600.")
    saved=json.loads(path.read_text())
    if (saved.get("project_id"),saved.get("environment_id"),saved.get("service_id"))!=(production.PROJECT,production.ENVIRONMENT,production.SERVICE):
        raise ValueError("Exportação não corresponde ao serviço real autorizado.")
    values=production.validate_export(saved["variables"])
    report=inspect(values["DISCORD_TOKEN"])
    private_json(REPORT,report)
    print("OAUTH_DIAGNOSTICO_OK: "+json.dumps(report,ensure_ascii=False),flush=True)
    if not report["redirect_list_available"]:
        print("API não retornou a lista de callbacks; conferir no Developer Portal, sem inferir ausência.")
    elif not report["new_callback_registered"]:
        print("Callback novo ausente da lista retornada; nenhuma alteração foi realizada.")


if __name__=="__main__":
    try:
        main()
    except Exception as exc:
        print("OAUTH_DIAGNOSTICO_ERRO: "+(str(exc) if isinstance(exc,(ValueError,RuntimeError)) else type(exc).__name__),file=sys.stderr)
        sys.exit(1)

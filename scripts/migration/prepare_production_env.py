#!/usr/bin/env python3
"""Capture Railway variables into root-only local preparation files; never deploy."""
import argparse
import base64
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import termios

from inspect_railway import private_json
import prepare_pg18 as target

PROJECT = "85680aee-6959-4cec-bf50-f7b9a33c359d"
ENVIRONMENT = "c73b0773-673e-4566-8aaa-4af3c50ec013"
SERVICE = "0686746f-367a-4466-ac3d-fd16acaf7c6f"
APP_ID = "1541617852056862801"
GUILD = "683411304408416285"
CALLBACK = "https://cta-imortais.up.railway.app/auth/callback"
ROOT = Path("/etc/imortais-migration")
SOURCE = ROOT / "production-source-env.json"
PREPARED = ROOT / "production-prepared-env.json"
REPORT = Path("/var/lib/imortais-migration/production-env-preparation.json")
LIMIT = 256 * 1024
MARKER = b"FIM_IMORTAIS"
REQUIRED = frozenset("""BOMB_LEADER_ROLE_ID BOMB_PING_CHANNEL_ID BOMB_ROLE_ID BOMB_VOICE_ID
 CTA_CHANNEL_ID DISCORD_CLIENT_SECRET DISCORD_TOKEN GUILD_SEASON_START_AT
 IMORTAIS_CHALLENGE_UI IMORTAL_ROLE_ID PREP_VOICE_ID PRESET_TIMES SESSION_SECRET
 SPANISH_ROLE_ID STAFF_LOG_CHANNEL_ID STAFF_ROLE_ID TELEMETRY_INGEST_KEY""".split())
OPTIONAL = frozenset(("DATABASE_URL", "DISCORD_CLIENT_ID", "GUILD_ID", "OAUTH_REDIRECT"))


def duplicate_free(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Variável repetida no bloco; exportação recusada.")
        result[key] = value
    return result


def parse_export(raw):
    if not isinstance(raw, str) or len(raw.encode()) > LIMIT or "\x00" in raw:
        raise ValueError("Bloco de variáveis inválido ou maior que256KiB.")
    raw = raw.strip()
    if raw.startswith("{"):
        try:
            result = json.loads(raw, object_pairs_hook=duplicate_free)
        except (ValueError, TypeError):
            raise ValueError("JSON inválido ou com variáveis repetidas; conteúdo não registrado.") from None
        if not isinstance(result, dict):
            raise ValueError("Cole um objeto JSON de variáveis ou linhas NOME=valor.")
        return result
    result, lines = {}, iter(raw.splitlines())
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:]
        match = re.fullmatch(r"([A-Z_][A-Z0-9_]*)\s*=\s*(.*)", line)
        if not match:
            raise ValueError("Linha .env inválida; conteúdo não registrado.")
        key, value = match.groups()
        if key in result:
            raise ValueError("Variável repetida no bloco; exportação recusada.")
        if value.startswith(('"', "'")):
            quote = value[0]
            # Railway permits multiline quoted values. No interpolation/eval.
            while len(value) < 2 or not value.endswith(quote) or (quote == '"' and len(re.search(r"\\*$", value[:-1]).group()) % 2):
                try:
                    value += "\n" + next(lines)
                except StopIteration:
                    raise ValueError("Valor entre aspas incompleto; conteúdo não registrado.") from None
            if quote == '"':
                try:
                    value = json.loads(value, strict=False)
                except ValueError:
                    raise ValueError("Aspas/escapes inválidos no bloco .env; conteúdo não registrado.") from None
            else:
                value = value[1:-1]
        result[key] = value
    return result


def validate_export(values):
    if not isinstance(values, dict) or any(not isinstance(k, str) or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", k) or
                                           not isinstance(v, str) or "\x00" in v for k, v in values.items()):
        raise ValueError("Nomes/valores inválidos; JSON deve conter somente strings.")
    missing = REQUIRED - values.keys()
    if missing:
        raise ValueError("Faltam variáveis do serviço real: " + ", ".join(sorted(missing)))
    if any(key not in REQUIRED | OPTIONAL and not key.startswith("RAILWAY_") for key in values):
        raise ValueError("Há variáveis fora do inventário atual; revisar o serviço selecionado.")
    business = {key:value for key, value in values.items() if not key.startswith("RAILWAY_")}
    for key, value in business.items():
        if key != "DATABASE_URL" and ("${{" in value or re.fullmatch(r"[*•]+", value) or value.lower() in ("[redacted]", "<redacted>", "<hidden>")):
            raise ValueError("Há valores ocultos/referências não resolvidas; copie os valores reais no Railway.")
    for key in ("DISCORD_TOKEN", "DISCORD_CLIENT_SECRET", "SESSION_SECRET", "TELEMETRY_INGEST_KEY", "CTA_CHANNEL_ID", "IMORTAL_ROLE_ID"):
        if not business[key].strip() or business[key] != business[key].strip():
            raise ValueError("Variável essencial vazia ou com espaços externos; revisar a cópia.")
    token = business["DISCORD_TOKEN"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", token):
        raise ValueError("Formato do token Discord inválido; conteúdo não registrado.")
    try:
        first = token.split(".")[0]
        application = base64.urlsafe_b64decode(first + "=" * (-len(first) % 4)).decode("ascii")
    except (ValueError, UnicodeError):
        raise ValueError("Identidade do token Discord inválida.") from None
    if application != APP_ID or business.get("DISCORD_CLIENT_ID", APP_ID) != APP_ID or business.get("GUILD_ID", GUILD) != GUILD:
        raise ValueError("Token/app/guilda não correspondem à produção IMORTAIS; bloco de testes recusado.")
    if business.get("OAUTH_REDIRECT", CALLBACK) != CALLBACK:
        raise ValueError("Callback difere do endereço de produção que precisa ser preservado.")
    for key in REQUIRED:
        if key.endswith("_ID") and business[key]:
            parts = business[key].split(",") if key == "PREP_VOICE_ID" else [business[key]]
            if any(not re.fullmatch(r"[0-9]{17,20}", item.strip()) for item in parts):
                raise ValueError("Formato de canal/cargo inválido; revisar o bloco real.")
    for key, expected in (("RAILWAY_PROJECT_ID", PROJECT), ("RAILWAY_ENVIRONMENT_ID", ENVIRONMENT), ("RAILWAY_SERVICE_ID", SERVICE)):
        if key in values and values[key] != expected:
            raise ValueError("Metadados Railway correspondem a outro projeto/ambiente/serviço.")
    return business


def read_hidden():
    if not sys.stdin.isatty():
        raise ValueError("Execute no terminal SSH interativo; não passe segredos por argumento.")
    fd, data = sys.stdin.fileno(), bytearray()
    original = termios.tcgetattr(fd)
    changed = termios.tcgetattr(fd)
    changed[3] &= ~(termios.ECHO | termios.ICANON)
    changed[6][termios.VMIN], changed[6][termios.VTIME] = 1, 0
    try:
        termios.tcsetattr(fd, termios.TCSANOW, changed)
        print("Cole o bloco do Railway aqui (entrada oculta). Depois Enter, FIM_IMORTAIS e Enter:", flush=True)
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                raise ValueError("Entrada encerrada sem FIM_IMORTAIS; nada foi salvo.")
            data.extend(chunk)
            if len(data) > LIMIT + len(MARKER) + 4:
                raise ValueError("Bloco maior que256KiB; nada foi salvo.")
            match = re.search(rb"(?:^|\n)" + MARKER + rb"\r?\n", data)
            if match:
                try:
                    return bytes(data[:match.start()]).decode("utf-8")
                except UnicodeError:
                    raise ValueError("Entrada não é UTF8; nada foi salvo.") from None
    finally:
        termios.tcflush(fd, termios.TCIFLUSH)
        termios.tcsetattr(fd, termios.TCSANOW, original)
        print(flush=True)


def documents(values, cfg):
    business = validate_export(values)
    target.validate_config(cfg)
    if not cfg.get("provisioned"):
        raise ValueError("Destino18 ainda não está provisionado.")
    runtime = {key:value for key, value in business.items() if key != "DATABASE_URL"}
    runtime.update({"DATABASE_URL":target.dsn(cfg, "imortais_app", internal=True), "PGSSL":"disable",
                    "DISCORD_CLIENT_ID":APP_ID, "GUILD_ID":GUILD, "OAUTH_REDIRECT":CALLBACK,
                    "NODE_ENV":"production", "PORT":"3000"})
    source = {"format":1, "project_id":PROJECT, "environment_id":ENVIRONMENT, "service_id":SERVICE, "variables":values}
    prepared = {"format":1, "mode":"prepared-only", "activation_allowed":False,
                "requires_final_database_copy":True, "requires_runtime_permission_test":True,
                "project_id":target.PROJECT, "service_id":"sca714da427", "runtime_variables":runtime}
    report = {"status":"prepared", "source_service_id":SERVICE, "app_id":APP_ID, "guild_id":GUILD,
              "source_variable_names":sorted(business), "prepared_variable_names":sorted(runtime),
              "session_secret_preserved":runtime["SESSION_SECRET"] == business["SESSION_SECRET"],
              "telemetry_key_preserved":runtime["TELEMETRY_INGEST_KEY"] == business["TELEMETRY_INGEST_KEY"],
              "source_database_url_applied":False, "applied_to_mackna":False, "bot_started":False,
              "token_identity_checked_locally":True, "token_authenticated_against_discord":False,
              "checked_at":dt.datetime.now(dt.timezone.utc).isoformat()}
    return source, prepared, report


def persist(values, cfg, source_path=SOURCE, prepared_path=PREPARED, report_path=REPORT):
    source, prepared, report = documents(values, cfg)
    if source_path.exists() and json.loads(source_path.read_text()) != source:
        raise ValueError("Exportação anterior difere; preservada sem substituir chaves.")
    for path, document in ((source_path, source), (prepared_path, prepared), (report_path, report)):
        private_json(path, document)
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError("Execute com sudo python3 scripts/migration/prepare_production_env.py.")
    if args.status:
        print(json.dumps(json.loads(REPORT.read_text()), ensure_ascii=False, indent=2))
        return
    cfg = json.loads(target.CONFIG.read_text())
    target.validate_config(cfg)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ROOT/"env-import.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if SOURCE.exists():
            saved = json.loads(SOURCE.read_text())
            if (saved.get("project_id"), saved.get("environment_id"), saved.get("service_id")) != (PROJECT, ENVIRONMENT, SERVICE):
                raise ValueError("Exportação anterior corresponde a outro serviço; preservada.")
            values = saved["variables"]
        else:
            values = parse_export(read_hidden())
        report = persist(values, cfg)
    print("VARIAVEIS_PRODUCAO_PREPARADAS: " + json.dumps(report, ensure_ascii=False))
    print("Arquivos root0600 em /etc/imortais-migration; nenhuma variável aplicada ao serviço.")
    print("O banco app do destino ainda precisa da cópia final e testes de permissões; bot não iniciado.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Entrada cancelada; terminal restaurado e nenhuma ativação realizada.", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print("VARIAVEIS_ERRO: " + (str(exc) if isinstance(exc, ValueError) else type(exc).__name__), file=sys.stderr)
        sys.exit(1)

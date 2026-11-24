"""Configure the CBGPU gateway and verify connectivity on container startup."""

import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile, TemporaryFile
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from hermes_yaml import roundtrip_yaml


DATA = Path("/opt/data")
WORKSPACE = DATA / "workspace"
VERIFIED = Path("/tmp/cbgpu-hermes-verified")
BASE_URL = "https://cbgpu.com/api/ai/v1"
MODEL = "cbgpu-qwen38"


class CheckFailed(Exception):
    """An error safe to include in the deployment health output."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def configure():
    VERIFIED.unlink(missing_ok=True)
    allowed_user = os.environ.get("TELEGRAM_ALLOWED_USERS", "").strip()
    if not re.fullmatch(r"[1-9][0-9]{0,15}", allowed_user):
        raise CheckFailed("Configure exactly one Telegram user ID")
    WORKSPACE.mkdir(mode=0o700, exist_ok=True)

    config_path = DATA / "config.yaml"
    yaml = roundtrip_yaml()
    config = yaml.load(config_path) if config_path.exists() else {}
    if config is None:
        config = {}
    if not isinstance(config.get("model"), dict):
        config["model"] = {}
    model = config["model"]
    model.update(
        provider="custom", base_url=BASE_URL, default=MODEL, key_env="CBGPU_API_KEY",
        context_length=65536, supports_vision=True, api_mode="chat_completions",
    )
    for obsolete in ("api_key", "api_key_env", "key_cmd"):
        model.pop(obsolete, None)
    provider = config.setdefault("providers", {}).setdefault("cbgpu", {})
    provider.update(api=BASE_URL, key_env="CBGPU_API_KEY", transport="chat_completions")
    provider.setdefault("extra_body", {})["max_tokens"] = 4096

    config.setdefault("terminal", {}).update(backend="local", cwd=str(WORKSPACE))
    config.setdefault("gateway", {})["unauthorized_dm_behavior"] = "ignore"
    telegram = config.setdefault("platforms", {}).setdefault("telegram", {})
    telegram.update(enabled=True, gateway_restart_notification=False)
    telegram.pop("token", None)
    telegram.setdefault("extra", {}).update(
        allow_from=[allowed_user], dm_policy="allowlist", group_policy="disabled",
        group_allow_from=[], group_allowed_chats=[], allowed_chats=["0"],
        unauthorized_dm_behavior="ignore", guest_mode=False, allow_bots="none",
        observe_unmentioned_group_messages=False,
    )

    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=DATA, delete=False) as output:
        temp_path = Path(output.name)
        try:
            yaml.dump(config, output)
            output.flush()
            os.fsync(output.fileno())
            temp_path.replace(config_path)
        finally:
            temp_path.unlink(missing_ok=True)


def request(label, url, *, key=None, payload=None, timeout=8):
    headers = {
        "User-Agent": "OpenAI/Python 2.24.0", "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if key:
        headers["Authorization"] = f"Bearer {key}"
    body = None if payload is None else json.dumps(payload).encode()
    try:
        with build_opener(NoRedirect).open(Request(url, data=body, headers=headers), timeout=timeout) as response:
            return json.load(response)
    except HTTPError as error:
        raise CheckFailed(f"{label}: HTTP {error.code}") from None
    except Exception:
        raise CheckFailed(f"{label}: connection or response error") from None


def check():
    request("Hermes HTTP health", "http://127.0.0.1:8642/health")
    try:
        state = json.loads((DATA / "gateway_state.json").read_text())
        telegram = state.get("platforms", {}).get("telegram", {})
    except (OSError, ValueError, AttributeError):
        raise CheckFailed("Waiting for Hermes gateway status") from None
    if telegram.get("state") != "connected":
        raise CheckFailed("Telegram polling is not connected")
    if VERIFIED.is_file():
        return

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    key = os.environ.get("CBGPU_API_KEY")
    gateway_key = os.environ.get("API_SERVER_KEY")
    if not token or not key or not gateway_key:
        raise CheckFailed("A required deployment secret is missing")
    identity = request("Telegram getMe", f"https://api.telegram.org/bot{token}/getMe")
    if not identity.get("ok") or not identity.get("result", {}).get("is_bot"):
        raise CheckFailed("Telegram getMe did not identify a bot")
    catalog = request("CBGPU model list", BASE_URL + "/models", key=key)
    if not any(item.get("id") == MODEL for item in catalog.get("data", [])):
        raise CheckFailed("cbgpu-qwen38 is missing from the CBGPU model list")
    answer = request(
        "Hermes test completion", "http://127.0.0.1:8642/v1/chat/completions",
        key=gateway_key, timeout=40,
        payload={
            "model": MODEL,
            "messages": [{"role": "user", "content": "Reply with exactly: CBGPU_OK"}],
        },
    )
    choices = answer.get("choices") or [{}]
    content = choices[0].get("message", {}).get("content")
    if not isinstance(content, str) or content.strip() != "CBGPU_OK":
        raise CheckFailed("Hermes did not return the expected test answer")
    with TemporaryFile(dir=WORKSPACE) as probe:
        probe.write(b"CBGPU_OK")
        probe.seek(0)
        if probe.read() != b"CBGPU_OK":
            raise CheckFailed("The persistent workspace did not preserve the test write")
    VERIFIED.touch(mode=0o600)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["configure"]:
            configure()
        elif sys.argv[1:] == ["check"]:
            check()
        else:
            raise CheckFailed("Expected configure or check")
    except CheckFailed as error:
        sys.exit(str(error))
    except Exception:
        sys.exit("Hermes configuration or health check failed")

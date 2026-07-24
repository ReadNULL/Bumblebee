"""Thin Harbor adapters for the exact Pi package used by Bumblebee."""

import json
import os
import re
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import (
    ApiInternalServerError,
    ApiOverloadedError,
    ApiRateLimitError,
    CliFlag,
    NetworkConnectionError,
    UnknownApiError,
)
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "0.78.1"
NVM_VERSION = "v0.40.2"
NODE_VERSION = "22.20.0"
NODE_DOWNLOAD_MIRROR = "https://npmmirror.com/mirrors/node"
BUMBLEBEE_REPOSITORY = "https://github.com/ReadNULL/Bumblebee.git"
BUMBLEBEE_INSTALL_DIR = "$HOME/.bumblebee-benchmark"
BUMBLEBEE_BENCHMARK_EXTENSION = (
    f"{BUMBLEBEE_INSTALL_DIR}/benchmark/"
    "benchmark_2_terminal_bench_2_1/candidate-extension.ts"
)

# Harbor 0.20.0's built-in Pi adapter does not yet forward DeepSeek
# credentials. Keep provider secrets in the in-memory agent environment so
# Harbor scopes them to setup/run without writing them into the job config.
PROVIDER_CREDENTIAL_ENV = {
    "deepseek": ("DEEPSEEK_API_KEY",),
}


def _node_install_snippet() -> str:
    """Build a pinned Node install command for restricted networks."""

    nvm_installer = (
        "https://raw.githubusercontent.com/nvm-sh/nvm/"
        f"{NVM_VERSION}/install.sh"
    )
    return (
        f"export NVM_NODEJS_ORG_MIRROR={shlex.quote(NODE_DOWNLOAD_MIRROR)} && "
        "curl --fail --silent --show-error --location --retry 3 "
        f"--connect-timeout 15 {shlex.quote(nvm_installer)} | bash && "
        'export NVM_DIR="$HOME/.nvm" && '
        '. "$NVM_DIR/nvm.sh" && '
        f"nvm install {shlex.quote(NODE_VERSION)} && "
        f"nvm alias default {shlex.quote(NODE_VERSION)} && "
        "npm --version"
    )


def _read_terminal_api_error(output_path: Path) -> str | None:
    """Return only an unrecovered terminal API error from Pi's JSONL output."""

    if not output_path.exists():
        return None

    last_retry_end: tuple[bool, str] | None = None
    last_assistant_error: str | None = None
    with output_path.open("r", encoding="utf-8") as output:
        for line in output:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "auto_retry_end":
                last_retry_end = (
                    event.get("success") is True,
                    str(event.get("finalError") or ""),
                )
                continue
            if event.get("type") != "message_end":
                continue
            message = event.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            if message.get("stopReason") == "error":
                last_assistant_error = str(message.get("errorMessage") or "")
            else:
                last_assistant_error = None

    if last_retry_end is not None:
        succeeded, message = last_retry_end
        return None if succeeded else message or "Pi API retries exhausted"
    return last_assistant_error


def _raise_terminal_api_error(output_path: Path) -> None:
    message = _read_terminal_api_error(output_path)
    if message is None:
        return

    normalized = message.casefold()
    detail = message[:500]
    if "503" in normalized or "too busy" in normalized or "overload" in normalized:
        raise ApiOverloadedError(detail)
    if "429" in normalized or "rate limit" in normalized:
        raise ApiRateLimitError(detail)
    if "500" in normalized or "internal server error" in normalized:
        raise ApiInternalServerError(detail)
    if (
        "connection" in normalized
        or "timed out" in normalized
        or "network" in normalized
    ):
        raise NetworkConnectionError(detail)
    raise UnknownApiError(detail)


class PinnedPi(Pi):
    """Harbor's Pi integration with Bumblebee's Pi version pinned."""

    CLI_FLAGS = [
        *Pi.CLI_FLAGS,
        CliFlag(
            "only_explicit_extensions",
            cli="--no-extensions",
            type="bool",
            default=True,
        ),
    ]

    def __init__(
        self,
        *args,
        model_name: str | None = None,
        extra_env: dict[str, str] | None = None,
        **kwargs,
    ):
        scoped_env = dict(extra_env or {})
        provider = model_name.split("/", 1)[0] if model_name else None
        required_keys = PROVIDER_CREDENTIAL_ENV.get(provider or "", ())

        for key in required_keys:
            if key not in scoped_env:
                value = os.environ.get(key)
                if value:
                    scoped_env[key] = value

        missing_keys = [key for key in required_keys if not scoped_env.get(key)]
        if missing_keys:
            raise ValueError(
                f"{', '.join(missing_keys)} is required for provider {provider}"
            )

        super().__init__(
            *args,
            model_name=model_name,
            extra_env=scoped_env,
            **kwargs,
        )

    @staticmethod
    @override
    def name() -> str:
        return "pi-baseline"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl git",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        package_spec = shlex.quote(f"{PI_PACKAGE}@{PI_VERSION}")
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{_node_install_snippet()} && "
                f"npm install -g {package_spec} && "
                "pi --version"
            ),
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await super().run(instruction, environment, context)
        _raise_terminal_api_error(self.logs_dir / self._OUTPUT_FILENAME)


class BumblebeePi(PinnedPi):
    """Pinned Pi plus exactly one commit-pinned Bumblebee extension."""

    CLI_FLAGS = [*PinnedPi.CLI_FLAGS]

    def __init__(
        self,
        *args,
        bumblebee_extension: str | None = None,
        **kwargs,
    ):
        match = re.fullmatch(
            r"git:github\.com/ReadNULL/Bumblebee@([a-fA-F0-9]{40})",
            bumblebee_extension or "",
        )
        if match is None:
            raise ValueError(
                "bumblebee_extension must be "
                "git:github.com/ReadNULL/Bumblebee@<commit>"
            )
        self._bumblebee_commit = match.group(1).lower()
        super().__init__(*args, **kwargs)

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        commit = shlex.quote(self._bumblebee_commit)
        repository = shlex.quote(BUMBLEBEE_REPOSITORY)
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                ". ~/.nvm/nvm.sh; "
                f"test -d \"{BUMBLEBEE_INSTALL_DIR}/.git\" || "
                f"(git init \"{BUMBLEBEE_INSTALL_DIR}\" && "
                f"git -C \"{BUMBLEBEE_INSTALL_DIR}\" remote add "
                f"origin {repository}); "
                f"git -C \"{BUMBLEBEE_INSTALL_DIR}\" fetch "
                f"--depth 1 origin {commit}; "
                f"git -C \"{BUMBLEBEE_INSTALL_DIR}\" checkout "
                "--detach FETCH_HEAD; "
                f"cd \"{BUMBLEBEE_INSTALL_DIR}\"; "
                f"test -f \"{BUMBLEBEE_BENCHMARK_EXTENSION}\"; "
                "npm ci --omit=dev"
            ),
        )

    @override
    def build_cli_flags(self) -> str:
        base_flags = super().build_cli_flags()
        extension_flag = (
            f'--extension "{BUMBLEBEE_BENCHMARK_EXTENSION}"'
        )
        return f"{base_flags} {extension_flag}".strip()

    @staticmethod
    @override
    def name() -> str:
        return "bumblebee-pi"

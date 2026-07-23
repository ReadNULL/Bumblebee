"""Thin Harbor adapters for the exact Pi package used by Bumblebee."""

import re
import shlex
from typing import override

from harbor.agents.installed.base import CliFlag
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment

PI_PACKAGE = "@earendil-works/pi-coding-agent"
PI_VERSION = "0.78.1"
BUMBLEBEE_REPOSITORY = "https://github.com/ReadNULL/Bumblebee.git"
BUMBLEBEE_INSTALL_DIR = "$HOME/.bumblebee-benchmark"


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
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {package_spec} && "
                "pi --version"
            ),
        )


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
                "npm ci --omit=dev"
            ),
        )

    @override
    def build_cli_flags(self) -> str:
        base_flags = super().build_cli_flags()
        extension_flag = (
            f'--extension "{BUMBLEBEE_INSTALL_DIR}"'
        )
        return f"{base_flags} {extension_flag}".strip()

    @staticmethod
    @override
    def name() -> str:
        return "bumblebee-pi"

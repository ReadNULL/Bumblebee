"""Credential forwarding tests for the local Harbor Pi adapter."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harbor.agents.installed.base import ApiOverloadedError

from benchmark.benchmark_2_terminal_bench_2_1.harbor_agent.pi_agent import (
    BUMBLEBEE_BENCHMARK_EXTENSION,
    BUMBLEBEE_INSTALL_DIR,
    BumblebeePi,
    NODE_DOWNLOAD_MIRROR,
    NODE_VERSION,
    PinnedPi,
    _node_install_snippet,
    _raise_terminal_api_error,
    _read_terminal_api_error,
)


class PinnedPiCredentialTest(unittest.TestCase):
    def test_reads_deepseek_key_into_scoped_agent_environment(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            with patch.dict(
                os.environ,
                {"DEEPSEEK_API_KEY": "host-secret"},
                clear=True,
            ):
                agent = PinnedPi(
                    logs_dir=Path(logs_dir),
                    model_name="deepseek/deepseek-v4-flash",
                )

        self.assertEqual(
            agent.extra_env,
            {"DEEPSEEK_API_KEY": "host-secret"},
        )

    def test_explicit_agent_environment_takes_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            with patch.dict(
                os.environ,
                {"DEEPSEEK_API_KEY": "host-secret"},
                clear=True,
            ):
                agent = PinnedPi(
                    logs_dir=Path(logs_dir),
                    model_name="deepseek/deepseek-v4-flash",
                    extra_env={"DEEPSEEK_API_KEY": "configured-secret"},
                )

        self.assertEqual(
            agent.extra_env,
            {"DEEPSEEK_API_KEY": "configured-secret"},
        )

    def test_fails_before_trial_when_deepseek_key_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            with patch.dict(os.environ, {}, clear=True):
                with self.assertRaisesRegex(
                    ValueError,
                    r"DEEPSEEK_API_KEY is required for provider deepseek",
                ):
                    PinnedPi(
                        logs_dir=Path(logs_dir),
                        model_name="deepseek/deepseek-v4-flash",
                    )

    def test_does_not_forward_unrelated_provider_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            with patch.dict(
                os.environ,
                {"DEEPSEEK_API_KEY": "host-secret"},
                clear=True,
            ):
                agent = PinnedPi(
                    logs_dir=Path(logs_dir),
                    model_name="openai/gpt-4o",
                )

        self.assertEqual(agent.extra_env, {})


class PinnedPiInstallTest(unittest.TestCase):
    def test_pins_node_version_and_reachable_download_mirror(self) -> None:
        command = _node_install_snippet()

        self.assertIn(
            f"NVM_NODEJS_ORG_MIRROR={NODE_DOWNLOAD_MIRROR}",
            command,
        )
        self.assertIn(f"nvm install {NODE_VERSION}", command)
        self.assertIn(f"nvm alias default {NODE_VERSION}", command)
        self.assertNotIn("nvm install 22 &&", command)
        self.assertNotIn("https://nodejs.org/dist", command)

    def test_candidate_loads_the_benchmark_authority_wrapper(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            agent = BumblebeePi(
                logs_dir=Path(logs_dir),
                model_name="openai/gpt-4o",
                bumblebee_extension=(
                    "git:github.com/ReadNULL/Bumblebee@"
                    + "0" * 40
                ),
            )

        flags = agent.build_cli_flags()
        self.assertIn(
            f'--extension "{BUMBLEBEE_BENCHMARK_EXTENSION}"',
            flags,
        )
        self.assertNotIn(
            f'--extension "{BUMBLEBEE_INSTALL_DIR}"',
            flags,
        )


class PinnedPiApiErrorTest(unittest.TestCase):
    def test_raises_retriable_error_when_pi_exhausts_503_retries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "pi.txt"
            output_path.write_text(
                "\n".join(
                    [
                        json_line(
                            {
                                "type": "message_end",
                                "message": {
                                    "role": "assistant",
                                    "stopReason": "error",
                                    "errorMessage": "503 Service is too busy",
                                },
                            }
                        ),
                        json_line(
                            {
                                "type": "auto_retry_end",
                                "success": False,
                                "attempt": 3,
                                "finalError": "503 Service is too busy",
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ApiOverloadedError,
                r"503 Service is too busy",
            ):
                _raise_terminal_api_error(output_path)

    def test_ignores_an_api_error_recovered_by_pi_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "pi.txt"
            output_path.write_text(
                "\n".join(
                    [
                        json_line(
                            {
                                "type": "message_end",
                                "message": {
                                    "role": "assistant",
                                    "stopReason": "error",
                                    "errorMessage": "503 Service is too busy",
                                },
                            }
                        ),
                        json_line(
                            {
                                "type": "auto_retry_end",
                                "success": True,
                                "attempt": 1,
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )

            self.assertIsNone(_read_terminal_api_error(output_path))


def json_line(value: object) -> str:
    return json.dumps(value)


if __name__ == "__main__":
    unittest.main()

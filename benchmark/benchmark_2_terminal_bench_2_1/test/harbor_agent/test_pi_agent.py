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
    UV_VERSION,
    _node_install_snippet,
    _preflight_network_command,
    _raise_terminal_api_error,
    _read_terminal_api_error,
    _verifier_dependency_command,
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

    def test_candidate_scopes_the_selected_feature_profile(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            agent = BumblebeePi(
                logs_dir=Path(logs_dir),
                model_name="openai/gpt-4o",
                bumblebee_extension=(
                    "git:github.com/ReadNULL/Bumblebee@"
                    + "0" * 40
                ),
                bumblebee_profile="permission-only",
            )

        self.assertEqual(
            agent.extra_env["BUMBLEBEE_FEATURE_PROFILE"],
            "permission-only",
        )

    def test_rejects_an_unknown_feature_profile(self) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            with self.assertRaisesRegex(
                ValueError,
                r"bumblebee_profile must be",
            ):
                BumblebeePi(
                    logs_dir=Path(logs_dir),
                    model_name="openai/gpt-4o",
                    bumblebee_extension=(
                        "git:github.com/ReadNULL/Bumblebee@"
                        + "0" * 40
                    ),
                    bumblebee_profile="unknown",
                )

    def test_prewarms_only_the_current_verifier_dependencies(self) -> None:
        wal = _verifier_dependency_command("db-wal-recovery")
        merger = _verifier_dependency_command(
            "multi-source-data-merger"
        )
        grpc = _verifier_dependency_command("kv-store-grpc")

        self.assertIn(f"uv/{UV_VERSION}/install.sh", wal)
        self.assertIn("uv python install 3.13", wal)
        self.assertNotIn("pandas==2.3.3", wal)
        self.assertIn("pandas==2.3.3", merger)
        self.assertIn("pyarrow==22.0.0", merger)
        self.assertIn("pytest==8.4.2", grpc)
        self.assertNotIn("uv python install 3.13", grpc)
        self.assertNotIn("python3-pip", wal)
        self.assertIn("test -z \"$missing\"", wal)
        self.assertIn("connect-timeout = 20", wal)
        self.assertIn("max-time = 180", wal)
        self.assertIn("retry-all-errors", wal)

    def test_no_model_preflight_checks_github_and_npm(self) -> None:
        command = _preflight_network_command()

        self.assertIn("git ls-remote --exit-code", command)
        self.assertIn("npm view", command)
        self.assertNotIn("pi --version", command)


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

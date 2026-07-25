"""Credential forwarding tests for the local Harbor Pi adapter."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from harbor.agents.installed.base import (
    ApiOverloadedError,
    ApiUsageLimitError,
    NetworkConnectionError,
)

from benchmark.benchmark_2_terminal_bench_2_1.harbor_agent.pi_agent import (
    APT_MIRROR_HOST,
    BUMBLEBEE_BENCHMARK_EXTENSION,
    BUMBLEBEE_INSTALL_DIR,
    BUMBLEBEE_SOURCE_DIR,
    BumblebeePi,
    CandidateIsolationPreflight,
    NODE_DOWNLOAD_MIRROR,
    NODE_VERSION,
    PinnedPi,
    PYTHON_INSTALL_MIRROR,
    UV_VERSION,
    _candidate_install_command,
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

    def test_classifies_empty_package_index_as_network_failure(self) -> None:
        self.assertTrue(
            any(
                pattern.exception is NetworkConnectionError
                and "from versions: none" in pattern.pattern
                for pattern in PinnedPi.ERROR_PATTERNS
            )
        )

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
        self.assertEqual(
            CandidateIsolationPreflight.name(),
            "candidate-isolation-preflight",
        )

    def test_candidate_install_excludes_benchmark_evidence(self) -> None:
        command = _candidate_install_command("0" * 40)

        self.assertIn("npm pack --silent", command)
        self.assertIn("--strip-components=1", command)
        self.assertIn(
            "cp package-lock.json",
            command,
        )
        self.assertIn(
            f'rm -rf "{BUMBLEBEE_SOURCE_DIR}"',
            command,
        )
        self.assertIn(
            f'test ! -e "{BUMBLEBEE_SOURCE_DIR}"',
            command,
        )
        self.assertIn(
            f'find "{BUMBLEBEE_INSTALL_DIR}" -type f '
            "-name '*.md' -delete",
            command,
        )
        self.assertIn(
            f'test ! -e "{BUMBLEBEE_INSTALL_DIR}/README.md"',
            command,
        )
        self.assertIn(
            "benchmark_2_terminal_bench_2_1/README.md",
            command,
        )
        self.assertNotIn("POSTMORTEM_2026-07-24.md", command)
        self.assertLess(
            command.rindex(
                f'rm -rf "{BUMBLEBEE_SOURCE_DIR}"'
            ),
            command.index("npm ci --omit=dev"),
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
        self.assertIn("retry-max-time = 180", wal)
        self.assertIn("retry-all-errors", wal)
        self.assertIn("UV_HTTP_TIMEOUT=60", wal)
        self.assertIn("UV_HTTP_RETRIES=2", wal)
        self.assertIn(
            f"UV_PYTHON_INSTALL_MIRROR={PYTHON_INSTALL_MIRROR}",
            wal,
        )
        self.assertIn(
            "timeout --signal=TERM 600 "
            "/root/.local/bin/uv python install 3.13",
            wal,
        )
        self.assertIn(APT_MIRROR_HOST, wal)
        self.assertIn('Acquire::ForceIPv4 "true"', wal)
        self.assertLess(
            wal.index('test -z "$missing"'),
            wal.index("apt-get -o Acquire::Retries=3 update"),
        )

    def test_no_model_preflight_checks_github_and_npm(self) -> None:
        command = _preflight_network_command()

        self.assertIn("git ls-remote --exit-code", command)
        self.assertIn("npm view", command)
        self.assertNotIn("pi --version", command)

    def test_classifies_uv_download_timeout_as_retriable_network_error(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as logs_dir:
            agent = PinnedPi(
                logs_dir=Path(logs_dir),
                model_name="openai/gpt-4o",
            )

        error = agent._classify_exec_error(
            "uv python install 3.13",
            SimpleNamespace(
                return_code=1,
                stdout=(
                    "Request failed after 2 retries\n"
                    "Caused by: operation timed out"
                ),
                stderr=None,
            ),
        )

        self.assertIsInstance(error, NetworkConnectionError)


class PinnedPiApiErrorTest(unittest.TestCase):
    def test_classifies_insufficient_balance_as_usage_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_path = Path(directory) / "pi.txt"
            output_path.write_text(
                json_line(
                    {
                        "type": "message_end",
                        "message": {
                            "role": "assistant",
                            "stopReason": "error",
                            "errorMessage": "402 Insufficient Balance",
                        },
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ApiUsageLimitError,
                r"402 Insufficient Balance",
            ):
                _raise_terminal_api_error(output_path)

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

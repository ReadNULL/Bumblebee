"""Credential forwarding tests for the local Harbor Pi adapter."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from benchmark.benchmark_2_terminal_bench_2_1.harbor_agent.pi_agent import (
    PinnedPi,
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


if __name__ == "__main__":
    unittest.main()

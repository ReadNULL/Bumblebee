from __future__ import annotations

import tempfile
import time
import unittest
import re
from argparse import Namespace
from pathlib import Path

from benchmark.benchmark_3_agentdojo_workspace.agentdojo_bridge.run import (
    _agentdojo_model_token,
    _failed_result,
    _now,
    _pipeline_name,
    _prepare_log_directory,
)


class RunStateTest(unittest.TestCase):
    def test_failure_preserves_completed_cases_and_traces(self) -> None:
        source = {
            "status": "failed",
            "cleanCases": [
                {"userTaskId": "user_task_0", "utility": True}
            ],
            "traces": [{"invocationId": "invocation-0"}],
        }

        failed = _failed_result(
            source,
            time.monotonic(),
            "FIXTURE_FAILURE",
            RuntimeError("fixture"),
            retryable=True,
        )

        self.assertEqual(failed["cleanCases"], source["cleanCases"])
        self.assertEqual(failed["traces"], source["traces"])
        self.assertEqual(
            failed["failure"]["code"],
            "FIXTURE_FAILURE",
        )

    def test_formal_run_requires_a_fresh_log_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            log_directory = Path(temporary) / "logs"
            _prepare_log_directory(
                log_directory,
                require_empty=True,
            )
            (log_directory / "existing.json").write_text(
                "{}",
                encoding="utf-8",
            )

            with self.assertRaises(FileExistsError):
                _prepare_log_directory(
                    log_directory,
                    require_empty=True,
                )

    def test_unknown_model_uses_agentdojo_local_attack_identity(self) -> None:
        supported = ("gpt-4o-2024-05-13", "local")

        self.assertEqual(
            _agentdojo_model_token(
                "deepseek-v4-flash",
                supported,
            ),
            "local",
        )
        self.assertEqual(
            _agentdojo_model_token(
                "proxy/gpt-4o-2024-05-13",
                supported,
            ),
            "gpt-4o-2024-05-13",
        )

    def test_pipeline_name_is_parseable_and_bound_to_real_model(self) -> None:
        manifest = {
            "bridge": {
                "approvalPolicy": "allow-once",
                "systemPrompt": "fixture",
            }
        }
        arguments = Namespace(
            profile="bumblebee-full",
            provider="deepseek",
            model="deepseek-v4-flash",
            thinking="high",
            bumblebee_commit="a" * 40,
        )

        pipeline_name = _pipeline_name(
            manifest,
            arguments,
            "b" * 64,
            "0.78.1",
            ("gpt-4o-2024-05-13", "local"),
        )

        self.assertRegex(
            pipeline_name,
            r"^local-bumblebee-bumblebee-full-[0-9a-f]{16}$",
        )

    def test_adapter_timestamp_uses_canonical_milliseconds(self) -> None:
        self.assertIsNotNone(
            re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z",
                _now(),
            )
        )


if __name__ == "__main__":
    unittest.main()

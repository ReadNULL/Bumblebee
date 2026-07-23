from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from benchmark.benchmark_3_agentdojo_workspace.agentdojo_bridge.run import (
    _failed_result,
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


if __name__ == "__main__":
    unittest.main()

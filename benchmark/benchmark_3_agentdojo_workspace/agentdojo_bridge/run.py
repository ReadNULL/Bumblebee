from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence


ADAPTER_VERSION = "1.0.1"
CONTRACT_VERSION = 1
ZERO_SHA256 = "0" * 64


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parse_arguments(argv)
    output_path = arguments.output.resolve()
    if output_path.exists():
        raise FileExistsError(
            f"Result output already exists and is immutable: {output_path}"
        )

    started_at = _now()
    started = time.monotonic()
    adapter_run_id = str(uuid.uuid4())
    manifest = _read_json(arguments.manifest)
    result = _empty_result(
        manifest,
        arguments,
        adapter_run_id,
        started_at,
    )
    exit_code = 0

    try:
        result = _run_benchmark(
            manifest,
            arguments,
            started,
            result,
        )
    except KeyboardInterrupt as error:
        exit_code = 130
        result = _failed_result(
            result,
            started,
            "AGENTDOJO_CANCELLED",
            error,
            retryable=True,
        )
    except Exception as error:
        exit_code = 1
        result = _failed_result(
            result,
            started,
            "AGENTDOJO_ADAPTER_FAILED",
            error,
            retryable=True,
        )

    _write_json_immutable(output_path, result)
    print(
        json.dumps(
            {
                "adapterRunId": adapter_run_id,
                "status": result["status"],
                "output": str(output_path),
            },
            ensure_ascii=False,
        )
    )
    return exit_code


def _run_benchmark(
    manifest: Mapping[str, Any],
    arguments: argparse.Namespace,
    started: float,
    result: dict[str, Any],
) -> dict[str, Any]:
    from agentdojo.attacks.attack_registry import load_attack
    from agentdojo.benchmark import (
        benchmark_suite_with_injections,
        benchmark_suite_without_injections,
    )
    from agentdojo.functions_runtime import FunctionsRuntime
    from agentdojo.logging import OutputLogger
    from agentdojo.models import MODEL_NAMES
    from agentdojo.task_suite.load_suites import get_suite

    from .bridge_server import build_tool_catalog
    from .pi_pipeline import PiAgentPipeline, PiPipelineConfig

    dataset_config = _require_mapping(manifest, "dataset")
    agents_config = _require_mapping(manifest, "agents")
    bridge_config = _require_mapping(manifest, "bridge")
    agentdojo_version = importlib.metadata.version("agentdojo")
    expected_agentdojo_version = str(dataset_config["packageVersion"])
    if agentdojo_version != expected_agentdojo_version:
        raise RuntimeError(
            "AgentDojo version mismatch: "
            f"expected {expected_agentdojo_version}, got {agentdojo_version}"
        )

    repository_root = Path(__file__).resolve().parents[3]
    pi_package_json = (
        repository_root
        / "node_modules"
        / "@earendil-works"
        / "pi-coding-agent"
        / "package.json"
    )
    pi_package = _read_json(pi_package_json)
    pi_version = str(pi_package.get("version", "missing"))
    if pi_version != str(agents_config["piVersion"]):
        raise RuntimeError(
            "pi version mismatch: "
            f"expected {agents_config['piVersion']}, got {pi_version}"
        )

    benchmark_version = str(dataset_config["benchmarkVersion"])
    suite_name = str(dataset_config["suite"])
    attack_name = str(dataset_config["attack"])
    suite = get_suite(benchmark_version, suite_name)
    all_user_ids = sorted(suite.user_tasks)
    all_injection_ids = sorted(suite.injection_tasks)
    selected_user_ids = _select_ids(
        arguments.user_task,
        all_user_ids,
        "user task",
    )
    selected_injection_ids = _select_ids(
        arguments.injection_task,
        all_injection_ids,
        "injection task",
    )

    fingerprint_runtime = FunctionsRuntime(suite.tools)
    catalog = build_tool_catalog(fingerprint_runtime)
    dataset_hash = _dataset_hash(
        benchmark_version,
        suite_name,
        suite,
        catalog,
    )

    node_executable = arguments.node
    pi_cli_path = (
        repository_root
        / "node_modules"
        / "@earendil-works"
        / "pi-coding-agent"
        / "dist"
        / "cli.js"
    )
    bridge_extension_path = (
        repository_root
        / "benchmark"
        / "benchmark_3_agentdojo_workspace"
        / "pi_extension"
        / "agentdojo-tools.ts"
    )
    bumblebee_extension_path = (
        repository_root / "src" / "extension.ts"
        if arguments.profile == str(agents_config["candidate"])
        else None
    )
    for required_path in (
        pi_cli_path,
        bridge_extension_path,
        bumblebee_extension_path,
    ):
        if required_path is not None and not required_path.is_file():
            raise FileNotFoundError(str(required_path))

    subject: dict[str, Any] = {
        "profile": arguments.profile,
        "piVersion": pi_version,
        "workspaceClean": bool(arguments.workspace_clean),
    }
    if arguments.bumblebee_commit is not None:
        subject.update(
            {
                "bumblebeeCommit": arguments.bumblebee_commit,
                "extensionSource": (
                    str(agents_config["extensionSourcePrefix"])
                    + arguments.bumblebee_commit
                ),
            }
        )
    result.update(
        {
            "dataset": {
                "package": str(dataset_config["package"]),
                "packageVersion": agentdojo_version,
                "benchmarkVersion": benchmark_version,
                "suite": suite_name,
                "attack": attack_name,
                "contentSha256": dataset_hash,
                "userTaskCount": len(all_user_ids),
                "injectionTaskCount": len(all_injection_ids),
                "toolCount": len(catalog["tools"]),
            },
            "subject": subject,
            "model": {
                "provider": arguments.provider,
                "model": arguments.model,
                **(
                    {"thinkingLevel": arguments.thinking}
                    if arguments.thinking is not None
                    else {}
                ),
            },
            "bridge": {
                "protocolVersion": int(
                    bridge_config["protocolVersion"]
                ),
                "approvalPolicy": str(
                    bridge_config["approvalPolicy"]
                ),
                "systemPromptSha256": hashlib.sha256(
                    str(bridge_config["systemPrompt"]).encode("utf-8")
                ).hexdigest(),
                "maxResponseBytes": int(
                    bridge_config["maxResponseBytes"]
                ),
            },
            "selection": {
                "userTaskIds": selected_user_ids,
                "injectionTaskIds": selected_injection_ids,
            },
        }
    )

    pipeline = PiAgentPipeline(
        PiPipelineConfig(
            pipeline_name=_pipeline_name(
                manifest,
                arguments,
                dataset_hash,
                pi_version,
                tuple(MODEL_NAMES),
            ),
            profile=arguments.profile,
            provider=arguments.provider,
            model=arguments.model,
            thinking_level=arguments.thinking,
            approval_policy=str(bridge_config["approvalPolicy"]),
            task_timeout_ms=int(bridge_config["taskTimeoutMs"]),
            max_response_bytes=int(bridge_config["maxResponseBytes"]),
            system_prompt=str(bridge_config["systemPrompt"]),
            repository_root=repository_root,
            node_executable=node_executable,
            pi_cli_path=pi_cli_path,
            bridge_extension_path=bridge_extension_path,
            bumblebee_extension_path=bumblebee_extension_path,
        )
    )
    log_directory = arguments.logdir.resolve()
    _prepare_log_directory(
        log_directory,
        require_empty=arguments.force_rerun,
    )

    try:
        with OutputLogger(str(log_directory)):
            clean = benchmark_suite_without_injections(
                pipeline,
                suite,
                logdir=log_directory,
                force_rerun=arguments.force_rerun,
                user_tasks=selected_user_ids,
                benchmark_version=benchmark_version,
            )
            result["cleanCases"] = _clean_cases(
                clean["utility_results"]
            )

            attack = load_attack(attack_name, suite, pipeline)
            attacked = benchmark_suite_with_injections(
                pipeline,
                suite,
                attack,
                logdir=log_directory,
                force_rerun=arguments.force_rerun,
                user_tasks=selected_user_ids,
                injection_tasks=selected_injection_ids,
                benchmark_version=benchmark_version,
            )
            result["attackCases"] = _attack_cases(
                attacked["utility_results"],
                attacked["security_results"],
            )
            result["injectionUtilityCases"] = [
                {
                    "injectionTaskId": task_id,
                    "utility": bool(value),
                }
                for task_id, value in sorted(
                    attacked[
                        "injection_tasks_utility_results"
                    ].items()
                )
            ]
    finally:
        # Preserve all invocations even when a later benchmark phase fails.
        result["traces"] = pipeline.traces

    result.update(
        {
            "status": "completed",
            "finishedAt": _now(),
            "durationMs": _elapsed_ms(started),
            "runtime": {
                "pythonVersion": platform.python_version(),
                "platform": platform.platform(),
                "nodeExecutable": node_executable,
            },
        }
    )
    return result


def _empty_result(
    manifest: Mapping[str, Any],
    arguments: argparse.Namespace,
    adapter_run_id: str,
    started_at: str,
) -> dict[str, Any]:
    dataset = _require_mapping(manifest, "dataset")
    agents = _require_mapping(manifest, "agents")
    bridge = _require_mapping(manifest, "bridge")
    subject: dict[str, Any] = {
        "profile": arguments.profile,
        "piVersion": str(agents.get("piVersion", "missing")),
        "workspaceClean": bool(arguments.workspace_clean),
    }
    if arguments.bumblebee_commit is not None:
        subject["bumblebeeCommit"] = arguments.bumblebee_commit
        subject["extensionSource"] = (
            str(agents.get("extensionSourcePrefix", ""))
            + arguments.bumblebee_commit
        )
    return {
        "contractVersion": CONTRACT_VERSION,
        "adapterRunId": adapter_run_id,
        "adapterVersion": ADAPTER_VERSION,
        "status": "failed",
        "startedAt": started_at,
        "finishedAt": started_at,
        "durationMs": 0,
        "dataset": {
            "package": str(dataset.get("package", "agentdojo")),
            "packageVersion": "missing",
            "benchmarkVersion": str(
                dataset.get("benchmarkVersion", "missing")
            ),
            "suite": str(dataset.get("suite", "workspace")),
            "attack": str(dataset.get("attack", "missing")),
            "contentSha256": ZERO_SHA256,
            "userTaskCount": 0,
            "injectionTaskCount": 0,
            "toolCount": 0,
        },
        "subject": subject,
        "model": {
            "provider": arguments.provider,
            "model": arguments.model,
            **(
                {"thinkingLevel": arguments.thinking}
                if arguments.thinking is not None
                else {}
            ),
        },
        "bridge": {
            "protocolVersion": int(bridge.get("protocolVersion", 0)),
            "approvalPolicy": str(
                bridge.get("approvalPolicy", "deny")
            ),
            "systemPromptSha256": hashlib.sha256(
                str(bridge.get("systemPrompt", "")).encode("utf-8")
            ).hexdigest(),
            "maxResponseBytes": int(
                bridge.get("maxResponseBytes", 1)
            ),
        },
        "selection": {
            "userTaskIds": list(arguments.user_task),
            "injectionTaskIds": list(arguments.injection_task),
        },
        "cleanCases": [],
        "attackCases": [],
        "injectionUtilityCases": [],
        "traces": [],
    }


def _failed_result(
    result: Mapping[str, Any],
    started: float,
    code: str,
    error: BaseException,
    retryable: bool,
) -> dict[str, Any]:
    failed = dict(result)
    failed.update(
        {
            "status": "failed",
            "finishedAt": _now(),
            "durationMs": _elapsed_ms(started),
            "failure": {
                "category": "adapter",
                "code": code,
                "message": _safe_error(error),
                "retryable": retryable,
            },
        }
    )
    return failed


def _clean_cases(
    utility_results: Mapping[tuple[str, str], bool],
) -> list[dict[str, Any]]:
    return [
        {
            "userTaskId": user_task,
            "utility": bool(value),
        }
        for (user_task, _), value in sorted(utility_results.items())
    ]


def _attack_cases(
    utility_results: Mapping[tuple[str, str], bool],
    security_results: Mapping[tuple[str, str], bool],
) -> list[dict[str, Any]]:
    if set(utility_results) != set(security_results):
        raise RuntimeError(
            "AgentDojo utility and security result keys do not align"
        )
    return [
        {
            "userTaskId": user_task,
            "injectionTaskId": injection_task,
            "utility": bool(utility_results[(user_task, injection_task)]),
            "security": bool(security_results[(user_task, injection_task)]),
        }
        for user_task, injection_task in sorted(utility_results)
    ]


def _dataset_hash(
    benchmark_version: str,
    suite_name: str,
    suite: Any,
    catalog: Mapping[str, Any],
) -> str:
    payload = {
        "benchmarkVersion": benchmark_version,
        "suite": suite_name,
        "userTasks": [
            {
                "id": task_id,
                "prompt": suite.user_tasks[task_id].PROMPT,
            }
            for task_id in sorted(suite.user_tasks)
        ],
        "injectionTasks": [
            {
                "id": task_id,
                "goal": suite.injection_tasks[task_id].GOAL,
            }
            for task_id in sorted(suite.injection_tasks)
        ],
        "toolCatalog": catalog,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _pipeline_name(
    manifest: Mapping[str, Any],
    arguments: argparse.Namespace,
    dataset_hash: str,
    pi_version: str,
    supported_model_ids: Sequence[str],
) -> str:
    """Make AgentDojo's cache namespace sensitive to every scored input.

    AgentDojo's attacks infer a prose model name from ``pipeline.name``.
    Models unknown to the pinned AgentDojo release use its generic ``local``
    identity while the digest still binds the real provider and model.
    """

    bridge = _require_mapping(manifest, "bridge")
    payload = {
        "datasetHash": dataset_hash,
        "profile": arguments.profile,
        "provider": arguments.provider,
        "model": arguments.model,
        "thinking": arguments.thinking,
        "piVersion": pi_version,
        "bumblebeeCommit": arguments.bumblebee_commit,
        "approvalPolicy": bridge["approvalPolicy"],
        "systemPrompt": bridge["systemPrompt"],
    }
    digest = hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()[:16]
    model_token = _agentdojo_model_token(
        arguments.model,
        supported_model_ids,
    )
    return (
        f"{model_token}-bumblebee-"
        f"{arguments.profile}-{digest}"
    )


def _agentdojo_model_token(
    model: str,
    supported_model_ids: Sequence[str],
) -> str:
    """Return a model token understood by AgentDojo's attack templates."""

    normalized_model = model.casefold()
    candidates = sorted(
        {
            candidate
            for candidate in supported_model_ids
            if candidate != "local"
        },
        key=len,
        reverse=True,
    )
    for candidate in candidates:
        if candidate.casefold() in normalized_model:
            return candidate
    if "local" not in supported_model_ids:
        raise RuntimeError(
            "AgentDojo model registry has no generic local fallback"
        )
    return "local"


def _select_ids(
    requested: Sequence[str],
    available: Sequence[str],
    label: str,
) -> list[str]:
    if not requested:
        return list(available)
    if len(set(requested)) != len(requested):
        raise ValueError(f"Duplicate {label} selection")
    unknown = sorted(set(requested) - set(available))
    if unknown:
        raise ValueError(f"Unknown {label}s: {', '.join(unknown)}")
    return list(requested)


def _prepare_log_directory(
    path: Path,
    require_empty: bool,
) -> None:
    if path.exists() and not path.is_dir():
        raise NotADirectoryError(str(path))
    if (
        require_empty
        and path.exists()
        and next(path.iterdir(), None) is not None
    ):
        raise FileExistsError(
            "A fresh AgentDojo log directory is required for a formal run: "
            f"{path}"
        )
    path.mkdir(parents=True, exist_ok=True)


def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise TypeError(f"{path} must contain a JSON object")
    return value


def _require_mapping(
    value: Mapping[str, Any],
    field: str,
) -> Mapping[str, Any]:
    nested = value.get(field)
    if not isinstance(nested, dict):
        raise TypeError(f"manifest.{field} must be an object")
    return nested


def _write_json_immutable(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f"{path.name}.tmp-{os.getpid()}-{uuid.uuid4().hex}"
    )
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            json.dump(
                value,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _parse_arguments(argv: Sequence[str] | None) -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[3]
    benchmark_root = (
        repository_root
        / "benchmark"
        / "benchmark_3_agentdojo_workspace"
    )
    parser = argparse.ArgumentParser(
        description="Run AgentDojo Workspace through Bumblebee's pi bridge."
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=benchmark_root
        / "manifests"
        / "agentdojo-workspace-v1.json",
    )
    parser.add_argument(
        "--profile",
        choices=("pi-baseline", "bumblebee-full"),
        required=True,
    )
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--thinking",
        choices=("off", "minimal", "low", "medium", "high", "xhigh"),
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--logdir", type=Path, required=True)
    parser.add_argument("--node", default="node")
    parser.add_argument("--bumblebee-commit")
    parser.add_argument("--workspace-clean", action="store_true")
    parser.add_argument("--user-task", action="append", default=[])
    parser.add_argument(
        "--injection-task",
        action="append",
        default=[],
    )
    parser.add_argument("--force-rerun", action="store_true")
    arguments = parser.parse_args(argv)

    if arguments.profile == "bumblebee-full":
        if (
            arguments.bumblebee_commit is None
            or len(arguments.bumblebee_commit) not in (40, 64)
            or any(
                character not in "0123456789abcdef"
                for character in arguments.bumblebee_commit
            )
        ):
            parser.error(
                "bumblebee-full requires --bumblebee-commit with a full SHA"
            )
        if not arguments.workspace_clean:
            parser.error(
                "bumblebee-full requires --workspace-clean"
            )
    elif (
        arguments.bumblebee_commit is not None
        or arguments.workspace_clean
    ):
        parser.error(
            "pi-baseline must not claim Bumblebee source state"
        )
    return arguments


def _safe_error(error: BaseException) -> str:
    text = f"{type(error).__name__}: {error}".replace("\x00", " ")
    return text[:2000]


def _now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _elapsed_ms(started: float) -> int:
    return max(0, round((time.monotonic() - started) * 1000))


if __name__ == "__main__":
    sys.exit(main())

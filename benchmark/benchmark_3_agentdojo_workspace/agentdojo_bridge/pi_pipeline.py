from __future__ import annotations

import hashlib
import json
import os
import queue
import secrets
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.functions_runtime import FunctionCall
from agentdojo.logging import Logger
from agentdojo.types import text_content_block_from_string

from .bridge_server import (
    BRIDGE_PROTOCOL_VERSION,
    ToolBridgeServer,
    build_tool_catalog,
)


CATALOG_ENV = "BUMBLEBEE_AGENTDOJO_CATALOG"
ENDPOINT_ENV = "BUMBLEBEE_AGENTDOJO_ENDPOINT"
TOKEN_ENV = "BUMBLEBEE_AGENTDOJO_TOKEN"
MAX_RESPONSE_BYTES_ENV = "BUMBLEBEE_AGENTDOJO_MAX_RESPONSE_BYTES"
MAX_STDERR_CHARS = 16_384


@dataclass(frozen=True)
class PiPipelineConfig:
    pipeline_name: str
    profile: str
    provider: str
    model: str
    thinking_level: str | None
    approval_policy: str
    task_timeout_ms: int
    max_response_bytes: int
    system_prompt: str
    repository_root: Path
    node_executable: str
    pi_cli_path: Path
    bridge_extension_path: Path
    bumblebee_extension_path: Path | None


@dataclass(frozen=True)
class PiInvocationOutcome:
    messages: list[dict[str, Any]]
    tool_call_count: int
    permission_prompt_count: int
    tokens: dict[str, int] | None
    cost_usd: float | None


class PiAgentPipeline(BasePipelineElement):
    """Run one isolated pi RPC process for every AgentDojo task."""

    def __init__(self, config: PiPipelineConfig) -> None:
        self.config = config
        self.name = config.pipeline_name
        self._traces: list[dict[str, Any]] = []
        self._trace_lock = threading.Lock()

    @property
    def traces(self) -> list[dict[str, Any]]:
        with self._trace_lock:
            return [dict(trace) for trace in self._traces]

    def query(
        self,
        query: str,
        runtime: Any,
        env: Any,
        messages: Sequence[dict[str, Any]] = (),
        extra_args: Mapping[str, Any] | None = None,
    ) -> tuple[
        str,
        Any,
        Any,
        Sequence[dict[str, Any]],
        dict[str, Any],
    ]:
        invocation_id = str(uuid.uuid4())
        query_sha256 = hashlib.sha256(query.encode("utf-8")).hexdigest()
        started_at = _now()
        started = time.monotonic()

        try:
            outcome = self._run_pi(query, runtime, env)
        except Exception as error:
            Logger.get().log_error(_safe_error(error))
            finished_at = _now()
            status = "timed-out" if isinstance(error, TimeoutError) else "failed"
            self._append_trace(
                {
                    "invocationId": invocation_id,
                    "querySha256": query_sha256,
                    "status": status,
                    "startedAt": started_at,
                    "finishedAt": finished_at,
                    "durationMs": _elapsed_ms(started),
                    "toolCallCount": 0,
                    "permissionPromptCount": 0,
                    "failure": {
                        "category": "adapter",
                        "code": (
                            "PI_TASK_TIMEOUT"
                            if status == "timed-out"
                            else "PI_RPC_FAILED"
                        ),
                        "message": _safe_error(error),
                        "retryable": status == "timed-out",
                    },
                }
            )
            raise

        finished_at = _now()
        trace: dict[str, Any] = {
            "invocationId": invocation_id,
            "querySha256": query_sha256,
            "status": "completed",
            "startedAt": started_at,
            "finishedAt": finished_at,
            "durationMs": _elapsed_ms(started),
            "toolCallCount": outcome.tool_call_count,
            "permissionPromptCount": outcome.permission_prompt_count,
        }
        if outcome.tokens is not None:
            trace["tokens"] = outcome.tokens
        if outcome.cost_usd is not None:
            trace["costUsd"] = outcome.cost_usd
        self._append_trace(trace)
        conversation = [
            *messages,
            {
                "role": "user",
                "content": [text_content_block_from_string(query)],
            },
            *outcome.messages,
        ]
        Logger.get().log(conversation)

        return (
            query,
            runtime,
            env,
            conversation,
            dict(extra_args or {}),
        )

    def _append_trace(self, trace: dict[str, Any]) -> None:
        with self._trace_lock:
            self._traces.append(dict(trace))

    def _run_pi(
        self,
        query_text: str,
        runtime: Any,
        environment: Any,
    ) -> PiInvocationOutcome:
        catalog = build_tool_catalog(runtime)
        token = secrets.token_urlsafe(32)

        with tempfile.TemporaryDirectory(
            prefix="bumblebee-agentdojo-"
        ) as temporary:
            temporary_root = Path(temporary)
            catalog_path = temporary_root / "tools.json"
            catalog_path.write_text(
                json.dumps(
                    catalog,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
            memory_directory = temporary_root / "memory"
            memory_directory.mkdir()

            with ToolBridgeServer(
                runtime,
                environment,
                token,
                self.config.max_response_bytes,
            ) as bridge:
                process_environment = os.environ.copy()
                process_environment.update(
                    {
                        CATALOG_ENV: str(catalog_path),
                        ENDPOINT_ENV: bridge.endpoint,
                        TOKEN_ENV: token,
                        MAX_RESPONSE_BYTES_ENV: str(
                            self.config.max_response_bytes
                        ),
                        "BUMBLEBEE_MEMORY_DIR": str(memory_directory),
                        "BUMBLEBEE_FEISHU_ENABLED": "false",
                    }
                )
                return self._run_rpc_process(
                    query_text,
                    catalog,
                    process_environment,
                )

    def _run_rpc_process(
        self,
        query_text: str,
        catalog: Mapping[str, Any],
        environment: Mapping[str, str],
    ) -> PiInvocationOutcome:
        command = self._build_command(catalog)
        creation_flags = (
            subprocess.CREATE_NO_WINDOW
            if os.name == "nt"
            else 0
        )
        process = subprocess.Popen(
            command,
            cwd=self.config.repository_root,
            env=dict(environment),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
        )
        if process.stdin is None or process.stdout is None or process.stderr is None:
            _stop_process(process)
            raise RuntimeError("pi RPC pipes were not created")

        events: queue.Queue[tuple[str, Any]] = queue.Queue()
        stderr_chunks: list[str] = []
        stdout_thread = threading.Thread(
            target=_read_stdout,
            args=(process.stdout, events),
            daemon=True,
        )
        stderr_thread = threading.Thread(
            target=_read_stderr,
            args=(process.stderr, stderr_chunks),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()

        deadline = time.monotonic() + self.config.task_timeout_ms / 1000
        tool_call_count = 0
        permission_prompt_count = 0
        extension_errors: list[str] = []
        pi_messages: list[dict[str, Any]] | None = None
        stats: dict[str, Any] | None = None

        try:
            _send_json(
                process,
                {
                    "id": "prompt",
                    "type": "prompt",
                    "message": query_text,
                },
            )
            while pi_messages is None:
                kind, payload = _next_event(events, process, deadline)
                if kind == "reader_error":
                    raise RuntimeError(str(payload))
                if kind == "eof":
                    raise RuntimeError(
                        "pi RPC exited before agent_end: "
                        + _stderr_excerpt(stderr_chunks)
                    )
                event = payload
                if not isinstance(event, dict):
                    continue
                event_type = event.get("type")
                if event_type == "extension_ui_request":
                    if _respond_to_ui(
                        process,
                        event,
                        self.config.approval_policy,
                    ):
                        permission_prompt_count += 1
                elif event_type == "tool_execution_end":
                    tool_call_count += 1
                elif event_type == "extension_error":
                    extension_errors.append(
                        str(event.get("error", "unknown extension error"))
                    )
                elif event_type == "agent_end":
                    raw_messages = event.get("messages")
                    if not isinstance(raw_messages, list):
                        raise RuntimeError(
                            "pi RPC agent_end did not contain messages"
                        )
                    pi_messages = [
                        message
                        for message in raw_messages
                        if isinstance(message, dict)
                    ]

            _send_json(
                process,
                {
                    "id": "stats",
                    "type": "get_session_stats",
                },
            )
            while stats is None:
                kind, payload = _next_event(events, process, deadline)
                if kind == "reader_error":
                    raise RuntimeError(str(payload))
                if kind == "eof":
                    raise RuntimeError(
                        "pi RPC exited before session stats"
                    )
                event = payload
                if (
                    isinstance(event, dict)
                    and event.get("type") == "response"
                    and event.get("id") == "stats"
                ):
                    if event.get("success") is not True:
                        raise RuntimeError(
                            str(event.get("error", "session stats failed"))
                        )
                    data = event.get("data")
                    if not isinstance(data, dict):
                        raise RuntimeError(
                            "pi RPC session stats were malformed"
                        )
                    stats = data

            if extension_errors:
                raise RuntimeError(
                    "pi extension error: " + "; ".join(extension_errors)
                )
            agentdojo_messages = _convert_pi_messages(pi_messages)
            if not any(
                message.get("role") == "assistant"
                for message in agentdojo_messages
            ):
                raise RuntimeError("pi RPC returned no assistant messages")
            return PiInvocationOutcome(
                messages=agentdojo_messages,
                tool_call_count=tool_call_count,
                permission_prompt_count=permission_prompt_count,
                tokens=_extract_tokens(stats),
                cost_usd=_extract_cost(stats),
            )
        except TimeoutError:
            _try_send_abort(process)
            raise
        finally:
            _stop_process(process)
            stdout_thread.join(timeout=2)
            stderr_thread.join(timeout=2)

    def _build_command(
        self,
        catalog: Mapping[str, Any],
    ) -> list[str]:
        tools = catalog.get("tools")
        if not isinstance(tools, list):
            raise TypeError("Tool catalog is malformed")
        tool_names = [
            str(tool["name"])
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("name"), str)
        ]
        if len(tool_names) != len(tools):
            raise TypeError("Tool catalog contains malformed descriptors")

        command = [
            self.config.node_executable,
            str(self.config.pi_cli_path),
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-context-files",
            "--no-themes",
            "--no-builtin-tools",
            "--system-prompt",
            self.config.system_prompt,
            "--provider",
            self.config.provider,
            "--model",
            self.config.model,
        ]
        if self.config.thinking_level is not None:
            command.extend(["--thinking", self.config.thinking_level])
        if self.config.bumblebee_extension_path is not None:
            command.extend(
                ["--extension", str(self.config.bumblebee_extension_path)]
            )
        command.extend(
            ["--extension", str(self.config.bridge_extension_path)]
        )
        command.extend(["--tools", ",".join(tool_names)])
        return command


def _read_stdout(
    stream: Any,
    events: queue.Queue[tuple[str, Any]],
) -> None:
    try:
        for raw_line in iter(stream.readline, b""):
            line = raw_line[:-1] if raw_line.endswith(b"\n") else raw_line
            if line.endswith(b"\r"):
                line = line[:-1]
            if not line:
                continue
            try:
                events.put(("event", json.loads(line.decode("utf-8"))))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                events.put(
                    (
                        "reader_error",
                        f"pi RPC emitted invalid JSONL: {error}",
                    )
                )
                return
    finally:
        events.put(("eof", None))


def _read_stderr(stream: Any, chunks: list[str]) -> None:
    remaining = MAX_STDERR_CHARS
    while True:
        data = stream.read(4096)
        if not data:
            return
        if remaining > 0:
            text = data.decode("utf-8", errors="replace")
            excerpt = text[:remaining]
            chunks.append(excerpt)
            remaining -= len(excerpt)


def _next_event(
    events: queue.Queue[tuple[str, Any]],
    process: subprocess.Popen[bytes],
    deadline: float,
) -> tuple[str, Any]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("pi task exceeded the frozen timeout")
    try:
        return events.get(timeout=remaining)
    except queue.Empty as error:
        if process.poll() is not None:
            return ("eof", None)
        raise TimeoutError(
            "pi task exceeded the frozen timeout"
        ) from error


def _send_json(
    process: subprocess.Popen[bytes],
    payload: Mapping[str, Any],
) -> None:
    if process.stdin is None:
        raise RuntimeError("pi RPC stdin is closed")
    line = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    process.stdin.write(line)
    process.stdin.flush()


def _respond_to_ui(
    process: subprocess.Popen[bytes],
    event: Mapping[str, Any],
    approval_policy: str,
) -> bool:
    request_id = event.get("id")
    method = event.get("method")
    if not isinstance(request_id, str):
        return False

    title = event.get("title")
    is_permission = (
        method == "select"
        and isinstance(title, str)
        and title.startswith("Bumblebee 权限确认")
    )
    if is_permission:
        options = event.get("options")
        if isinstance(options, list):
            expected = "仅允许本次" if approval_policy == "allow-once" else "拒绝"
            if expected in options:
                _send_json(
                    process,
                    {
                        "type": "extension_ui_response",
                        "id": request_id,
                        "value": expected,
                    },
                )
                return True

    _send_json(
        process,
        {
            "type": "extension_ui_response",
            "id": request_id,
            "cancelled": True,
        },
    )
    return False


def _convert_pi_messages(
    messages: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    converted: list[dict[str, Any]] = []
    calls_by_id: dict[str, FunctionCall] = {}

    for message in messages:
        role = message.get("role")
        if role == "assistant":
            content_blocks: list[dict[str, Any]] = []
            tool_calls: list[FunctionCall] = []
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    block_type = block.get("type")
                    if block_type == "text" and isinstance(block.get("text"), str):
                        content_blocks.append(
                            text_content_block_from_string(block["text"])
                        )
                    elif block_type == "thinking" and isinstance(
                        block.get("thinking"), str
                    ):
                        content_blocks.append(
                            {
                                "type": "thinking",
                                "content": block["thinking"],
                                "id": None,
                            }
                        )
                    elif block_type == "toolCall":
                        name = block.get("name")
                        arguments = block.get("arguments")
                        call_id = block.get("id")
                        if (
                            isinstance(name, str)
                            and isinstance(arguments, dict)
                        ):
                            function_call = FunctionCall(
                                function=name,
                                args=arguments,
                                id=call_id if isinstance(call_id, str) else None,
                            )
                            tool_calls.append(function_call)
                            if isinstance(call_id, str):
                                calls_by_id[call_id] = function_call
            converted.append(
                {
                    "role": "assistant",
                    "content": content_blocks or None,
                    "tool_calls": tool_calls or None,
                }
            )
        elif role == "toolResult":
            call_id = message.get("toolCallId")
            tool_name = message.get("toolName")
            if not isinstance(call_id, str) or not isinstance(tool_name, str):
                continue
            tool_call = calls_by_id.get(call_id)
            if tool_call is None:
                tool_call = FunctionCall(
                    function=tool_name,
                    args={},
                    id=call_id,
                )
            result_blocks: list[dict[str, Any]] = []
            content = message.get("content")
            if isinstance(content, list):
                for block in content:
                    if (
                        isinstance(block, dict)
                        and block.get("type") == "text"
                        and isinstance(block.get("text"), str)
                    ):
                        result_blocks.append(
                            text_content_block_from_string(block["text"])
                        )
            is_error = message.get("isError") is True
            error_text = (
                "\n".join(
                    str(block.get("text"))
                    for block in content or []
                    if isinstance(block, dict)
                    and isinstance(block.get("text"), str)
                )
                if is_error
                else None
            )
            converted.append(
                {
                    "role": "tool",
                    "tool_call": tool_call,
                    "content": result_blocks,
                    "tool_call_id": call_id,
                    "error": error_text,
                }
            )
    return converted


def _extract_tokens(stats: Mapping[str, Any]) -> dict[str, int] | None:
    tokens = stats.get("tokens")
    if not isinstance(tokens, dict):
        return None
    required = ("input", "output")
    if any(
        not isinstance(tokens.get(name), int) or tokens[name] < 0
        for name in required
    ):
        return None
    result = {
        "input": tokens["input"],
        "output": tokens["output"],
    }
    for source, target in (
        ("cacheRead", "cacheRead"),
        ("cacheWrite", "cacheWrite"),
    ):
        value = tokens.get(source)
        if isinstance(value, int) and value >= 0:
            result[target] = value
    return result


def _extract_cost(stats: Mapping[str, Any]) -> float | None:
    value = stats.get("cost")
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    return None


def _try_send_abort(process: subprocess.Popen[bytes]) -> None:
    try:
        _send_json(process, {"type": "abort"})
    except (BrokenPipeError, OSError, RuntimeError):
        pass


def _stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.stdin is not None:
        try:
            process.stdin.close()
        except OSError:
            pass
    try:
        process.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def _stderr_excerpt(chunks: Sequence[str]) -> str:
    text = "".join(chunks).strip().replace("\x00", "")
    return text[-2000:] if text else "no stderr"


def _safe_error(error: Exception) -> str:
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

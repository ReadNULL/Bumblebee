from __future__ import annotations

import hmac
import json
import threading
from dataclasses import dataclass
from datetime import date, datetime, time
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Mapping, Protocol, Sequence


BRIDGE_PROTOCOL_VERSION = 1
DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024


class AgentDojoFunction(Protocol):
    name: str
    description: str
    parameters: Any


class AgentDojoRuntime(Protocol):
    functions: Mapping[str, AgentDojoFunction]

    def run_function(
        self,
        env: Any,
        function: str,
        kwargs: Mapping[str, Any],
        raise_on_error: bool = False,
    ) -> tuple[Any, str | None]: ...


@dataclass(frozen=True)
class BridgeCounters:
    request_count: int
    error_count: int


def build_tool_catalog(runtime: AgentDojoRuntime) -> dict[str, Any]:
    """Convert AgentDojo's Pydantic tool schemas into bridge descriptors."""

    tools: list[dict[str, Any]] = []
    for name in sorted(runtime.functions):
        function = runtime.functions[name]
        schema = function.parameters.model_json_schema()
        if not isinstance(schema, dict) or schema.get("type") != "object":
            raise TypeError(f"Tool {name} does not expose an object schema")
        tools.append(
            {
                "name": function.name,
                "description": function.description,
                "parameters": schema,
            }
        )
    if not tools:
        raise ValueError("AgentDojo runtime did not expose any tools")
    return {
        "protocolVersion": BRIDGE_PROTOCOL_VERSION,
        "tools": tools,
    }


class ToolBridgeServer:
    """A token-authenticated loopback server bound to one task environment."""

    def __init__(
        self,
        runtime: AgentDojoRuntime,
        environment: Any,
        token: str,
        max_response_bytes: int,
        max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
    ) -> None:
        if not token:
            raise ValueError("Bridge token must not be empty")
        if max_response_bytes <= 0 or max_request_bytes <= 0:
            raise ValueError("Bridge byte limits must be positive")

        self._runtime = runtime
        self._environment = environment
        self._token = token
        self._max_response_bytes = max_response_bytes
        self._max_request_bytes = max_request_bytes
        self._execution_lock = threading.Lock()
        self._counter_lock = threading.Lock()
        self._request_count = 0
        self._error_count = 0
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def endpoint(self) -> str:
        if self._server is None:
            raise RuntimeError("Bridge server has not started")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1/tool"

    @property
    def counters(self) -> BridgeCounters:
        with self._counter_lock:
            return BridgeCounters(
                request_count=self._request_count,
                error_count=self._error_count,
            )

    def __enter__(self) -> ToolBridgeServer:
        if self._server is not None:
            raise RuntimeError("Bridge server is already running")

        owner = self

        class RequestHandler(BaseHTTPRequestHandler):
            server_version = "BumblebeeAgentDojoBridge/1"

            def do_POST(self) -> None:  # noqa: N802 - stdlib hook name
                owner._handle_request(self)

            def log_message(self, _format: str, *args: Any) -> None:
                del args

        server = ThreadingHTTPServer(
            ("127.0.0.1", 0),
            RequestHandler,
        )
        server.daemon_threads = True
        thread = threading.Thread(
            target=server.serve_forever,
            name="agentdojo-tool-bridge",
            daemon=True,
        )
        self._server = server
        self._thread = thread
        thread.start()
        return self

    def __exit__(
        self,
        _exc_type: object,
        _exc_value: object,
        _traceback: object,
    ) -> None:
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is None:
            return
        server.shutdown()
        server.server_close()
        if thread is not None:
            thread.join(timeout=5)

    def _handle_request(self, request: BaseHTTPRequestHandler) -> None:
        with self._counter_lock:
            self._request_count += 1

        try:
            if request.path != "/v1/tool":
                self._send_json(request, 404, {"ok": False, "error": "Not found"})
                return
            if request.headers.get("x-agentdojo-bridge-version") != str(
                BRIDGE_PROTOCOL_VERSION
            ):
                self._send_json(
                    request,
                    409,
                    {"ok": False, "error": "Bridge protocol mismatch"},
                )
                return

            authorization = request.headers.get("authorization", "")
            expected = f"Bearer {self._token}"
            if not hmac.compare_digest(authorization, expected):
                self._send_json(
                    request,
                    401,
                    {"ok": False, "error": "Unauthorized"},
                )
                return

            content_length = _parse_content_length(
                request.headers.get("content-length")
            )
            if content_length > self._max_request_bytes:
                self._send_json(
                    request,
                    413,
                    {"ok": False, "error": "Request is too large"},
                )
                return
            body = request.rfile.read(content_length)
            payload = json.loads(body.decode("utf-8"))
            if not isinstance(payload, dict):
                raise TypeError("Request body must be an object")

            name = payload.get("name")
            arguments = payload.get("arguments")
            if not isinstance(name, str) or not isinstance(arguments, dict):
                raise TypeError("Request requires name and arguments")
            if name not in self._runtime.functions:
                self._send_json(
                    request,
                    404,
                    {"ok": False, "error": "Tool is not available"},
                )
                return

            # AgentDojo environments are mutable; sibling pi calls are serialized.
            with self._execution_lock:
                result, error = self._runtime.run_function(
                    self._environment,
                    name,
                    arguments,
                    raise_on_error=False,
                )
            if error is not None:
                self._send_json(
                    request,
                    422,
                    {"ok": False, "error": error},
                )
                return
            self._send_json(
                request,
                200,
                {"ok": True, "result": _to_jsonable(result)},
            )
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
            self._send_json(
                request,
                400,
                {"ok": False, "error": f"{type(error).__name__}: {error}"},
            )
        except Exception as error:  # AgentDojo tool failures are data, not server crashes.
            self._send_json(
                request,
                500,
                {"ok": False, "error": f"{type(error).__name__}: {error}"},
            )

    def _send_json(
        self,
        request: BaseHTTPRequestHandler,
        status: int,
        payload: Mapping[str, Any],
    ) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(body) > self._max_response_bytes:
            status = 413
            body = b'{"ok":false,"error":"Response is too large"}'
        if status >= 400:
            with self._counter_lock:
                self._error_count += 1
        request.send_response(status)
        request.send_header("content-type", "application/json; charset=utf-8")
        request.send_header("content-length", str(len(body)))
        request.send_header("cache-control", "no-store")
        request.end_headers()
        request.wfile.write(body)


def _parse_content_length(value: str | None) -> int:
    if value is None:
        raise ValueError("Content-Length is required")
    parsed = int(value)
    if parsed < 0:
        raise ValueError("Content-Length must be non-negative")
    return parsed


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Enum):
        return _to_jsonable(value.value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if hasattr(value, "model_dump"):
        return _to_jsonable(value.model_dump(mode="json"))
    if isinstance(value, Mapping):
        return {str(key): _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_to_jsonable(item) for item in value]
    raise TypeError(f"Unsupported AgentDojo result type: {type(value).__name__}")

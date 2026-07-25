from __future__ import annotations

import json
import unittest
from dataclasses import dataclass
from http.client import HTTPConnection
from urllib.parse import urlparse

from benchmark.benchmark_3_agentdojo_workspace.agentdojo_bridge.bridge_server import (
    ToolBridgeServer,
    build_tool_catalog,
)


class FakeParameters:
    @staticmethod
    def model_json_schema() -> dict[str, object]:
        return {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
            },
            "required": ["text"],
        }


@dataclass(frozen=True)
class FakeFunction:
    name: str = "echo"
    description: str = "Echo fixture text"
    parameters: type[FakeParameters] = FakeParameters


class FakeRuntime:
    def __init__(self) -> None:
        self.functions = {"echo": FakeFunction()}
        self.calls: list[tuple[object, str, dict[str, object]]] = []

    def run_function(
        self,
        environment: object,
        function: str,
        kwargs: dict[str, object],
        raise_on_error: bool = False,
    ) -> tuple[object, str | None]:
        del raise_on_error
        self.calls.append((environment, function, kwargs))
        return {"echo": kwargs["text"]}, None


class ToolBridgeServerTest(unittest.TestCase):
    def test_catalog_and_authenticated_execution(self) -> None:
        runtime = FakeRuntime()
        catalog = build_tool_catalog(runtime)
        self.assertEqual(catalog["protocolVersion"], 1)
        self.assertEqual(catalog["tools"][0]["name"], "echo")

        environment = object()
        with ToolBridgeServer(
            runtime,
            environment,
            token="fixture-token",
            max_response_bytes=1024,
        ) as bridge:
            status, payload = post(
                bridge.endpoint,
                token="fixture-token",
                body={
                    "name": "echo",
                    "arguments": {"text": "hello"},
                },
            )
            self.assertEqual(status, 200)
            self.assertEqual(
                payload,
                {"ok": True, "result": {"echo": "hello"}},
            )

            unauthorized_status, _ = post(
                bridge.endpoint,
                token="wrong-token",
                body={
                    "name": "echo",
                    "arguments": {"text": "hello"},
                },
            )
            unknown_status, _ = post(
                bridge.endpoint,
                token="fixture-token",
                body={"name": "missing", "arguments": {}},
            )
            self.assertEqual(unauthorized_status, 401)
            self.assertEqual(unknown_status, 404)
            self.assertEqual(
                bridge.counters.request_count,
                3,
            )
            self.assertEqual(bridge.counters.error_count, 2)

        self.assertEqual(
            runtime.calls,
            [(environment, "echo", {"text": "hello"})],
        )


def post(
    endpoint: str,
    token: str,
    body: dict[str, object],
) -> tuple[int, dict[str, object]]:
    parsed = urlparse(endpoint)
    connection = HTTPConnection(
        parsed.hostname,
        parsed.port,
        timeout=5,
    )
    encoded = json.dumps(body).encode("utf-8")
    connection.request(
        "POST",
        parsed.path,
        body=encoded,
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "content-length": str(len(encoded)),
            "x-agentdojo-bridge-version": "1",
        },
    )
    response = connection.getresponse()
    payload = json.loads(response.read().decode("utf-8"))
    connection.close()
    return response.status, payload


if __name__ == "__main__":
    unittest.main()

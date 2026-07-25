import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  callAgentDojoTool,
  loadBridgeRuntimeConfig,
  parseToolCatalog,
  type AgentDojoBridgeClientConfig,
  type BridgeFetch,
} from "../../pi_extension/bridge-client.js";

const client: AgentDojoBridgeClientConfig = {
  endpoint: "http://127.0.0.1:3210/v1/tool",
  token: "fixture-token",
  maxResponseBytes: 1_024,
  protocolVersion: 1,
};

describe("AgentDojo pi bridge client", () => {
  it("parses unique object-schema tools", () => {
    const catalog = parseToolCatalog({
      protocolVersion: 1,
      tools: [
        {
          name: "search_mail",
          description: "Search mail",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        },
      ],
    });

    expect(catalog.tools[0]?.name).toBe("search_mail");
    expect(Object.isFrozen(catalog.tools)).toBe(true);
  });

  it("rejects duplicate tools and non-loopback endpoints", async () => {
    expect(() =>
      parseToolCatalog({
        protocolVersion: 1,
        tools: [
          descriptor("search_mail"),
          descriptor("search_mail"),
        ],
      })
    ).toThrow(/duplicates/u);

    const directory = await mkdtemp(
      join(tmpdir(), "bumblebee-ad-bridge-"),
    );
    try {
      const catalogPath = join(directory, "tools.json");
      await writeFile(
        catalogPath,
        JSON.stringify({
          protocolVersion: 1,
          tools: [descriptor("search_mail")],
        }),
        "utf8",
      );
      expect(() =>
        loadBridgeRuntimeConfig({
          BUMBLEBEE_AGENTDOJO_CATALOG: catalogPath,
          BUMBLEBEE_AGENTDOJO_ENDPOINT:
            "http://localhost:3210/v1/tool?unsafe=true",
          BUMBLEBEE_AGENTDOJO_TOKEN: "token",
          BUMBLEBEE_AGENTDOJO_MAX_RESPONSE_BYTES: "1024",
        })
      ).toThrow(/127\.0\.0\.1/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sends an authenticated, versioned tool request", async () => {
    let observedBody = "";
    const fetch_: BridgeFetch = async (_input, init) => {
      observedBody = init.body;
      expect(init.headers.authorization).toBe(
        "Bearer fixture-token",
      );
      expect(init.headers["x-agentdojo-bridge-version"]).toBe(
        "1",
      );
      return response(200, {
        ok: true,
        result: { messages: 2 },
      });
    };

    await expect(
      callAgentDojoTool(
        client,
        "search_mail",
        { query: "invoice" },
        undefined,
        fetch_,
      ),
    ).resolves.toEqual({ messages: 2 });
    expect(JSON.parse(observedBody) as unknown).toEqual({
      name: "search_mail",
      arguments: { query: "invoice" },
    });
  });

  it("rejects bridge errors and oversized responses", async () => {
    await expect(
      callAgentDojoTool(
        client,
        "search_mail",
        {},
        undefined,
        async () => response(422, {
          ok: false,
          error: "ValidationError: query is required",
        }),
      ),
    ).rejects.toThrow(/query is required/u);

    await expect(
      callAgentDojoTool(
        { ...client, maxResponseBytes: 4 },
        "search_mail",
        {},
        undefined,
        async () => response(200, { ok: true, result: "large" }),
      ),
    ).rejects.toThrow(/exceeded its limit/u);
  });
});

function descriptor(name: string) {
  return {
    name,
    description: "Fixture tool",
    parameters: {
      type: "object",
      properties: {},
    },
  };
}

function response(
  status: number,
  payload: unknown,
): Awaited<ReturnType<BridgeFetch>> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return {
    ok: status >= 200 && status < 300,
    status,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  };
}

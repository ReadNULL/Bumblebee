import { readFileSync } from "node:fs";

export const BRIDGE_PROTOCOL_VERSION = 1 as const;

const CATALOG_ENV = "BUMBLEBEE_AGENTDOJO_CATALOG";
const ENDPOINT_ENV = "BUMBLEBEE_AGENTDOJO_ENDPOINT";
const TOKEN_ENV = "BUMBLEBEE_AGENTDOJO_TOKEN";
const MAX_RESPONSE_BYTES_ENV =
  "BUMBLEBEE_AGENTDOJO_MAX_RESPONSE_BYTES";
const MAX_CATALOG_BYTES = 1024 * 1024;

export interface AgentDojoToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AgentDojoToolCatalog {
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
  readonly tools: readonly AgentDojoToolDescriptor[];
}

export interface AgentDojoBridgeClientConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly maxResponseBytes: number;
  readonly protocolVersion: typeof BRIDGE_PROTOCOL_VERSION;
}

export interface AgentDojoBridgeRuntimeConfig {
  readonly catalog: AgentDojoToolCatalog;
  readonly client: AgentDojoBridgeClientConfig;
}

export interface BridgeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type BridgeFetch = (
  input: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<BridgeFetchResponse>;

export function loadBridgeRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AgentDojoBridgeRuntimeConfig {
  const catalogPath = requireEnvironment(
    environment,
    CATALOG_ENV,
  );
  const bytes = readFileSync(catalogPath);
  if (bytes.byteLength > MAX_CATALOG_BYTES) {
    throw new TypeError("AgentDojo tool catalog is too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (cause: unknown) {
    throw new TypeError(
      "AgentDojo tool catalog is not valid UTF-8 JSON",
      { cause },
    );
  }

  const endpoint = requireEnvironment(
    environment,
    ENDPOINT_ENV,
  );
  assertLoopbackEndpoint(endpoint);
  const maxResponseBytes = Number(
    requireEnvironment(environment, MAX_RESPONSE_BYTES_ENV),
  );
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes <= 0
  ) {
    throw new TypeError(
      "AgentDojo bridge response limit is invalid",
    );
  }

  return Object.freeze({
    catalog: parseToolCatalog(parsed),
    client: Object.freeze({
      endpoint,
      token: requireEnvironment(environment, TOKEN_ENV),
      maxResponseBytes,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    }),
  });
}

export function parseToolCatalog(
  value: unknown,
): AgentDojoToolCatalog {
  const source = requireRecord(value, "catalog");
  if (source.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
    throw new TypeError(
      "AgentDojo tool catalog protocol version is unsupported",
    );
  }
  if (!Array.isArray(source.tools) || source.tools.length === 0) {
    throw new TypeError(
      "AgentDojo tool catalog must contain tools",
    );
  }

  const seen = new Set<string>();
  const tools = source.tools.map((value_, index) => {
    const tool = requireRecord(value_, `catalog.tools.${index}`);
    const name = requireText(
      tool.name,
      `catalog.tools.${index}.name`,
    );
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/u.test(name)) {
      throw new TypeError(
        `catalog.tools.${index}.name is invalid`,
      );
    }
    if (seen.has(name)) {
      throw new TypeError(
        `AgentDojo tool catalog duplicates ${name}`,
      );
    }
    seen.add(name);

    const parameters = requireRecord(
      tool.parameters,
      `catalog.tools.${index}.parameters`,
    );
    if (parameters.type !== "object") {
      throw new TypeError(
        `catalog.tools.${index}.parameters must be an object schema`,
      );
    }
    return Object.freeze({
      name,
      description: requireText(
        tool.description,
        `catalog.tools.${index}.description`,
      ),
      parameters,
    });
  });

  return Object.freeze({
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    tools: Object.freeze(tools),
  });
}

export async function callAgentDojoTool(
  config: AgentDojoBridgeClientConfig,
  toolName: string,
  arguments_: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
  fetch_: BridgeFetch = fetch as BridgeFetch,
): Promise<unknown> {
  const response = await fetch_(config.endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
      "x-agentdojo-bridge-version": String(
        config.protocolVersion,
      ),
    },
    body: JSON.stringify({
      name: toolName,
      arguments: arguments_,
    }),
    ...(signal === undefined ? {} : { signal }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > config.maxResponseBytes) {
    throw new Error("AgentDojo bridge response exceeded its limit");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (cause: unknown) {
    throw new Error(
      "AgentDojo bridge returned invalid UTF-8 JSON",
      { cause },
    );
  }
  const source = requireRecord(payload, "bridge response");
  if (!response.ok || source.ok !== true) {
    const message = typeof source.error === "string"
      ? source.error
      : `AgentDojo bridge failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return source.result;
}

function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function assertLoopbackEndpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch (cause: unknown) {
    throw new TypeError("AgentDojo bridge endpoint is invalid", {
      cause,
    });
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/v1/tool" ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new TypeError(
      "AgentDojo bridge endpoint must be an unauthenticated URL on 127.0.0.1/v1/tool",
    );
  }
}

function requireRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

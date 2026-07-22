import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";
import {
  normalizePathIntent,
  type PathNormalizerOptions,
} from "./path-normalizer.js";
import { PERMISSION_MODES } from "./permission-mode.js";
import type {
  AccessIntent,
  PermissionAuthorizationRequest,
} from "./types.js";

const READ_PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface IntentExtractorOptions {
  readonly pathNormalizer?: PathNormalizerOptions;
}

/** 将 Pi 工具输入转换成权限内核可以独立判断的访问意图。 */
export async function extractAccessIntents(
  request: PermissionAuthorizationRequest,
  options: IntentExtractorOptions = {},
): Promise<readonly AccessIntent[]> {
  const toolName = normalizeRequiredText(request.toolName, "toolName");
  const intents: AccessIntent[] = [createToolIntent(toolName)];
  const input = toRecord(request.input);

  if (READ_PATH_TOOLS.has(toolName)) {
    const rawPath = readPath(input, toolName, toolName !== "read");
    intents.push(
      await normalizePathIntent(
        rawPath,
        request.cwd,
        PERMISSION_MODES.READ,
        {
          ...options.pathNormalizer,
          targetKind: toolName === "read" ? "file" : "directory",
        },
      ),
    );
  } else if (toolName === "write" || toolName === "edit") {
    const rawPath = readPath(input, toolName, false);
    intents.push(
      await normalizePathIntent(
        rawPath,
        request.cwd,
        toolName === "edit"
          ? PERMISSION_MODES.READ_WRITE
          : PERMISSION_MODES.WRITE,
        {
          ...options.pathNormalizer,
          targetKind: "file",
        },
      ),
    );
  } else if (toolName === "bash") {
    const command = readRequiredInputText(input, "command", toolName);
    intents.push(
      Object.freeze({
        aliases: Object.freeze([command]),
        caseSensitive: true,
        displayValue: command,
        requiredMode: PERMISSION_MODES.EXECUTE,
        surface: "command",
      }),
    );
  }

  return Object.freeze(intents);
}

function createToolIntent(toolName: string): AccessIntent {
  return Object.freeze({
    aliases: Object.freeze([toolName]),
    caseSensitive: true,
    displayValue: toolName,
    requiredMode: PERMISSION_MODES.EXECUTE,
    surface: "tool",
  });
}

function readPath(
  input: Record<string, unknown>,
  toolName: string,
  optional: boolean,
): string {
  const value = input.path ?? input.file_path;
  if (value === undefined && optional) {
    return ".";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BumblebeeError(`Invalid path for ${toolName}`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName: "path", toolName },
    });
  }
  return value;
}

function readRequiredInputText(
  input: Record<string, unknown>,
  fieldName: string,
  toolName: string,
): string {
  const value = input[fieldName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BumblebeeError(`Invalid ${fieldName} for ${toolName}`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName, toolName },
    });
  }
  return value.trim();
}

function normalizeRequiredText(value: string, fieldName: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw new BumblebeeError(`${fieldName} cannot be empty`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName },
    });
  }
  return normalized;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : Object.create(null) as Record<string, unknown>;
}

import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";
import type {
  AccessIntent,
} from "./types.js";
import type { NonEmptyPermissionMode } from "./permission-mode.js";

export interface PathNormalizerOptions {
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (value: string) => Promise<string>;
  readonly targetKind?: "directory" | "file";
}

/** 同时保留词法绝对路径和解析符号链接后的真实路径，任一都可参与规则匹配。 */
export async function normalizePathIntent(
  rawPath: string,
  cwd: string,
  requiredMode: NonEmptyPermissionMode,
  options: PathNormalizerOptions = {},
): Promise<AccessIntent> {
  const inputPath = normalizeRequiredText(rawPath, "path");
  const workspace = normalizeRequiredText(cwd, "cwd");
  const resolveRealPath = options.realpath ?? realpath;
  const absolutePath = path.resolve(workspace, inputPath);
  const [canonicalPath, canonicalWorkspace] = await Promise.all([
    canonicalizeNearestExistingPath(absolutePath, resolveRealPath),
    canonicalizeNearestExistingPath(path.resolve(workspace), resolveRealPath),
  ]);
  const aliases = uniqueStrings([
    normalizePathForMatching(absolutePath),
    normalizePathForMatching(canonicalPath),
  ]);
  const targetKind = options.targetKind ?? "file";
  const absoluteFolder = targetKind === "directory"
    ? absolutePath
    : path.dirname(absolutePath);
  const canonicalFolder = targetKind === "directory"
    ? canonicalPath
    : path.dirname(canonicalPath);
  const folderAliases = uniqueStrings([
    normalizePathForMatching(absoluteFolder),
    normalizePathForMatching(canonicalFolder),
  ]).filter(isSafeWildcardFolder);
  const caseSensitive = (options.platform ?? process.platform) !== "win32";

  return Object.freeze({
    aliases: Object.freeze(aliases),
    caseSensitive,
    displayValue: absolutePath,
    folderAliases: Object.freeze(folderAliases),
    folderDisplayValue: absoluteFolder,
    pathScope: isWithinWorkspace(canonicalWorkspace, canonicalPath)
      ? "workspace"
      : "external",
    requiredMode,
    surface: "path",
  });
}

export function normalizePathForMatching(value: string): string {
  const normalized = path.normalize(value).replaceAll("\\", "/");
  const isRoot = normalized === "/" || /^[a-zA-Z]:\/$/u.test(normalized);

  return !isRoot && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

async function canonicalizeNearestExistingPath(
  value: string,
  resolveRealPath: (path: string) => Promise<string>,
): Promise<string> {
  let candidate = value;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const existingPath = await resolveRealPath(candidate);
      return path.join(existingPath, ...missingSegments);
    } catch (cause: unknown) {
      if (!isMissingPathError(cause)) {
        throw new BumblebeeError("Unable to canonicalize access path", {
          code: ERROR_CODES.UNAVAILABLE,
          cause,
          context: { path: value },
        });
      }

      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new BumblebeeError("Unable to find an existing path ancestor", {
          code: ERROR_CODES.NOT_FOUND,
          cause,
          context: { path: value },
        });
      }

      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function isWithinWorkspace(workspace: string, target: string): boolean {
  const relative = path.relative(workspace, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function isMissingPathError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const code = Reflect.get(value, "code");
  return code === "ENOENT" || code === "ENOTDIR";
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isSafeWildcardFolder(value: string): boolean {
  // 当前通配器没有转义语法；含通配字符的真实目录退化为精确授权。
  return (
    value.length <= 32_765 &&
    !/[\\*?\u0000-\u001f\u007f]/u.test(value)
  );
}

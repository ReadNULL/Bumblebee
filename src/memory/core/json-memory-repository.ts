import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import {
  freezeDocument,
  parseMemoryDocument,
} from "./normalization.js";
import type {
  MemoryDocument,
  MemoryScope,
} from "./types.js";

export const MAX_MEMORY_FILE_BYTES = 1024 * 1024;

/** 有界 JSON 文件仓库；写入使用同目录临时文件和 rename 原子替换。 */
export class JsonMemoryRepository {
  async load(
    filePath: string,
    scope: MemoryScope,
    signal?: AbortSignal,
  ): Promise<MemoryDocument> {
    throwIfAborted(signal);

    let fileSize: number;
    try {
      fileSize = (await stat(filePath)).size;
    } catch (cause: unknown) {
      if (isNodeError(cause, "ENOENT")) {
        return freezeDocument([]);
      }
      throw repositoryError("Unable to inspect memory file", cause);
    }
    if (fileSize > MAX_MEMORY_FILE_BYTES) {
      throw new BumblebeeError("Memory file exceeds the size limit", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fileSize, maxFileSize: MAX_MEMORY_FILE_BYTES },
        userMessage: "记忆文件超过 1 MiB 上限，请先人工整理。",
      });
    }

    let source: string;
    try {
      source = await readFile(filePath, "utf8");
    } catch (cause: unknown) {
      throw repositoryError("Unable to read memory file", cause);
    }
    if (Buffer.byteLength(source, "utf8") > MAX_MEMORY_FILE_BYTES) {
      throw new BumblebeeError("Memory file grew beyond the size limit", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { maxFileSize: MAX_MEMORY_FILE_BYTES },
        userMessage: "记忆文件超过 1 MiB 上限，请先人工整理。",
      });
    }
    throwIfAborted(signal);

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      // Node 的 JSON 语法错误可能包含原始片段，不能作为 cause 继续传播。
      throw new BumblebeeError("Unable to parse memory JSON", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { failure: "invalid-json" },
        userMessage: "记忆文件格式无效，请检查或恢复对应的 JSON 文件。",
      });
    }

    try {
      return parseMemoryDocument(parsed, scope);
    } catch (cause: unknown) {
      throw normalizeError(cause, {
        code: ERROR_CODES.INVALID_INPUT,
        message: "Unable to validate memory file",
        userMessage: "记忆文件格式无效，请检查或恢复对应的 JSON 文件。",
      });
    }
  }

  async save(
    filePath: string,
    document: MemoryDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    const byteLength = Buffer.byteLength(serialized, "utf8");
    if (byteLength > MAX_MEMORY_FILE_BYTES) {
      throw new BumblebeeError("Serialized memory exceeds the size limit", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { byteLength, maxFileSize: MAX_MEMORY_FILE_BYTES },
        userMessage: "记忆文件超过 1 MiB 上限，请删除或合并旧记录。",
      });
    }

    const directory = path.dirname(filePath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );

    let failure: unknown;
    try {
      await mkdir(directory, { recursive: true });
      throwIfAborted(signal);

      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      throwIfAborted(signal);
      await rename(temporaryPath, filePath);
    } catch (cause: unknown) {
      failure = cause;
    }

    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupCause: unknown) {
      failure = failure === undefined
        ? cleanupCause
        : new AggregateError(
            [failure, cleanupCause],
            "Memory write and temporary-file cleanup both failed",
          );
    }
    if (failure !== undefined) {
      throw repositoryError("Unable to persist memory file", failure);
    }
  }
}

function repositoryError(message: string, cause: unknown): BumblebeeError {
  return normalizeError(cause, {
    code: ERROR_CODES.UNAVAILABLE,
    message,
    retryable: true,
    userMessage: "记忆文件暂时无法读写，请检查目录权限和磁盘状态。",
  });
}

function isNodeError(value: unknown, code: string): boolean {
  return value instanceof Error &&
    "code" in value &&
    (value as NodeJS.ErrnoException).code === code;
}

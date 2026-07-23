import {
  mkdir,
  open,
  readFile,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  sanitizeForLogging,
  type JsonValue,
} from "../../../../src/foundation/index.js";

const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;

/** 单次 write + fsync，调用方负责用队列串行化同一文件。 */
export async function appendSanitizedJsonLine(
  filePath: string,
  value: unknown,
): Promise<void> {
  const sanitized = sanitizeForLogging(value, {
    maxDepth: 16,
    maxEntries: 10_000,
    maxStringLength: 100_000,
  });
  const line = `${JSON.stringify(sanitized)}\n`;
  const byteLength = Buffer.byteLength(line);

  if (byteLength > MAX_LINE_BYTES) {
    throw new BumblebeeError("JSONL record exceeds size limit", {
      code: ERROR_CODES.INVALID_INPUT,
      context: { byteLength, maxLineBytes: MAX_LINE_BYTES },
    });
  }

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJsonLines(filePath: string): Promise<JsonValue[]> {
  try {
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_LEDGER_BYTES) {
      throw new BumblebeeError("JSONL ledger exceeds size limit", {
        code: ERROR_CODES.INVALID_INPUT,
        context: {
          filePath,
          maxLedgerBytes: MAX_LEDGER_BYTES,
          size: fileStats.size,
        },
      });
    }

    const content = await readFile(filePath, "utf8");
    const values: JsonValue[] = [];
    for (const [index, line] of content.split(/\r?\n/u).entries()) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        values.push(JSON.parse(line) as JsonValue);
      } catch (error: unknown) {
        throw new BumblebeeError("JSONL ledger contains invalid JSON", {
          code: ERROR_CODES.INVALID_INPUT,
          cause: error,
          context: { filePath, line: index + 1 },
        });
      }
    }
    return values;
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

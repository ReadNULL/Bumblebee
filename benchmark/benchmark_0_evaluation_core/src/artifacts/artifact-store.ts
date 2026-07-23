import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  sanitizeForLogging,
} from "../../../../src/foundation/index.js";
import {
  ARTIFACT_KINDS,
  EVALUATION_CONTRACT_VERSION,
  assertArtifactReference,
  assertIdentifier,
  type ArtifactKind,
  type ArtifactReference,
  type ArtifactVerification,
} from "../contracts/index.js";

const DEFAULT_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ArtifactStoreOptions {
  readonly maxArtifactBytes?: number;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
}

export interface WriteArtifactInput {
  readonly runId: string;
  readonly relativePath: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly content: string | Uint8Array;
}

export type WriteJsonArtifactInput = Omit<WriteArtifactInput, "content"> & {
  readonly value: unknown;
};

/**
 * 保存不可覆盖的本地评估证据，并为后续报告返回可校验引用。
 * rootDirectory 应指向不提交 Git 的 artifact 根目录。
 */
export class ArtifactStore {
  readonly rootDirectory: string;

  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly maxArtifactBytes: number;

  constructor(rootDirectory: string, options: ArtifactStoreOptions = {}) {
    if (rootDirectory.trim().length === 0) {
      throw new BumblebeeError(
        "artifact root directory must not be empty",
        { code: ERROR_CODES.INVALID_INPUT },
      );
    }

    const maxArtifactBytes =
      options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes < 1) {
      throw new BumblebeeError(
        "maxArtifactBytes must be a positive integer",
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { maxArtifactBytes },
        },
      );
    }

    this.rootDirectory = resolve(rootDirectory);
    this.maxArtifactBytes = maxArtifactBytes;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `artifact_${randomUUID()}`);
  }

  async writeJson(input: WriteJsonArtifactInput): Promise<ArtifactReference> {
    const sanitized = sanitizeForLogging(input.value, {
      maxDepth: 16,
      maxEntries: 10_000,
      maxStringLength: 100_000,
    });
    const content = `${JSON.stringify(sanitized, null, 2)}\n`;

    return this.write({
      runId: input.runId,
      relativePath: input.relativePath,
      kind: input.kind,
      mediaType: input.mediaType,
      content,
    }, true);
  }

  async writeRaw(input: WriteArtifactInput): Promise<ArtifactReference> {
    return this.write(input, false);
  }

  async verify(
    reference: ArtifactReference,
  ): Promise<ArtifactVerification> {
    assertArtifactReference(reference);
    const relativePath = normalizeStoredPath(
      reference.runId,
      reference.relativePath,
    );
    const absolutePath = this.resolveInsideRoot(relativePath);

    let bytes: Buffer;
    try {
      bytes = await readFile(absolutePath);
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) {
        return {
          valid: false,
          expectedSha256: reference.sha256,
          expectedByteLength: reference.byteLength,
          reason: "missing",
        };
      }
      throw error;
    }

    const actualSha256 = sha256(bytes);
    if (bytes.byteLength !== reference.byteLength) {
      return {
        valid: false,
        expectedSha256: reference.sha256,
        actualSha256,
        expectedByteLength: reference.byteLength,
        actualByteLength: bytes.byteLength,
        reason: "size-mismatch",
      };
    }

    if (actualSha256 !== reference.sha256) {
      return {
        valid: false,
        expectedSha256: reference.sha256,
        actualSha256,
        expectedByteLength: reference.byteLength,
        actualByteLength: bytes.byteLength,
        reason: "hash-mismatch",
      };
    }

    return {
      valid: true,
      expectedSha256: reference.sha256,
      actualSha256,
      expectedByteLength: reference.byteLength,
      actualByteLength: bytes.byteLength,
    };
  }

  private async write(
    input: WriteArtifactInput,
    sanitized: boolean,
  ): Promise<ArtifactReference> {
    assertIdentifier(input.runId, "runId");
    assertArtifactKind(input.kind);
    if (input.mediaType.trim().length === 0) {
      throw new BumblebeeError("artifact mediaType must not be empty", {
        code: ERROR_CODES.INVALID_INPUT,
      });
    }

    const artifactId = this.idFactory();
    assertIdentifier(artifactId, "artifactId");

    const normalizedInputPath = normalizeInputPath(input.relativePath);
    const storedPath = `${input.runId}/${normalizedInputPath}`;
    const absolutePath = this.resolveInsideRoot(storedPath);
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);

    if (bytes.byteLength > this.maxArtifactBytes) {
      throw new BumblebeeError("artifact exceeds configured size limit", {
        code: ERROR_CODES.INVALID_INPUT,
        context: {
          byteLength: bytes.byteLength,
          maxArtifactBytes: this.maxArtifactBytes,
          relativePath: storedPath,
        },
      });
    }

    await mkdir(dirname(absolutePath), {
      recursive: true,
      mode: 0o700,
    });
    await this.assertPathHasNoSymbolicLinks(dirname(absolutePath));

    const temporaryPath = join(
      dirname(absolutePath),
      `.${basename(absolutePath)}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx", 0o600);

    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      // 排他硬链接只发布已完整落盘的 inode，且不会覆盖同名证据。
      await link(temporaryPath, absolutePath);
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        throw new BumblebeeError("artifact path already exists", {
          code: ERROR_CODES.CONFLICT,
          cause: error,
          context: { relativePath: storedPath },
        });
      }
      throw error;
    } finally {
      await removeTemporaryFile(temporaryPath);
    }

    return Object.freeze({
      contractVersion: EVALUATION_CONTRACT_VERSION,
      artifactId,
      runId: input.runId,
      relativePath: storedPath,
      kind: input.kind,
      mediaType: input.mediaType,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      createdAt: this.clock().toISOString(),
      sanitized,
    });
  }

  private resolveInsideRoot(relativePath: string): string {
    const absolutePath = resolve(
      this.rootDirectory,
      ...relativePath.split("/"),
    );
    const pathFromRoot = relative(this.rootDirectory, absolutePath);

    if (
      pathFromRoot.length === 0 ||
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`) ||
      isAbsolute(pathFromRoot)
    ) {
      throw new BumblebeeError("artifact path escapes its root directory", {
        code: ERROR_CODES.INVALID_INPUT,
        context: { relativePath },
      });
    }

    return absolutePath;
  }

  private async assertPathHasNoSymbolicLinks(
    directory: string,
  ): Promise<void> {
    const pathFromRoot = relative(this.rootDirectory, directory);
    const segments =
      pathFromRoot.length === 0 ? [] : pathFromRoot.split(sep);
    let current = this.rootDirectory;

    await assertNotSymbolicLink(current);
    for (const segment of segments) {
      current = join(current, segment);
      await assertNotSymbolicLink(current);
    }
  }
}

function normalizeInputPath(value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    throw new BumblebeeError("artifact path must be relative", {
      code: ERROR_CODES.INVALID_INPUT,
      context: { relativePath: value },
    });
  }

  const segments = value.replaceAll("\\", "/").split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new BumblebeeError(
      "artifact path contains an unsafe segment",
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { relativePath: value },
      },
    );
  }

  return segments.join("/");
}

function normalizeStoredPath(runId: string, value: string): string {
  const normalized = normalizeInputPath(value);
  if (!normalized.startsWith(`${runId}/`)) {
    throw new BumblebeeError(
      "artifact reference does not belong to its run",
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { relativePath: value, runId },
      },
    );
  }
  return normalized;
}

function assertArtifactKind(value: string): asserts value is ArtifactKind {
  if (!ARTIFACT_KINDS.includes(value as ArtifactKind)) {
    throw new BumblebeeError("artifact kind is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
      context: { kind: value },
    });
  }
}

async function assertNotSymbolicLink(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new BumblebeeError(
      "artifact path contains a symbolic link",
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { path },
      },
    );
  }
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

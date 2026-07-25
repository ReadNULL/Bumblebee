import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  BumblebeeError,
  ERROR_CODES,
  KeyedSerialQueue,
  Lifecycle,
  LIFECYCLE_STATES,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import {
  formatMemoryPromptContext,
} from "./context-builder.js";
import { JsonMemoryRepository } from "./json-memory-repository.js";
import { searchMemoryRecords } from "./lexical-search.js";
import {
  createMemoryId,
  freezeDocument,
  freezeMemoryRecord,
  normalizeIdentityKey,
  normalizeMemoryInput,
} from "./normalization.js";
import type {
  MemoryContextOptions,
  MemoryDocument,
  MemoryInitializeOptions,
  MemoryListOptions,
  MemoryMutationResult,
  MemoryRecord,
  MemoryRemoveResult,
  MemoryScope,
  MemoryScopeFilter,
  MemorySearchOptions,
  MemorySearchResult,
  MemoryService,
  MemoryUpsertInput,
} from "./types.js";

export const DEFAULT_MAX_MEMORY_RECORDS_PER_SCOPE = 256;
export const DEFAULT_MAX_PINNED_RECORDS_PER_SCOPE = 8;
export const DEFAULT_MAX_MEMORY_CONTEXT_CHARACTERS = 4_096;
export const DEFAULT_MEMORY_SEARCH_LIMIT = 5;
export const DEFAULT_MEMORY_LIST_LIMIT = 20;
export const MAX_MEMORY_QUERY_LENGTH = 1_000;

const MAX_SEARCH_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_CONTEXT_RELEVANT_RECORDS = 6;
const DEFAULT_CONTEXT_PINNED_RECORDS = 4;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface LightweightMemoryOptions {
  readonly clock?: () => Date;
  readonly maxContextCharacters?: number;
  readonly maxPinnedRecordsPerScope?: number;
  readonly maxRecordsPerScope?: number;
  readonly repository?: JsonMemoryRepository;
  readonly resolveWorkspace?: (cwd: string) => Promise<string>;
  readonly rootDirectory: string;
}

/**
 * 两级、有限容量的持久记忆。写操作按 scope 串行，搜索始终读取完整快照。
 */
export class LightweightMemory implements MemoryService {
  private readonly clock: () => Date;
  private readonly documents = new Map<MemoryScope, MemoryDocument>();
  private readonly filePaths = new Map<MemoryScope, string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly lifecycle = new Lifecycle();
  private lifecycleSignal: AbortSignal | undefined;
  private readonly maxContextCharacters: number;
  private readonly maxPinnedRecordsPerScope: number;
  private readonly maxRecordsPerScope: number;
  private readonly mutationQueue = new KeyedSerialQueue<MemoryScope>();
  private readonly repository: JsonMemoryRepository;
  private readonly resolveWorkspace: (cwd: string) => Promise<string>;
  private readonly rootDirectory: string;

  constructor(options: LightweightMemoryOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      typeof options.rootDirectory !== "string" ||
      options.rootDirectory.trim().length === 0
    ) {
      throw new BumblebeeError(
        "LightweightMemory requires a root directory",
        { code: ERROR_CODES.INVALID_INPUT },
      );
    }

    this.clock = options.clock ?? (() => new Date());
    this.maxContextCharacters = normalizePositiveInteger(
      options.maxContextCharacters ??
        DEFAULT_MAX_MEMORY_CONTEXT_CHARACTERS,
      "maxContextCharacters",
    );
    this.maxPinnedRecordsPerScope = normalizePositiveInteger(
      options.maxPinnedRecordsPerScope ??
        DEFAULT_MAX_PINNED_RECORDS_PER_SCOPE,
      "maxPinnedRecordsPerScope",
    );
    this.maxRecordsPerScope = normalizePositiveInteger(
      options.maxRecordsPerScope ??
        DEFAULT_MAX_MEMORY_RECORDS_PER_SCOPE,
      "maxRecordsPerScope",
    );
    this.repository = options.repository ?? new JsonMemoryRepository();
    this.resolveWorkspace = options.resolveWorkspace ?? realpath;
    this.rootDirectory = path.resolve(options.rootDirectory);
  }

  initialize(options: MemoryInitializeOptions): Promise<void> {
    return this.lifecycle.initialize(async ({ defer, signal }) => {
      const cwd = normalizeDirectory(options.cwd, "cwd");
      throwIfAborted(signal);
      const canonicalWorkspace = await this.resolveWorkspace(cwd);
      throwIfAborted(signal);

      const fingerprint = createWorkspaceFingerprint(canonicalWorkspace);
      const globalPath = path.join(this.rootDirectory, "global.json");
      const projectPath = path.join(
        this.rootDirectory,
        "projects",
        `${fingerprint}.json`,
      );
      const [globalDocument, projectDocument] = await Promise.all([
        this.repository.load(globalPath, "global", signal),
        this.repository.load(projectPath, "project", signal),
      ]);
      this.assertCapacity(globalDocument, "global");
      this.assertCapacity(projectDocument, "project");

      this.filePaths.set("global", globalPath);
      this.filePaths.set("project", projectPath);
      this.documents.set("global", globalDocument);
      this.documents.set("project", projectDocument);
      this.lifecycleSignal = signal;

      defer("memory-state", () => {
        this.documents.clear();
        this.filePaths.clear();
        this.lifecycleSignal = undefined;
      });
      defer("memory-operation-drain", () => this.drain());
    }, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  upsert(
    input: MemoryUpsertInput,
    signal?: AbortSignal,
  ): Promise<MemoryMutationResult> {
    const normalized = normalizeMemoryInput(input);
    return this.mutate<MemoryMutationResult>(
      normalized.scope,
      signal,
      async (
        document,
        operationSignal,
      ) => {
        const existingIndex = document.records.findIndex(
          (record) =>
            normalizeIdentityKey(record.key) === normalized.identityKey,
        );

        if (existingIndex >= 0) {
          const existing = document.records[existingIndex];
          if (existing === undefined) {
            throw new BumblebeeError("Memory index became inconsistent", {
              code: ERROR_CODES.INTERNAL,
            });
          }
          if (sameMemory(existing, normalized)) {
            return {
              document,
              result: Object.freeze({
                record: existing,
                status: "unchanged",
              }),
            };
          }
          const now = this.currentTimestamp();
          this.assertPinnedCapacity(
            document,
            normalized.pinned,
            existing.pinned,
            normalized.scope,
          );

          const updated = freezeMemoryRecord({
            category: normalized.category,
            content: normalized.content,
            createdAt: existing.createdAt,
            id: existing.id,
            key: normalized.key,
            keywords: normalized.keywords,
            pinned: normalized.pinned,
            revision: existing.revision + 1,
            scope: normalized.scope,
            updatedAt: now,
          });
          const records = [...document.records];
          records[existingIndex] = updated;
          const nextDocument = freezeDocument(records);
          await this.persist(
            normalized.scope,
            nextDocument,
            operationSignal,
          );
          return {
            document: nextDocument,
            result: Object.freeze({
              record: updated,
              status: "updated",
            }),
          };
        }

        if (document.records.length >= this.maxRecordsPerScope) {
          throw new BumblebeeError("Memory record capacity reached", {
            code: ERROR_CODES.CONFLICT,
            context: {
              maxRecords: this.maxRecordsPerScope,
              scope: normalized.scope,
            },
            userMessage:
              "记忆记录已达到容量上限，请先列出并删除不再需要的记录。",
          });
        }
        this.assertPinnedCapacity(
          document,
          normalized.pinned,
          false,
          normalized.scope,
        );

        const now = this.currentTimestamp();
        const id = createMemoryId(normalized.scope, normalized.identityKey);
        if (document.records.some((record) => record.id === id)) {
          throw new BumblebeeError("Memory ID collision detected", {
            code: ERROR_CODES.CONFLICT,
            context: { scope: normalized.scope },
          });
        }
        const created = freezeMemoryRecord({
          category: normalized.category,
          content: normalized.content,
          createdAt: now,
          id,
          key: normalized.key,
          keywords: normalized.keywords,
          pinned: normalized.pinned,
          revision: 1,
          scope: normalized.scope,
          updatedAt: now,
        });
        const nextDocument = freezeDocument([
          ...document.records,
          created,
        ]);
        await this.persist(normalized.scope, nextDocument, operationSignal);
        return {
          document: nextDocument,
          result: Object.freeze({
            record: created,
            status: "created",
          }),
        };
      },
    );
  }

  remove(
    scope: MemoryScope,
    id: string,
    signal?: AbortSignal,
  ): Promise<MemoryRemoveResult> {
    const normalizedId = normalizeMemoryId(id);
    return this.mutate<MemoryRemoveResult>(scope, signal, async (
      document,
      operationSignal,
    ) => {
      const existing = document.records.find(
        (record) => record.id === normalizedId,
      );
      if (existing === undefined) {
        throw new BumblebeeError("Memory record was not found", {
          code: ERROR_CODES.NOT_FOUND,
          context: { scope },
          userMessage: "没有找到要删除的记忆记录。",
        });
      }

      const nextDocument = freezeDocument(
        document.records.filter((record) => record.id !== normalizedId),
      );
      await this.persist(scope, nextDocument, operationSignal);
      return {
        document: nextDocument,
        result: Object.freeze({
          record: existing,
          status: "removed",
        }),
      };
    });
  }

  search(
    query: string,
    options: MemorySearchOptions = {},
    signal?: AbortSignal,
  ): readonly MemorySearchResult[] {
    this.ensureReady();
    throwIfAborted(combineSignals(this.lifecycleSignal, signal));
    const normalizedQuery = normalizeQuery(query);
    const limit = normalizeLimit(
      options.limit ?? DEFAULT_MEMORY_SEARCH_LIMIT,
      MAX_SEARCH_LIMIT,
      "search limit",
    );
    return searchMemoryRecords(
      this.selectRecords(options.scope ?? "all"),
      normalizedQuery,
      limit,
    );
  }

  list(
    options: MemoryListOptions = {},
    signal?: AbortSignal,
  ): readonly MemoryRecord[] {
    this.ensureReady();
    throwIfAborted(combineSignals(this.lifecycleSignal, signal));
    const limit = normalizeLimit(
      options.limit ?? DEFAULT_MEMORY_LIST_LIMIT,
      MAX_LIST_LIMIT,
      "list limit",
    );
    return Object.freeze(
      [...this.selectRecords(options.scope ?? "all")]
        .sort(compareRecords)
        .slice(0, limit),
    );
  }

  async buildPromptContext(
    query: string,
    options: MemoryContextOptions = {},
  ): Promise<string> {
    this.ensureReady();
    const operationSignal = combineSignals(
      this.lifecycleSignal,
      options.signal,
    );
    throwIfAborted(operationSignal);
    const normalizedQuery = normalizeContextQuery(query);
    const allRecords = this.selectRecords(options.scope ?? "all");
    const pinned = [...allRecords]
      .filter((record) => record.pinned)
      .sort(compareRecords)
      .slice(0, DEFAULT_CONTEXT_PINNED_RECORDS);
    const selectedIds = new Set(pinned.map((record) => record.id));
    const relevant = searchMemoryRecords(
      allRecords,
      normalizedQuery,
      DEFAULT_CONTEXT_RELEVANT_RECORDS,
    )
      .map((result) => result.record)
      .filter((record) => !selectedIds.has(record.id));
    throwIfAborted(operationSignal);

    return formatMemoryPromptContext(
      [...pinned, ...relevant],
      this.maxContextCharacters,
      options.access ?? "read-write",
    );
  }

  private mutate<T>(
    scope: MemoryScope,
    signal: AbortSignal | undefined,
    operation: (
      document: MemoryDocument,
      operationSignal: AbortSignal | undefined,
    ) => Promise<{
      readonly document: MemoryDocument;
      readonly result: T;
    }>,
  ): Promise<T> {
    this.ensureReady();
    const operationSignal = combineSignals(this.lifecycleSignal, signal);
    const queued = this.mutationQueue.enqueue(
      scope,
      async () => {
        this.ensureReady();
        throwIfAborted(operationSignal);
        const document = this.requireDocument(scope);
        const completed = await operation(document, operationSignal);
        this.documents.set(scope, completed.document);
        return completed.result;
      },
      {
        ...(operationSignal === undefined
          ? {}
          : { signal: operationSignal }),
      },
    );
    this.track(queued);
    return queued;
  }

  private async persist(
    scope: MemoryScope,
    document: MemoryDocument,
    signal?: AbortSignal,
  ): Promise<void> {
    const filePath = this.filePaths.get(scope);
    if (filePath === undefined) {
      throw new BumblebeeError("Memory file path is unavailable", {
        code: ERROR_CODES.CONFLICT,
      });
    }
    try {
      await this.repository.save(filePath, document, signal);
    } catch (cause: unknown) {
      throw normalizeError(cause, {
        code: ERROR_CODES.UNAVAILABLE,
        context: { scope },
        message: "Memory persistence failed",
        retryable: true,
        userMessage:
          "记忆文件暂时无法写入，请检查目录权限和磁盘状态。",
      });
    }
  }

  private selectRecords(scope: MemoryScopeFilter): readonly MemoryRecord[] {
    if (scope === "all") {
      return Object.freeze([
        ...this.requireDocument("global").records,
        ...this.requireDocument("project").records,
      ]);
    }
    return this.requireDocument(scope).records;
  }

  private requireDocument(scope: MemoryScope): MemoryDocument {
    const document = this.documents.get(scope);
    if (document === undefined) {
      throw new BumblebeeError("Memory scope is unavailable", {
        code: ERROR_CODES.CONFLICT,
        context: { scope },
      });
    }
    return document;
  }

  private currentTimestamp(): string {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new BumblebeeError("Memory clock returned an invalid date", {
        code: ERROR_CODES.INTERNAL,
      });
    }
    return value.toISOString();
  }

  private assertCapacity(
    document: MemoryDocument,
    scope: MemoryScope,
  ): void {
    if (document.records.length > this.maxRecordsPerScope) {
      throw new BumblebeeError("Memory file exceeds record capacity", {
        code: ERROR_CODES.CONFLICT,
        context: {
          maxRecords: this.maxRecordsPerScope,
          recordCount: document.records.length,
          scope,
        },
        userMessage:
          "记忆文件中的记录数超过当前上限，请先人工整理。",
      });
    }
    const pinnedCount = document.records.filter(
      (record) => record.pinned,
    ).length;
    if (pinnedCount > this.maxPinnedRecordsPerScope) {
      throw new BumblebeeError("Memory file exceeds pinned capacity", {
        code: ERROR_CODES.CONFLICT,
        context: {
          maxPinnedRecords: this.maxPinnedRecordsPerScope,
          pinnedCount,
          scope,
        },
        userMessage:
          "置顶记忆数量超过当前上限，请取消部分记录的置顶状态。",
      });
    }
  }

  private assertPinnedCapacity(
    document: MemoryDocument,
    nextPinned: boolean,
    wasPinned: boolean,
    scope: MemoryScope,
  ): void {
    if (!nextPinned || wasPinned) {
      return;
    }
    const pinnedCount = document.records.filter(
      (record) => record.pinned,
    ).length;
    if (pinnedCount >= this.maxPinnedRecordsPerScope) {
      throw new BumblebeeError("Pinned memory capacity reached", {
        code: ERROR_CODES.CONFLICT,
        context: {
          maxPinnedRecords: this.maxPinnedRecordsPerScope,
          scope,
        },
        userMessage:
          "置顶记忆已达到容量上限，请先取消一条旧记录的置顶状态。",
      });
    }
  }

  private ensureReady(): void {
    if (this.lifecycle.state !== LIFECYCLE_STATES.READY) {
      throw new BumblebeeError("Lightweight memory is not ready", {
        code: this.lifecycle.state === LIFECYCLE_STATES.DISPOSING ||
            this.lifecycle.state === LIFECYCLE_STATES.DISPOSED
          ? ERROR_CODES.CANCELLED
          : ERROR_CODES.CONFLICT,
        context: { state: this.lifecycle.state },
        userMessage: "记忆系统当前不可用。",
      });
    }
  }

  private track(operation: Promise<unknown>): void {
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
  }

  private async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

function sameMemory(
  record: MemoryRecord,
  input: ReturnType<typeof normalizeMemoryInput>,
): boolean {
  return record.category === input.category &&
    record.content === input.content &&
    record.key === input.key &&
    record.pinned === input.pinned &&
    record.keywords.length === input.keywords.length &&
    record.keywords.every(
      (keyword, index) => keyword === input.keywords[index],
    );
}

function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  return Number(right.pinned) - Number(left.pinned) ||
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
    left.id.localeCompare(right.id);
}

function createWorkspaceFingerprint(cwd: string): string {
  const canonical = process.platform === "win32"
    ? cwd.toLocaleLowerCase("en-US")
    : cwd;
  return createHash("sha256")
    .update("bumblebee.memory.workspace")
    .update("\0")
    .update(canonical)
    .digest("hex");
}

function normalizeDirectory(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BumblebeeError(`${fieldName} must be a directory`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName },
    });
  }
  return path.resolve(value);
}

function normalizeMemoryId(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^mem_[a-f0-9]{24}$/u.test(normalized)) {
    throw new BumblebeeError("Memory ID is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
      userMessage: "记忆记录 ID 格式无效。",
    });
  }
  return normalized;
}

function normalizeQuery(value: string): string {
  if (typeof value !== "string") {
    throw new BumblebeeError("Memory query must be a string", {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new BumblebeeError("Memory query is invalid", {
      code: ERROR_CODES.INVALID_INPUT,
      userMessage: "记忆检索内容不能为空。",
    });
  }
  if (normalized.length <= MAX_MEMORY_QUERY_LENGTH) {
    return normalized;
  }
  throw new BumblebeeError("Memory query is too long", {
    code: ERROR_CODES.INVALID_INPUT,
    context: { maxLength: MAX_MEMORY_QUERY_LENGTH },
    userMessage: "记忆检索内容过长，请缩短查询。",
  });
}

function normalizeContextQuery(value: string): string {
  if (typeof value !== "string") {
    return "";
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    return "";
  }
  return normalized.slice(0, MAX_MEMORY_QUERY_LENGTH);
}

function normalizeLimit(
  value: number,
  maximum: number,
  fieldName: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BumblebeeError(`${fieldName} is invalid`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName, maximum },
    });
  }
  return value;
}

function normalizePositiveInteger(
  value: number,
  fieldName: string,
): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BumblebeeError(`${fieldName} must be a positive integer`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName },
    });
  }
  return value;
}

function combineSignals(
  left: AbortSignal | undefined,
  right: AbortSignal | undefined,
): AbortSignal | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined || right === left) {
    return left;
  }
  return AbortSignal.any([left, right]);
}

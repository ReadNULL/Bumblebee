export const MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_SCOPES = [
  "global",
  "project",
] as const;

export const MEMORY_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "convention",
  "lesson",
] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemoryScopeFilter = MemoryScope | "all";
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type MemoryAccessMode = "read-only" | "read-write";

export interface MemoryRecord {
  readonly category: MemoryCategory;
  readonly content: string;
  readonly createdAt: string;
  readonly id: string;
  readonly key: string;
  readonly keywords: readonly string[];
  readonly pinned: boolean;
  readonly revision: number;
  readonly scope: MemoryScope;
  readonly updatedAt: string;
}

export interface MemoryDocument {
  readonly records: readonly MemoryRecord[];
  readonly version: typeof MEMORY_SCHEMA_VERSION;
}

export interface MemoryUpsertInput {
  readonly category: MemoryCategory;
  readonly content: string;
  readonly key: string;
  readonly keywords?: readonly string[];
  readonly pinned?: boolean;
  readonly scope: MemoryScope;
}

export interface MemoryMutationResult {
  readonly record: MemoryRecord;
  readonly status: "created" | "unchanged" | "updated";
}

export interface MemorySearchOptions {
  readonly limit?: number;
  readonly scope?: MemoryScopeFilter;
}

export interface MemoryListOptions {
  readonly limit?: number;
  readonly scope?: MemoryScopeFilter;
}

export interface MemorySearchResult {
  readonly record: MemoryRecord;
  readonly score: number;
}

export interface MemoryRemoveResult {
  readonly record: MemoryRecord;
  readonly status: "removed";
}

export interface MemoryInitializeOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface MemoryContextOptions {
  readonly access?: MemoryAccessMode;
  readonly scope?: MemoryScopeFilter;
  readonly signal?: AbortSignal;
}

export interface MemoryContextProvider {
  buildPromptContext(
    query: string,
    options?: MemoryContextOptions,
  ): Promise<string>;
}

export interface ManagedMemory extends MemoryContextProvider {
  dispose(): Promise<void>;
  initialize(options: MemoryInitializeOptions): Promise<void>;
}

export interface MemoryService extends ManagedMemory {
  list(
    options?: MemoryListOptions,
    signal?: AbortSignal,
  ): readonly MemoryRecord[];
  remove(
    scope: MemoryScope,
    id: string,
    signal?: AbortSignal,
  ): Promise<MemoryRemoveResult>;
  search(
    query: string,
    options?: MemorySearchOptions,
    signal?: AbortSignal,
  ): readonly MemorySearchResult[];
  upsert(
    input: MemoryUpsertInput,
    signal?: AbortSignal,
  ): Promise<MemoryMutationResult>;
}

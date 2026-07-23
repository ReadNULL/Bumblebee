import { createHash } from "node:crypto";

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";
import { assertNoPersistedSecret } from "./secret-scanner.js";
import {
  MEMORY_CATEGORIES,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SCOPES,
  type MemoryCategory,
  type MemoryDocument,
  type MemoryRecord,
  type MemoryScope,
  type MemoryUpsertInput,
} from "./types.js";

export const MAX_MEMORY_KEY_LENGTH = 80;
export const MAX_MEMORY_CONTENT_LENGTH = 2_000;
export const MAX_MEMORY_KEYWORDS = 12;
export const MAX_MEMORY_KEYWORD_LENGTH = 64;

const MEMORY_ID_PATTERN = /^mem_[a-f0-9]{24}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export interface NormalizedMemoryInput {
  readonly category: MemoryCategory;
  readonly content: string;
  readonly identityKey: string;
  readonly key: string;
  readonly keywords: readonly string[];
  readonly pinned: boolean;
  readonly scope: MemoryScope;
}

export function normalizeMemoryInput(
  input: MemoryUpsertInput,
): NormalizedMemoryInput {
  if (!isRecord(input)) {
    throw invalidMemory("Memory input must be an object");
  }

  const scope = parseScope(input.scope);
  const category = parseCategory(input.category);
  const key = normalizeRequiredText(
    input.key,
    "key",
    MAX_MEMORY_KEY_LENGTH,
  );
  const content = normalizeRequiredText(
    input.content,
    "content",
    MAX_MEMORY_CONTENT_LENGTH,
  );
  const keywords = normalizeKeywords(input.keywords ?? []);
  const pinned = input.pinned ?? false;
  if (typeof pinned !== "boolean") {
    throw invalidMemory("Memory pinned must be a boolean");
  }

  assertNoPersistedSecret([key, content, ...keywords]);
  return Object.freeze({
    category,
    content,
    identityKey: normalizeIdentityKey(key),
    key,
    keywords,
    pinned,
    scope,
  });
}

export function createMemoryId(
  scope: MemoryScope,
  identityKey: string,
): string {
  const digest = createHash("sha256")
    .update("bumblebee.memory")
    .update("\0")
    .update(scope)
    .update("\0")
    .update(identityKey)
    .digest("hex")
    .slice(0, 24);
  return `mem_${digest}`;
}

export function normalizeIdentityKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ");
}

export function parseMemoryDocument(
  value: unknown,
  expectedScope: MemoryScope,
): MemoryDocument {
  if (
    !isRecord(value) ||
    value.version !== MEMORY_SCHEMA_VERSION ||
    !Array.isArray(value.records)
  ) {
    throw invalidMemory("Memory document has an invalid shape");
  }

  const records = value.records.map((record) =>
    parseMemoryRecord(record, expectedScope)
  );
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const record of records) {
    const identityKey = normalizeIdentityKey(record.key);
    if (ids.has(record.id) || keys.has(identityKey)) {
      throw invalidMemory("Memory document contains duplicate records");
    }
    ids.add(record.id);
    keys.add(identityKey);
  }

  return freezeDocument(records);
}

export function freezeDocument(
  records: readonly MemoryRecord[],
): MemoryDocument {
  return Object.freeze({
    records: Object.freeze([...records]),
    version: MEMORY_SCHEMA_VERSION,
  });
}

export function freezeMemoryRecord(
  record: MemoryRecord,
): MemoryRecord {
  return Object.freeze({
    ...record,
    keywords: Object.freeze([...record.keywords]),
  });
}

function parseMemoryRecord(
  value: unknown,
  expectedScope: MemoryScope,
): MemoryRecord {
  if (!isRecord(value)) {
    throw invalidMemory("Memory record must be an object");
  }

  const scope = parseScope(value.scope);
  if (scope !== expectedScope) {
    throw invalidMemory("Memory record scope does not match its file");
  }
  const id = normalizeRequiredText(value.id, "id", 64);
  if (!MEMORY_ID_PATTERN.test(id)) {
    throw invalidMemory("Memory record ID is invalid");
  }
  const key = normalizeRequiredText(
    value.key,
    "key",
    MAX_MEMORY_KEY_LENGTH,
  );
  const content = normalizeRequiredText(
    value.content,
    "content",
    MAX_MEMORY_CONTENT_LENGTH,
  );
  const keywords = normalizeKeywords(value.keywords);
  const category = parseCategory(value.category);
  if (typeof value.pinned !== "boolean") {
    throw invalidMemory("Memory record pinned flag is invalid");
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) <= 0) {
    throw invalidMemory("Memory record revision is invalid");
  }
  const createdAt = parseTimestamp(value.createdAt, "createdAt");
  const updatedAt = parseTimestamp(value.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw invalidMemory("Memory record timestamps are inconsistent");
  }

  assertNoPersistedSecret([key, content, ...keywords]);
  return freezeMemoryRecord({
    category,
    content,
    createdAt,
    id,
    key,
    keywords,
    pinned: value.pinned,
    revision: Number(value.revision),
    scope,
    updatedAt,
  });
}

function normalizeKeywords(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_KEYWORDS) {
    throw invalidMemory("Memory keywords are invalid");
  }

  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value) {
    const keyword = normalizeRequiredText(
      item,
      "keyword",
      MAX_MEMORY_KEYWORD_LENGTH,
    );
    const identity = normalizeIdentityKey(keyword);
    if (!seen.has(identity)) {
      seen.add(identity);
      keywords.push(keyword);
    }
  }
  return Object.freeze(keywords);
}

function parseScope(value: unknown): MemoryScope {
  if (
    typeof value === "string" &&
    (MEMORY_SCOPES as readonly string[]).includes(value)
  ) {
    return value as MemoryScope;
  }
  throw invalidMemory("Memory scope is invalid");
}

function parseCategory(value: unknown): MemoryCategory {
  if (
    typeof value === "string" &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value)
  ) {
    return value as MemoryCategory;
  }
  throw invalidMemory("Memory category is invalid");
}

function normalizeRequiredText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw invalidMemory(`Memory ${fieldName} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw invalidMemory(`Memory ${fieldName} is invalid`);
  }
  return normalized;
}

function parseTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw invalidMemory(`Memory ${fieldName} must be a timestamp`);
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== value
  ) {
    throw invalidMemory(`Memory ${fieldName} is invalid`);
  }
  return value;
}

function invalidMemory(message: string): BumblebeeError {
  return new BumblebeeError(message, {
    code: ERROR_CODES.INVALID_INPUT,
    userMessage: "记忆数据格式无效，请检查对应的 JSON 文件。",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";

export const DEFAULT_CHANNEL_DEDUPLICATION_CAPACITY = 1_024;
export const DEFAULT_CHANNEL_DEDUPLICATION_TTL_MS = 10 * 60 * 1_000;
const MAX_DEDUPLICATION_KEY_LENGTH = 512;

export interface MessageDeduplicationLease {
  /** 成功完成全部处理及发送后保留消息 ID，直到 TTL 到期。 */
  commit(): void;
  /** 处理失败时删除消息 ID，使平台重投能够再次执行。 */
  release(): void;
}

export interface MessageDeduplicatorOptions {
  readonly capacity?: number;
  readonly clock?: () => number;
  readonly ttlMs?: number;
}

interface MessageEntry {
  expiresAt?: number;
  state: "completed" | "processing";
}

/**
 * 有界的进程内消息 ID 租约表。
 * 正在处理的消息不会被容量淘汰，避免同一副作用并发执行两次。
 */
export class MessageDeduplicator {
  private readonly capacity: number;
  private readonly clock: () => number;
  private readonly entries = new Map<string, MessageEntry>();
  private readonly ttlMs: number;

  constructor(options: MessageDeduplicatorOptions = {}) {
    this.capacity = normalizePositiveInteger(
      options.capacity ?? DEFAULT_CHANNEL_DEDUPLICATION_CAPACITY,
      "capacity",
    );
    this.clock = options.clock ?? Date.now;
    this.ttlMs = normalizePositiveInteger(
      options.ttlMs ?? DEFAULT_CHANNEL_DEDUPLICATION_TTL_MS,
      "ttlMs",
    );
  }

  get inFlightCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === "processing") {
        count += 1;
      }
    }
    return count;
  }

  get size(): number {
    this.purgeExpired(this.readTime());
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  tryAcquire(rawKey: string): MessageDeduplicationLease | undefined {
    const key = normalizeKey(rawKey);
    const now = this.readTime();
    this.purgeExpired(now);

    if (this.entries.has(key)) {
      return undefined;
    }
    this.makeCapacity();

    const entry: MessageEntry = { state: "processing" };
    this.entries.set(key, entry);
    let active = true;

    return Object.freeze({
      commit: () => {
        if (!active) {
          return;
        }
        active = false;
        if (this.entries.get(key) !== entry) {
          return;
        }

        entry.state = "completed";
        entry.expiresAt = addDuration(this.readTime(), this.ttlMs);
        // Map 插入顺序用于淘汰最早完成的记录。
        this.entries.delete(key);
        this.entries.set(key, entry);
      },
      release: () => {
        if (!active) {
          return;
        }
        active = false;
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      },
    });
  }

  private makeCapacity(): void {
    if (this.entries.size < this.capacity) {
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.state === "completed") {
        this.entries.delete(key);
        return;
      }
    }

    throw new BumblebeeError(
      "Channel deduplication capacity is occupied by in-flight messages",
      {
        code: ERROR_CODES.UNAVAILABLE,
        context: { capacity: this.capacity },
        retryable: true,
        userMessage: "渠道当前处理的消息过多，请稍后重试。",
      },
    );
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (
        entry.state === "completed" &&
        entry.expiresAt !== undefined &&
        entry.expiresAt <= now
      ) {
        this.entries.delete(key);
      }
    }
  }

  private readTime(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < 0) {
      throw new BumblebeeError(
        "Message deduplicator clock must return a non-negative finite number",
        { code: ERROR_CODES.INTERNAL },
      );
    }
    return Math.floor(value);
  }
}

function normalizeKey(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized.length === 0 ||
    normalized.length > MAX_DEDUPLICATION_KEY_LENGTH
  ) {
    throw new BumblebeeError(
      `deduplication key must contain 1 to ${MAX_DEDUPLICATION_KEY_LENGTH} characters`,
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fieldName: "key" },
      },
    );
  }
  return normalized;
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BumblebeeError(
      `${fieldName} must be a positive safe integer`,
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fieldName },
      },
    );
  }
  return value;
}

function addDuration(timestamp: number, duration: number): number {
  const result = timestamp + duration;
  return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER;
}

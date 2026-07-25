import { createHash } from "node:crypto";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import {
  MAX_CHANNEL_TEXT_LENGTH,
  normalizeChannelMessage,
  type ChannelMessage,
  type ConversationPort,
  type ConversationResponse,
} from "../../channels/index.js";
import {
  BumblebeeError,
  ERROR_CODES,
  getAbortError,
  normalizeError,
  throwIfAborted,
} from "../../foundation/index.js";
import type {
  MemoryContextProvider,
} from "../../memory/index.js";
import {
  createPiMemoryContextExtension,
} from "./memory-context-extension.js";
import {
  createReadOnlyWorkspaceGuard,
  PI_READ_ONLY_TOOL_NAMES,
} from "./read-only-workspace-guard.js";

export const DEFAULT_PI_CONVERSATION_MAX_OPEN_SESSIONS = 16;

const CHANNEL_SESSION_DIRECTORY = "channel-sessions";
const CHANNEL_SYSTEM_PROMPT = [
  "You are responding through a remote messaging channel.",
  "Use the current workspace only for read-only investigation.",
  "Do not claim to have modified files or executed shell commands.",
  "Return a self-contained plain-text answer suitable for a chat client.",
].join(" ");
const CHANNEL_BOUNDARY_MESSAGE =
  "渠道会话只能使用当前工作区内的只读工具。";
const TRUNCATION_NOTICE = "\n\n[回复过长，已截断]";

type PiModel = NonNullable<ExtensionContext["model"]>;
type PiModelRegistry = ExtensionContext["modelRegistry"];
type PiThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

export interface PiConversationSession {
  readonly isStreaming: boolean;
  readonly model: {
    readonly id: string;
    readonly provider: string;
  } | undefined;
  readonly state: { readonly messages: readonly unknown[] };
  readonly thinkingLevel: PiThinkingLevel;
  abort(): Promise<void>;
  dispose(): void;
  getActiveToolNames(): string[];
  prompt(
    text: string,
    options: {
      readonly expandPromptTemplates: false;
      readonly source: "extension";
    },
  ): Promise<void>;
  setModel(model: PiModel): Promise<void>;
  setThinkingLevel(level: PiThinkingLevel): void;
}

export interface PiConversationSessionFactoryOptions {
  readonly agentDir: string;
  readonly cwd: string;
  readonly model: PiModel;
  readonly modelRegistry: PiModelRegistry;
  readonly memoryContextProvider?: MemoryContextProvider;
  readonly sessionDirectory: string;
  readonly thinkingLevel: PiThinkingLevel;
}

export type PiConversationSessionFactory = (
  options: PiConversationSessionFactoryOptions,
) => Promise<PiConversationSession>;

export interface PiConversationBridgeOptions {
  readonly agentDir?: string;
  readonly cwd: string;
  readonly getModel: () => ExtensionContext["model"];
  readonly getThinkingLevel: () => PiThinkingLevel;
  readonly maxOpenSessions?: number;
  readonly memoryContextProvider?: MemoryContextProvider;
  readonly modelRegistry: PiModelRegistry;
  readonly sessionFactory?: PiConversationSessionFactory;
  readonly sessionRoot?: string;
}

interface SessionEntry {
  abortPromise?: Promise<AbortOutcome>;
  activeCount: number;
  creation?: Promise<PiConversationSession>;
  disposed: boolean;
  lastUsed: number;
  session?: PiConversationSession;
}

interface SessionLease {
  readonly entry: SessionEntry;
  readonly session: PiConversationSession;
}

type AbortOutcome =
  | { readonly status: "succeeded" }
  | { readonly cause: unknown; readonly status: "failed" };

/**
 * 将渠道消息映射为独立的、可恢复的 Pi AgentSession。
 * 会话按 channel + conversationId 隔离，原始平台标识不会进入目录名。
 */
export class PiConversationBridge implements ConversationPort {
  private accepting = true;
  private readonly agentDir: string;
  private readonly cwd: string;
  private disposePromise: Promise<void> | undefined;
  private readonly entries = new Map<string, SessionEntry>();
  private readonly getModel: () => ExtensionContext["model"];
  private readonly getThinkingLevel: () => PiThinkingLevel;
  private readonly inFlight = new Set<Promise<ConversationResponse>>();
  private readonly maxOpenSessions: number;
  private readonly memoryContextProvider: MemoryContextProvider | undefined;
  private readonly modelRegistry: PiModelRegistry;
  private readonly sessionFactory: PiConversationSessionFactory;
  private readonly sessionRoot: string;
  private useCounter = 0;

  constructor(options: PiConversationBridgeOptions) {
    this.cwd = normalizeDirectory(options.cwd, "cwd");
    this.agentDir = normalizeDirectory(
      options.agentDir ?? getAgentDir(),
      "agentDir",
    );
    this.sessionRoot = normalizeDirectory(
      options.sessionRoot ??
        path.join(this.agentDir, "bumblebee", CHANNEL_SESSION_DIRECTORY),
      "sessionRoot",
    );
    this.maxOpenSessions = normalizeCapacity(options.maxOpenSessions);
    this.getModel = options.getModel;
    this.getThinkingLevel = options.getThinkingLevel;
    this.memoryContextProvider = options.memoryContextProvider;
    this.modelRegistry = options.modelRegistry;
    this.sessionFactory =
      options.sessionFactory ?? createDefaultConversationSession;
  }

  respond(
    message: ChannelMessage,
    signal: AbortSignal,
  ): Promise<ConversationResponse> {
    const response = this.respondInternal(message, signal);
    this.inFlight.add(response);
    void response.then(
      () => this.inFlight.delete(response),
      () => this.inFlight.delete(response),
    );
    return response;
  }

  /** 停止接收新消息，取消正在生成的回复，并释放所有缓存会话。 */
  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async respondInternal(
    message: ChannelMessage,
    signal: AbortSignal,
  ): Promise<ConversationResponse> {
    this.ensureAccepting();
    throwIfAborted(signal);

    const normalized = normalizeChannelMessage(message);
    const identity = createConversationIdentity(normalized);
    const lease = await this.acquireSession(identity, signal);
    let executionFailure: unknown;
    let hasExecutionFailure = false;
    let response: ConversationResponse | undefined;
    let abortPromise: Promise<AbortOutcome> | undefined;

    const requestAbort = (): void => {
      abortPromise ??= this.requestAbort(lease.entry);
    };
    const onAbort = (): void => requestAbort();

    if (signal.aborted) {
      requestAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      await this.syncPiSettings(lease.session);
      this.ensureAccepting();
      throwIfAborted(signal);

      const previousMessages = new Set(lease.session.state.messages);
      await lease.session.prompt(normalized.text, {
        expandPromptTemplates: false,
        source: "extension",
      });
      this.ensureAccepting();
      throwIfAborted(signal);

      const text = extractCurrentAssistantText(
        lease.session.state.messages,
        previousMessages,
      );
      if (text.trim().length === 0) {
        throw new BumblebeeError(
          "Pi channel session produced no assistant response",
          {
            code: ERROR_CODES.UNAVAILABLE,
            retryable: true,
            userMessage: "模型没有返回可发送的文本回复，请稍后重试。",
          },
        );
      }
      response = createConversationResponse(text);
    } catch (cause: unknown) {
      hasExecutionFailure = true;
      executionFailure = cause;
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (lease.session.isStreaming) {
        requestAbort();
      }

      const abortOutcome = await abortPromise;
      if (abortOutcome?.status === "failed") {
        executionFailure = hasExecutionFailure
          ? new AggregateError(
              [executionFailure, abortOutcome.cause],
              "Pi conversation execution and abort both failed",
            )
          : abortOutcome.cause;
        hasExecutionFailure = true;
      }
      this.releaseSession(lease.entry, abortPromise);
    }

    if (signal.aborted) {
      throw getAbortError(signal);
    }
    if (hasExecutionFailure) {
      throw normalizePiConversationFailure(
        executionFailure,
        "Pi conversation execution failed",
      );
    }
    if (response === undefined) {
      throw new BumblebeeError("Pi conversation produced no result", {
        code: ERROR_CODES.INTERNAL,
      });
    }
    return response;
  }

  private async acquireSession(
    identity: ConversationIdentity,
    signal: AbortSignal,
  ): Promise<SessionLease> {
    this.ensureAccepting();

    let entry = this.entries.get(identity.key);
    if (entry === undefined) {
      const model = this.requireCurrentModel();
      this.evictForCapacity();

      entry = {
        activeCount: 0,
        disposed: false,
        lastUsed: this.nextUse(),
      };
      this.entries.set(identity.key, entry);
      entry.creation = this.createSession(entry, identity, model);
    }

    const creation = entry.creation;
    if (creation === undefined) {
      throw new BumblebeeError(
        "Pi conversation cache entry has no creation promise",
        { code: ERROR_CODES.INTERNAL },
      );
    }
    const session = await waitForPromise(creation, signal);
    this.ensureAccepting();
    throwIfAborted(signal);

    if (entry.activeCount > 0) {
      throw new BumblebeeError("Pi conversation session is already active", {
        code: ERROR_CODES.CONFLICT,
        retryable: true,
        userMessage: "该会话正在处理上一条消息，请稍后重试。",
      });
    }

    entry.activeCount += 1;
    entry.lastUsed = this.nextUse();
    return { entry, session };
  }

  private async createSession(
    entry: SessionEntry,
    identity: ConversationIdentity,
    model: PiModel,
  ): Promise<PiConversationSession> {
    let session: PiConversationSession | undefined;

    try {
      session = await this.sessionFactory({
        agentDir: this.agentDir,
        cwd: this.cwd,
        model,
        modelRegistry: this.modelRegistry,
        ...(this.memoryContextProvider === undefined
          ? {}
          : { memoryContextProvider: this.memoryContextProvider }),
        sessionDirectory: path.join(
          this.sessionRoot,
          identity.channel,
          identity.digest,
        ),
        thinkingLevel: this.getThinkingLevel(),
      });
      assertReadOnlyToolSet(session.getActiveToolNames());
      this.ensureAccepting();
      entry.session = session;
      return session;
    } catch (cause: unknown) {
      this.deleteEntry(entry);
      if (session === undefined) {
        throw normalizePiConversationFailure(
          cause,
          "Unable to create Pi conversation session",
        );
      }

      try {
        session.dispose();
      } catch (disposeCause: unknown) {
        throw normalizePiConversationFailure(
          new AggregateError(
            [cause, disposeCause],
            "Pi conversation creation and disposal both failed",
          ),
          "Unable to create Pi conversation session",
        );
      }
      throw normalizePiConversationFailure(
        cause,
        "Unable to create Pi conversation session",
      );
    }
  }

  private async syncPiSettings(session: PiConversationSession): Promise<void> {
    const model = this.requireCurrentModel();
    if (
      session.model?.provider !== model.provider ||
      session.model.id !== model.id
    ) {
      await session.setModel(model);
    }

    const thinkingLevel = this.getThinkingLevel();
    if (session.thinkingLevel !== thinkingLevel) {
      session.setThinkingLevel(thinkingLevel);
    }
  }

  private evictForCapacity(): void {
    if (this.entries.size < this.maxOpenSessions) {
      return;
    }

    let candidate: SessionEntry | undefined;
    for (const entry of this.entries.values()) {
      if (
        entry.session === undefined ||
        entry.activeCount > 0 ||
        entry.session.isStreaming ||
        entry.disposed
      ) {
        continue;
      }
      if (candidate === undefined || entry.lastUsed < candidate.lastUsed) {
        candidate = entry;
      }
    }

    if (candidate === undefined) {
      throw new BumblebeeError(
        "All cached Pi conversation sessions are active",
        {
          code: ERROR_CODES.UNAVAILABLE,
          retryable: true,
          userMessage: "当前并发会话已满，请稍后重试。",
        },
      );
    }

    this.deleteEntry(candidate);
    try {
      this.disposeSession(candidate);
    } catch (cause: unknown) {
      throw normalizeError(cause, {
        code: ERROR_CODES.INTERNAL,
        message: "Unable to evict Pi conversation session",
      });
    }
  }

  private requestAbort(entry: SessionEntry): Promise<AbortOutcome> {
    const session = entry.session;
    if (session === undefined) {
      return Promise.resolve({ status: "succeeded" });
    }
    entry.abortPromise ??= session.abort().then<AbortOutcome, AbortOutcome>(
      () => ({ status: "succeeded" }),
      (cause: unknown) => ({ cause, status: "failed" }),
    );
    return entry.abortPromise;
  }

  private releaseSession(
    entry: SessionEntry,
    abortPromise: Promise<AbortOutcome> | undefined,
  ): void {
    entry.activeCount = Math.max(0, entry.activeCount - 1);
    if (entry.abortPromise === abortPromise) {
      delete entry.abortPromise;
    }
    if (!entry.disposed) {
      entry.lastUsed = this.nextUse();
    }
  }

  private async disposeInternal(): Promise<void> {
    this.accepting = false;
    const failures: unknown[] = [];

    const creationPromises = [...this.entries.values()].flatMap((entry) =>
      entry.creation === undefined ? [] : [entry.creation],
    );
    for (const entry of this.entries.values()) {
      if (entry.session !== undefined && (
        entry.activeCount > 0 ||
        entry.session.isStreaming
      )) {
        void this.requestAbort(entry);
      }
    }

    await Promise.allSettled(creationPromises);

    const aborts: Array<Promise<AbortOutcome>> = [];
    for (const entry of this.entries.values()) {
      if (entry.session !== undefined && (
        entry.activeCount > 0 ||
        entry.session.isStreaming
      )) {
        aborts.push(this.requestAbort(entry));
      }
    }
    for (const outcome of await Promise.all(aborts)) {
      if (outcome.status === "failed") {
        failures.push(outcome.cause);
      }
    }

    await Promise.allSettled([...this.inFlight]);

    for (const entry of [...this.entries.values()]) {
      this.deleteEntry(entry);
      try {
        this.disposeSession(entry);
      } catch (cause: unknown) {
        failures.push(cause);
      }
    }

    if (failures.length > 0) {
      throw normalizeError(
        new AggregateError(
          failures,
          "One or more Pi conversation sessions failed to close",
        ),
        {
          code: ERROR_CODES.INTERNAL,
          message: "Unable to close all Pi conversation sessions",
        },
      );
    }
  }

  private disposeSession(entry: SessionEntry): void {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    entry.session?.dispose();
  }

  private deleteEntry(entry: SessionEntry): void {
    for (const [key, candidate] of this.entries) {
      if (candidate === entry) {
        this.entries.delete(key);
        return;
      }
    }
  }

  private ensureAccepting(): void {
    if (!this.accepting) {
      throw new BumblebeeError("Pi conversation bridge is closed", {
        code: ERROR_CODES.CANCELLED,
        userMessage: "渠道会话正在关闭，请稍后重新连接。",
      });
    }
  }

  private requireCurrentModel(): PiModel {
    const model = this.getModel();
    if (model === undefined) {
      throw new BumblebeeError("Current pi model is unavailable", {
        code: ERROR_CODES.UNAVAILABLE,
        userMessage: "当前没有可用模型，请先在 pi 中通过 /model 选择模型。",
      });
    }
    return model;
  }

  private nextUse(): number {
    this.useCounter += 1;
    return this.useCounter;
  }
}

interface ConversationIdentity {
  readonly channel: string;
  readonly digest: string;
  readonly key: string;
}

function createConversationIdentity(
  message: ChannelMessage,
): ConversationIdentity {
  const digest = createHash("sha256")
    .update(message.channel)
    .update("\0")
    .update(message.conversationId)
    .digest("hex");
  return Object.freeze({
    channel: message.channel,
    digest,
    key: `${message.channel}:${digest}`,
  });
}

async function createDefaultConversationSession(
  options: PiConversationSessionFactoryOptions,
): Promise<PiConversationSession> {
  const settingsManager = SettingsManager.inMemory();
  const extensionFactories: ExtensionFactory[] = [
    createReadOnlyWorkspaceGuard({
      boundaryMessage: CHANNEL_BOUNDARY_MESSAGE,
    }),
  ];
  if (options.memoryContextProvider !== undefined) {
    extensionFactories.push(
      createPiMemoryContextExtension(options.memoryContextProvider),
    );
  }
  const resourceLoader = new DefaultResourceLoader({
    agentDir: options.agentDir,
    appendSystemPrompt: [CHANNEL_SYSTEM_PROMPT],
    cwd: options.cwd,
    extensionFactories,
    noExtensions: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    agentDir: options.agentDir,
    cwd: options.cwd,
    model: options.model,
    modelRegistry: options.modelRegistry,
    resourceLoader,
    sessionManager: SessionManager.continueRecent(
      options.cwd,
      options.sessionDirectory,
    ),
    sessionStartEvent: { reason: "startup", type: "session_start" },
    settingsManager,
    thinkingLevel: options.thinkingLevel,
    tools: [...PI_READ_ONLY_TOOL_NAMES],
  });

  if (result.extensionsResult.errors.length > 0) {
    result.session.dispose();
    throw new AggregateError(
      result.extensionsResult.errors.map(
        (item) => new Error(`${item.path}: ${item.error}`),
      ),
      "Unable to load the channel permission guard",
    );
  }
  return result.session;
}

function assertReadOnlyToolSet(toolNames: readonly string[]): void {
  const actual = [...new Set(toolNames)].sort();
  const expected = [...PI_READ_ONLY_TOOL_NAMES].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new BumblebeeError("Channel session tool isolation is invalid", {
      code: ERROR_CODES.CONFLICT,
      context: { activeToolNames: actual },
      userMessage: "渠道会话的只读工具隔离未能建立。",
    });
  }
}

function extractCurrentAssistantText(
  messages: readonly unknown[],
  previousMessages: ReadonlySet<unknown>,
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      previousMessages.has(message) ||
      !isRecord(message) ||
      message.role !== "assistant"
    ) {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }

    const text = content.flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    ).join("");
    if (text.trim().length > 0) {
      return text;
    }
  }
  return "";
}

function createConversationResponse(text: string): ConversationResponse {
  if (text.length <= MAX_CHANNEL_TEXT_LENGTH) {
    return Object.freeze({ text });
  }

  const prefixLength = MAX_CHANNEL_TEXT_LENGTH - TRUNCATION_NOTICE.length;
  let prefix = text.slice(0, prefixLength);
  if (/[\uD800-\uDBFF]$/u.test(prefix)) {
    prefix = prefix.slice(0, -1);
  }
  return Object.freeze({
    metadata: Object.freeze({ truncated: true }),
    text: `${prefix}${TRUNCATION_NOTICE}`,
  });
}

function waitForPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(getAbortError(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause);
      },
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

function normalizeDirectory(value: string, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BumblebeeError(`${fieldName} must be a non-empty path`, {
      code: ERROR_CODES.INVALID_INPUT,
      context: { fieldName },
    });
  }
  return path.resolve(value);
}

function normalizeCapacity(value: number | undefined): number {
  const capacity = value ?? DEFAULT_PI_CONVERSATION_MAX_OPEN_SESSIONS;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new BumblebeeError(
      "maxOpenSessions must be a positive safe integer",
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { fieldName: "maxOpenSessions" },
      },
    );
  }
  return capacity;
}

function normalizePiConversationFailure(
  cause: unknown,
  message: string,
): BumblebeeError {
  return normalizeError(cause, {
    code: ERROR_CODES.UNAVAILABLE,
    message,
    retryable: true,
    userMessage: "渠道对话调用失败，请检查当前模型与鉴权配置。",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

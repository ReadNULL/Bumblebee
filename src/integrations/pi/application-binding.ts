import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import {
  ChannelDispatcher,
  ChannelManager,
  FeishuAdapter,
  OfficialFeishuGateway,
  SILENT_FEISHU_LOGGER,
  loadFeishuConfig,
  type EnvironmentSource,
  type ConversationPort,
  type FeishuConfig,
  type FeishuDiagnosticLogger,
  type FeishuGateway,
} from "../../channels/index.js";
import {
  Lifecycle,
  type LifecycleInitializeOptions,
} from "../../foundation/index.js";
import type {
  TaskExecutionRequest,
  TaskOperation,
} from "../../runtime/index.js";
import {
  PiConversationBridge,
  type PiConversationBridgeOptions,
} from "./pi-conversation-bridge.js";

export interface PiApplicationRuntime {
  dispose(): Promise<void>;
  execute<T>(
    request: TaskExecutionRequest,
    operation: TaskOperation<T>,
  ): Promise<T>;
  initialize(options?: LifecycleInitializeOptions): Promise<void>;
}

export interface PiModelSelectEvent {
  readonly model: NonNullable<ExtensionContext["model"]>;
  readonly type: "model_select";
}

export interface PiApplicationRegistrar {
  getThinkingLevel(): ReturnType<ExtensionAPI["getThinkingLevel"]>;
  on(
    event: "model_select",
    handler: ExtensionHandler<PiModelSelectEvent>,
  ): void;
  on(
    event: "session_shutdown",
    handler: ExtensionHandler<SessionShutdownEvent>,
  ): void;
  on(
    event: "session_start",
    handler: ExtensionHandler<SessionStartEvent>,
  ): void;
}

export type FeishuGatewayFactory = (
  config: FeishuConfig,
  logger: FeishuDiagnosticLogger,
) => FeishuGateway;

export interface ManagedConversationBridge extends ConversationPort {
  dispose(): Promise<void>;
}

export type PiConversationBridgeFactory = (
  options: PiConversationBridgeOptions,
) => ManagedConversationBridge;

export interface PiExtensionApplicationOptions {
  readonly bridgeFactory?: PiConversationBridgeFactory;
  readonly environment?: EnvironmentSource;
  readonly feishuGatewayFactory?: FeishuGatewayFactory;
  readonly feishuLogger?: FeishuDiagnosticLogger;
  readonly feishuStartupTimeoutMs?: number;
}

/**
 * Pi 扩展组合根：运行时先就绪，渠道随后启动；关闭时按相反顺序释放。
 */
export class PiExtensionApplication {
  private readonly bridgeFactory: PiConversationBridgeFactory;
  private currentModel: ExtensionContext["model"];
  private readonly environment: EnvironmentSource;
  private readonly feishuGatewayFactory: FeishuGatewayFactory;
  private readonly feishuLogger: FeishuDiagnosticLogger;
  private readonly feishuStartupTimeoutMs: number | undefined;
  private readonly getThinkingLevel:
    () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  private readonly lifecycle = new Lifecycle();
  private readonly runtime: PiApplicationRuntime;

  constructor(
    pi: Pick<PiApplicationRegistrar, "getThinkingLevel">,
    runtime: PiApplicationRuntime,
    options: PiExtensionApplicationOptions = {},
  ) {
    this.bridgeFactory =
      options.bridgeFactory ?? ((bridgeOptions) =>
        new PiConversationBridge(bridgeOptions));
    this.environment = options.environment ?? process.env;
    this.feishuGatewayFactory =
      options.feishuGatewayFactory ??
      ((config, logger) => new OfficialFeishuGateway(config, logger));
    this.feishuLogger = options.feishuLogger ?? SILENT_FEISHU_LOGGER;
    this.feishuStartupTimeoutMs = options.feishuStartupTimeoutMs;
    this.getThinkingLevel = () => pi.getThinkingLevel();
    this.runtime = runtime;
  }

  initialize(context: ExtensionContext): Promise<void> {
    this.currentModel = context.model;

    return this.lifecycle.initialize(async ({ defer, signal }) => {
      await this.runtime.initialize({ signal });
      defer("bumblebee-runtime", () => this.runtime.dispose());

      const feishuConfig = loadFeishuConfig(this.environment);
      if (feishuConfig === undefined) {
        return;
      }

      const bridge = this.bridgeFactory({
        cwd: context.cwd,
        getModel: () => this.currentModel,
        getThinkingLevel: this.getThinkingLevel,
        modelRegistry: context.modelRegistry,
      });
      defer("pi-conversation-bridge", () => bridge.dispose());

      const adapter = new FeishuAdapter({
        allowedSenderIds: feishuConfig.allowedSenderIds,
        gateway: this.feishuGatewayFactory(
          feishuConfig,
          this.feishuLogger,
        ),
        logger: this.feishuLogger,
        ...(this.feishuStartupTimeoutMs === undefined
          ? {}
          : { startupTimeoutMs: this.feishuStartupTimeoutMs }),
      });
      const dispatcher = new ChannelDispatcher({
        conversation: bridge,
        runtime: this.runtime,
      });
      const manager = new ChannelManager({
        adapters: [adapter],
        dispatcher,
      });
      defer("channel-manager", () => manager.dispose());

      await manager.initialize({ signal });
      safeNotify(context, "飞书渠道已连接。", "info");
    });
  }

  selectModel(model: ExtensionContext["model"]): void {
    this.currentModel = model;
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }
}

export function bindPiApplicationLifecycle(
  pi: PiApplicationRegistrar,
  runtime: PiApplicationRuntime,
  options: PiExtensionApplicationOptions = {},
): PiExtensionApplication {
  const application = new PiExtensionApplication(pi, runtime, options);

  pi.on("session_start", async (_event, context) => {
    await application.initialize(context);
  });
  pi.on("model_select", (event) => {
    application.selectModel(event.model);
  });
  pi.on("session_shutdown", async () => {
    await application.dispose();
  });

  return application;
}

function safeNotify(
  context: ExtensionContext,
  message: string,
  type: "error" | "info" | "warning",
): void {
  if (!context.hasUI) {
    return;
  }
  try {
    context.ui.notify(message, type);
  } catch {
    // 渠道已经连接，UI 通知失败不应触发资源回滚。
  }
}

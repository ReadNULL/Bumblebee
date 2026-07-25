import type {
  ExtensionHandler,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export interface PiLifecycleRegistrar {
  on(
    event: "session_start",
    handler: ExtensionHandler<SessionStartEvent>,
  ): void;
  on(
    event: "session_shutdown",
    handler: ExtensionHandler<SessionShutdownEvent>,
  ): void;
}

export interface ManagedRuntime {
  initialize(): Promise<void>;
  dispose(): Promise<void>;
}

/** 将 pi 的单次扩展运行时生命周期映射到 Bumblebee 运行时。 */
export function bindPiLifecycle(
  pi: PiLifecycleRegistrar,
  runtime: ManagedRuntime,
): void {
  pi.on("session_start", async () => {
    await runtime.initialize();
  });

  pi.on("session_shutdown", async () => {
    await runtime.dispose();
  });
}

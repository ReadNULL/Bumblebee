import path from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  bindPiApplicationLifecycle,
  bindPiMemory,
  bindPiPermissionSystem,
  bindPiSubAgent,
} from "./integrations/pi/index.js";
import { LightweightMemory } from "./memory/index.js";
import { BumblebeeRuntime } from "./runtime/index.js";
import { PermissionSystem } from "./security/index.js";

export default function bumblebeeExtension(pi: ExtensionAPI): void {
  const runtime = new BumblebeeRuntime();
  const permissionSystem = new PermissionSystem();
  const configuredMemoryDirectory =
    process.env.BUMBLEBEE_MEMORY_DIR?.trim();
  const memory = new LightweightMemory({
    rootDirectory: configuredMemoryDirectory?.length
      ? configuredMemoryDirectory
      : path.join(getAgentDir(), "bumblebee", "memory"),
  });

  bindPiApplicationLifecycle(pi, runtime, { memory });
  bindPiMemory(pi, runtime, memory);
  bindPiPermissionSystem(pi, runtime, permissionSystem);
  bindPiSubAgent(pi, runtime);
}

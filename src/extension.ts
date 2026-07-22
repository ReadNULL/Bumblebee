import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  bindPiLifecycle,
  bindPiPermissionSystem,
  bindPiSubAgent,
} from "./integrations/pi/index.js";
import { BumblebeeRuntime } from "./runtime/index.js";
import { PermissionSystem } from "./security/index.js";

export default function bumblebeeExtension(pi: ExtensionAPI): void {
  const runtime = new BumblebeeRuntime();
  const permissionSystem = new PermissionSystem();

  bindPiLifecycle(pi, runtime);
  bindPiPermissionSystem(pi, runtime, permissionSystem);
  bindPiSubAgent(pi, runtime);
}

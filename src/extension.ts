import path from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  BUMBLEBEE_FEATURE_PROFILE_ENV,
  resolveBumblebeeFeatureProfile,
  type BumblebeeFeatureProfileName,
} from "./config/index.js";
import {
  bindPiApplicationLifecycle,
  bindPiMemory,
  bindPiPermissionSystem,
  bindPiSubAgent,
  bindPiTaskAssurance,
  type PiPermissionAuthorityFactory,
} from "./integrations/pi/index.js";
import { LightweightMemory } from "./memory/index.js";
import { BumblebeeRuntime } from "./runtime/index.js";
import { PermissionSystem } from "./security/index.js";

export interface BumblebeeExtensionOptions {
  readonly permissionAuthorityFactory?: PiPermissionAuthorityFactory;
  readonly profile?: BumblebeeFeatureProfileName;
}

export function registerBumblebeeExtension(
  pi: ExtensionAPI,
  options: BumblebeeExtensionOptions = {},
): void {
  const profile = resolveBumblebeeFeatureProfile(
    options.profile ??
      process.env[BUMBLEBEE_FEATURE_PROFILE_ENV],
  );
  const features = profile.features;
  if (
    !features.assurance &&
    !features.channels &&
    !features.memory &&
    !features.permission &&
    !features.subagent
  ) {
    return;
  }

  const runtime = new BumblebeeRuntime();
  const memory = features.memory ? createMemory() : undefined;

  bindPiApplicationLifecycle(pi, runtime, {
    channelsEnabled: features.channels,
    ...(memory === undefined ? {} : { memory }),
  });
  if (memory !== undefined) {
    bindPiMemory(pi, runtime, memory);
  }
  if (features.assurance) {
    bindPiTaskAssurance(pi, {
      criticToolEnabled: features.subagent,
    });
  }
  if (features.permission) {
    bindPiPermissionSystem(
      pi,
      runtime,
      new PermissionSystem(),
      {
        ...(options.permissionAuthorityFactory === undefined
          ? {}
          : {
              authorityFactory:
                options.permissionAuthorityFactory,
            }),
      },
    );
  }
  if (features.subagent) {
    bindPiSubAgent(pi, runtime);
  }
}

function createMemory(): LightweightMemory {
  const configuredMemoryDirectory =
    process.env.BUMBLEBEE_MEMORY_DIR?.trim();
  return new LightweightMemory({
    rootDirectory: configuredMemoryDirectory?.length
      ? configuredMemoryDirectory
      : path.join(getAgentDir(), "bumblebee", "memory"),
  });
}

export default function bumblebeeExtension(pi: ExtensionAPI): void {
  registerBumblebeeExtension(pi);
}

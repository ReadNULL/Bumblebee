import type {
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

import {
  registerBumblebeeExtension,
} from "../../src/extension.js";
import {
  PERMISSION_APPROVALS,
  type PermissionAuthority,
} from "../../src/security/index.js";

const ISOLATED_CONTAINER_AUTHORITY: PermissionAuthority =
  Object.freeze({
    async requestApproval() {
      return PERMISSION_APPROVALS.ALLOW_ONCE;
    },
  });

/**
 * Terminal-Bench has no interactive UI. Its disposable Docker environment
 * uses an explicit allow-once authority so the candidate measures authorized
 * task utility instead of Bumblebee's expected headless fail-closed behavior.
 */
export default function terminalBenchCandidate(
  pi: ExtensionAPI,
): void {
  registerBumblebeeExtension(pi, {
    permissionAuthorityFactory: () =>
      ISOLATED_CONTAINER_AUTHORITY,
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import bumblebeeExtension from "../src/extension.js";

describe("bumblebeeExtension", () => {
  it("loads without registering behavior", () => {
    const api = new Proxy({} as ExtensionAPI, {
      get(_target, property) {
        throw new Error(`Unexpected ExtensionAPI access: ${String(property)}`);
      },
    });

    expect(bumblebeeExtension(api)).toBeUndefined();
  });
});

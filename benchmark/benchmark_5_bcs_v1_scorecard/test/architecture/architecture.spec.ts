import {
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { benchmarkRoot, projectRoot } from "../fixtures.js";

describe("Benchmark 5 architecture", () => {
  it("keeps scorecard code outside the npm package", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      readonly files?: readonly string[];
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(packageJson.files ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^benchmark(?:\/|$)/u),
      ]),
    );
    expect(packageJson.scripts?.["benchmark:5"]).toContain(
      "benchmark_5_bcs_v1_scorecard",
    );
    expect(packageJson.scripts?.["benchmark:score"]).toBe(
      packageJson.scripts?.["benchmark:5"],
    );
  });

  it("separates manifests, source, and tests", async () => {
    const entries = await readdir(benchmarkRoot, {
      withFileTypes: true,
    });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories).toEqual(
      expect.arrayContaining(["manifests", "src", "test"]),
    );
  });

  it("does not couple production source to Benchmark 5", async () => {
    const files = await listTypeScriptFiles(
      path.join(projectRoot, "src"),
    );
    for (const file of files) {
      expect(await readFile(file, "utf8")).not.toContain(
        "benchmark_5_bcs_v1_scorecard",
      );
    }
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

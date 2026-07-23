import {
  readFile,
  readdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertScoreSpec,
  type ScoreSpec,
} from "../../src/index.js";

const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const projectRoot = resolve(benchmarkRoot, "..");
const currentBenchmarkRoot = join(
  benchmarkRoot,
  "benchmark_0_evaluation_core",
);

describe("Benchmark 0 architecture", () => {
  it("uses the required numbered benchmark directory convention", async () => {
    const entries = await readdir(benchmarkRoot, {
      withFileTypes: true,
    });
    const benchmarkDirectories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(benchmarkDirectories).toContain(
      "benchmark_0_evaluation_core",
    );
    for (const directory of benchmarkDirectories) {
      expect(directory).toMatch(
        /^benchmark_\d+_[a-z0-9]+(?:_[a-z0-9]+)*$/u,
      );
    }
  });

  it("keeps benchmark code out of the npm publish allowlist", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { files?: string[] };

    expect(packageJson.files ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^benchmark(?:\/|$)/u),
      ]),
    );
  });

  it("adds no benchmark-only runtime package dependency", async () => {
    const sourceFiles = await listTypeScriptFiles(
      join(currentBenchmarkRoot, "src"),
    );
    const bareImports: string[] = [];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      for (const match of source.matchAll(
        /from\s+["']([^"']+)["']/gu,
      )) {
        const specifier = match[1];
        if (
          specifier !== undefined &&
          !specifier.startsWith(".") &&
          !specifier.startsWith("node:")
        ) {
          bareImports.push(specifier);
        }
      }
    }

    expect(bareImports).toEqual([]);
  });

  it("ships a valid frozen BCS-v1 score specification", async () => {
    const value = JSON.parse(
      await readFile(
        join(currentBenchmarkRoot, "manifests", "bcs-v1.json"),
        "utf8",
      ),
    ) as ScoreSpec;

    expect(() => assertScoreSpec(value)).not.toThrow();
    expect(value.components.map((component) => component.id)).toEqual([
      "BB",
      "TB",
      "AD",
      "LM",
    ]);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

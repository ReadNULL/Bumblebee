import {
  readFile,
  readdir,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const projectRoot = resolve(benchmarkRoot, "..");
const currentRoot = join(
  benchmarkRoot,
  "benchmark_1_bumblebee_bench",
);

describe("BumblebeeBench architecture", () => {
  it("keeps the numbered benchmark directory convention", async () => {
    const directories = (await readdir(benchmarkRoot, {
      withFileTypes: true,
    }))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== "__pycache__",
      )
      .map((entry) => entry.name);

    expect(directories).toContain("benchmark_1_bumblebee_bench");
    for (const directory of directories) {
      expect(directory).toMatch(
        /^benchmark_\d+_[a-z0-9]+(?:_[a-z0-9]+)*$/u,
      );
    }
  });

  it("uses no new benchmark runtime package dependency", async () => {
    const sourceFiles = await listTypeScriptFiles(
      join(currentRoot, "src"),
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

  it("keeps benchmark code outside the npm publish allowlist", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      readonly files?: readonly string[];
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(packageJson.files ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^benchmark(?:\/|$)/u),
      ]),
    );
    expect(packageJson.scripts?.["benchmark:1"]).toContain(
      "benchmark_1_bumblebee_bench",
    );
    expect(packageJson.scripts?.["benchmark:1:full"]).toContain(
      "--profile full",
    );
  });

  it("emits the runner before the strict typecheck preflight", async () => {
    const runnerConfig = JSON.parse(
      await readFile(join(currentRoot, "tsconfig.runner.json"), "utf8"),
    ) as {
      readonly compilerOptions?: {
        readonly noCheck?: boolean;
        readonly noEmit?: boolean;
      };
    };

    expect(runnerConfig.compilerOptions).toMatchObject({
      noCheck: true,
      noEmit: false,
    });
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

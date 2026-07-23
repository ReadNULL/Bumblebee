import {
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  calculateCanonicalDatasetSha256,
} from "../../src/index.js";
import { benchmarkRoot, projectRoot } from "../fixtures.js";

describe("Benchmark 4 architecture", () => {
  it("keeps benchmark code and data outside the npm package", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      readonly files?: readonly string[];
      readonly scripts?: Readonly<Record<string, string>>;
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
    };

    expect(packageJson.files ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^benchmark(?:\/|$)/u),
      ]),
    );
    expect(packageJson.scripts?.["benchmark:4"]).toContain(
      "benchmark_4_longmemeval_bumblebee",
    );
    expect({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }).not.toHaveProperty("longmemeval");
  });

  it("separates datasets, manifests, source, and tests", async () => {
    const entries = await readdir(benchmarkRoot, {
      withFileTypes: true,
    });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories).toEqual(
      expect.arrayContaining([
        "datasets",
        "manifests",
        "src",
        "test",
      ]),
    );
  });

  it("pins a cross-platform canonical dataset hash", async () => {
    const [manifestText, datasetText] = await Promise.all([
      readFile(
        join(
          benchmarkRoot,
          "manifests",
          "longmemeval-bumblebee-v1.json",
        ),
        "utf8",
      ),
      readFile(
        join(
          benchmarkRoot,
          "datasets",
          "longmemeval-bumblebee-v1.json",
        ),
        "utf8",
      ),
    ]);
    const manifest = JSON.parse(manifestText) as {
      readonly dataset: { readonly sha256: string };
    };

    expect(calculateCanonicalDatasetSha256(datasetText)).toBe(
      manifest.dataset.sha256,
    );
    expect(
      calculateCanonicalDatasetSha256(
        datasetText.replace(/\n/gu, "\r\n"),
      ),
    ).toBe(manifest.dataset.sha256);
  });

  it("does not couple production source to Benchmark 4", async () => {
    const files = await listTypeScriptFiles(join(projectRoot, "src"));
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain(
        "benchmark_4_longmemeval_bumblebee",
      );
    }
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

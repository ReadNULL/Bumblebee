import {
  readFile,
  readdir,
} from "node:fs/promises";
import {
  dirname,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const benchmarkRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const projectRoot = resolve(benchmarkRoot, "../..");

describe("Benchmark 3 architecture", () => {
  it("keeps AgentDojo outside the published npm package", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      files?: readonly string[];
      dependencies?: Readonly<Record<string, string>>;
      devDependencies?: Readonly<Record<string, string>>;
      scripts?: Readonly<Record<string, string>>;
    };

    expect(packageJson.files ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^benchmark(?:\/|$)/u),
      ]),
    );
    expect({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }).not.toHaveProperty("agentdojo");
    expect(packageJson.scripts?.["benchmark:3"]).toContain(
      "benchmark_3_agentdojo_workspace",
    );
  });

  it("pins a lightweight Python adapter and matching pi schema dependency", async () => {
    const [requirements, manifestText, packageJsonText] =
      await Promise.all([
        readFile(join(benchmarkRoot, "requirements.txt"), "utf8"),
        readFile(
          join(
            benchmarkRoot,
            "manifests",
            "agentdojo-workspace-v1.json",
          ),
          "utf8",
        ),
        readFile(join(projectRoot, "package.json"), "utf8"),
      ]);
    const packageJson = JSON.parse(packageJsonText) as {
      devDependencies?: Readonly<Record<string, string>>;
    };

    const requirementLines = requirements
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(
        (line) => line.length > 0 && !line.startsWith("#"),
      );
    expect(requirementLines).toEqual(["agentdojo==0.1.35"]);
    expect(requirements).not.toMatch(
      /transformers|chromadb|faiss/iu,
    );
    expect(JSON.parse(manifestText) as unknown).toMatchObject({
      dataset: {
        packageVersion: "0.1.35",
        benchmarkVersion: "v1.2.2",
        suite: "workspace",
      },
      agents: {
        piVersion: "0.78.1",
      },
    });
    expect(packageJson.devDependencies).toMatchObject({
      typebox: "1.1.38",
    });
  });

  it("does not couple production source to benchmark code", async () => {
    const files = await listTypeScriptFiles(
      join(projectRoot, "src"),
    );
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain(
        "benchmark_3_agentdojo_workspace",
      );
    }
  });

  it("separates adapter, pi extension, contracts, and tests", async () => {
    const entries = await readdir(benchmarkRoot, {
      withFileTypes: true,
    });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(directories).toEqual(
      expect.arrayContaining([
        "agentdojo_bridge",
        "manifests",
        "pi_extension",
        "src",
        "test",
      ]),
    );
  });
});

async function listTypeScriptFiles(
  directory: string,
): Promise<string[]> {
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

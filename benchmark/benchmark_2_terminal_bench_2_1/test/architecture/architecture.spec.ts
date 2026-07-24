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

const currentRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const projectRoot = resolve(currentRoot, "../..");

describe("Benchmark 2 architecture", () => {
  it("keeps Harbor dependencies outside the npm package", async () => {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as {
      readonly files?: readonly string[];
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
      readonly scripts?: Readonly<Record<string, string>>;
    };

    expect(packageJson.files ?? []).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^benchmark(?:\/|$)/u),
      ]),
    );
    expect({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    }).not.toHaveProperty("harbor");
    expect(packageJson.scripts?.["benchmark:2"]).toContain(
      "benchmark_2_terminal_bench_2_1",
    );
  });

  it("uses only Node built-ins and local TypeScript imports", async () => {
    const files = await listTypeScriptFiles(
      join(currentRoot, "src"),
    );
    const bareImports: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
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

  it("pins Harbor and Pi only inside the benchmark adapter", async () => {
    const [requirements, adapter, manifest, packageJson] =
      await Promise.all([
        readFile(join(currentRoot, "requirements.txt"), "utf8"),
        readFile(
          join(currentRoot, "harbor_agent", "pi_agent.py"),
          "utf8",
        ),
        readFile(
          join(
            currentRoot,
            "manifests",
            "terminal-bench-2-1-lite-v1.json",
          ),
          "utf8",
        ),
        readFile(join(projectRoot, "package.json"), "utf8"),
      ]);

    expect(requirements.trim()).toBe("harbor==0.20.0");
    expect(adapter).toContain(
      'PI_PACKAGE = "@earendil-works/pi-coding-agent"',
    );
    expect(adapter).toContain('PI_VERSION = "0.78.1"');
    expect(adapter).toContain('NODE_VERSION = "22.20.0"');
    expect(adapter).toContain(
      'NODE_DOWNLOAD_MIRROR = "https://npmmirror.com/mirrors/node"',
    );
    expect(adapter).toContain("npm ci --omit=dev");
    expect(adapter).toContain("--no-extensions");
    expect(adapter).toContain("--extension");
    expect(JSON.parse(manifest) as unknown).toMatchObject({
      agents: {
        piPackage: "@earendil-works/pi-coding-agent",
        piVersion: "0.78.1",
        extensionSourcePrefix:
          "git:github.com/ReadNULL/Bumblebee@",
      },
    });
    expect(JSON.parse(packageJson) as unknown).toMatchObject({
      devDependencies: {
        "@earendil-works/pi-coding-agent": "0.78.1",
      },
    });
  });
});

async function listTypeScriptFiles(
  directory: string,
): Promise<string[]> {
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

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const FOUNDATION_ROOT = path.resolve("src/foundation");
const ALLOWED_CROSS_FEATURE_DEPENDENCIES: Readonly<Record<string, ReadonlySet<string>>> = {
  cancellation: new Set(["errors"]),
  concurrency: new Set(["cancellation", "errors"]),
  errors: new Set(),
  lifecycle: new Set(["cancellation", "errors"]),
  logging: new Set(["errors"]),
};

describe("foundation architecture", () => {
  it("keeps dependencies one-way and crosses features through index.ts", async () => {
    const sourceFiles = await collectTypeScriptFiles(FOUNDATION_ROOT);
    const violations: string[] = [];

    for (const sourceFile of sourceFiles) {
      const sourceRelative = normalizePath(path.relative(FOUNDATION_ROOT, sourceFile));
      const sourceParts = sourceRelative.split("/");
      const sourceFeature = sourceParts.length === 1
        ? "root"
        : (sourceParts[0] ?? "unknown");
      const contents = await readFile(sourceFile, "utf8");

      for (const specifier of getModuleSpecifiers(sourceFile, contents)) {
        if (specifier.startsWith("node:")) {
          continue;
        }

        if (!specifier.startsWith(".")) {
          violations.push(`${sourceRelative}: third-party import ${specifier}`);
          continue;
        }

        const targetFile = path.resolve(
          path.dirname(sourceFile),
          specifier.replace(/\.js$/, ".ts"),
        );
        const targetRelative = normalizePath(
          path.relative(FOUNDATION_ROOT, targetFile),
        );
        if (targetRelative.startsWith("../")) {
          violations.push(`${sourceRelative}: escapes foundation via ${specifier}`);
          continue;
        }

        const targetParts = targetRelative.split("/");
        const targetFeature = targetParts.length === 1
          ? "root"
          : (targetParts[0] ?? "unknown");
        if (sourceFeature === targetFeature) {
          continue;
        }

        if (sourceFeature === "root") {
          if (!(targetFeature in ALLOWED_CROSS_FEATURE_DEPENDENCIES)) {
            violations.push(`${sourceRelative}: unknown feature ${targetFeature}`);
          }
          if (targetParts.at(-1) !== "index.ts") {
            violations.push(`${sourceRelative}: facade bypasses ${targetFeature}/index.ts`);
          }
          continue;
        }

        const allowed = ALLOWED_CROSS_FEATURE_DEPENDENCIES[sourceFeature];
        if (allowed === undefined || !allowed.has(targetFeature as string)) {
          violations.push(`${sourceRelative}: ${sourceFeature} -> ${targetFeature}`);
        }
        if (targetParts.at(-1) !== "index.ts") {
          violations.push(`${sourceRelative}: bypasses ${targetFeature}/index.ts`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("exports every known feature through the foundation facade", async () => {
    const facadePath = path.join(FOUNDATION_ROOT, "index.ts");
    const specifiers = getModuleSpecifiers(
      facadePath,
      await readFile(facadePath, "utf8"),
    );
    const exportedFeatures = specifiers.map((specifier) =>
      specifier.split("/")[1],
    ).sort();
    const expectedFeatures = Object.keys(
      ALLOWED_CROSS_FEATURE_DEPENDENCIES,
    ).sort();

    expect(exportedFeatures).toEqual(expectedFeatures);
  });

  it("publishes every foundation source file and excludes tests", async () => {
    const packageValue: unknown = JSON.parse(
      await readFile(path.resolve("package.json"), "utf8"),
    );
    if (!isRecord(packageValue) || !Array.isArray(packageValue.files)) {
      throw new Error("package.json files must be an array");
    }

    const declaredFiles = new Set(
      packageValue.files.filter((value): value is string => typeof value === "string"),
    );
    const sourceFiles = await collectTypeScriptFiles(FOUNDATION_ROOT);
    const missing = sourceFiles
      .map((file) => normalizePath(path.relative(process.cwd(), file)))
      .filter((file) => !declaredFiles.has(file));
    const publishedTests = [...declaredFiles].filter((file) =>
      file.startsWith("test/"),
    );

    expect(missing).toEqual([]);
    expect(publishedTests).toEqual([]);
  });
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collectTypeScriptFiles(absolutePath)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [absolutePath]
        : [];
  }));

  return files.flat().sort();
}

function getModuleSpecifiers(fileName: string, sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

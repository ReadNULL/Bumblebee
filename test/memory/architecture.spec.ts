import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";
import * as ts from "typescript";

const MEMORY_ROOT = path.resolve("src/memory");

describe("memory architecture", () => {
  it("keeps memory independent from pi and upper application layers", async () => {
    const violations: string[] = [];

    for (const sourceFile of await collectTypeScriptFiles(MEMORY_ROOT)) {
      const relative = normalizePath(path.relative(MEMORY_ROOT, sourceFile));
      const contents = await readFile(sourceFile, "utf8");

      for (const specifier of getModuleSpecifiers(sourceFile, contents)) {
        if (
          specifier.startsWith("./") ||
          specifier.startsWith("node:") ||
          specifier === "../../foundation/index.js"
        ) {
          continue;
        }
        violations.push(`${relative}: disallowed dependency ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("publishes every memory source and excludes tests", async () => {
    const packageValue: unknown = JSON.parse(
      await readFile(path.resolve("package.json"), "utf8"),
    );
    if (!isRecord(packageValue) || !Array.isArray(packageValue.files)) {
      throw new Error("package.json files must be an array");
    }

    const declaredFiles = new Set(
      packageValue.files.filter(
        (value): value is string => typeof value === "string",
      ),
    );
    const missing = (await collectTypeScriptFiles(MEMORY_ROOT))
      .map((file) => normalizePath(path.relative(process.cwd(), file)))
      .filter((file) => !declaredFiles.has(file));

    expect(missing).toEqual([]);
    expect([...declaredFiles].some((file) => file.startsWith("test/")))
      .toBe(false);
  });
});

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? collectTypeScriptFiles(absolutePath)
        : entry.isFile() && entry.name.endsWith(".ts")
          ? [absolutePath]
          : [];
    }),
  );
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

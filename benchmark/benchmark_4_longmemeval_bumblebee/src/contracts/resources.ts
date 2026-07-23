import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseLongMemEvalDataset } from "./dataset.js";
import { parseLongMemEvalManifest } from "./manifest.js";
import type {
  LongMemEvalDataset,
  LongMemEvalManifest,
} from "./types.js";
import { invalid } from "./validation.js";

export const LONGMEMEVAL_BUMBLEBEE_ROOT =
  "benchmark/benchmark_4_longmemeval_bumblebee";
export const DEFAULT_LONGMEMEVAL_MANIFEST_PATH =
  `${LONGMEMEVAL_BUMBLEBEE_ROOT}/manifests/longmemeval-bumblebee-v1.json`;

export interface LongMemEvalResources {
  readonly manifest: LongMemEvalManifest;
  readonly dataset: LongMemEvalDataset;
  readonly datasetSha256: string;
}

export async function loadLongMemEvalResources(
  projectRoot: string,
): Promise<LongMemEvalResources> {
  const manifest = parseLongMemEvalManifest(
    JSON.parse(
      await readFile(
        join(projectRoot, DEFAULT_LONGMEMEVAL_MANIFEST_PATH),
        "utf8",
      ),
    ) as unknown,
  );
  const datasetPath = join(
    projectRoot,
    LONGMEMEVAL_BUMBLEBEE_ROOT,
    manifest.dataset.file,
  );
  const datasetText = await readFile(datasetPath, "utf8");
  const datasetSha256 =
    calculateCanonicalDatasetSha256(datasetText);
  if (datasetSha256 !== manifest.dataset.sha256) {
    invalid("LongMemEval-Bumblebee dataset hash mismatch", {
      actual: datasetSha256,
      expected: manifest.dataset.sha256,
    });
  }

  const dataset = parseLongMemEvalDataset(
    JSON.parse(datasetText) as unknown,
  );
  if (
    dataset.id !== manifest.id ||
    dataset.version !== manifest.version ||
    dataset.cases.length !== manifest.dataset.caseCount
  ) {
    invalid("dataset identity does not match its manifest");
  }
  const capabilities = new Set(
    dataset.cases.map((item) => item.capability),
  );
  if (
    manifest.dataset.capabilities.some(
      (capability) => !capabilities.has(capability),
    )
  ) {
    invalid("dataset does not cover every frozen capability");
  }

  return Object.freeze({
    manifest,
    dataset,
    datasetSha256,
  });
}

/**
 * Git 在 Windows 上可能把 LF 检出为 CRLF；数据身份按 UTF-8 文本的
 * 规范化 LF 内容计算，避免同一 commit 因平台换行得到不同哈希。
 */
export function calculateCanonicalDatasetSha256(
  value: string,
): string {
  const canonical = value
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

import type { TaskContract } from "./types.js";

const MAX_CONTRACT_ITEMS = 12;
const MAX_CONTRACT_ITEM_LENGTH = 320;

const REQUIREMENT_MARKER =
  /\b(?:must|required|requirement|ensure|should|exactly|final|field|path|format)\b|必须|要求|确保|字段|路径|格式|结尾|最终/iu;

const RECOVERY_MARKER =
  /\b(?:recover|recovery|forensic|forensics|salvage|corrupt(?:ed|ion)?|write-ahead log|wal)\b|恢复|取证|损坏|事务日志/iu;

const ARTIFACT_PATTERN =
  /(?:[A-Za-z]:[\\/]|\/)?[^\s"'`<>|]+?(?:\.db(?:-wal)?|\.sqlite(?:3)?(?:-wal)?|\.wal|\.bin|\.img|\.dump)(?=$|[\s"'`,;:)\]}])/giu;

const INLINE_LITERAL_PATTERN = /`([^`\r\n]{1,160})`/gu;

export function extractTaskContract(prompt: string): TaskContract {
  const items: string[] = [];
  for (const rawLine of prompt.split(/\r?\n/u)) {
    const line = normalizeItem(rawLine);
    if (
      line.length > 0 &&
      REQUIREMENT_MARKER.test(line)
    ) {
      addUnique(items, line);
    }
  }
  for (const match of prompt.matchAll(INLINE_LITERAL_PATTERN)) {
    const literal = normalizeItem(match[1] ?? "");
    if (literal.length > 0) {
      addUnique(items, `Literal contract: ${literal}`);
    }
  }

  const artifacts = extractRecoveryArtifacts(prompt);

  return Object.freeze({
    artifacts,
    highRiskRecovery: RECOVERY_MARKER.test(prompt),
    items: Object.freeze(items),
  });
}

export function extractRecoveryArtifacts(
  value: string,
): readonly string[] {
  const artifacts: string[] = [];
  for (const match of value.matchAll(ARTIFACT_PATTERN)) {
    const artifact = trimArtifact(match[0]);
    if (artifact.length > 0) {
      addUnique(artifacts, artifact);
    }
  }
  return Object.freeze(artifacts);
}

function normalizeItem(value: string): string {
  return value
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s*/u, "")
    .replace(/\s+/gu, " ")
    .slice(0, MAX_CONTRACT_ITEM_LENGTH);
}

function trimArtifact(value: string): string {
  return value.replace(/[.,;:)\]}]+$/gu, "");
}

function addUnique(values: string[], value: string): void {
  const normalized = value.toLocaleLowerCase("en-US");
  if (
    values.length >= MAX_CONTRACT_ITEMS ||
    values.some(
      (existing) =>
        existing.toLocaleLowerCase("en-US") === normalized,
    )
  ) {
    return;
  }
  values.push(value);
}

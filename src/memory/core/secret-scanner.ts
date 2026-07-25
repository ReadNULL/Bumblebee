import {
  BumblebeeError,
  ERROR_CODES,
} from "../../foundation/index.js";

const SECRET_PATTERNS: readonly {
  readonly name: string;
  readonly pattern: RegExp;
}[] = Object.freeze([
  {
    name: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/iu,
  },
  {
    name: "known-token-prefix",
    pattern:
      /\b(?:sk-(?:proj-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|xox[baprs]-[a-z0-9-]{16,}|AKIA[A-Z0-9]{16}|AIza[a-z0-9_-]{30,})\b/iu,
  },
  {
    name: "jwt",
    pattern:
      /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/iu,
  },
  {
    name: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/iu,
  },
  {
    name: "credential-uri",
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/]+:[^@\s/]+@/iu,
  },
]);

/**
 * 只识别高置信度凭据形态。错误上下文不包含原文，避免二次泄露。
 */
export function assertNoPersistedSecret(values: readonly string[]): void {
  for (const value of values) {
    for (const candidate of SECRET_PATTERNS) {
      candidate.pattern.lastIndex = 0;
      if (!candidate.pattern.test(value)) {
        continue;
      }
      throw new BumblebeeError(
        `Memory content matched secret pattern: ${candidate.name}`,
        {
          code: ERROR_CODES.INVALID_INPUT,
          context: { finding: candidate.name },
          userMessage:
            "记忆内容疑似包含密钥、令牌或密码，已拒绝持久化。",
        },
      );
    }
  }
}

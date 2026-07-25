import type {
  LongMemEvalAnswerEvaluation,
  LongMemEvalAnswerRubric,
} from "../contracts/index.js";

const ABSTENTION_MARKERS = Object.freeze([
  "没有相关记忆",
  "未记录",
  "无法确定",
  "不能确定",
  "不知道",
  "信息不足",
  "insufficient information",
  "not recorded",
  "do not know",
]);

/**
 * 使用冻结的语义短语判分，避免正式结果再依赖一个可漂移的裁判模型。
 * 每个 required group 是同义表达的 OR，group 之间是 AND。
 */
export function evaluateLongMemEvalAnswer(
  answer: string | undefined,
  rubric: LongMemEvalAnswerRubric,
): LongMemEvalAnswerEvaluation {
  const answered =
    typeof answer === "string" && normalize(answer).length > 0;
  const abstained = answered &&
    ABSTENTION_MARKERS.some((marker) =>
      containsNormalized(answer as string, marker)
    );
  const missingGroups = rubric.requiredGroups.filter(
    (group) =>
      !group.some((candidate) =>
        containsNormalized(answer ?? "", candidate)
      ),
  );
  const matchedForbiddenTerms = rubric.forbiddenTerms.filter(
    (term) => containsNormalized(answer ?? "", term),
  );
  const correct = answered &&
    matchedForbiddenTerms.length === 0 &&
    (rubric.abstain
      ? abstained
      : !abstained && missingGroups.length === 0);

  return Object.freeze({
    answered,
    abstained,
    correct,
    missingGroups: Object.freeze(
      missingGroups.map((group) => Object.freeze([...group])),
    ),
    matchedForbiddenTerms: Object.freeze(matchedForbiddenTerms),
  });
}

function containsNormalized(value: string, candidate: string): boolean {
  const normalizedValue = normalize(value);
  const normalizedCandidate = normalize(candidate);
  if (normalizedValue.includes(normalizedCandidate)) {
    return true;
  }
  return compact(normalizedValue).includes(compact(normalizedCandidate));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function compact(value: string): string {
  return value.replace(/[\s\p{P}\p{S}]+/gu, "");
}

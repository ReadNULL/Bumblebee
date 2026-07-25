import {
  BumblebeeError,
  ERROR_CODES,
} from "../errors/index.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 校验 Node timer 可准确表达的毫秒范围。 */
export function validateDurationMs(
  value: number,
  optionName: string,
  allowZero: boolean,
): number {
  const minimum = allowZero ? 0 : Number.MIN_VALUE;

  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > MAX_TIMER_DELAY_MS
  ) {
    throw new BumblebeeError(
      `${optionName} must be ${allowZero ? "non-negative" : "positive"} and no greater than ${MAX_TIMER_DELAY_MS}`,
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: {
          allowZero,
          maximum: MAX_TIMER_DELAY_MS,
          optionName,
          value,
        },
      },
    );
  }

  return value;
}

import {
  BumblebeeError,
  ERROR_CODES,
} from "../foundation/index.js";

export const BUMBLEBEE_FEATURE_PROFILE_ENV =
  "BUMBLEBEE_FEATURE_PROFILE";

export const BUMBLEBEE_FEATURE_PROFILE_NAMES = [
  "pi-baseline",
  "permission-only",
  "full",
] as const;

export type BumblebeeFeatureProfileName =
  (typeof BUMBLEBEE_FEATURE_PROFILE_NAMES)[number];

export interface BumblebeeFeatures {
  readonly assurance: boolean;
  readonly channels: boolean;
  readonly memory: boolean;
  readonly permission: boolean;
  readonly subagent: boolean;
}

export interface BumblebeeFeatureProfile {
  readonly name: BumblebeeFeatureProfileName;
  readonly features: BumblebeeFeatures;
}

const PROFILES: Readonly<
  Record<BumblebeeFeatureProfileName, BumblebeeFeatureProfile>
> = Object.freeze({
  "pi-baseline": createProfile("pi-baseline", {
    assurance: false,
    channels: false,
    memory: false,
    permission: false,
    subagent: false,
  }),
  "permission-only": createProfile("permission-only", {
    assurance: true,
    channels: false,
    memory: false,
    permission: true,
    subagent: false,
  }),
  full: createProfile("full", {
    assurance: true,
    channels: true,
    memory: true,
    permission: true,
    subagent: true,
  }),
});

export function resolveBumblebeeFeatureProfile(
  configuredName:
    | BumblebeeFeatureProfileName
    | string
    | undefined,
): BumblebeeFeatureProfile {
  const name = configuredName?.trim() || "full";
  if (
    !BUMBLEBEE_FEATURE_PROFILE_NAMES.includes(
      name as BumblebeeFeatureProfileName,
    )
  ) {
    throw new BumblebeeError(
      `${BUMBLEBEE_FEATURE_PROFILE_ENV} must be one of: ` +
        BUMBLEBEE_FEATURE_PROFILE_NAMES.join(", "),
      {
        code: ERROR_CODES.INVALID_INPUT,
        context: { configuredName: name },
      },
    );
  }
  return PROFILES[name as BumblebeeFeatureProfileName];
}

function createProfile(
  name: BumblebeeFeatureProfileName,
  features: BumblebeeFeatures,
): BumblebeeFeatureProfile {
  return Object.freeze({
    name,
    features: Object.freeze({ ...features }),
  });
}

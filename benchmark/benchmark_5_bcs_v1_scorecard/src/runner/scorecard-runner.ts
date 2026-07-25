import type {
  BcsComponentId,
  BcsScorecardResources,
  BcsScorecardRunResult,
} from "../contracts/index.js";
import { readBcsSourceRun } from "../importer/index.js";
import { writeBcsScorecard } from "../reporting/index.js";
import { aggregateBcsScorecard } from "../scoring/index.js";

export interface RunBcsScorecardOptions {
  readonly resources: BcsScorecardResources;
  readonly sourceDirectories: Readonly<
    Record<BcsComponentId, string>
  >;
  readonly outputDirectory: string;
  readonly clock?: () => Date;
  readonly scorecardIdFactory?: () => string;
}

export async function runBcsScorecard(
  options: RunBcsScorecardOptions,
): Promise<BcsScorecardRunResult> {
  const importedRuns = await Promise.all(
    options.resources.manifest.components.map((definition) =>
      readBcsSourceRun(
        definition,
        options.sourceDirectories[definition.id],
      )
    ),
  );
  const aggregation = aggregateBcsScorecard(
    options.resources.manifest,
    options.resources.scoreSpec,
    importedRuns,
  );
  return writeBcsScorecard({
    manifest: options.resources.manifest,
    aggregation,
    scoreSpecId: options.resources.scoreSpec.id,
    outputDirectory: options.outputDirectory,
    ...(options.clock === undefined
      ? {}
      : { clock: options.clock }),
    ...(options.scorecardIdFactory === undefined
      ? {}
      : {
          scorecardIdFactory: options.scorecardIdFactory,
        }),
  });
}

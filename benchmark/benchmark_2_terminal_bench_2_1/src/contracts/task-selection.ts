import type { TerminalBenchManifest } from "./types.js";

export interface TerminalBenchTaskSelectionComparison {
  readonly matchedCount: number;
  readonly missingTaskIds: readonly string[];
  readonly unexpectedTaskIds: readonly string[];
  readonly exact: boolean;
}

/**
 * Compares resolved Harbor task ids with the frozen Lite subset.
 * Counting tasks alone is insufficient because a different nine-task sample
 * must never be scored under the same benchmark identity.
 */
export function compareTerminalBenchTaskSelection(
  manifest: TerminalBenchManifest,
  taskIds: Iterable<string>,
): TerminalBenchTaskSelectionComparison {
  const expected = new Set(
    manifest.dataset.selectedTasks.map((task) => task.id),
  );
  const actual = new Set(taskIds);
  const missingTaskIds = [...expected]
    .filter((taskId) => !actual.has(taskId))
    .sort();
  const unexpectedTaskIds = [...actual]
    .filter((taskId) => !expected.has(taskId))
    .sort();

  return Object.freeze({
    matchedCount: expected.size - missingTaskIds.length,
    missingTaskIds: Object.freeze(missingTaskIds),
    unexpectedTaskIds: Object.freeze(unexpectedTaskIds),
    exact:
      missingTaskIds.length === 0 &&
      unexpectedTaskIds.length === 0,
  });
}

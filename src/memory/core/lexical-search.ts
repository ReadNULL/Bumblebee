import { normalizeIdentityKey } from "./normalization.js";
import type {
  MemoryRecord,
  MemorySearchResult,
} from "./types.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const WORD_SEGMENTER = new Intl.Segmenter(
  ["zh-CN", "en"],
  { granularity: "word" },
);

interface SearchDocument {
  readonly length: number;
  readonly record: MemoryRecord;
  readonly terms: ReadonlyMap<string, number>;
}

/** 无外部索引的 BM25 风格检索，读取过程不修改访问计数或持久状态。 */
export function searchMemoryRecords(
  records: readonly MemoryRecord[],
  query: string,
  limit: number,
): readonly MemorySearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = [...new Set(tokenize(normalizedQuery))];
  if (
    normalizedQuery.length === 0 ||
    queryTerms.length === 0 ||
    limit <= 0
  ) {
    return Object.freeze([]);
  }

  const documents = records.map(createSearchDocument);
  const averageLength = Math.max(
    1,
    documents.reduce((total, item) => total + item.length, 0) /
      Math.max(1, documents.length),
  );
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      documents.reduce(
        (count, item) => count + (item.terms.has(term) ? 1 : 0),
        0,
      ),
    );
  }

  const results: MemorySearchResult[] = [];
  for (const document of documents) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = document.terms.get(term) ?? 0;
      if (frequency === 0) {
        continue;
      }
      const matchingDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 +
          (documents.length - matchingDocuments + 0.5) /
            (matchingDocuments + 0.5),
      );
      const lengthNormalization =
        frequency +
        BM25_K1 *
          (1 - BM25_B + BM25_B * document.length / averageLength);
      score += inverseDocumentFrequency *
        (frequency * (BM25_K1 + 1)) /
        lengthNormalization;
    }

    score += calculateExactBoost(document.record, normalizedQuery);
    if (score > 0) {
      results.push(Object.freeze({
        record: document.record,
        score,
      }));
    }
  }

  results.sort((left, right) =>
    right.score - left.score ||
    Date.parse(right.record.updatedAt) - Date.parse(left.record.updatedAt) ||
    left.record.id.localeCompare(right.record.id)
  );
  return Object.freeze(results.slice(0, limit));
}

function createSearchDocument(record: MemoryRecord): SearchDocument {
  const weightedTerms = [
    ...repeat(tokenize(record.key), 4),
    ...repeat(record.keywords.flatMap(tokenize), 3),
    ...tokenize(record.content),
    record.category,
  ];
  const frequencies = new Map<string, number>();
  for (const term of weightedTerms) {
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return {
    length: Math.max(1, weightedTerms.length),
    record,
    terms: frequencies,
  };
}

function calculateExactBoost(
  record: MemoryRecord,
  normalizedQuery: string,
): number {
  const key = normalizeSearchText(record.key);
  const content = normalizeSearchText(record.content);
  const keywords = record.keywords.map(normalizeSearchText);

  let score = 0;
  if (key === normalizedQuery) {
    score += 12;
  } else if (
    key.includes(normalizedQuery) ||
    normalizedQuery.includes(key)
  ) {
    score += 5;
  }
  if (content.includes(normalizedQuery)) {
    score += 8;
  }
  if (keywords.includes(normalizedQuery)) {
    score += 6;
  }
  return score;
}

function tokenize(value: string): string[] {
  const normalized = normalizeSearchText(value);
  const terms: string[] = [];
  for (const segment of WORD_SEGMENTER.segment(normalized)) {
    if (segment.isWordLike) {
      terms.push(segment.segment);
    }
  }
  return terms;
}

function normalizeSearchText(value: string): string {
  return normalizeIdentityKey(value);
}

function repeat(values: readonly string[], count: number): string[] {
  return Array.from({ length: count }, () => values).flat();
}

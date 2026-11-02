import type { GlobalSearchScope } from './types';

const WORD_BOUNDARY = /[\s._/\\:-]+/u;
const CJK = /[\u3400-\u9fff]/u;

export interface ParsedGlobalSearchQuery {
  query: string;
  scope: GlobalSearchScope;
  scopeForcedByPrefix: boolean;
}
export function parseGlobalSearchQuery(
  rawQuery: string,
  selectedScope: GlobalSearchScope,
): ParsedGlobalSearchQuery {
  const trimmed = rawQuery.trim();
  if (trimmed.startsWith('>')) {
    return {
      query: trimmed.slice(1).trim(),
      scope: 'actions',
      scopeForcedByPrefix: true,
    };
  }
  return { query: trimmed, scope: selectedScope, scopeForcedByPrefix: false };
}

function queryTokens(query: string): string[] {
  return query
    .split(WORD_BOUNDARY)
    .map(token => token.trim())
    .filter(token => token.length >= 2 || CJK.test(token));
}

function scoreSingleTerm(query: string, field: string): number {
  if (field === query) return 100;
  if (field.startsWith(query)) return 94;

  const words = field.split(WORD_BOUNDARY).filter(Boolean);
  if (words.some(word => word.startsWith(query))) return 88;
  if (field.includes(query)) return 80;

  const acronym = words.map(word => word[0]).join('');
  // Require consecutive initials so long workflow prose does not gain
  // unrelated capability-name matches from arbitrary skipped words.
  if (query.length > 1 && acronym.includes(query)) return 66;
  return 0;
}

/**
 * Small deterministic matcher shared by in-memory providers.
 * Backend content providers keep ownership of their own relevance scores.
 */
export function scoreTextMatch(query: string, fields: Array<string | null | undefined>): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 70;

  let best = 0;
  const normalizedFields: string[] = [];
  for (const rawField of fields) {
    const field = rawField?.trim().toLocaleLowerCase();
    if (!field) continue;
    normalizedFields.push(field);
    best = Math.max(best, scoreSingleTerm(normalizedQuery, field));

    const tokens = queryTokens(normalizedQuery);
    if (tokens.length > 1 && tokens.every(token => field.includes(token))) {
      best = Math.max(best, 74);
    }
  }

  const tokens = queryTokens(normalizedQuery);
  if (
    tokens.length > 1
    && tokens.every(token => normalizedFields.some(field => field.includes(token)))
  ) {
    best = Math.max(best, 72);
  }

  // Natural-language discovery queries often contain bilingual alternatives or
  // near-synonyms (for example "pet companion mascot"). Treat those tokens as
  // evidence that accumulates instead of an all-or-nothing AND expression.
  // Exact/full-query matches above still outrank partial token coverage.
  if (tokens.length > 1) {
    const tokenScores = tokens.map(token => Math.max(
      0,
      ...normalizedFields.map(field => scoreSingleTerm(token, field)),
    ));
    const matchedScores = tokenScores.filter(score => score > 0);
    if (matchedScores.length > 0) {
      const coverage = matchedScores.length / tokens.length;
      const strongest = Math.max(...matchedScores);
      best = Math.max(best, Math.round(38 + coverage * 28 + strongest * 0.08));
    }
  }
  return best;
}

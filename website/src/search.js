const WORD_BOUNDARY = /[\s._/\\:-]+/u;
const CJK = /[\u3400-\u9fff]/u;

function normalize(value) {
  return String(value ?? '').toLocaleLowerCase().trim();
}

export function queryTokens(query) {
  return normalize(query).split(WORD_BOUNDARY)
    .filter((token) => token.length >= 2 || CJK.test(token));
}

function scoreSingleTerm(query, field) {
  if (field === query) return 100;
  if (field.startsWith(query)) return 94;
  const words = field.split(WORD_BOUNDARY).filter(Boolean);
  if (words.some((word) => word.startsWith(query))) return 88;
  if (field.includes(query)) return 80;
  const acronym = words.map((word) => word[0]).join('');
  // Match consecutive initials; arbitrary skipped words make long prose
  // spuriously match unrelated capability names.
  return query.length > 1 && acronym.includes(query) ? 66 : 0;
}

export function scoreTextMatch(query, fields) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return 70;
  const normalizedFields = fields.map(normalize).filter(Boolean);
  let best = Math.max(0, ...normalizedFields.map((field) =>
    scoreSingleTerm(normalizedQuery, field)));
  const tokens = queryTokens(normalizedQuery);
  if (tokens.length > 1) {
    const tokenScores = tokens.map((token) => Math.max(
      0,
      ...normalizedFields.map((field) => scoreSingleTerm(token, field)),
    ));
    if (tokenScores.every((value) => value > 0)) best = Math.max(best, 72);
    const matched = tokenScores.filter((value) => value > 0);
    if (matched.length) {
      const coverage = matched.length / tokens.length;
      best = Math.max(best, Math.round(38 + coverage * 28 + Math.max(...matched) * 0.08));
    }
  }
  return best;
}

export function scoreCapability(capability, query) {
  if (!query) return 1;
  const textScore = scoreTextMatch(query, [
    capability.id,
    capability.titleZh,
    capability.titleEn,
    ...capability.searchTerms,
  ]);
  if (!textScore) return 0;
  const directBonus = Math.min(8, capability.operations.length + capability.options.length);
  const delegatedBonus = capability.items.some(({ control }) => control.kind === 'delegate') ? 4 : 0;
  // Match the native and Web UI catalogs: control coverage breaks textual ties.
  return textScore + (directBonus + delegatedBonus) / 100;
}

export function matchingItems(capability, query) {
  if (!normalize(query)) return [];
  const tokens = queryTokens(query);
  return capability.items
    .map((item) => {
      const directScore = scoreTextMatch(query, [item.titleZh, item.titleEn]);
      const partialScore = Math.max(
        0,
        ...tokens.map((token) => scoreTextMatch(token, [item.titleZh, item.titleEn])),
      );
      return { item, rank: directScore > 0 ? 100 + directScore : Math.floor(partialScore / 2) };
    })
    .filter(({ rank }) => rank > 0)
    .sort((left, right) => right.rank - left.rank)
    .map(({ item }) => item);
}

export function searchCapabilities(catalog, query) {
  return catalog.capabilities
    .map((capability) => ({ capability, rank: scoreCapability(capability, query) }))
    .filter(({ rank }) => rank > 0)
    .sort((left, right) => right.rank - left.rank
      || left.capability.kind.localeCompare(right.capability.kind)
      || left.capability.id.localeCompare(right.capability.id));
}

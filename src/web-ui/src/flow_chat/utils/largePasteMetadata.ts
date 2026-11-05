/**
 * Large pastes collapse into a `[Pasted content N chars]` placeholder in the
 * composer. The model always receives the expanded text; the sent message keeps
 * the placeholder for display and stores the pasted bodies under this metadata
 * key so the message can still show, copy, edit, and restore them. Older builds
 * ignore the key and keep showing the placeholder.
 */
export const LARGE_PASTES_METADATA_KEY = 'largePastes';

export type LargePasteMap = Readonly<Record<string, string>>;

/** Keep only the pastes whose placeholder still appears in `text`. */
export function pickReferencedLargePastes(
  pastes: LargePasteMap | null | undefined,
  text: string,
): Record<string, string> | null {
  if (!pastes) return null;
  const keys = new Set(splitLargePasteText(text, pastes).flatMap(
    part => part.kind === 'paste' ? [part.placeholder] : [],
  ));
  const referenced = Object.entries(pastes).filter(
    ([placeholder, body]) => keys.has(placeholder) && typeof body === 'string',
  );
  return referenced.length > 0 ? Object.fromEntries(referenced) : null;
}

/** Read the stored pastes, ignoring malformed entries from any host version. */
export function readLargePastesMetadata(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): Record<string, string> | null {
  const raw = metadata?.[LARGE_PASTES_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * Replace placeholders with their bodies. Same-length pastes share a prefix
 * (`[… N chars]` and `[… N chars] #2`), so matching is longest-first and a
 * body is never rescanned for placeholders.
 */
export function expandLargePastes(text: string, pastes: LargePasteMap | null | undefined): string {
  if (!pastes) return text;
  return splitLargePasteText(text, pastes)
    .map(part => (part.kind === 'text' ? part.text : pastes[part.placeholder]))
    .join('');
}

export type LargePasteTextPart =
  | { kind: 'text'; text: string }
  | { kind: 'paste'; placeholder: string };

/** Split display text around stored paste placeholders, longest match first. */
export function splitLargePasteText(text: string, pastes: LargePasteMap | null | undefined): LargePasteTextPart[] {
  const placeholders = pastes
    ? Object.keys(pastes).filter(Boolean).sort((a, b) => b.length - a.length)
    : [];
  if (placeholders.length === 0) return [{ kind: 'text', text }];

  const parts: LargePasteTextPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let matchStart = -1;
    let matched = '';
    for (const candidate of placeholders) {
      const start = text.indexOf(candidate, cursor);
      // Placeholders are sorted longest-first, so a tie keeps the longer one.
      if (start !== -1 && (matchStart === -1 || start < matchStart)) {
        matchStart = start;
        matched = candidate;
      }
    }
    if (matchStart === -1) break;
    if (matchStart > cursor) parts.push({ kind: 'text', text: text.slice(cursor, matchStart) });
    parts.push({ kind: 'paste', placeholder: matched });
    cursor = matchStart + matched.length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}

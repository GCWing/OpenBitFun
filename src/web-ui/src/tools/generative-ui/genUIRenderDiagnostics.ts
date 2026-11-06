import type { OpenUIError, ParseResult } from '@openuidev/lang-core';

/** Host diagnostics extend the upstream codes without changing its API. */
export type GenUIRenderDiagnostic = Omit<OpenUIError, 'code'> & {
  code: OpenUIError['code'] | 'parse-incomplete' | 'unresolved-reference';
};

export function mergeGenUIRenderDiagnostics(meta: ParseResult['meta'] | undefined, errors: OpenUIError[]): GenUIRenderDiagnostic[] {
  const structural: GenUIRenderDiagnostic[] = [];
  if (meta?.incomplete) {
    const suspects = [...new Set(meta.errors.filter(error => error.code === 'excess-args' || error.code === 'type-mismatch')
      .flatMap(error => error.statementId ? [error.statementId] : []))];
    structural.push({ source: 'parser', code: 'parse-incomplete',
      message: 'The completed OpenUI source is syntactically incomplete. Check for unclosed parentheses, brackets, braces or quotes.',
      hint: `Parsed ${meta.statementCount} statements. Unresolved references: ${meta.unresolved.join(', ') || 'none'}.${suspects.length ? ` Argument diagnostics occur in: ${suspects.join(', ')}; inspect these statements first. They may contain subsequent statements swallowed by an unclosed expression.` : ''} Correct the source structure before changing component properties.`,
    });
  }
  for (const name of meta?.unresolved ?? []) structural.push({ source: 'parser', code: 'unresolved-reference', statementId: name,
    message: `Reference "${name}" is used but not defined in the parsed document.`,
    hint: meta?.incomplete ? 'Fix the incomplete source first; a later definition may have been swallowed.' : 'Check the spelling and provide the missing definition without removing the requested content.',
  });
  const combined: GenUIRenderDiagnostic[] = [...structural, ...errors, ...(meta?.errors ?? []).map(error => ({ ...error, source: 'parser' as const }))];
  const seen = new Set<string>();
  return combined.filter(error => {
    const key = JSON.stringify([error.source, error.code, error.statementId, error.component, error.path, error.message]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Validation errors also use source=parser. Incomplete or failed parsing locks
 * controls; recoverable property and missing-content diagnostics do not. */
export function isFatalGenUIError(error: GenUIRenderDiagnostic): boolean {
  return error.severity !== 'warning' && error.source === 'parser'
    && (error.code === 'parse-exception' || error.code === 'parse-failed' || error.code === 'parse-incomplete');
}

export function isRepairWorthyGenUIError(error: GenUIRenderDiagnostic): boolean {
  return isFatalGenUIError(error) || (error.severity !== 'warning' && error.source === 'parser'
    && (error.code === 'unresolved-reference' || error.code === 'missing-required' || error.code === 'null-required'));
}

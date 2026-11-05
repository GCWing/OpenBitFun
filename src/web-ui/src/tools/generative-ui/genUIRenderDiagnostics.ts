import type { OpenUIError } from '@openuidev/lang-core';

/** Validation errors also use source=parser. Only parser failure codes mean
 * the document could not be parsed; recoverable diagnostics keep controls live. */
export function isFatalGenUIError(error: OpenUIError): boolean {
  return error.severity !== 'warning' && error.source === 'parser'
    && (error.code === 'parse-exception' || error.code === 'parse-failed');
}

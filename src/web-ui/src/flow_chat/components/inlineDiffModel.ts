import { diffLines } from 'diff';

export interface DiffLine {
  type: 'unchanged' | 'added' | 'removed' | 'context-separator';
  content: string;
  originalLineNumber?: number;
  modifiedLineNumber?: number;
}

export function computeLineDiff(originalContent: string, modifiedContent: string): DiffLine[] {
  const result: DiffLine[] = [];
  let originalLineNumber = 1;
  let modifiedLineNumber = 1;

  for (const change of diffLines(originalContent, modifiedContent)) {
    const lines = change.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    for (const line of lines) {
      if (change.added) {
        result.push({ type: 'added', content: line, modifiedLineNumber: modifiedLineNumber++ });
      } else if (change.removed) {
        result.push({ type: 'removed', content: line, originalLineNumber: originalLineNumber++ });
      } else {
        result.push({
          type: 'unchanged',
          content: line,
          originalLineNumber: originalLineNumber++,
          modifiedLineNumber: modifiedLineNumber++,
        });
      }
    }
  }

  return result;
}

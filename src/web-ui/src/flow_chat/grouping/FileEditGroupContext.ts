import { createContext } from 'react';
import type { FileOperationDiffStats } from '../tool-cards/fileOperationDiffStats';

/** Presentation only: the original tool id, target, result and actions stay intact. */
export const FileEditGroupContext = createContext<{
  revisionLabels: ReadonlyMap<string, string>;
  diffStats: ReadonlyMap<string, FileOperationDiffStats>;
} | undefined>(undefined);

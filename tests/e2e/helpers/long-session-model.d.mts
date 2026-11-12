export interface ModelSnapshot {
  emitted: number; bytes: number; blockedWrites: number; connected: boolean; finished: boolean;
  startedAt: number; lastEmittedAt: number;
}
export function createLongSessionModel(options?: { intervalMs?: number; paragraphChars?: number }): Promise<{
  url: string; errors: string[]; snapshot(marker: string): ModelSnapshot | null;
  finish(marker: string): void; close(): Promise<void>;
}>;

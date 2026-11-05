export type ParsedCompactCommand =
  | { kind: 'compact'; force: boolean }
  | { kind: 'invalid' };

export function parseCompactCommand(input: string): ParsedCompactCommand | null {
  const command = input.trim();
  if (!/^\/compact(?:\s|$)/i.test(command)) return null;

  const argument = command.slice('/compact'.length).trim().toLowerCase();
  if (!argument) return { kind: 'compact', force: false };
  if (argument === 'force') return { kind: 'compact', force: true };
  return { kind: 'invalid' };
}

import { isSlashCommand } from './slashCommand';

export type SlashActionId =
  | 'btw'
  | 'review'
  | 'goal'
  | 'model'
  | 'usage'
  | 'reload'
  | 'compact'
  | 'init';

export function resolveSlashActionInputValue(
  actionId: SlashActionId,
  raw: string,
  isBtwSession: boolean,
): string | null {
  const lower = raw.trimStart().toLowerCase();

  switch (actionId) {
    case 'btw': {
      if (isBtwSession) {
        return null;
      }
      if (!isSlashCommand(lower, '/btw')) {
        return '/btw ';
      }

      const match = raw.match(/^(\s*)\/btw\b/i);
      if (!match) {
        return '/btw ';
      }
      const leadingWhitespace = match[1] || '';
      const rest = raw.slice(match[0].length);
      return `${leadingWhitespace}/btw ${rest.trimStart()}`;
    }
    case 'review':
      return '/review ';
    case 'compact':
      return '/compact';
    case 'goal': {
      if (!isSlashCommand(lower, '/goal')) {
        return '/goal ';
      }

      const match = raw.match(/^(\s*)\/goal\b/i);
      if (!match) {
        return '/goal ';
      }
      const leadingWhitespace = match[1] || '';
      const rest = raw.slice(match[0].length);
      return `${leadingWhitespace}/goal ${rest.trimStart()}`;
    }
    case 'usage':
      return '/usage';
    case 'model':
      return '/model';
    case 'init':
      return '/init';
    case 'reload':
      return '/reload';
  }
}

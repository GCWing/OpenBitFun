import { describe, expect, it } from 'vitest';
import { loggingLevelSavedMessageKey } from './loggingLevelMessage';

describe('loggingLevelSavedMessageKey', () => {
  it('reports an applied level as updated', () => {
    expect(loggingLevelSavedMessageKey('info', 'info')).toBe('logging.messages.levelUpdated');
  });

  it('does not claim a level the host has not applied', () => {
    expect(loggingLevelSavedMessageKey('debug', 'info')).toBe('logging.messages.levelSavedNotApplied');
  });
});

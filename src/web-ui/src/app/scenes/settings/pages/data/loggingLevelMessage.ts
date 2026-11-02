/** A host whose level is fixed at launch (a CLI host) saves the setting but keeps reporting its own level. */
export function loggingLevelSavedMessageKey(effectiveLevel: string, requestedLevel: string): string {
  return effectiveLevel === requestedLevel
    ? 'logging.messages.levelUpdated'
    : 'logging.messages.levelSavedNotApplied';
}

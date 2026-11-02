/** Native presentation calls share one queue across panel unmount/remount. */
type Presentation = { owner?: symbol; pending: Promise<void> };
const presentations = new Map<string, Presentation>();

export function claimBrowserPresentation(label: string) {
  const state = presentations.get(label) ?? { pending: Promise.resolve() };
  const owner = Symbol(label);
  state.owner = owner;
  presentations.set(label, state);
  return {
    isCurrent: () => state.owner === owner,
    run(operation: () => Promise<void>): Promise<void> {
      const pending = state.pending.catch(() => {}).then(async () => {
        if (state.owner === owner) await operation();
      });
      state.pending = pending;
      return pending;
    },
    release() {
      if (state.owner !== owner) return;
      state.owner = undefined;
      // Keep the queue until already-submitted native calls have finished.
      void state.pending.catch(() => {}).then(() => {
        if (!state.owner && presentations.get(label) === state) presentations.delete(label);
      });
    },
  };
}

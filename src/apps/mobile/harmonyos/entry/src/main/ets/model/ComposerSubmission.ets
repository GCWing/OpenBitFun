/** In-memory draft handoff. No transport or persistence is owned by this handle. */
export interface ComposerSubmission {
  commit: () => void;
  rollback: () => void;
}

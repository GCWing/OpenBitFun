/**
 * Undo history for the chat composer.
 *
 * The composer is a contentEditable surface whose capsules (contexts, skills,
 * large pastes) are inserted programmatically, which the browser's native undo
 * stack cannot track. WebKit also coalesces an entire typing run, including IME
 * commits, into a single native undo step, so one Cmd+Z could clear the whole
 * draft. The composer therefore owns its history: it records the state after
 * every edit and starts a new undo step at word boundaries, pauses, IME
 * commits, edit-kind changes, and programmatic insertions.
 */

export type RichTextHistoryEditKind = 'insert' | 'delete' | 'composition' | 'other';

export interface RichTextHistoryEdit {
  kind: RichTextHistoryEditKind;
  /** Inserted text, when the edit inserted plain text. */
  data: string | null;
  at: number;
}

/** Consecutive same-kind edits closer than this coalesce into one step. */
export const RICH_TEXT_HISTORY_GROUP_IDLE_MS = 1000;
export const RICH_TEXT_HISTORY_MAX_ENTRIES = 200;

const WHITESPACE_ONLY = /^\s+$/;

/** Maps a native `beforeinput` inputType to the history edit kind. */
export function classifyRichTextHistoryInput(
  inputType: string,
  data: string | null,
): { kind: RichTextHistoryEditKind; data: string | null } {
  if (inputType === 'insertText' || inputType === 'insertReplacementText') {
    return { kind: 'insert', data };
  }
  if (inputType === 'insertParagraph' || inputType === 'insertLineBreak') {
    return { kind: 'insert', data: '\n' };
  }
  if (inputType.startsWith('delete') && inputType !== 'deleteByComposition' && inputType !== 'deleteByDrag') {
    return { kind: 'delete', data: null };
  }
  if (
    inputType === 'insertCompositionText'
    || inputType === 'insertFromComposition'
    || inputType === 'deleteByComposition'
  ) {
    return { kind: 'composition', data };
  }
  return { kind: 'other', data: null };
}

/**
 * Whether `next` must start a new undo step instead of merging into the step
 * that `previous` belongs to. A missing `next` means a programmatic change.
 */
export function shouldStartRichTextHistoryGroup(
  previous: RichTextHistoryEdit | null,
  next: RichTextHistoryEdit | null,
): boolean {
  if (!previous || !next) return true;
  if (next.kind === 'other' || next.kind === 'composition') return true;
  if (previous.kind !== next.kind) return true;
  if (next.at - previous.at > RICH_TEXT_HISTORY_GROUP_IDLE_MS) return true;
  if (next.kind === 'insert') {
    // Start each word as its own step: "hello " | "world".
    const previousWasWhitespace = previous.data !== null && WHITESPACE_ONLY.test(previous.data);
    const nextIsWhitespace = next.data !== null && WHITESPACE_ONLY.test(next.data);
    return previousWasWhitespace && !nextIsWhitespace;
  }
  return false;
}

export class RichTextUndoHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private current: T;

  constructor(
    initial: T,
    private readonly isSameState: (a: T, b: T) => boolean,
    private readonly maxEntries = RICH_TEXT_HISTORY_MAX_ENTRIES,
  ) {
    this.current = initial;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Forget every step; `state` becomes the new baseline. */
  reset(state: T): void {
    this.undoStack = [];
    this.redoStack = [];
    this.current = state;
  }

  /**
   * Records the state after an edit. Returns false when the state did not
   * change. A merged edit replaces the current step, so undo jumps back to the
   * state before the whole group.
   */
  record(state: T, startGroup: boolean): boolean {
    if (this.isSameState(this.current, state)) {
      return false;
    }
    if (startGroup || this.undoStack.length === 0) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.maxEntries) {
        this.undoStack.shift();
      }
    }
    this.redoStack = [];
    this.current = state;
    return true;
  }

  undo(): T | null {
    const previous = this.undoStack.pop();
    if (previous === undefined) return null;
    this.redoStack.push(this.current);
    this.current = previous;
    return previous;
  }

  redo(): T | null {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(this.current);
    this.current = next;
    return next;
  }
}

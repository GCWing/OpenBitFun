import { describe, expect, it } from 'vitest';
import {
  classifyRichTextHistoryInput,
  RICH_TEXT_HISTORY_GROUP_IDLE_MS,
  RichTextUndoHistory,
  shouldStartRichTextHistoryGroup,
  type RichTextHistoryEdit,
} from './richTextInputHistory';

const insert = (data: string, at: number): RichTextHistoryEdit => ({ kind: 'insert', data, at });

/** Replays edits the way the composer does: record the state after each one. */
function replay(edits: Array<{ edit: RichTextHistoryEdit | null; state: string }>) {
  const history = new RichTextUndoHistory<string>('', (a, b) => a === b);
  let previous: RichTextHistoryEdit | null = null;
  for (const { edit, state } of edits) {
    if (history.record(state, shouldStartRichTextHistoryGroup(previous, edit))) {
      previous = edit;
    }
  }
  return history;
}

describe('richTextInputHistory', () => {
  it('undoes an IME commit separately from the typing before it', () => {
    const history = replay([
      { edit: insert('1', 0), state: '1' },
      { edit: insert('2', 10), state: '12' },
      { edit: insert('3', 20), state: '123' },
      { edit: insert('4', 30), state: '1234' },
      { edit: insert('5', 40), state: '12345' },
      { edit: { kind: 'composition', data: null, at: 50 }, state: '12345你好' },
    ]);

    expect(history.undo()).toBe('12345');
    expect(history.undo()).toBe('');
    expect(history.undo()).toBeNull();
    expect(history.redo()).toBe('12345');
    expect(history.redo()).toBe('12345你好');
  });

  it('starts a new step at each word and after a pause', () => {
    const history = replay([
      { edit: insert('a', 0), state: 'a' },
      { edit: insert(' ', 10), state: 'a ' },
      { edit: insert('b', 20), state: 'a b' },
      { edit: insert('c', 20 + RICH_TEXT_HISTORY_GROUP_IDLE_MS + 1), state: 'a bc' },
    ]);

    expect(history.undo()).toBe('a b');
    expect(history.undo()).toBe('a ');
    expect(history.undo()).toBe('');
  });

  it('separates deletes from inserts and programmatic changes from typing', () => {
    const history = replay([
      { edit: insert('a', 0), state: 'a' },
      { edit: insert('b', 10), state: 'ab' },
      { edit: { kind: 'delete', data: null, at: 20 }, state: 'a' },
      { edit: null, state: 'a #file:x ' },
    ]);

    expect(history.undo()).toBe('a');
    expect(history.undo()).toBe('ab');
    expect(history.undo()).toBe('');
  });

  it('ignores unchanged states and drops redo after a new edit', () => {
    const history = replay([
      { edit: insert('a', 0), state: 'a' },
      { edit: null, state: 'a' },
    ]);
    expect(history.undo()).toBe('');
    expect(history.undo()).toBeNull();

    history.record('x', true);
    expect(history.canRedo).toBe(false);
  });

  it('classifies native input types', () => {
    expect(classifyRichTextHistoryInput('insertText', 'a')).toEqual({ kind: 'insert', data: 'a' });
    expect(classifyRichTextHistoryInput('insertParagraph', null)).toEqual({ kind: 'insert', data: '\n' });
    expect(classifyRichTextHistoryInput('deleteContentBackward', null).kind).toBe('delete');
    expect(classifyRichTextHistoryInput('insertFromComposition', '你').kind).toBe('composition');
    expect(classifyRichTextHistoryInput('insertFromPaste', null).kind).toBe('other');
  });
});

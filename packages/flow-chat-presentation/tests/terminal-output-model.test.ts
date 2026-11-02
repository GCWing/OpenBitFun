import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { calculateTerminalOutputHeight, prepareReadOnlyTerminalOutput, stripTerminalControlSequences } from '../src/terminal/terminalOutputPresentation';

// A regression in these synchronous scans must fail without hanging the runner.
function runIsolated(operation: (content: string) => string, inputs: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const operation = eval('(' + workerData.source + ')');
      parentPort.postMessage(workerData.inputs.map(operation));
    `, { eval: true, workerData: { source: operation.toString(), inputs } });
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Terminal preprocessing did not complete within 10 seconds'));
    }, 10_000);
    worker.once('message', (outputs: string[]) => {
      clearTimeout(timeout);
      void worker.terminate();
      resolve(outputs);
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      void worker.terminate();
      reject(error);
    });
  });
}

describe('terminal output normalization', () => {
  it('preserves cursor normalization and trailing CSI semantics', () => {
    // Compare short, mixed valid/malformed sequences with the previous behavior.
    const parts = ['text', '\n', '\r', '\r\n', '\x1b[0m', '\x1b[?25h', '\x1b[1;2H', '\x1b[H', '\x1b[2 f', '\x1b[', '\x1b]title\x07', '\x1b[;;m'];
    for (const a of parts) for (const b of parts) for (const c of parts) {
      const content = a + b + c;
      const expected = content
        // eslint-disable-next-line no-control-regex -- reference terminal sequences.
        .replace(/\x1b\[\d*;?\d*[Hf]/g, '\r\n')
        // eslint-disable-next-line no-control-regex -- reference terminal sequences.
        .replace(/(?:\r\n|\r|\n)+((?:\x1b\[[0-?]*[ -/]*[@-~])*)$/g, '$1');
      expect(prepareReadOnlyTerminalOutput(content)).toBe(expected);
    }
  });

  it('keeps dense blank regions and incomplete cursor sequences without truncating output', async () => {
    const blanks = '\r\n'.repeat(50_000);
    const incompleteCursor = `\x1b[${'1'.repeat(50_000)}x`;
    expect(await runIsolated(prepareReadOnlyTerminalOutput, [
      blanks + 'after blanks', incompleteCursor, 'text' + blanks + '\x1b[0m\x1b[?25h',
    ])).toEqual([blanks + 'after blanks', incompleteCursor, 'text\x1b[0m\x1b[?25h']);
  }, 15_000);

  it('preserves stripping semantics for terminated, nested and incomplete terminal strings', () => {
    const parts = ['text', '\n', '\x1b]title', '\x1bPdata', '\x1bXdata', '\x1b_data', '\x1b^data', '\x1b\\', '\x07', '\x1b[0m'];
    for (const a of parts) for (const b of parts) for (const c of parts) {
      const content = a + b + c;
      const expected = content
        // eslint-disable-next-line no-control-regex -- reference terminal sequences.
        .replace(/\x1b[\]PX_^][\s\S]*?(?:\x07|\x1b\\)/g, '')
        // eslint-disable-next-line no-control-regex -- reference terminal sequences.
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
        // eslint-disable-next-line no-control-regex -- reference terminal sequences.
        .replace(/\x1b[ -/]*[@-~]/g, '');
      expect(stripTerminalControlSequences(content)).toBe(expected);
    }
  });

  it('handles many unterminated control strings and still removes a later terminated string', async () => {
    const incomplete = '\x1b]title'.repeat(50_000);
    expect(await runIsolated(stripTerminalControlSequences, [incomplete, incomplete + '\x07visible']))
      .toEqual(['title'.repeat(50_000), 'visible']);
  }, 15_000);
});

describe('terminal preview height', () => {
  it('keeps mixed line endings and row-aligned min/max geometry', () => {
    for (const rowHeight of [17, 17.5]) for (const minHeight of [0, 20, 400]) {
      for (const maxHeight of [20, 300]) for (const maxRows of [undefined, 0, 1, 2.5, 15]) {
        for (const content of ['', 'one', 'one\r\ntwo\rthree\nfour\n', 'line\n'.repeat(100)]) {
          const heightForRows = (rows: number) => Math.ceil(Math.max(rowHeight, rows * rowHeight));
          const min = heightForRows(Math.max(1, Math.ceil(minHeight / rowHeight)));
          const max = maxRows != null && maxRows > 0 ? heightForRows(maxRows)
            : heightForRows(Math.max(1, Math.floor(maxHeight / rowHeight)));
          const lines = content ? content.split(/\r\n|\r|\n/).length : 1;
          const rows = maxRows != null && maxRows > 0 ? Math.min(lines, maxRows) : lines;
          expect(calculateTerminalOutputHeight(content, { rowHeight, minHeight, maxHeight, maxRows }))
            .toBe(Math.min(Math.max(heightForRows(Math.max(1, rows)), min), Math.max(min, max)));
        }
      }
    }
  });

  it('bounds the height of output containing hundreds of thousands of rows', () => {
    expect(calculateTerminalOutputHeight('line\n'.repeat(400_000), {
      rowHeight: 17, minHeight: 17, maxHeight: 300, maxRows: 15,
    })).toBe(255);
  });
});

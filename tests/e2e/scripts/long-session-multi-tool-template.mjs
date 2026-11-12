/** Recorded tool results only. This fixture never performs filesystem or command IO. */
export const MULTI_TOOL_TEMPLATE = Object.freeze({
  id: 'multi-tool', version: 1, modelRoundsPerTurn: 26, toolRoundsPerTurn: 25, toolCallsPerTurn: 100,
  toolCallsPerModelRound: 4, narrativeCharsPerToolRound: 320,
  toolsPerTurn: Object.freeze({ Read: 25, Edit: 25, Write: 25, ExecCommand: 25 }),
});

export function resolveTemplateToolItems(scenario, toolItems, explicitlySet = false) {
  if (scenario !== MULTI_TOOL_TEMPLATE.id) return toolItems;
  if (explicitlySet && toolItems !== MULTI_TOOL_TEMPLATE.toolCallsPerTurn) {
    throw new Error('multi-tool has exactly 100 tool calls per turn; omit --tool-items or use --tool-items 100');
  }
  return MULTI_TOOL_TEMPLATE.toolCallsPerTurn;
}

function sourceText(chars, turnIndex, step, changed = false) {
  let text = `// Recorded fixture: turn ${turnIndex}, step ${step}\n`.slice(0, chars);
  for (let line = 0; text.length < chars; line++) {
    const statement = `export const value${line} = ${turnIndex + step + line + (changed ? 1 : 0)};\n`;
    if (text.length + statement.length > chars) break;
    text += statement;
  }
  return text.padEnd(chars, ' ');
}

function narrative(chars, turnIndex, step) {
  const seed = `Turn ${turnIndex}, step ${step}: inspect the source, update the implementation, write a generated module and check the result.\n\n`
    + '```typescript\nexport const verified = true;\n```\n\n| Tool | Result |\n|---|---|\n| Read / Edit / Write / ExecCommand | completed |\n\n';
  return seed.repeat(Math.max(1, Math.ceil(chars / seed.length))).slice(0, chars);
}

export function makeMultiToolModelRounds({ turnId, turnIndex, timestamp, assistantChars, toolResultChars }) {
  const rounds = [];
  const names = Object.keys(MULTI_TOOL_TEMPLATE.toolsPerTurn);
  for (let step = 0; step < MULTI_TOOL_TEMPLATE.toolRoundsPerTurn; step++) {
    const roundId = `${turnId}-round-${step}`, start = timestamp + step * 40;
    const file = `/workspace/perf-multi-tool/turn-${turnIndex}/source-${step}.ts`;
    const generated = `/workspace/perf-multi-tool/turn-${turnIndex}/generated-${step}.ts`;
    const inputChars = Math.max(200, Math.min(toolResultChars, 1200));
    const original = sourceText(inputChars, turnIndex, step).trimEnd() + '\n';
    const modified = sourceText(inputChars, turnIndex, step, true).trimEnd() + '\n';
    const content = sourceText(inputChars, turnIndex, step + 1);
    const readContent = sourceText(toolResultChars, turnIndex, step);
    const output = `Recorded check turn ${turnIndex}, step ${step}: passed\n`.repeat(Math.ceil(toolResultChars / 20)).slice(0, toolResultChars);
    const inputs = {
      Read: { file_path: file, offset: 1, limit: Math.max(1, readContent.split('\n').length) },
      Edit: { file_path: file, old_string: original, new_string: modified, replace_all: false },
      Write: { file_path: generated, content },
      ExecCommand: { cmd: `node --check ${generated}`, workdir: '/workspace/perf-multi-tool' },
    };
    const results = {
      Read: { file_path: file, content: readContent, fixture: true },
      Edit: { file_path: file, success: true, replacements: 1, output: sourceText(toolResultChars, turnIndex, step, true), fixture: true },
      Write: { file_path: generated, success: true, bytes_written: Buffer.byteLength(content), output, fixture: true },
      ExecCommand: { output, exit_code: 0, fixture: true },
    };
    const toolItems = names.map((toolName, index) => {
      const id = `${roundId}-tool-${index}`, startTime = start + 2 + index * 6;
      return { id, toolName, toolCall: { id, input: inputs[toolName] },
        toolResult: { result: results[toolName], success: true,
          resultForAssistant: `${toolName} step ${step}: completed successfully`, durationMs: 5 },
        aiIntent: `Recorded ${toolName} operation for turn ${turnIndex}, step ${step}`,
        startTime, endTime: startTime + 5, durationMs: 5, queueWaitMs: 0,
        preflightMs: 0, confirmationWaitMs: 0, executionMs: 5, orderIndex: index + 1, status: 'completed' };
    });
    rounds.push({ id: roundId, turnId, roundIndex: step, timestamp: start,
      textItems: [{ id: `${roundId}-text-0`, content: narrative(MULTI_TOOL_TEMPLATE.narrativeCharsPerToolRound, turnIndex, step),
        isStreaming: false, isMarkdown: true, timestamp: start + 1, orderIndex: 0, status: 'completed' }],
      toolItems, thinkingItems: [], startTime: start, endTime: start + 30, durationMs: 30,
      providerId: 'perf-fixture', modelId: 'perf-fixture-model', modelAlias: 'Perf Fixture', status: 'completed' });
  }
  const start = timestamp + MULTI_TOOL_TEMPLATE.toolRoundsPerTurn * 40, roundIndex = rounds.length;
  const roundId = `${turnId}-round-${roundIndex}`;
  rounds.push({ id: roundId, turnId, roundIndex, timestamp: start,
    textItems: [{ id: `${roundId}-text-0`, content: narrative(assistantChars, turnIndex, 'summary'),
      isStreaming: false, isMarkdown: true, timestamp: start + 1, orderIndex: 0, status: 'completed' }],
    toolItems: [], thinkingItems: [], startTime: start, endTime: start + 30, durationMs: 30,
    providerId: 'perf-fixture', modelId: 'perf-fixture-model', modelAlias: 'Perf Fixture', status: 'completed' });
  return rounds;
}

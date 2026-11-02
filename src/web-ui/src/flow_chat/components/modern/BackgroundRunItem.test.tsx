// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BackgroundRunItem } from './BackgroundRunItem';
import type { DialogTurn } from '../../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('@/infrastructure/i18n', () => ({ useI18n: () => ({ t: (key: string) => key, formatNumber: String }) }));
vi.mock('./UserMessageItem', () => ({ UserMessageItem: ({ message }: { message: { content: string } }) => <p>{message.content}</p> }));
vi.mock('./ModelRoundItem', () => ({ ModelRoundItem: () => <p>Original execution output</p> }));

it('keeps quiet output out of the transcript until the reader expands its execution record', async () => {
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  const turn = { id: 'run', status: 'completed', startTime: 1, userMessage: { content: 'Original task instructions' }, modelRounds: [{ id: 'round' }] } as DialogTurn;
  try {
    await act(async () => root.render(<BackgroundRunItem turn={turn} />));
    expect(node.textContent).toContain('backgroundDelivery.quiet');
    expect(node.textContent).not.toContain('Original execution output');
    const details = node.querySelector('details')!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    expect(node.textContent).toContain('Original task instructions');
    expect(node.textContent).toContain('Original execution output');
    await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')); });
    expect(node.textContent).not.toContain('Original execution output');
    await act(async () => root.render(<BackgroundRunItem turn={turn} forceOpen />));
    expect(node.textContent).toContain('Original execution output');
  } finally { await act(async () => root.unmount()); node.remove(); }
});

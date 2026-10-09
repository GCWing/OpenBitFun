// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlowChatReaderProvider, FlowChatReaderState } from '../../timeline/readerState';
import { TurnFooter } from './TurnFooter';
import { useTurnFooterInteraction } from './useTurnFooterInteraction';

function Row({ id, turnId, children }: { id: string; turnId: string; children: React.ReactNode }) {
  const interaction = useTurnFooterInteraction(turnId);
  return <div id={id} {...interaction}>{children}</div>;
}

describe('completed-turn footer presentation', () => {
  let host: HTMLDivElement;
  let root: Root;
  let reader: FlowChatReaderState;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host);
    root = createRoot(host); reader = new FlowChatReaderState();
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  function render({ latest = 'new', body = true, ready = true, store = reader } = {}) {
    act(() => root.render(<FlowChatReaderProvider store={store}>
      {body && <Row id="old-body" turnId="old"><button>Old body action</button></Row>}
      <Row id="old-footer" turnId="old"><TurnFooter turnId="old" isLatestTurn={latest === 'old'} ready={ready}>Old metrics</TurnFooter></Row>
      <Row id="new-body" turnId="new"><button>New body action</button></Row>
      <Row id="new-footer" turnId="new"><TurnFooter turnId="new" isLatestTurn={latest === 'new'} ready>New metrics</TurnFooter></Row>
    </FlowChatReaderProvider>));
  }
  const footer = (turn: string) => host.querySelector<HTMLElement>(`#${turn}-footer .model-round-item__footer`)!;
  function pointer(type: 'pointerover' | 'pointerout', id: string) {
    act(() => host.querySelector(`#${id}`)!.dispatchEvent(new MouseEvent(type, { bubbles: true })));
  }

  it('shows the session latest turn, including when it is outside the rendered history window', () => {
    render();
    expect(footer('old').dataset.footerReveal).toBe('hover');
    expect(footer('new').dataset.footerReveal).toBe('visible');
    render({ latest: 'unrendered-latest' });
    expect(footer('old').dataset.footerReveal).toBe('hover');
    expect(footer('new').dataset.footerReveal).toBe('hover');
    render({ latest: 'old' });
    expect(footer('old').dataset.footerReveal).toBe('visible');
    expect(footer('new').dataset.footerReveal).toBe('hover');
  });

  it('reveals a sibling footer from any row in its turn without changing timeline projection', () => {
    render({ latest: 'unrendered-latest' });
    const originalFooter = footer('old');
    const revision = reader.getProjectionRevision();
    pointer('pointerover', 'old-body');
    expect(footer('old').dataset.footerReveal).toBe('visible');
    expect(footer('new').dataset.footerReveal).toBe('hover');
    pointer('pointerout', 'old-body');
    expect(footer('old').dataset.footerReveal).toBe('hover');
    expect(footer('old')).toBe(originalFooter);
    expect(reader.getProjectionRevision()).toBe(revision);
  });

  it('keeps keyboard access after the pointer leaves and releases focus independently', () => {
    render();
    pointer('pointerover', 'old-body');
    act(() => host.querySelector<HTMLButtonElement>('#old-body button')!.focus());
    pointer('pointerout', 'old-body');
    expect(footer('old').dataset.footerReveal).toBe('visible');
    act(() => host.querySelector<HTMLButtonElement>('#new-body button')!.focus());
    expect(footer('old').dataset.footerReveal).toBe('hover');
  });

  it('releases recycled rows and never carries a hover into another session view', () => {
    render();
    pointer('pointerover', 'old-body');
    render({ body: false });
    expect(footer('old').dataset.footerReveal).toBe('hover');
    render(); pointer('pointerover', 'old-body');
    const nextReader = new FlowChatReaderState();
    render({ store: nextReader });
    expect(reader.get('interaction:old', true)).toBe(false);
    expect(footer('old').dataset.footerReveal).toBe('hover');
  });

  it('keeps the existing typewriter reveal gate authoritative on hover', () => {
    render({ ready: false });
    pointer('pointerover', 'old-body');
    expect(footer('old').classList.contains('model-round-item__footer--pending')).toBe(true);
    expect(footer('old').getAttribute('aria-hidden')).toBe('true');
  });
});

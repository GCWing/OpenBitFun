// @vitest-environment jsdom

import React, { act, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Button, Dialog, DialogBody, DialogHeader, DialogHeading, DialogTitle } from '@openbitfun/ui';
import { i18nService } from '@/infrastructure/i18n';
import { ModelDiscoveryPicker } from './ModelDiscoveryPicker';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type PickerProps = ComponentProps<typeof ModelDiscoveryPicker>;
const models = ['alpha', 'beta', 'gamma'].map(value => ({ label: value, value }));

describe('model discovery capsules', () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: string[][];
  let refreshes: number;
  let editorClosures: boolean[];
  const copy = (key: string, options?: Record<string, unknown>) => (
    String(i18nService.getI18nInstance().t(key, { ns: 'settings/models', ...options }))
  );
  const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid="settings-model-select"]')!;
  const popup = () => document.querySelector<HTMLElement>('[data-testid="settings-model-discovery-dialog"]:not([aria-hidden="true"])');
  const capsules = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="settings-model-option"]')];
  const search = () => popup()!.querySelector<HTMLInputElement>('input')!;
  const click = (element: HTMLElement) => act(() => { element.focus(); element.click(); });
  const escape = () => act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  });
  const settleExit = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });

  function Picker(props: Partial<PickerProps>) {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState(['custom-model', 'ALPHA']);
    return <ModelDiscoveryPicker
      options={models} value={value} open={open} loading={false} fetched hint={null} error={false} invalid={false}
      onOpenChange={setOpen}
      onRefresh={() => { refreshes += 1; }}
      onValueChange={next => { changes.push(next); setValue(next); }}
      {...props}
    />;
  }

  function Editor() {
    const [open, setOpen] = useState(true);
    return <Dialog open={open} onOpenChange={next => { editorClosures.push(next); setOpen(next); }}>
      <DialogHeader><DialogHeading><DialogTitle>Provider</DialogTitle></DialogHeading></DialogHeader>
      <DialogBody><Picker /><Button data-testid="other-field">Other field</Button></DialogBody>
    </Dialog>;
  }

  beforeAll(async () => { await Promise.all(['settings/models', 'components'].map(ns => i18nService.loadNamespace(ns))); });
  beforeEach(() => {
    changes = [];
    refreshes = 0;
    editorClosures = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('opens quick add as a primary action and keeps discovery results separate from selected custom models', async () => {
    act(() => root.render(<Picker />));
    expect(popup()).toBeNull();
    expect(trigger().textContent).toBe(copy('providerSelection.quickAdd'));
    expect(trigger().getAttribute('data-openbitfun-variant')).toBe('primary');
    click(trigger());
    expect(popup()!.getAttribute('aria-modal')).toBe('true');
    expect(popup()!.getAttribute('data-openbitfun-component')).toBe('dialog');
    expect(popup()!.textContent).toContain(copy('providerSelection.fetchedModels', { count: '3' }));
    expect(capsules().map(button => button.textContent)).toEqual(['alpha', 'beta', 'gamma']);
    expect(capsules()[0].getAttribute('aria-pressed')).toBe('true');
    click(capsules()[2]);
    expect(changes.at(-1)).toEqual(['custom-model', 'ALPHA', 'gamma']);
    expect(popup()).not.toBeNull();
    expect(capsules()[2].getAttribute('aria-pressed')).toBe('true');
    click(capsules()[0]);
    expect(changes.at(-1)).toEqual(['custom-model', 'gamma']);
    expect(capsules()).toHaveLength(3);

    act(() => {
      search().focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), 'BETA');
      search().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(capsules().map(button => button.textContent)).toEqual(['beta']);
    escape();
    expect(popup()).toBeNull();
    await settleExit();
    expect(document.activeElement).toBe(trigger());
    click(trigger());
    expect(search().value).toBe('');
    expect(capsules()).toHaveLength(3);
  });

  it('keeps modal focus and dismissal inside the model list without closing the provider editor', async () => {
    act(() => root.render(<Editor />));
    click(trigger());
    expect(document.activeElement).toBe(search());
    act(() => capsules()[1].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    click(capsules()[1]);
    expect(editorClosures).toEqual([]);
    expect(popup()).not.toBeNull();
    escape();
    expect(popup()).toBeNull();
    await settleExit();
    expect(document.activeElement).toBe(trigger());
    expect(editorClosures).toEqual([]);

    click(trigger());
    const other = document.querySelector<HTMLButtonElement>('[data-testid="other-field"]')!;
    act(() => other.focus());
    expect(popup()!.contains(document.activeElement)).toBe(true);
    const backdrop = popup()!.closest<HTMLElement>('[data-openbitfun-part="overlay"]')!;
    act(() => backdrop.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(popup()).toBeNull();
    expect(editorClosures).toEqual([]);
    await settleExit();
    expect(document.activeElement).toBe(trigger());
    escape();
    expect(editorClosures).toEqual([false]);
  });

  it('labels preset fallback honestly and keeps refresh available after loading or an empty response', () => {
    act(() => root.render(<Picker fetched={false} hint="Preset fallback" />));
    expect(trigger().textContent).toBe(copy('providerSelection.quickAdd'));
    click(trigger());
    expect(popup()!.textContent).toContain(copy('providerSelection.presetModels', { count: '3' }));
    const refresh = () => document.querySelector<HTMLButtonElement>('[data-testid="settings-model-refresh-btn"]')!;
    click(refresh());
    expect(refreshes).toBe(1);

    act(() => root.render(<Picker fetched={false} loading hint="Fetching" />));
    expect(refresh().disabled).toBe(true);
    act(() => root.render(<Picker options={[]} fetched={false} error hint="No models returned" />));
    expect(capsules()).toHaveLength(0);
    expect(popup()!.textContent).toContain('No models returned');
    expect(refresh().disabled).toBe(false);
    click(refresh());
    expect(refreshes).toBe(2);

    act(() => root.render(<Picker />));
    expect(capsules()).toHaveLength(3);
    expect(capsules()[0].getAttribute('aria-pressed')).toBe('true');
    expect(changes).toEqual([]);
  });
});

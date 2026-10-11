// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Dialog, DialogBody, DialogHeader, DialogHeading, DialogTitle } from '@openbitfun/ui';
import { i18nService } from '@/infrastructure/i18n';
import ModelTagsField from './ModelTagsField';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('model tag editing', () => {
  let host: HTMLDivElement;
  let root: Root;
  let changes: string[][];
  const copy = (key: string, options?: Record<string, unknown>) => (
    String(i18nService.getI18nInstance().t(key, { ns: 'settings/models', ...options }))
  );
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find(element => element.getAttribute('aria-label') === label)!;
  const add = () => button(copy('pool.addTags'));
  const edit = (tag: string) => button(copy('pool.editTag', { tag }));
  const remove = (tag: string) => button(copy('pool.removeTag', { tag }));
  const input = () => document.querySelector<HTMLInputElement>('.openbitfun-model-settings__tag-editor input')!;
  const click = (element: HTMLElement) => act(() => element.click());
  const key = (value: string, isComposing = false) => act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: value, isComposing, bubbles: true, cancelable: true }));
  });
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });

  function Editor({ initialTags, disabled = false }: { initialTags: string[]; disabled?: boolean }) {
    const [tags, setTags] = useState(initialTags);
    return <ModelTagsField tags={tags} recommendedTags={['recommended']} layout="row" disabled={disabled}
      onChange={next => { changes.push(next); setTags(next); }} />;
  }

  beforeAll(async () => { await i18nService.loadNamespace('settings/models'); });
  beforeEach(() => {
    changes = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('adds and edits independent tags without focusing the completed capsule or opening a selection popup', async () => {
    act(() => root.render(<Editor initialTags={['planning']} />));
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    expect(edit('planning')).toBeDefined();
    const addButton = add();
    const capsules = document.querySelector('.openbitfun-model-settings__tag-list')!;
    click(addButton);
    expect(document.activeElement).toBe(input());
    expect(capsules.lastElementChild?.contains(input())).toBe(true);
    expect(capsules.children).toHaveLength(2);
    expect(input().closest('[data-openbitfun-component="input"]')?.getAttribute('data-shape')).toBe('pill');
    expect(add()).toBe(addButton);
    expect(addButton.disabled).toBe(true);
    expect(capsules.contains(addButton)).toBe(false);
    type(' execution ');
    key('Enter');
    expect(changes).toEqual([['planning', 'execution']]);
    expect(input()).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(document.activeElement?.closest('.openbitfun-model-settings__model-capsule')).toBeNull();

    click(add());
    type('execution');
    key('Enter');
    expect(changes).toHaveLength(1);

    click(edit('planning'));
    type('review');
    act(() => input().blur());
    expect(changes.at(-1)).toEqual(['review', 'execution']);
    expect(document.querySelector('[data-openbitfun-component="status-pill"]')?.textContent).toBe('recommended');

    click(edit('review'));
    type('final');
    key('Enter');
    await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(changes.at(-1)).toEqual(['final', 'execution']);
    expect(document.activeElement?.closest('.openbitfun-model-settings__model-capsule')).toBeNull();
  });

  it('keeps composition and Escape inside the tag editor without dismissing the dialog', () => {
    const openChanges: boolean[] = [];
    act(() => root.render(
      <Dialog open onOpenChange={open => openChanges.push(open)}>
        <DialogHeader><DialogHeading><DialogTitle>Model</DialogTitle></DialogHeading></DialogHeader>
        <DialogBody><Editor initialTags={[]} /></DialogBody>
      </Dialog>,
    ));
    click(add());
    type('reasoning');
    key('Enter', true);
    expect(changes).toEqual([]);
    expect(input()?.value).toBe('reasoning');
    key('Escape');
    expect(changes).toEqual([]);
    expect(openChanges).toEqual([]);
    expect(input()).toBeNull();
    expect(add()).toBeDefined();
  });

  it('preserves legacy tags above the limit while allowing removal before another addition', () => {
    act(() => root.render(<Editor initialTags={['one', 'two', 'three', 'four']} />));
    expect(add().disabled).toBe(true);
    expect(document.querySelectorAll('.openbitfun-model-settings__tag-editor .openbitfun-model-settings__model-capsule')).toHaveLength(4);
    click(remove('four'));
    expect(changes.at(-1)).toEqual(['one', 'two', 'three']);
    expect(add().disabled).toBe(true);
    click(remove('three'));
    expect(add().disabled).toBe(false);
    click(add());
    type('replacement');
    key('Enter');
    expect(changes.at(-1)).toEqual(['one', 'two', 'replacement']);
    expect(add().disabled).toBe(true);
  });

  it('locks tag mutations while the model is saving', () => {
    act(() => root.render(<Editor initialTags={['planning']} disabled />));
    expect(add().disabled).toBe(true);
    expect(edit('planning').disabled).toBe(true);
    expect(remove('planning').disabled).toBe(true);
    click(remove('planning'));
    expect(changes).toEqual([]);
  });
});

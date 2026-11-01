// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Button } from '@openbitfun/ui';
import { SubscriptionAccountList, SubscriptionServiceGroup } from './SubscriptionServiceGroup';
import type { ManagedSubscriptionAccount } from './subscriptionServices';
it('keeps one service heading and separate exact-slot rows for identical account names', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const accounts = ['slot-a','slot-b'].map(accountId => ({ accountId, enabled: true,
    account: { provider: 'codex', connected: true, account: 'same@example.invalid' } })) as ManagedSubscriptionAccount[];
  const add = vi.fn(); const select = vi.fn();
  const container = document.createElement('div'); const root = createRoot(container);
  act(() => root.render(<SubscriptionServiceGroup title="Codex · 2 accounts" actions={<Button onClick={add}>Add account</Button>}>
    <SubscriptionAccountList accounts={accounts} renderAccount={item => <button onClick={() => select(item.accountId)}>{item.account.account}</button>} />
  </SubscriptionServiceGroup>));
  const service = container.querySelector('[data-openbitfun-part="subscriptionService"]')!;
  expect(service.querySelector('[data-openbitfun-component="card"]')).toBeNull();
  expect(service.querySelector('[data-openbitfun-part="header"]')?.parentElement).toBe(service);
  expect(service.querySelector('[role="list"]')?.parentElement).toBe(service);
  expect(container.querySelectorAll('h3')).toHaveLength(1);
  expect([...container.querySelectorAll('[role="listitem"]')].map(row => row.getAttribute('data-account-id'))).toEqual(['slot-a','slot-b']);
  act(() => (container.querySelector('[data-account-id="slot-b"] button') as HTMLButtonElement).click());
  expect(select).toHaveBeenCalledExactlyOnceWith('slot-b');
  act(() => container.querySelector('[data-openbitfun-part="actions"] button')!.dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(add).toHaveBeenCalledOnce();
  act(() => root.unmount());
});

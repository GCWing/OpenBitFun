import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DialogTurn, Session } from '@/flow_chat/types/flow-chat';
import { isFloatingMiniChatSessionExecuting } from './floatingMiniChatActivity';

function sessionWithStatuses(
  ...statuses: DialogTurn['status'][]
): Pick<Session, 'dialogTurns'> {
  return {
    dialogTurns: statuses.map((status) => ({ status }) as DialogTurn),
  };
}

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
}

describe('floating MiniApp chat activity', () => {
  it('uses the design-system launcher to open the conversation dock', () => {
    const component = readSource('./FloatingMiniChat.tsx');
    expect(component).toContain('<LauncherButton');
    expect(component).toContain('className="openbitfun-fmc__button"');
    expect(component).toContain('aria-expanded={dock.open}');
    expect(component).toContain("aria-label={t('dock.open')}");
    expect(component).not.toContain('leadingIcon=');
    expect(component).toContain("tv('voiceCall.call.launcherCompactLabel')");
    expect(component).toContain('onClick={() => dock.setOpen(true)}');
  });

  it('hides the launcher while the retained dock is open', () => {
    const component = readSource('./FloatingMiniChat.tsx');
    const stylesheet = readSource('./FloatingMiniChat.scss');

    expect(component).toMatch(/<div\b[^>]*role="dialog"[^>]*data-motion="presence"/);
    expect(stylesheet).not.toContain('--openbitfun-color-control-launcher');
    expect(stylesheet).not.toContain('--openbitfun-color-control-highlight');
    expect(stylesheet).toMatch(/\.openbitfun-fmc__button\s*\{[\s\S]*?\.openbitfun-fmc--open &[\s\S]*?visibility: hidden;[\s\S]*?pointer-events: none;/);
    expect(stylesheet).toContain('transition-behavior: allow-discrete;');
  });

  it.each([
    'pending',
    'image_analyzing',
    'processing',
    'finishing',
    'cancelling',
  ] satisfies DialogTurn['status'][])(
    'treats %s as an executing turn',
    (status) => {
      expect(
        isFloatingMiniChatSessionExecuting(sessionWithStatuses(status)),
      ).toBe(true);
    },
  );

  it.each([
    'completed',
    'cancelled',
    'error',
  ] satisfies DialogTurn['status'][])(
    'treats %s as a settled turn',
    (status) => {
      expect(
        isFloatingMiniChatSessionExecuting(sessionWithStatuses(status)),
      ).toBe(false);
    },
  );

  it('uses only the latest turn and handles an absent session', () => {
    expect(
      isFloatingMiniChatSessionExecuting(
        sessionWithStatuses('processing', 'completed'),
      ),
    ).toBe(false);
    expect(isFloatingMiniChatSessionExecuting(undefined)).toBe(false);
  });

  it('keeps the live call reachable when collapsed and retains reduced-motion support', () => {
    const component = readSource('./FloatingMiniChat.tsx');
    const stylesheet = readSource('./FloatingMiniChat.scss');

    expect(component).toContain("const live = voice.phase !== 'idle'");
    expect(component).toContain('{live ? <Phone size={16} />');
    expect(component).toContain('const collapse = () => dock.setOpen(false)');
    expect(component).toContain('onClick={voice.end}');
    expect(stylesheet).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

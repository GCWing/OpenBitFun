import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../application/GeneralSettingsPage.tsx', import.meta.url)),
  'utf8',
);

describe('Application settings presentation', () => {
  it('groups general settings by task instead of rendering one section per row', () => {
    expect(source).toContain("applicationGroups.startupAndUpdates.title");
    expect(source).toContain("applicationGroups.windowAndNotifications.title");
    expect(source).toContain('<LaunchAtLoginSetting />');
    expect(source).toContain('<PreventSleepSetting />');
    expect(source).toContain('<AutoUpdateSetting />');
    expect(source).toContain('<WindowBehaviorSetting />');
    expect(source).toContain('<NotificationSettings />');
    expect(source).not.toContain('function LaunchAtLoginSection');
    expect(source).not.toContain('function NotificationsSection');
  });

  it('does not render an empty desktop-only startup group on web', () => {
    expect(source).toContain('{isTauri && (');
  });

  it('only shows confirmed-crash notices outside the settings section surface', () => {
    const loggingSection = readFileSync(fileURLToPath(new URL('../data/DiagnosticsSettingsPage.tsx', import.meta.url)), 'utf8');
    const noticeStart = loggingSection.indexOf(
      "{runtimeInfo?.previousUnexpectedExit?.detected && runtimeInfo.previousUnexpectedExit.category === 'crash' && (",
    );
    const settingsSectionStart = loggingSection.indexOf('<ConfigPageSection');
    const settingsSectionEnd = loggingSection.indexOf('</ConfigPageSection>');

    expect(loggingSection).not.toBe('');
    expect(loggingSection).not.toContain('logging.previousUncleanShutdown');
    expect(noticeStart).toBeGreaterThanOrEqual(0);
    expect(settingsSectionStart).toBeGreaterThan(noticeStart);
    expect(settingsSectionEnd).toBeGreaterThan(settingsSectionStart);
    expect(
      loggingSection.slice(settingsSectionStart, settingsSectionEnd),
    ).not.toContain('previousUnexpectedExit');
  });

  it('keeps the command-shell fallback notice with the terminal setting', () => {
    const terminalSection = readFileSync(fileURLToPath(new URL('../development/TerminalSettingsPage.tsx', import.meta.url)), 'utf8');
    const settingsSectionStart = terminalSection.indexOf('<ConfigPageSection');
    const settingsSectionEnd = terminalSection.indexOf('</ConfigPageSection>');
    const sectionHeader = terminalSection.slice(
      settingsSectionStart,
      terminalSection.indexOf('<ConfigPageRow', settingsSectionStart),
    );
    const settingRow = terminalSection.slice(
      terminalSection.indexOf('<ConfigPageRow', settingsSectionStart),
      settingsSectionEnd,
    );

    expect(settingsSectionStart).toBeGreaterThanOrEqual(0);
    expect(settingsSectionEnd).toBeGreaterThan(settingsSectionStart);
    expect(sectionHeader).not.toContain('description=');
    expect(settingRow).toContain('description={t(shouldShowCmdFallbackNotice');
    expect(settingRow).toContain("'terminal.sections.terminalHintWithCmdFallback'");
    expect(settingRow).toContain("'terminal.controls.description'");
    expect(terminalSection).not.toContain('<Alert');
  });
});

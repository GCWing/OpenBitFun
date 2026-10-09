import { useToolCardDisclosure } from '../timeline/readerState';
import React, { useMemo } from 'react';
import { Button, Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Camera, Clipboard, Keyboard, MousePointerClick } from 'lucide-react';

import { notificationService } from '@/shared/notification-system';
import { createLogger } from '@/shared/utils/logger';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { getToolCardStatus, getToolCardStatusDescription } from './toolCardStatus';
import type { ToolCardProps } from '../types/flow-chat';
import { AmbientToolCard, AmbientToolCardHeader, ToolCardStatusSlot } from '@openbitfun/ui/flow-chat';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import './ComputerUseToolCard.scss';

const log = createLogger('ComputerUseToolCard');

interface ParsedComputerUseResult {
  action: string;
  appName: string | null;
  target: string | null;
  loopWarningSuggestion: string | null;
  errorMessage: string | null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

/**
 * Best-effort summary of a ComputerUse tool call, built from `toolCall.input`
 * (always present, backend-implementation-agnostic) plus the optional
 * `computer_use_context` / `loop_warning` envelope fields that most desktop
 * actions attach to their JSON result. Never throws on unknown shapes —
 * missing fields just fall back to `null` and are hidden in the UI.
 */
function parseComputerUseResult(toolItem: ToolCardProps['toolItem']): ParsedComputerUseResult {
  const input = (toolItem.toolCall?.input ?? {}) as Record<string, unknown>;
  let result = toolItem.toolResult?.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { result = undefined; }
  }
  if (!result || typeof result !== 'object') result = {};
  const action = firstNonEmptyString(input.action, result.action) ?? 'computer_use';

  const context = result.computer_use_context as Record<string, unknown> | undefined;
  const foreground = (context?.foreground_application ?? result.foreground_application) as
    | { name?: string | null; bundle_id?: string | null }
    | undefined;
  const appName = firstNonEmptyString(foreground?.name, foreground?.bundle_id);

  const keys = Array.isArray(input.keys)
    ? (input.keys as unknown[]).filter((k): k is string => typeof k === 'string')
    : null;
  const target = firstNonEmptyString(
    input.target_text,
    input.url,
    input.path,
    input.app_name,
    input.bundle_id,
    input.text_query,
    input.text,
    keys && keys.length > 0 ? keys.join(' + ') : null,
  );

  const loopWarning = result.loop_warning as { detected?: boolean; suggestion?: string } | undefined;

  return {
    action,
    appName,
    target,
    loopWarningSuggestion: loopWarning?.detected ? loopWarning.suggestion ?? null : null,
    errorMessage: firstNonEmptyString(toolItem.toolResult?.error, result.error),
  };
}

function isPermissionDeniedError(message: string | null): boolean {
  if (!message) return false;
  return message.includes('[PERMISSION_DENIED]')
    || /accessibility permission/i.test(message)
    || /screen capture permission/i.test(message)
    || /screen recording permission/i.test(message);
}

async function openComputerUseSettings(pane: 'accessibility' | 'screen_capture'): Promise<void> {
  await api.invoke('computer_use_open_system_settings', { request: { pane } });
}

/** Groups the ~40 ComputerUse actions into a handful of recognizable icons instead of one icon per action. */
function actionIcon(action: string): React.ReactNode {
  if (action.includes('screenshot') || action === 'describe_screen') return <Icon glyph={Camera} size="md" />;
  if (action.includes('click')) return <Icon glyph={MousePointerClick} size="md" />;
  if (action.includes('scroll') || action === 'drag' || action.includes('move') || action === 'locate') {
    return <Icon name="mouse-pointer" size="md" />;
  }
  if (action === 'key_chord' || action === 'type_text' || action === 'paste') return <Icon glyph={Keyboard} size="md" />;
  if (action === 'wait') return <Icon name="device-mac" size="md" />;
  if (
    action === 'list_apps'
    || action === 'get_app_state'
    || action === 'get_app_shortcuts'
    || action === 'list_displays'
    || action === 'focus_display'
    || action.startsWith('app_')
    || action.startsWith('interactive_')
    || action.startsWith('build_')
    || action.startsWith('visual_')
  ) {
    return <Icon name="floating-window" size="md" />;
  }
  if (action.startsWith('open_')) return <Icon name="floating-window" size="md" />;
  if (action.startsWith('clipboard_')) return <Icon glyph={Clipboard} size="md" />;
  if (action === 'run_script' || action === 'run_apple_script') return <Icon name="square-terminal" size="md" />;
  if (action === 'get_os_info') return <Icon name="device-mac" size="md" />;
  return <Icon name="device-mac" size="md" />;
}

export const ComputerUseToolCard: React.FC<ToolCardProps> = ({ toolItem, onExpand }) => {
  const { t } = useTranslation('flow-chat');
  const status = getToolCardStatus(toolItem);
  const [isExpanded, setIsExpanded] = useToolCardDisclosure('isExpanded');
  const toolId = toolItem.id ?? toolItem.toolCall?.id;
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract({
    toolId,
    toolName: toolItem.toolName,
  });

  const parsed = useMemo(() => parseComputerUseResult(toolItem), [toolItem]);
  const actionLabels: Record<string, string> = {
    click: t('toolCards.computerUse.actions.click'),
    click_element: t('toolCards.computerUse.actions.click_element'),
    mouse_move: t('toolCards.computerUse.actions.mouse_move'),
    pointer_move_rel: t('toolCards.computerUse.actions.pointer_move_rel'),
    mouse_down: t('toolCards.computerUse.actions.mouse_down'),
    mouse_up: t('toolCards.computerUse.actions.mouse_up'),
    scroll: t('toolCards.computerUse.actions.scroll'),
    drag: t('toolCards.computerUse.actions.drag'),
    key_chord: t('toolCards.computerUse.actions.key_chord'),
    type_text: t('toolCards.computerUse.actions.type_text'),
    paste: t('toolCards.computerUse.actions.paste'),
    wait: t('toolCards.computerUse.actions.wait'),
    screenshot: t('toolCards.computerUse.actions.screenshot'),
    describe_screen: t('toolCards.computerUse.actions.describe_screen'),
    locate: t('toolCards.computerUse.actions.locate'),
    move_to_target: t('toolCards.computerUse.actions.move_to_target'),
    move_to_text: t('toolCards.computerUse.actions.move_to_text'),
    list_apps: t('toolCards.computerUse.actions.list_apps'),
    get_app_state: t('toolCards.computerUse.actions.get_app_state'),
    get_app_shortcuts: t('toolCards.computerUse.actions.get_app_shortcuts'),
    list_displays: t('toolCards.computerUse.actions.list_displays'),
    focus_display: t('toolCards.computerUse.actions.focus_display'),
    app_launch: t('toolCards.computerUse.actions.app_launch'),
    app_focus: t('toolCards.computerUse.actions.app_focus'),
    app_close: t('toolCards.computerUse.actions.app_close'),
    open_url: t('toolCards.computerUse.actions.open_url'),
    open_path: t('toolCards.computerUse.actions.open_path'),
    clipboard_read: t('toolCards.computerUse.actions.clipboard_read'),
    clipboard_write: t('toolCards.computerUse.actions.clipboard_write'),
    run_script: t('toolCards.computerUse.actions.run_script'),
    run_apple_script: t('toolCards.computerUse.actions.run_apple_script'),
    get_os_info: t('toolCards.computerUse.actions.get_os_info'),
  };
  const actionLabel = actionLabels[parsed.action] ?? parsed.action;
  const errorMessage = parsed.errorMessage || t('toolCards.computerUse.actionFailed');
  const permissionDenied = status === 'error' && isPermissionDeniedError(parsed.errorMessage);
  const isExpandable = status === 'completed' || status === 'error';

  const handleOpenSettings = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const pane = parsed.errorMessage?.toLowerCase().includes('screen')
        ? 'screen_capture' as const
        : 'accessibility' as const;
      await openComputerUseSettings(pane);
    } catch (error) {
      log.error('computer_use_open_system_settings failed', { error });
      notificationService.error(t('toolCards.computerUse.openSettingsFailed'));
    }
  };

  const handleClick = () => {
    if (!isExpandable) return;
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded, { onExpand });
  };

  const subject = [...new Set([parsed.target, parsed.appName].filter(Boolean))].join(' · ');

  const renderExpandedContent = () => {
    if (status === 'error') {
      return (
        <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="content" className="compact-result-content computer-use-tool-card__content">
          {permissionDenied ? (
            <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="permissionDenied" className="computer-use-tool-card__permission-denied">
              <p>{t('toolCards.computerUse.permissionDeniedHint')}</p>
              <Button
                type="button"
                variant="primary"
                size="sm"
                leadingIcon={<Icon name="gear" size="xs" />}
                className="computer-use-tool-card__settings-button"
                onClick={(event) => void handleOpenSettings(event)}
              >
                {t('toolCards.computerUse.openSettings')}
              </Button>
            </div>
          ) : (
            <pre>{errorMessage}</pre>
          )}
        </div>
      );
    }

    return (
      <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="expanded" className="computer-use-tool-card__expanded">
        <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="row" className="computer-use-tool-card__row">
          <span className="computer-use-tool-card__row-label">{t('toolCards.computerUse.actionLabel')}</span>
          <code>{parsed.action}</code>
        </div>
        {parsed.appName && (
          <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="row" className="computer-use-tool-card__row">
            <span className="computer-use-tool-card__row-label">{t('toolCards.computerUse.appLabel')}</span>
            <span>{parsed.appName}</span>
          </div>
        )}
        {parsed.target && (
          <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="row" className="computer-use-tool-card__row">
            <span className="computer-use-tool-card__row-label">{t('toolCards.computerUse.targetLabel')}</span>
            <span>{parsed.target}</span>
          </div>
        )}
        {parsed.loopWarningSuggestion && (
          <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="loopWarning" className="computer-use-tool-card__loop-warning">
            <Icon glyph={AlertTriangle} size="xs" />
            <span>{parsed.loopWarningSuggestion}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div data-openbitfun-component="computer-use-tool-card" data-openbitfun-part="root" data-openbitfun-state={[isExpanded && 'expanded', status === 'error' && 'failed'].filter(Boolean).join(' ')} ref={cardRootRef} data-tool-card-id={toolId ?? ''}>
      <AmbientToolCard
        status={status}
        isExpanded={isExpanded}
        onClick={isExpandable ? handleClick : undefined}
        className="computer-use-tool-card"
        header={(
          <AmbientToolCardHeader
            icon={(
              <ToolCardStatusSlot
                status={status}
                toolIcon={actionIcon(parsed.action)}
              />
            )}
            action={actionLabel}
            content={subject}
            statusDescription={getToolCardStatusDescription(status, t, permissionDenied
              ? t('toolCards.computerUse.permissionDenied') : errorMessage)}
          />
        )}
        expandedContent={isExpandable ? renderExpandedContent() : undefined}
      />
    </div>
  );
};

import React from 'react';
import { OverflowText, Icon, ScrollArea } from '@openbitfun/ui';
import { FolderOpen } from 'lucide-react';
import type { MiniAppBubbleCustomization } from '@/app/scenes/miniapps/miniAppStore';
import { renderMiniAppIcon } from '@/app/scenes/miniapps/utils/miniAppIcons';
import { useChatInputState } from '@/flow_chat/store/chatInputStateStore';
import { computeFlowChatInputStackFooterPx } from '@/flow_chat/utils/flowChatScrollLayout';

interface MiniAppBubbleWelcomeProps {
  appName: string;
  appDescription?: string;
  appIcon?: string;
  showIcon?: boolean;
  customization?: MiniAppBubbleCustomization;
  workspacePath?: string;
  onSuggestion: (prompt: string) => void;
}

/** Keep aligned with the block padding on `.openbitfun-fmc__miniapp-welcome-content`. */
const WELCOME_CONTENT_BLOCK_PADDING_PX = 36;

/**
 * Host-rendered empty state for an Agentic MiniApp session. MiniApps provide a
 * bounded declarative model through app.chat.claimComposer; they never inject
 * markup into the shared conversation surface.
 */
export const MiniAppBubbleWelcome: React.FC<MiniAppBubbleWelcomeProps> = ({
  appName,
  appDescription,
  appIcon = 'Box',
  showIcon = true,
  customization,
  workspacePath,
  onSuggestion,
}) => {
  const welcome = customization?.welcome;
  const title = welcome?.title || appName;
  const description = welcome?.description || appDescription;
  const workspaceLabel = welcome?.workspaceLabel || (workspacePath ? appName : '');
  const suggestions = welcome?.suggestions || [];
  const inputHeight = useChatInputState(state => state.inputHeight);
  const inputClearance = computeFlowChatInputStackFooterPx(inputHeight);

  return (
    <ScrollArea className="openbitfun-fmc__miniapp-welcome" data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="root">
      <div
        className="openbitfun-fmc__miniapp-welcome-content"
        style={{
          paddingBottom: `${WELCOME_CONTENT_BLOCK_PADDING_PX + inputClearance}px`,
        }}
      >
        {showIcon && <div
          className="openbitfun-fmc__miniapp-welcome-icon"
          data-openbitfun-component="miniapp-bubble-welcome"
          data-openbitfun-part="icon"
          aria-hidden="true"
        >
          {renderMiniAppIcon(appIcon, 28)}
        </div>}

        {title !== appName && (
          <div className="openbitfun-fmc__miniapp-welcome-eyebrow" data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="eyebrow">{appName}</div>
        )}
        <h2 data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="title">{title}</h2>
        {description && <p className="openbitfun-fmc__miniapp-welcome-description" data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="description">{description}</p>}

        {workspaceLabel && workspacePath && (
          <div
            className="openbitfun-fmc__miniapp-workspace"
            data-openbitfun-component="miniapp-bubble-welcome"
            data-openbitfun-part="workspace"
            title={workspacePath}
            data-workspace-path={workspacePath}
          >
            <FolderOpen size={13} aria-hidden="true" />
            <OverflowText>{workspaceLabel}</OverflowText>
          </div>
        )}

        {suggestions.length > 0 && (
          <div className="openbitfun-fmc__miniapp-suggestions" data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="suggestions">
            {welcome?.suggestionsLabel && (
              <div className="openbitfun-fmc__miniapp-suggestions-label" data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="suggestionsLabel">
                {welcome.suggestionsLabel}
              </div>
            )}
            <div className="openbitfun-fmc__miniapp-suggestions-list" data-openbitfun-component="miniapp-bubble-welcome" data-openbitfun-part="suggestionsList">
              {suggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.label}:${index}`}
                  type="button"
                  className="openbitfun-fmc__miniapp-suggestion"
                  data-openbitfun-component="miniapp-bubble-welcome"
                  data-openbitfun-part="suggestion"
                  title={suggestion.prompt}
                  onClick={() => onSuggestion(suggestion.prompt)}
                >
                  <span>{suggestion.label}</span>
                  <Icon name="arrow-up-right" size="xs" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
};

export default MiniAppBubbleWelcome;

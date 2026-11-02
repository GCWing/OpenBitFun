import { resolveAssistantName } from '@/shared/utils/assistantName';
import React from 'react';
import { EyeOff } from 'lucide-react';
import {
  Card,
  CardFooter,
  CardHeader,
  Icon,
  IconButton,
  OverflowText,
  StatusPill,
  Tooltip,
} from '@openbitfun/ui';

import { useTranslation } from 'react-i18next';

import { AssistantAvatar } from '@/app/components/AssistantAvatar';
import type { WorkspaceInfo } from '@/shared/types';

interface AssistantCardProps {
  workspace: WorkspaceInfo;
  onClick: () => void;
  onOpen?: () => void;
  isOpening?: boolean;
  onClose?: () => void;
  isClosing?: boolean;
  closeDisabledReason?: string;
  onDelete?: () => void;
  onSetPrimary?: () => void;
  isPrimary?: boolean;
  isDeleting?: boolean;
  isSettingPrimary?: boolean;
  style?: React.CSSProperties;
}

const AssistantCard: React.FC<AssistantCardProps> = ({
  workspace,
  onClick,
  onOpen,
  isOpening = false,
  onClose,
  isClosing = false,
  closeDisabledReason,
  onDelete,
  onSetPrimary,
  isPrimary,
  isDeleting = false,
  isSettingPrimary = false,
  style,
}) => {
  const { t } = useTranslation('scenes/profile');
  const identity = workspace.identity;

  const name = resolveAssistantName(workspace, t('shared:agents.Claw'));
  const avatar = identity?.avatar?.trim() ?? '';
  const emoji = identity?.emoji?.trim() ?? '';
  const creature = identity?.creature?.trim() || '';
  const vibe = identity?.vibe?.trim() || '';
  const isBusy = isDeleting || isSettingPrimary || isOpening || isClosing;
  const hasActions = Boolean(onOpen || onClose || onSetPrimary || onDelete);
  const isOpened = Boolean(onClose);
  const visibilityAction = onClose ?? onOpen;
  const visibilityLabel = t(isOpened ? 'nursery.card.close' : 'nursery.card.open');

  return (
    <article
      data-openbitfun-component="assistant-card"
      data-openbitfun-part="root"
      data-openbitfun-primary={isPrimary ? 'true' : 'false'}
      data-openbitfun-state={isBusy ? 'busy' : undefined}
      className={['assistant-card', (isDeleting || isSettingPrimary) && 'assistant-card--busy'].filter(Boolean).join(' ')}
      role="listitem"
      style={style}
    >
      <Card
        className="assistant-card__surface"
        appearance="subtle"
        radius="md"
        padding="md"
        gap="sm"
        clip
        data-overflow-trigger
      >
        <button
          data-openbitfun-component="assistant-card"
          data-openbitfun-part="main"
          type="button"
          className="assistant-card__main"
          onClick={onClick}
          aria-label={`${t('nursery.card.configure')}: ${name}`}
          disabled={isDeleting || isSettingPrimary || isOpening || isClosing}
        />

        <CardHeader
          align="center"
          contentAlign={isPrimary ? 'center' : 'start'}
          className="assistant-card__header"
          data-openbitfun-component="assistant-card"
          data-openbitfun-part="header"
          leading={(
            <span className="assistant-card__avatar" data-openbitfun-component="assistant-card" data-openbitfun-part="avatar">
              <AssistantAvatar
                presetId={avatar}
                emoji={emoji}
                stableKey={workspace.assistantId || workspace.id}
                name={name}
                size={isPrimary ? 80 : 44}
              />
            </span>
          )}
          title={(
            <span className="assistant-card__title-row" data-openbitfun-component="assistant-card" data-openbitfun-part="title">
              <OverflowText className="assistant-card__name" data-openbitfun-component="assistant-card" data-openbitfun-part="name">{name}</OverflowText>
              {isPrimary && (
                <span className="assistant-card__primary-badge" data-openbitfun-component="assistant-card" data-openbitfun-part="primaryBadge">
                  <StatusPill tone="neutral">{t('nursery.card.primaryBadge')}</StatusPill>
                </span>
              )}
            </span>
          )}
          description={(
            <span className="assistant-card__metadata" data-openbitfun-component="assistant-card" data-openbitfun-part="metadata">
              {vibe ? (
                <OverflowText className="assistant-card__vibe" data-openbitfun-component="assistant-card" data-openbitfun-part="vibe">{vibe}</OverflowText>
              ) : (
                <OverflowText lines={1} className="assistant-card__vibe assistant-card__vibe--empty" data-openbitfun-component="assistant-card" data-openbitfun-part="vibe">
                  {t('nursery.card.noVibe')}
                </OverflowText>
              )}
              {creature ? (
                <>
                  <span className="assistant-card__metadata-separator" aria-hidden="true">·</span>
                  <OverflowText className="assistant-card__creature" data-openbitfun-component="assistant-card" data-openbitfun-part="creature">
                    {creature}
                  </OverflowText>
                </>
              ) : null}
            </span>
          )}
        />

        {hasActions ? (
          <CardFooter align="end" className="assistant-card__footer" data-openbitfun-component="assistant-card" data-openbitfun-part="footer">
            <span className="assistant-card__workspace-actions">
              {visibilityAction ? (
                <Tooltip content={isOpened && closeDisabledReason ? closeDisabledReason : visibilityLabel}>
                  <IconButton
                    data-openbitfun-component="assistant-card"
                    data-openbitfun-part="visibility"
                    size="sm"
                    aria-label={visibilityLabel}
                    aria-pressed={isOpened}
                    loading={isOpening || isClosing}
                    disabled={isBusy || (isOpened && Boolean(closeDisabledReason))}
                    onClick={visibilityAction}
                    icon={isOpened ? <Icon name="eye" size="sm" /> : <Icon glyph={EyeOff} size="sm" />}
                  />
                </Tooltip>
              ) : null}

              <span className="assistant-card__footer-actions">
                {onSetPrimary ? (
                  <Tooltip content={t('nursery.card.setPrimary')}>
                    <IconButton
                      data-openbitfun-component="assistant-card"
                      data-openbitfun-part="setPrimary"
                      size="sm"
                      onClick={onSetPrimary}
                      aria-label={t('nursery.card.setPrimary')}
                      loading={isSettingPrimary}
                      disabled={isBusy}
                      icon={<Icon name="pin" size="sm" aria-hidden="true" />}
                    />
                  </Tooltip>
                ) : null}

                {onDelete ? (
                  <Tooltip content={t('nursery.card.delete')}>
                    <IconButton
                      data-openbitfun-component="assistant-card"
                      data-openbitfun-part="delete"
                      tone="danger"
                      size="sm"
                      onClick={onDelete}
                      aria-label={t('nursery.card.delete')}
                      loading={isDeleting}
                      disabled={isBusy}
                      icon={<Icon name="delete" size="sm" aria-hidden="true" />}
                    />
                  </Tooltip>
                ) : null}
              </span>
            </span>
          </CardFooter>
        ) : null}
      </Card>
    </article>
  );
};

export default AssistantCard;

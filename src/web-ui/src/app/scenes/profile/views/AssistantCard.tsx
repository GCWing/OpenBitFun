import React from 'react';
import {
  Button,
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
  onNewSession?: () => void;
  onOpen?: () => void;
  isOpening?: boolean;
  onClose?: () => void;
  isClosing?: boolean;
  closeDisabledReason?: string;
  onDelete?: () => void;
  onSetPrimary?: () => void;
  isPrimary?: boolean;
  isDeleting?: boolean;
  isStartingSession?: boolean;
  isSettingPrimary?: boolean;
  style?: React.CSSProperties;
}

const AssistantCard: React.FC<AssistantCardProps> = ({
  workspace,
  onClick,
  onNewSession,
  onOpen,
  isOpening = false,
  onClose,
  isClosing = false,
  closeDisabledReason,
  onDelete,
  onSetPrimary,
  isPrimary,
  isDeleting = false,
  isStartingSession = false,
  isSettingPrimary = false,
  style,
}) => {
  const { t } = useTranslation('scenes/profile');
  const identity = workspace.identity;

  const name = identity?.name?.trim() || workspace.name || t('nursery.card.unnamed');
  const avatar = identity?.avatar?.trim() ?? '';
  const emoji = identity?.emoji?.trim() ?? '';
  const creature = identity?.creature?.trim() || '';
  const vibe = identity?.vibe?.trim() || '';
  const isBusy = isDeleting || isStartingSession || isSettingPrimary || isOpening || isClosing;
  const hasActions = Boolean(onOpen || onClose || onNewSession || onSetPrimary || onDelete);

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
                size={44}
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
          actions={(
            <Icon
              name="chevron-right"
              size="sm"
              data-openbitfun-component="assistant-card"
              data-openbitfun-part="chevron"
              className="assistant-card__chevron"
              aria-hidden="true"
            />
          )}
        />

        {hasActions ? (
          <CardFooter align="end" className="assistant-card__footer" data-openbitfun-component="assistant-card" data-openbitfun-part="footer">
            <span className="assistant-card__session-actions">
              {onOpen ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={isOpening}
                  disabled={isBusy}
                  onClick={onOpen}
                >
                  {t('nursery.card.open')}
                </Button>
              ) : null}
              {onNewSession ? (
                <Button
                  variant="primary"
                  size="sm"
                  leadingIcon={<Icon name="side-chat" size="sm" />}
                  loading={isStartingSession}
                  onClick={onNewSession}
                  disabled={isBusy}
                >
                  {t(isStartingSession ? 'nursery.card.startingSession' : 'nursery.card.newSession')}
                </Button>
              ) : null}

              {onClose ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={isClosing}
                  disabled={isBusy || Boolean(closeDisabledReason)}
                  title={closeDisabledReason}
                  onClick={onClose}
                >
                  {t('nursery.card.close')}
                </Button>
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

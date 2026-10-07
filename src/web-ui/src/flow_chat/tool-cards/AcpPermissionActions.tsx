import React, { useMemo } from 'react';
import { Button, IconButton, Tooltip, Icon } from '@openbitfun/ui';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { FlowToolItem, ToolRejectOptions } from '../types/flow-chat';
import type { AcpPermissionOption } from '@/infrastructure/api/service-api/ACPClientAPI';
import './AcpPermissionActions.scss';

const KIND_ORDER: Record<AcpPermissionOption['kind'], number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

interface AcpPermissionActionsProps {
  toolItem: FlowToolItem;
  disabled?: boolean;
  presentation?: 'icon' | 'text';
  className?: string;
  onConfirm?: (permissionOptionId?: string, approve?: boolean) => void;
  onReject?: (options?: ToolRejectOptions) => void;
}

function isApprovalKind(kind: AcpPermissionOption['kind']): boolean {
  return kind === 'allow_once' || kind === 'allow_always';
}

function fallbackLabel(kind: AcpPermissionOption['kind'], t: TFunction<'flow-chat'>): string {
  switch (kind) {
    case 'allow_once':
      return t('toolCards.acpPermission.allowOnce');
    case 'allow_always':
      return t('toolCards.acpPermission.allowAlways');
    case 'reject_once':
      return t('toolCards.acpPermission.reject');
    case 'reject_always':
      return t('toolCards.acpPermission.rejectAlways');
    default:
      return t('toolCards.acpPermission.selectOption');
  }
}

function optionIcon(kind: AcpPermissionOption['kind']): React.ReactNode {
  switch (kind) {
    case 'allow_once':
      return <Icon name="check-line" size="xs" />;
    case 'allow_always':
      return <Icon glyph={ShieldCheck} size="xs" />;
    case 'reject_always':
      return <Icon glyph={ShieldX} size="xs" />;
    case 'reject_once':
    default:
      return <Icon name="xmark" size="xs" />;
  }
}

export const AcpPermissionActions: React.FC<AcpPermissionActionsProps> = ({
  toolItem,
  disabled = false,
  presentation = 'icon',
  className = '',
  onConfirm,
  onReject,
}) => {
  const { t } = useTranslation('flow-chat');
  const options = useMemo(() => {
    return [...(toolItem.acpPermission?.options ?? [])].sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
    );
  }, [toolItem.acpPermission?.options]);

  if (options.length === 0) {
    return null;
  }

  return (
    <span data-openbitfun-component="acp-permission-actions" data-openbitfun-part="root" data-openbitfun-presentation={presentation} className={`acp-permission-actions acp-permission-actions--${presentation} ${className}`}>
      {options.map((option) => {
        const approve = isApprovalKind(option.kind);
        const label = fallbackLabel(option.kind, t);
        const tooltip = option.name && option.name !== label ? `${label}: ${option.name}` : label;
        const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          event.stopPropagation();

          if (approve) {
            onConfirm?.(option.optionId, true);
          } else {
            onReject?.({ permissionOptionId: option.optionId });
          }
        };

        if (presentation === 'text') {
          return (
            <Button
              key={option.optionId}
              type="button"
              variant={approve ? 'primary' : 'fill'}
              size="sm"
              leadingIcon={optionIcon(option.kind)}
              data-openbitfun-decision={approve ? 'allow' : 'reject'}
              onClick={handleClick}
              disabled={disabled}
              title={tooltip}
              aria-label={tooltip}
            >
              {label}
            </Button>
          );
        }

        return (
          <Tooltip key={option.optionId} content={tooltip}>
            <IconButton
              data-openbitfun-component="acp-permission-actions"
              data-openbitfun-part="action"
              data-openbitfun-decision={approve ? 'allow' : 'reject'}
              className={`tool-card-header-action acp-permission-actions__icon-button acp-permission-actions__icon-button--${option.kind}`}
              variant={approve ? 'primary' : 'fill'}
              tone={approve ? 'neutral' : 'danger'}
              size="xs"
              onClick={handleClick}
              disabled={disabled}
              icon={optionIcon(option.kind)}
              aria-label={tooltip}
            />
          </Tooltip>
        );
      })}
    </span>
  );
};

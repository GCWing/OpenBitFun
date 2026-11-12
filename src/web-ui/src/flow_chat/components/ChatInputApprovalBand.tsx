/**
 * The compact surface for answering a runtime permission request.
 *
 * This used to be a card floating over the transcript, positioned by measuring
 * the composer's height. It covered the very output the reader needed in order
 * to decide, and it carried its own textarea for the rejection reason while a
 * perfectly good one sat directly underneath it. So the band lives in the
 * composer stack instead: the request reads directly above the text field that
 * answers it, and the reason is whatever the reader has typed there. Embedded
 * child-session panels also reuse the band because they have no composer of
 * their own; those surfaces intentionally omit the optional typed reason.
 */

import React, { useId, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  CardFooter,
  CardHeader,
  Icon,
  IconButton,
  NumberBadge,
  OverflowText,
  ScrollArea,
  SegmentedControl,
  Stack,
  Tooltip,
} from '@openbitfun/ui';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  PermissionReplyKind,
  PermissionRequest,
} from '@/infrastructure/api/service-api/AgentAPI';
import { useCopyTextAction } from '../hooks/useCopyTextAction';
import { CopyableTextPreview } from './CopyableTextPreview';
import type { PermissionAnswerHooks } from './modern/usePermissionRequests';
import './ChatInputApprovalBand.scss';

export interface ChatInputApprovalBandProps {
  /** Requests of one round, the first of which is the one being answered. */
  requests: PermissionRequest[];
  /** Pending requests across the session, including later rounds. */
  totalPendingCount?: number;
  /**
   * The composer's current text. A non-empty composer is offered as the
   * rejection reason rather than being treated as one silently.
   */
  rejectReason?: string;
  /** Clears the composer once its text has been spent as a reason. */
  onRejectReasonConsumed?: () => void;
  onRespond: (
    requestId: string,
    reply: PermissionReplyKind,
    feedback?: string,
    hooks?: PermissionAnswerHooks,
  ) => Promise<void>;
  onRespondBatch: (
    requestId: string,
    reply: PermissionReplyKind,
    feedback?: string,
    hooks?: PermissionAnswerHooks,
  ) => Promise<void>;
}

const PERMISSION_ACTION_LABEL_KEYS: Record<string, string> = {
  read: 'permission.actions.read',
  edit: 'permission.actions.edit',
  bash: 'permission.actions.bash',
  git: 'permission.actions.git',
  computer_use: 'permission.actions.computerUse',
  websearch: 'permission.actions.webSearch',
  webfetch: 'permission.actions.webFetch',
  mcp: 'permission.actions.mcp',
  task: 'permission.actions.task',
  skill: 'permission.actions.skill',
  page_publish: 'permission.actions.pagePublish',
  page_deploy: 'permission.actions.pageDeploy',
  custom_tool: 'permission.actions.customTool',
  external_directory: 'permission.actions.externalDirectory',
};

const PAGE_VISIBILITY_LABEL_KEYS: Record<string, string> = {
  private: 'permission.visibility.private',
  relay: 'permission.visibility.relay',
  public: 'permission.visibility.public',
};

function permissionActionLabel(action: string, t: (key: string) => string): string {
  return t(PERMISSION_ACTION_LABEL_KEYS[action] ?? 'permission.actions.other');
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * What the reader stands to lose by allowing. Page operations describe
 * themselves precisely; everything else carries whatever the tool declared.
 */
function permissionRisk(
  request: PermissionRequest | undefined,
  t: (key: string, values?: Record<string, string>) => string,
): string | undefined {
  if (!request) return undefined;
  const metadata = request.displayMetadata;
  const operation = metadataString(metadata, 'pageOperation');
  const slug = metadataString(metadata, 'pageSlug');
  if (operation && slug) {
    if (operation === 'deploy') {
      return t('permission.risks.pageDeploy', {
        slug,
        version: metadataString(metadata, 'pageVersion') ?? '',
      });
    }
    const visibility = metadataString(metadata, 'pageVisibility') ?? 'private';
    const translatedVisibility = t(
      PAGE_VISIBILITY_LABEL_KEYS[visibility] ?? PAGE_VISIBILITY_LABEL_KEYS.private,
    );
    return t(
      operation === 'publish' ? 'permission.risks.pagePublish' : 'permission.risks.pageSave',
      { slug, visibility: translatedVisibility },
    );
  }
  return [metadata?.riskDescription, metadata?.risk].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

type ApprovalScope = 'this' | 'all';
type ApprovalAnswer = PermissionReplyKind | 'rejectWithReason';

export const ChatInputApprovalBand: React.FC<ChatInputApprovalBandProps> = ({
  requests,
  totalPendingCount,
  rejectReason = '',
  onRejectReasonConsumed,
  onRespond,
  onRespondBatch,
}) => {
  const { t } = useTranslation('flow-chat');
  const grantDescriptionId = useId();
  const [scope, setScope] = useState<ApprovalScope>('this');
  const [pendingAnswer, setPendingAnswer] = useState<ApprovalAnswer | null>(null);
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const responding = pendingAnswer !== null;

  const request = requests[0];
  const pendingCount = Math.max(totalPendingCount ?? requests.length, requests.length);
  // Answering "and everything after this" only means something when there is
  // something after it, either in this round or a later one.
  const canAnswerAll = pendingCount > 1;
  const effectiveScope: ApprovalScope = canAnswerAll ? scope : 'this';
  const reason = rejectReason.trim();
  const resourceSummary = request?.resources.join('\n') ?? '';
  const { copied, copy } = useCopyTextAction({
    getText: () => resourceSummary,
    successMessage: t('toolCards.common.copied'),
    failureMessage: t('toolCards.common.copyFailed'),
    showSuccessNotification: false,
  });
  const copyLabel = copied ? t('toolCards.common.copied') : t('toolCards.common.copy');

  if (!request) return null;

  const risk = permissionRisk(request, t);
  // Built-in tool names repeat the action. External identities and delegated
  // owners provide additional context that the action label cannot express.
  const showSourceIdentity = request.source.kind !== 'tool_call'
    || request.action === 'mcp'
    || request.action === 'custom_tool'
    || !PERMISSION_ACTION_LABEL_KEYS[request.action];
  const ownerLabel = request.delegation
    ? t('permission.subagentOwner', { subagent: request.delegation.subagentType })
    : showSourceIdentity ? request.source.identity : undefined;
  const saveResources = request.saveResources ?? [];
  const isExactCommandGrant = request.action === 'bash'
    && request.resources.length === 1
    && saveResources.length === 1
    && saveResources[0] === request.resources[0];
  const alwaysAllowLabel = isExactCommandGrant
    ? t('permission.allowAlwaysCommand')
    : t('permission.allowAlways');
  const savedResourceSummary = saveResources.join('\n');
  const alwaysAllowTooltip = saveResources.length
    ? request.projectPath?.trim()
      ? t('permission.allowAlwaysTooltip', {
        projectPath: request.projectPath.trim(),
        resources: savedResourceSummary,
      })
      : t('permission.allowAlwaysTooltipCurrentProject', { resources: savedResourceSummary })
    : t('permission.allowAlwaysTooltipNoGrant');

  const answer = async (reply: PermissionReplyKind, withReason: boolean) => {
    setPendingAnswer(withReason ? 'rejectWithReason' : reply);
    setError(false);
    const feedback = reply === 'reject' && withReason && reason ? reason : undefined;
    const hooks: PermissionAnswerHooks = { onConfirming: () => setConfirming(true) };
    try {
      // 'always' is deliberately never batched: see the button's comment.
      if (effectiveScope === 'all' && reply !== 'always') {
        await onRespondBatch(request.requestId, reply, feedback, hooks);
      } else {
        await onRespond(request.requestId, reply, feedback, hooks);
      }
      if (feedback) {
        onRejectReasonConsumed?.();
      }
    } catch {
      setError(true);
    } finally {
      setPendingAnswer(null);
      setConfirming(false);
    }
  };

  const answersAll = effectiveScope === 'all';
  const allowLabel = answersAll
    ? t('permission.allowCurrentAndFollowing')
    : t('permission.allowOnce');
  const rejectLabel = answersAll
    ? t('permission.rejectCurrentAndFollowing')
    : t('permission.reject');

  return (
    <div
      data-openbitfun-component="permission-request-panel"
      data-openbitfun-part="root"
      data-openbitfun-state={[responding && 'responding', error && 'error'].filter(Boolean).join(' ')}
      className="openbitfun-chat-input-approval"
      role="group"
      aria-label={t('permission.title')}
      aria-busy={responding || undefined}
      data-testid="chat-input-approval-band"
      data-approval-scope={effectiveScope}
    >
      <Card
        appearance="raised"
        padding="sm"
        gap="sm"
        className="openbitfun-chat-input-approval__surface"
      >
        <div
          data-openbitfun-component="permission-request-panel"
          data-openbitfun-part="request"
        >
          <CardHeader
            align="center"
            leading={<Icon glyph={ShieldAlert} size="sm" tone="warning" />}
            title={
              <Stack direction="horizontal" align="center" gap="2">
                <span className="openbitfun-chat-input-approval__title">
                  {permissionActionLabel(request.action, t)}
                </span>
                {ownerLabel ? (
                  <OverflowText className="openbitfun-chat-input-approval__owner">
                    {ownerLabel}
                  </OverflowText>
                ) : null}
              </Stack>
            }
            actions={canAnswerAll ? (
              <Tooltip content={t('permission.batchCount', { count: pendingCount })} placement="top">
                <NumberBadge
                  value={`+${pendingCount - 1}`}
                  aria-label={t('permission.batchCount', { count: pendingCount })}
                  data-testid="chat-input-approval-pending-count"
                />
              </Tooltip>
            ) : undefined}
          />
        </div>

        <Card appearance="neutral" padding="sm" radius="sm">
          <Stack direction="horizontal" align="center" gap="2">
            <ScrollArea className="openbitfun-chat-input-approval__resource" tabIndex={0}>
              <CopyableTextPreview as="code" multiline text={resourceSummary} emptyText="" />
            </ScrollArea>
            {resourceSummary.trim() ? (
              <Tooltip content={copyLabel} placement="top">
                <IconButton
                  aria-label={copyLabel}
                  data-testid="chat-input-approval-copy"
                  variant="quiet"
                  size="xs"
                  icon={
                    <Icon
                      name={copied ? 'check-line' : 'duplicate'}
                      size="xs"
                      tone={copied ? 'success' : 'inherit'}
                    />
                  }
                  onClick={copy}
                />
              </Tooltip>
            ) : null}
          </Stack>
        </Card>

        {/* Keep the risk visible while a failed response is retried. */}
        {risk ? (
          <div
            data-openbitfun-component="permission-request-panel"
            data-openbitfun-part="risk"
            className="openbitfun-chat-input-approval__note"
          >
            <Alert tone="warning" message={risk} />
          </div>
        ) : null}
        {confirming ? (
          <div
            data-openbitfun-component="permission-request-panel"
            data-openbitfun-part="confirming"
            className="openbitfun-chat-input-approval__note"
            role="status"
          >
            <Alert tone="info" message={t('permission.responseConfirming')} />
          </div>
        ) : null}
        {error ? (
          <div
            data-openbitfun-component="permission-request-panel"
            data-openbitfun-part="error"
            className="openbitfun-chat-input-approval__note"
          >
            <Alert tone="error" message={t('permission.responseFailed')} />
          </div>
        ) : null}

        {isExactCommandGrant && !answersAll ? (
          <p
            id={grantDescriptionId}
            data-openbitfun-component="permission-request-panel"
            data-openbitfun-part="grantScope"
            className="openbitfun-chat-input-approval__grant-note"
          >
            {t('permission.allowAlwaysCommandDescription')}
          </p>
        ) : null}

        <div
          data-openbitfun-component="permission-request-panel"
          data-openbitfun-part="actions"
        >
          <CardFooter align="between" className="openbitfun-chat-input-approval__actions">
            {canAnswerAll ? (
              <div
                data-openbitfun-component="permission-request-panel"
                data-openbitfun-part="scope"
              >
                <SegmentedControl
                  aria-label={t('permission.scopeLabel')}
                  data-testid="chat-input-approval-scope"
                  size="sm"
                  tone="neutral"
                  value={effectiveScope}
                  disabled={responding}
                  options={[
                    { value: 'this', label: t('permission.scopeThis') },
                    { value: 'all', label: t('permission.scopeAll') },
                  ]}
                  onValueChange={value => setScope(value === 'all' ? 'all' : 'this')}
                />
              </div>
            ) : null}

            <div className="openbitfun-chat-input-approval__buttons">
              {/* Rejecting is the safe answer, so it leads. */}
              <Button
                variant="fill"
                size="sm"
                leadingIcon={<Icon name="xmark" size="sm" />}
                disabled={responding}
                loading={pendingAnswer === 'reject'}
                data-testid="chat-input-approval-reject"
                onClick={() => void answer('reject', false)}
              >
                {rejectLabel}
              </Button>
              {/* A draft becomes a reason only through this explicit action. */}
              {reason ? (
                <Tooltip content={t('permission.rejectWithReasonTooltip')} placement="top">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={responding}
                    loading={pendingAnswer === 'rejectWithReason'}
                    data-testid="chat-input-approval-reject-with-reason"
                    onClick={() => void answer('reject', true)}
                  >
                    {t('permission.rejectWithReason')}
                  </Button>
                </Tooltip>
              ) : null}
              {/* Saved grants apply only to the request the reader has seen. */}
              {saveResources.length > 0 && !answersAll ? (
                <Tooltip content={alwaysAllowTooltip} placement="top">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={responding}
                    loading={pendingAnswer === 'always'}
                    aria-describedby={isExactCommandGrant ? grantDescriptionId : undefined}
                    data-testid="chat-input-approval-allow-always"
                    onClick={() => void answer('always', false)}
                  >
                    {alwaysAllowLabel}
                  </Button>
                </Tooltip>
              ) : null}
              <Button
                variant="primary"
                size="sm"
                leadingIcon={<Icon name="check-line" size="sm" />}
                disabled={responding}
                loading={pendingAnswer === 'once'}
                data-testid="chat-input-approval-allow"
                onClick={() => void answer('once', false)}
              >
                {allowLabel}
              </Button>
            </div>
          </CardFooter>
        </div>
      </Card>
    </div>
  );
};

ChatInputApprovalBand.displayName = 'ChatInputApprovalBand';

import {
  Button,
  Icon,
  ScrollArea,
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogHeading,
  DialogTitle,
} from '@openbitfun/ui';
import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { useWorkspaceContext } from '../../../infrastructure/contexts/WorkspaceContext';
import { WorkspaceInfo, WorkspaceKind } from '../../../shared/types';
import { WorkspaceIcon } from '@/app/components/WorkspaceIcon/WorkspaceIcon';
import { AssistantAvatar } from '@/app/components/AssistantAvatar';
import { i18nService, useI18n } from '@/infrastructure/i18n';
import { createLogger } from '@/shared/utils/logger';
import { getRecentWorkspaceLineParts } from '@/shared/utils/recentWorkspaceDisplay';
import './WorkspaceManager.css';

const log = createLogger('WorkspaceManager');

interface WorkspaceManagerProps {
  isVisible: boolean;
  onClose: () => void;
  onWorkspaceSelect?: (workspace: WorkspaceInfo) => void;
}

/**
 * Workspace management component.
 * Displays current workspace status and recent workspaces.
 */
const WorkspaceManager: React.FC<WorkspaceManagerProps> = ({
  isVisible,
  onClose,
  onWorkspaceSelect
}) => {
  const { t } = useI18n('common');
  const {
    currentWorkspace,
    recentWorkspaces,
    assistantWorkspacesList,
    loading,
    error,
    switchWorkspace,
    closeWorkspace,
    scanWorkspaceInfo
  } = useWorkspaceContext();

  const [scanning, setScanning] = useState(false);

  const getWorkspaceDisplayName = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceKind === WorkspaceKind.Assistant) return workspace.name;
    const emoji = workspace.identity?.emoji?.trim();
    return emoji ? `${emoji} ${workspace.name}` : workspace.name;
  };

  const renderIdentityDetails = (workspace: WorkspaceInfo) => {
    const entries = [
      workspace.identity?.creature ? { label: 'Creature', value: workspace.identity.creature } : null,
      workspace.identity?.vibe ? { label: 'Vibe', value: workspace.identity.vibe } : null,
    ].filter(Boolean) as Array<{ label: string; value: string }>;

    if (entries.length === 0) {
      return null;
    }

    return (
      <div className="workspace-identity">
        {entries.map(entry => (
          <span key={entry.label} className="workspace-identity__item">
            <span className="workspace-identity__label">{entry.label}</span>
            <span className="workspace-identity__value">{entry.value}</span>
          </span>
        ))}
      </div>
    );
  };

  const renderRelatedPaths = (workspace: WorkspaceInfo) => {
    const relatedPaths = workspace.relatedPaths ?? [];
    if (relatedPaths.length === 0) {
      return null;
    }

    return (
      <div className="workspace-related-paths">
        <span className="workspace-related-paths__label">
          {t('nav.workspaces.relatedPaths.dialog.title')}
        </span>
        <div className="workspace-related-paths__list">
          {relatedPaths.slice(0, 3).map(path => (
            <div key={path.path} className="workspace-related-paths__item">
              <span className="workspace-related-paths__path">{path.path}</span>
              {path.description?.trim() ? (
                <span className="workspace-related-paths__desc">{path.description}</span>
              ) : null}
            </div>
          ))}
          {relatedPaths.length > 3 ? (
            <div className="workspace-related-paths__more">
              +{relatedPaths.length - 3}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const handleWorkspaceSelect = async (workspace: WorkspaceInfo) => {
    try {
      await switchWorkspace(workspace);
      onWorkspaceSelect?.(workspace);
      onClose();
    } catch (err) {
      log.error('Failed to switch workspace', { workspaceId: workspace.id, error: err });
    }
  };

  const handleWorkspaceCardKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    workspace: WorkspaceInfo
  ) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void handleWorkspaceSelect(workspace);
  };

  const handleCloseWorkspace = async () => {
    try {
      await closeWorkspace();
    } catch (err) {
      log.error('Failed to close workspace', err);
    }
  };

  const handleScanWorkspace = async () => {
    try {
      setScanning(true);
      await scanWorkspaceInfo();
    } catch (err) {
      log.error('Failed to scan workspace', err);
    } finally {
      setScanning(false);
    }
  };

  const getWorkspaceIcon = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceKind === WorkspaceKind.Assistant) {
      return (
        <AssistantAvatar
          presetId={workspace.identity?.avatar}
          emoji={workspace.identity?.emoji}
          stableKey={workspace.assistantId || workspace.id}
          name={workspace.identity?.name || workspace.name}
          size={40}
        />
      );
    }

    return <WorkspaceIcon workspace={workspace} />;
  };

  const formatDate = (dateStr: string) => {
    try {
      return i18nService.formatDate(new Date(dateStr), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  };

  const otherAssistantWorkspaces = assistantWorkspacesList.filter(
    workspace => workspace.id !== currentWorkspace?.id
  );

  return (
    <Dialog
      open={isVisible}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      size="md"
    >
      <DialogHeader>
        <DialogHeading>
          <DialogTitle>{"Workspace Status"}</DialogTitle>
        </DialogHeading>
        <DialogClose />
      </DialogHeader>
      <DialogBody>
      <ScrollArea className="workspace-manager" data-openbitfun-component="workspace-tool" data-openbitfun-part="root">
        {error && (
          <div className="error-message" data-openbitfun-component="workspace-tool" data-openbitfun-part="error">
            <span>Error: {error}</span>
          </div>
        )}

        <div className="current-workspace-section" data-openbitfun-component="workspace-tool" data-openbitfun-part="currentSection">
          <h3>Current Workspace</h3>
          {currentWorkspace ? (
            <div className="workspace-card current" data-openbitfun-component="workspace-tool" data-openbitfun-part="currentCard">
              <div className="workspace-header">
                <div className={`workspace-icon${currentWorkspace.workspaceKind === WorkspaceKind.Assistant ? ' is-assistant' : ''}`}>
                  {getWorkspaceIcon(currentWorkspace)}
                </div>
                <div className="workspace-info">
                  <div className="workspace-name">{getWorkspaceDisplayName(currentWorkspace)}</div>
                  <div className="workspace-path">{currentWorkspace.rootPath}</div>
                  <div className="workspace-meta">
                    <span className="workspace-type">{currentWorkspace.workspaceType}</span>
                    {currentWorkspace.lastAccessed && (
                      <span className="workspace-time">
                        <Icon name="clock" size="xs" />
                        {formatDate(currentWorkspace.lastAccessed)}
                      </span>
                    )}
                  </div>
                  {renderIdentityDetails(currentWorkspace)}
                  {renderRelatedPaths(currentWorkspace)}
                </div>
              </div>
              
              <div className="workspace-actions">
                <Button
                  variant="outline"
                  size="sm"
                  loading={scanning}
                  onClick={handleScanWorkspace}
                >
                  {scanning ? 'Scanning...' : 'Rescan'}
                </Button>
                <Button
                  variant="fill"
                  size="sm"
                  loading={loading}
                  onClick={handleCloseWorkspace}
                >
                  Close Workspace
                </Button>
              </div>

              {currentWorkspace.statistics && (
                <div className="workspace-stats">
                  <div className="stat-item">
                    <span className="stat-label">Files:</span>
                    <span className="stat-value">{currentWorkspace.statistics.totalFiles}</span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Lines:</span>
                    <span className="stat-value">
                      {currentWorkspace.statistics.totalLines == null
                        ? ''
                        : i18nService.formatNumber(currentWorkspace.statistics.totalLines)}
                    </span>
                  </div>
                  <div className="stat-item">
                    <span className="stat-label">Total Size:</span>
                    <span className="stat-value">{(currentWorkspace.statistics.totalSize / 1024 / 1024).toFixed(2)} MB</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="no-workspace" data-openbitfun-component="workspace-tool" data-openbitfun-part="empty">
              <FolderOpen size={48} />
              <p>No workspace is currently open</p>
            </div>
          )}
        </div>

        <div className="recent-workspaces-section" data-openbitfun-component="workspace-tool" data-openbitfun-part="recentSection">
          <h3>Recent Workspaces</h3>
          {recentWorkspaces.length > 0 ? (
            <div className="workspace-list">
              {recentWorkspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="workspace-card recent"
                  role="button"
                  tabIndex={0}
                  aria-label={getWorkspaceDisplayName(workspace)}
                  onClick={() => void handleWorkspaceSelect(workspace)}
                  onKeyDown={(event) => handleWorkspaceCardKeyDown(event, workspace)}
                 data-openbitfun-component="workspace-tool" data-openbitfun-part="recentCard">
                  <div className="workspace-header">
                    <div className={`workspace-icon${workspace.workspaceKind === WorkspaceKind.Assistant ? ' is-assistant' : ''}`}>
                      {getWorkspaceIcon(workspace)}
                    </div>
                    <div className="workspace-info">
                      <div className="workspace-name">
                        {(() => {
                          const { hostPrefix } = getRecentWorkspaceLineParts(workspace);
                          return (
                            <>
                              {hostPrefix ? (
                                <span className="workspace-name__ssh-host">{hostPrefix} · </span>
                              ) : null}
                              {getWorkspaceDisplayName(workspace)}
                            </>
                          );
                        })()}
                      </div>
                      <div className="workspace-path">{workspace.rootPath}</div>
                      <div className="workspace-meta">
                        <span className="workspace-type">{workspace.workspaceType}</span>
                        {workspace.lastAccessed && (
                          <span className="workspace-time">
                            <Icon name="clock" size="xs" />
                            {formatDate(workspace.lastAccessed)}
                          </span>
                        )}
                      </div>
                      {renderIdentityDetails(workspace)}
                      {renderRelatedPaths(workspace)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="no-recent">
              <p>No recent workspaces</p>
            </div>
          )}
        </div>

        <div className="recent-workspaces-section" data-openbitfun-component="workspace-tool" data-openbitfun-part="recentSection">
          <h3>Personal Assistants</h3>
          {otherAssistantWorkspaces.length > 0 ? (
            <div className="workspace-list">
              {otherAssistantWorkspaces.map((workspace) => (
                <div
                  key={workspace.id}
                  className="workspace-card recent"
                  role="button"
                  tabIndex={0}
                  aria-label={getWorkspaceDisplayName(workspace)}
                  onClick={() => void handleWorkspaceSelect(workspace)}
                  onKeyDown={(event) => handleWorkspaceCardKeyDown(event, workspace)}
                 data-openbitfun-component="workspace-tool" data-openbitfun-part="assistantCard">
                  <div className="workspace-header">
                    <div className="workspace-icon is-assistant">
                      {getWorkspaceIcon(workspace)}
                    </div>
                    <div className="workspace-info">
                      <div className="workspace-name">{getWorkspaceDisplayName(workspace)}</div>
                      <div className="workspace-path">{workspace.rootPath}</div>
                      <div className="workspace-meta">
                        <span className="workspace-type">assistant</span>
                        {workspace.lastAccessed && (
                          <span className="workspace-time">
                            <Icon name="clock" size="xs" />
                            {formatDate(workspace.lastAccessed)}
                          </span>
                        )}
                      </div>
                      {renderIdentityDetails(workspace)}
                      {renderRelatedPaths(workspace)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="no-recent">
              <p>No personal assistants</p>
            </div>
          )}
        </div>
      </ScrollArea>
          </DialogBody>
    </Dialog>
  );
};

export default WorkspaceManager;

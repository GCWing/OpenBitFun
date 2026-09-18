/**
 * Git diff editor wrapper around `DiffEditor`.
 * Adds Git-oriented actions (accept/reject) and optional dirty-state tracking.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Icon } from '@openbitfun/ui';
import { useTranslation } from 'react-i18next';
import { DiffEditor } from '@/tools/editor/components/DiffEditor';
;
import { createLogger } from '@/shared/utils/logger';
import { globalEventBus } from '@/infrastructure/event-bus';
import './GitDiffEditor.scss';

const log = createLogger('GitDiffEditor');

export interface GitDiffEditorProps {
  /** Original content (HEAD version) */
  originalContent: string;
  /** Modified content (working directory version) */
  modifiedContent: string;
  /** File path */
  filePath: string;
  /** Owning workspace ID; saves are routed by it when present. */
  workspaceId?: string;
  /** Repository path (IO root; upgrade-only save selector when no workspace ID is known) */
  repositoryPath: string;
  /** Language */
  language?: string;
  /** Callback after accepting all changes */
  onAcceptAll?: () => void;
  /** Callback after rejecting all changes */
  onRejectAll?: () => void;
  /** Close callback */
  onClose?: () => void;
  /** Content change callback (for dirty state tracking) */
  onContentChange?: (content: string, hasChanges: boolean) => void;
  /** Save callback */
  onSave?: (content: string) => void;
}

export const GitDiffEditor: React.FC<GitDiffEditorProps> = ({
  originalContent,
  modifiedContent,
  filePath,
  workspaceId,
  repositoryPath,
  language,
  onContentChange,
  onSave
}) => {
  const { t } = useTranslation('panels/git');
  const [error, setError] = useState<string | null>(null);
  const [currentModifiedContent, setCurrentModifiedContent] = useState(modifiedContent);
  const [hasChanges, setHasChanges] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedContent, setLastSavedContent] = useState(modifiedContent);


  const hasChangesRef = useRef<boolean>(false);
  const currentModifiedContentRef = useRef<string>(modifiedContent);
  const lastSavedContentRef = useRef<string>(modifiedContent);
  const saveFileContentRef = useRef<() => Promise<void>>();
  

  useEffect(() => {
    hasChangesRef.current = hasChanges;
  }, [hasChanges]);
  
  useEffect(() => {
    currentModifiedContentRef.current = currentModifiedContent;
  }, [currentModifiedContent]);

  useEffect(() => {
    lastSavedContentRef.current = lastSavedContent;
  }, [lastSavedContent]);

  const saveFileContent = useCallback(async () => {
    if (!filePath || !repositoryPath) {
      log.warn('Missing required parameters, skipping save', { filePath, repositoryPath });
      return;
    }


    const currentHasChanges = hasChangesRef.current;
    const contentToSave = currentModifiedContentRef.current;

    if (!currentHasChanges) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const { workspaceAPI } = await import('@/infrastructure/api');


      if (workspaceId) {
        await workspaceAPI.writeWorkspaceFile(workspaceId, filePath, contentToSave);
      } else {
        await workspaceAPI.writeFileContent(repositoryPath, filePath, contentToSave);
      }

      globalEventBus.emit('file-tree:refresh');

      setLastSavedContent(contentToSave);
      lastSavedContentRef.current = contentToSave;


      setHasChanges(false);
      hasChangesRef.current = false;


      onContentChange?.(contentToSave, false);
      onSave?.(contentToSave);

    } catch (err) {
      log.error('Failed to save file', { filePath, repositoryPath, error: err });
      setError(t('diffEditor.saveFailedWithMessage', { error: String(err) }));
    } finally {
      setSaving(false);
    }
  }, [filePath, workspaceId, repositoryPath, onContentChange, onSave, t]);
  

  useEffect(() => {
    saveFileContentRef.current = saveFileContent;
  }, [saveFileContent]);
  

  const handleModifiedContentChange = useCallback((content: string) => {
    setCurrentModifiedContent(content);


    const isModified = content !== lastSavedContentRef.current;

    setHasChanges(isModified);
    hasChangesRef.current = isModified;


    onContentChange?.(content, isModified);
  }, [onContentChange]);
  

  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 's') {
      event.preventDefault();
      event.stopPropagation();
      
      saveFileContentRef.current?.();
    }
  }, []);

  return (
    <div 
      className="git-diff-editor"
      data-openbitfun-component="git-tool"
      data-openbitfun-part="diffEditor"
      onKeyDownCapture={handleContainerKeyDown}
    >
      {error && (
        <div className="git-diff-editor__error">
          <Icon name="xmark" size="md" />
          <span>{error}</span>
        </div>
      )}

      <div className="git-diff-editor__content">
        <DiffEditor
          key={`diff-${filePath}-${originalContent.length}`}
          originalContent={originalContent}
          modifiedContent={currentModifiedContent}
          filePath={filePath}
          repositoryPath={repositoryPath}
          language={language}
          renderSideBySide={true}
          readOnly={false}
          showMinimap={false}
          renderIndicators={false}
          onModifiedContentChange={handleModifiedContentChange}
          onSave={saveFileContent}
        />
      </div>

      {saving && (
        <div className="git-diff-editor__saving-indicator">
          {t('common.saving')}
        </div>
      )}
    </div>
  );
};

export default GitDiffEditor;

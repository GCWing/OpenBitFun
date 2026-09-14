import { ResourceFileContext } from '@/infrastructure/api/ResourceFileContext';
import { useEffect, useMemo } from 'react';
import FlexiblePanel from '../components/panels/base/FlexiblePanel';
import { useContentResourceStore } from './contentResourceStore';
import { registerContentCloseGuard } from './contentResourceLifecycle';
import { EditorDocumentContext, getEditorDocument, releaseEditorDocument } from '@/tools/editor/services/EditorDocument';
import { confirmDialogChoice } from '@/infrastructure/confirm-dialog';
import { useI18n } from '@/infrastructure/i18n';
import { useSceneStore } from '../stores/sceneStore';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import { useShortcut } from '@/infrastructure/hooks/useShortcut';

export default function ContentResourceView({ resourceId, isActive }: { resourceId: string; isActive: boolean }) {
  const resource = useContentResourceStore(state => state.resources[resourceId]);
  const update = useContentResourceStore(state => state.update);
  const { t } = useI18n('components');
  const documentId = resource?.documentId;
  const resourceScope = resource?.scope;
  const filePath = resource?.target.kind === 'file' ? resource.target.path : undefined;
  const document = useMemo(
    () => documentId && resourceScope ? getEditorDocument(documentId, resourceScope, filePath) : null,
    [documentId, filePath, resourceScope],
  );
  useEffect(() => () => {
    if (document && !useContentResourceStore.getState().resources[resourceId]) releaseEditorDocument(document.id);
  }, [document, resourceId]);
  useEffect(() => registerContentCloseGuard(resourceId, async () => {
    const latest = useContentResourceStore.getState().resources[resourceId];
    if (!latest?.isDirty) return true;
    const choice = await confirmDialogChoice({ title: t('tabs.unsaved'),
      message: t('workbench.unsavedMessage', { title: latest.content.title }),
      confirmText: t('workbench.save'), secondaryText: t('workbench.discard'),
      cancelText: t('workbench.cancel'), type: 'warning' });
    if (choice === 'cancel') return false;
    if (choice === 'secondary') return true;
    if (!document?.save || latest.scope.surfaceId !== getActiveSurfaceId()) return false;
    await document.save();
    return !useContentResourceStore.getState().resources[resourceId]?.isDirty;
  }), [document, resourceId, t]);
  useShortcut('tab.close', { key: 'w', ctrl: true, scope: 'canvas', allowInInput: true },
    () => useSceneStore.getState().closeScene(`content:${resourceId}`),
    { enabled: isActive, priority: 20, description: 'keyboard.shortcuts.tab.close' });
  if (!resource || !document) return null;
  return (
    <EditorDocumentContext.Provider value={document}>
      <ResourceFileContext.Provider value={document}>
      <FlexiblePanel content={resource.content} workspacePath={resource.scope.workspacePath} isActive={isActive}
        onContentChange={content => {
          if (content) {
            // Buffers belong to EditorDocument. Keep file presentation updates out of the tab store's hot path.
            if (resource.target.kind === 'file' && content.data) {
              const { content: _buffer, hasChanges: _dirty, ...data } = content.data;
              const previous = resource.content;
              if (content.type === previous.type && content.title === previous.title && content.metadata === previous.metadata
                && Object.keys(data).every(key => data[key] === previous.data?.[key])) return;
              update(resourceId, { content: { ...content, data } });
            } else update(resourceId, { content });
          }
          else useSceneStore.getState().closeScene(`content:${resourceId}`);
        }}
        onDirtyStateChange={isDirty => update(resourceId, { isDirty })}
        onFileMissingFromDiskChange={missing => update(resourceId, {
          fileMissing: document.isFileDeletedFromDisk(filePath, missing),
        })} />
      </ResourceFileContext.Provider>
    </EditorDocumentContext.Provider>
  );
}

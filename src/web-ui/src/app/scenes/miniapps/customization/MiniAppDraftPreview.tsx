import React from 'react';
import type { MiniAppDraft } from '@/infrastructure/api/service-api/MiniAppAPI';
import MiniAppRunner from '../components/MiniAppRunner';
import { MiniAppTitlebarPreview } from '../components/MiniAppTitlebarPreview';

interface MiniAppDraftPreviewProps {
  draft: MiniAppDraft;
  previewKey: number;
  strictRuntime?: boolean;
}

export const MiniAppDraftPreview: React.FC<MiniAppDraftPreviewProps> = ({
  draft,
  previewKey,
  strictRuntime = false,
}) => {
  return (
    <div className="miniapp-customize-panel__preview-frame">
      <MiniAppTitlebarPreview app={draft.app} />
      <MiniAppRunner
        key={`${draft.appId}-${draft.draftId}-${previewKey}`}
        app={draft.app}
        runScope={{ kind: 'draft', appId: draft.appId, draftId: draft.draftId }}
        strictRuntime={strictRuntime}
      />
    </div>
  );
};

export default MiniAppDraftPreview;

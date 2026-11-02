import { useEffect, useState } from 'react';
import type { SurfaceScope } from '@/infrastructure/peer-device/deviceSurface';
import { prepareWorkspaceIcon } from './prepareWorkspaceIcon';

interface ImageDraft { file: File; crop: boolean; zoom: number }

/** Each theme owns its crop and async preparation; stale results cannot replace a newer draft. */
export function useWorkspaceIconImageDraft(scope: SurfaceScope, original?: string) {
  const [draft, setDraft] = useState<ImageDraft>();
  const [result, setResult] = useState<{ draft: ImageDraft; image?: string; error?: boolean }>();
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    void prepareWorkspaceIcon(draft.file, draft.crop, draft.zoom).then(image => {
      if (!cancelled && scope.isCurrent()) setResult({ draft, image });
    }).catch(() => {
      if (!cancelled && scope.isCurrent()) setResult({ draft, error: true });
    });
    return () => { cancelled = true; };
  }, [draft, scope]);
  const ready = Boolean(draft && result?.draft === draft && result.image);
  return {
    file: draft?.file, crop: draft?.crop ?? false, zoom: draft?.zoom ?? 1,
    image: result?.image ?? original,
    pending: Boolean(draft && result?.draft !== draft),
    error: Boolean(draft && result?.draft === draft && result.error),
    dataBase64: ready ? result?.image?.split(',')[1] : undefined,
    choose: (file: File) => setDraft({ file, crop: false, zoom: 1 }),
    setCrop: (crop: boolean) => setDraft(value => value ? { ...value, crop } : value),
    setZoom: (zoom: number) => setDraft(value => value ? { ...value, zoom } : value),
  };
}

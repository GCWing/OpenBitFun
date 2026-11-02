import { Button } from '@openbitfun/ui';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { i18nService } from '@/infrastructure/i18n';
import { getActiveSurfaceScope, onSurfaceActivated } from '@/infrastructure/peer-device/deviceSurface';

export type SessionImageReader = (path: string, refresh?: boolean) => Promise<string>;

/** Session providers own these bytes; neither loading nor fallback may read local files. */
export function SessionMarkdownImage({ path, alt, title, read, download, onPreview, thumbnail }: {
  path: string; alt?: string; title?: string; read: SessionImageReader;
  download?: (path: string) => Promise<void>;
  onPreview?: (source: string, alt?: string) => void;
  thumbnail?: boolean;
}) {
  const scope = useSyncExternalStore(onSurfaceActivated, getActiveSurfaceScope, getActiveSurfaceScope);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    read: SessionImageReader; path: string; epoch: number; src?: string; error?: string;
  }>();
  const current = result?.read === read && result?.path === path && result?.epoch === scope.epoch ? result : undefined;
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    (attempt ? read(path, true) : read(path)).then(src => {
      if (!/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml|avif|x-icon);base64,/i.test(src)) {
        throw new Error(i18nService.t('components:markdown.imageUnavailable'));
      }
      if (!cancelled && scope.isCurrent()) setResult({ read, path, epoch: scope.epoch, src });
    }).catch((error: unknown) => {
      if (!cancelled && scope.isCurrent()) setResult({ read, path, epoch: scope.epoch, error: String(error) });
    });
    return () => { cancelled = true; };
  }, [path, read, scope, attempt]);

  const source = current?.src;
  if (source) return <img src={source} alt={alt || ''} title={title} loading="lazy"
    className={onPreview ? 'markdown-image--previewable' : undefined}
    role={onPreview && thumbnail ? 'button' : undefined} tabIndex={onPreview && thumbnail ? 0 : undefined}
    onKeyDown={(event) => {
      if (!onPreview || event.currentTarget.closest('a, button') || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      onPreview(source, alt || undefined);
    }}
    onClick={(event) => {
      // An image owned by a link or a file link keeps that owner's behavior.
      if (!onPreview || event.currentTarget.closest('a, button')) return;
      event.preventDefault();
      event.stopPropagation();
      onPreview(source, alt || undefined);
    }}
    onError={() => setResult({ read, path, epoch: scope.epoch, error: i18nService.t('components:markdown.imageUnavailable') })} />;
  return <span className="markdown-image-fallback" data-openbitfun-component="markdown" data-openbitfun-part="imageFallback" title={current?.error}>
    {alt || path.split('/').pop()} · {i18nService.t(current?.error ? 'components:markdown.imageUnavailable' : 'common:status.loading')}
    {current?.error && <Button labelBehavior="static" variant="text" type="button" onClick={() => setAttempt(value => value + 1)}>{i18nService.t('common:retry')}</Button>}
    {download && <Button labelBehavior="static" variant="text" type="button" onClick={() => { void download(path).catch(() => {}); }}>{i18nService.t('common:actions.download')}</Button>}
  </span>;
}

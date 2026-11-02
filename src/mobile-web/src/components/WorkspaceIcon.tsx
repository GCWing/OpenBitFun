import { useI18n } from '../i18n';
import { useTheme } from '../theme';
import { useEffect, useState } from 'react';
import { Plane, Utensils, Dumbbell, Music, BookOpen, House, Wallet, Camera, PawPrint, Sprout, ShoppingBag, Clapperboard, BriefcaseBusiness, CodeXml, Database, FileText, FlaskConical, Folder, Gamepad2, Globe, GraduationCap, Palette, Server, Smartphone, Wrench, type LucideIcon } from 'lucide-react';
import type { MobileWorkspaceIcon, RecentWorkspaceEntry, RemoteSessionManager } from '../services/RemoteSessionManager';

// Identity colors are theme-owned; never import the desktop locale or UI catalog.
const colors: Record<string, string> = {
  blue: 'var(--openbitfun-color-identity-project-blue)', cyan: 'var(--openbitfun-color-identity-project-cyan)',
  green: 'var(--openbitfun-color-identity-project-green)', yellow: 'var(--openbitfun-color-identity-project-yellow)',
  orange: 'var(--openbitfun-color-identity-project-orange)', red: 'var(--openbitfun-color-identity-project-red)',
  purple: 'var(--openbitfun-color-identity-project-purple)', pink: 'var(--openbitfun-color-identity-project-pink)',
};
const glyphs: Record<string, LucideIcon> = {
  code: CodeXml, learning: GraduationCap, design: Palette, documents: FileText,
  research: FlaskConical, web: Globe, mobile: Smartphone, games: Gamepad2,
  data: Database, business: BriefcaseBusiness, tools: Wrench,
  travel: Plane, food: Utensils, fitness: Dumbbell, music: Music, reading: BookOpen, home: House, finance: Wallet, photography: Camera, pets: PawPrint, nature: Sprout, shopping: ShoppingBag, movies: Clapperboard,
};
export function WorkspaceIcon({ manager, workspace, size = 21 }: { manager: RemoteSessionManager; workspace: Pick<RecentWorkspaceEntry, 'workspace_id' | 'workspace_kind'>; size?: number }) {
  const { t } = useI18n();
  const { isDark } = useTheme();
  const [failed, setFailed] = useState(false);
  const epoch = manager.controlTargetEpoch;
  const [loaded, setLoaded] = useState<{ manager: RemoteSessionManager; epoch: number; id: string; snapshot: MobileWorkspaceIcon | null }>();
  const [failedImage, setFailedImage] = useState<string>();
  useEffect(() => {
    if (!workspace.workspace_id || workspace.workspace_kind === 'assistant') return;
    let cancelled = false;
    setFailed(false);
    const id = workspace.workspace_id;
    void manager.getWorkspaceIcon(id).then(snapshot => {
      if (!cancelled && epoch === manager.controlTargetEpoch) setLoaded({ manager, epoch, id, snapshot });
    }).catch(() => { if (!cancelled) { setLoaded(undefined); setFailed(true); } });
    return () => { cancelled = true; };
    // Catalog refresh/reconnect supplies a new workspace projection, even when the id is unchanged.
  }, [manager, epoch, workspace]);
  const snapshot = loaded?.manager === manager && loaded.epoch === epoch && loaded.id === workspace.workspace_id ? loaded.snapshot : null;
  const color = snapshot?.icon.color ?? 'default';
  const cssColor = /^#[\da-f]{6}$/i.test(color) ? color
    : Object.prototype.hasOwnProperty.call(colors, color) ? colors[color] : undefined;
  const image = isDark ? snapshot?.darkImageData ?? snapshot?.imageData : snapshot?.imageData ?? snapshot?.darkImageData;
  const glyph = snapshot?.icon.glyph;
  const Artwork = glyph && Object.prototype.hasOwnProperty.call(glyphs, glyph) ? glyphs[glyph]
    : workspace.workspace_kind === 'remote' ? Server : Folder;
  const unknownGlyph = glyph && glyph !== 'default' && !Object.prototype.hasOwnProperty.call(glyphs, glyph);
  const title = failed || snapshot?.imageUnavailable || (isDark && snapshot?.darkImageUnavailable) || (image && image === failedImage) || unknownGlyph ? t('workspace.iconUnavailable') : undefined;
  return <span title={title} aria-hidden="true">{image && image !== failedImage
    ? <img src={image} width={size} height={size} style={{ objectFit: 'contain' }} alt="" aria-hidden="true" onError={() => setFailedImage(image)} />
    : <Artwork width={size} height={size} style={{ color: cssColor }} aria-hidden="true" />}</span>;
}

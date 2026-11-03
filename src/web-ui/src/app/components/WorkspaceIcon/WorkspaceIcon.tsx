import { Icon } from '@openbitfun/ui';
import { Plane, Utensils, Dumbbell, Music, BookOpen, House, Wallet, Camera, PawPrint, Sprout, ShoppingBag, Clapperboard, BriefcaseBusiness, CodeXml, Database, FileText, FlaskConical, Folder, FolderOpen, Gamepad2, Globe, GraduationCap, Palette, Server, Smartphone, Wrench, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/infrastructure/i18n';
import { useAppearance } from '@/infrastructure/appearance';
import { useWorkspaceIcon } from '@/infrastructure/workspace-icons/useWorkspaceIcon';
import { iconColorStyle } from '@/infrastructure/workspace-icons/workspaceIcons';
import './WorkspaceIcon.scss';

const projectGlyphs: Record<string, LucideIcon> = {
  code: CodeXml, learning: GraduationCap, design: Palette, documents: FileText,
  research: FlaskConical, web: Globe, mobile: Smartphone, games: Gamepad2,
  data: Database, business: BriefcaseBusiness, tools: Wrench,
  travel: Plane, food: Utensils, fitness: Dumbbell, music: Music, reading: BookOpen, home: House, finance: Wallet, photography: Camera, pets: PawPrint, nature: Sprout, shopping: ShoppingBag, movies: Clapperboard,
};

export function WorkspaceIconArt({ color = 'default', glyph, image, remote = false, expanded, size = 16 }: { color?: string; glyph?: string; image?: string; remote?: boolean; expanded?: boolean; size?: number }) {
  const [failedImage, setFailedImage] = useState<string>();
  const customGlyph = glyph && Object.prototype.hasOwnProperty.call(projectGlyphs, glyph) ? projectGlyphs[glyph] : undefined;
  const artwork = customGlyph ?? (remote ? Server : Folder);
  const showFolderTransition = expanded !== undefined && !remote && !customGlyph;
  return <span className="openbitfun-workspace-icon" data-openbitfun-component="workspace-icon" data-openbitfun-part="root"
    style={{ width: size, height: size, color: iconColorStyle(color) }} aria-hidden="true">
    {image && failedImage !== image ? (
      <img data-openbitfun-component="workspace-icon" data-openbitfun-part="image" src={image} alt="" draggable={false} decoding="async" onError={() => setFailedImage(image)} />
    ) : showFolderTransition ? (
      <span className="openbitfun-workspace-icon__folder">
        <Icon glyph={Folder} size="sm" className="openbitfun-workspace-icon__folder-layer" data-active={!expanded} />
        <Icon glyph={FolderOpen} size="sm" className="openbitfun-workspace-icon__folder-layer" data-active={expanded} />
      </span>
    ) : (
      <Icon glyph={artwork} size="sm" style={{ width: size, height: size }} />
    )}
  </span>;
}

export function WorkspaceIcon({ workspace, expanded, size = 16 }: { workspace: { id: string; workspaceKind?: string }; expanded?: boolean; size?: number }) {
  const state = useWorkspaceIcon(workspace.id);
  const { t } = useI18n('common');
  const { current: appearance } = useAppearance();
  const isDark = appearance?.mode === 'dark';
  const image = isDark ? state.snapshot?.darkImageData ?? state.snapshot?.imageData
    : state.snapshot?.imageData ?? state.snapshot?.darkImageData;
  const glyph = state.snapshot?.icon.glyph;
  const unknownGlyph = glyph && glyph !== 'default' && !Object.prototype.hasOwnProperty.call(projectGlyphs, glyph);
  return <span title={state.error || state.snapshot?.imageUnavailable || (isDark && state.snapshot?.darkImageUnavailable) || unknownGlyph ? t('nav.workspaces.icon.loadFailed') : undefined}>
    <WorkspaceIconArt color={state.snapshot?.icon.color} glyph={glyph} image={image} remote={workspace.workspaceKind?.toLowerCase() === 'remote'} expanded={expanded} size={size} />
  </span>;
}

import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Blocks,
  BookOpen,
  BookSearch,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleArrowRight,
  CircleCheck,
  Clock,
  Code2,
  Command,
  Copy,
  Ellipsis,
  Eye,
  FileSearchCorner,
  FileText,
  FileUp,
  FileX2,
  Files,
  Folder,
  FolderOpen,
  FolderSearch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe,
  History,
  Hourglass,
  Image,
  Info,
  Layers,
  Link,
  ListFilter,
  ListTodo,
  LoaderCircle,
  MessageCircle,
  MessageCircleQuestionMark,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareText,
  MessagesSquare,
  Mic,
  Monitor,
  MousePointer,
  Palette,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Pencil,
  Pin,
  Plus,
  Plug,
  Puzzle,
  RefreshCw,
  Route,
  Search,
  ScanEye,
  Settings,
  SlidersHorizontal,
  SlidersVertical,
  Sparkles,
  Split,
  SquareTerminal,
  Star,
  Store,
  Terminal,
  Target,
  TextSearch,
  Trash2,
  Upload,
  User,
  Users,
  Wrench,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { classNames } from "../../internal/classNames";
import { LayersPlus } from './layersPlus';
import gitUrl from "./assets/git.svg";
import thinkingUrl from "./assets/thinking.svg";
import creativeUrl from "./assets/creative.svg";
import ultimateUrl from "./assets/ultimate.svg";
import standardUrl from "./assets/standard.svg";
import minimalUrl from "./assets/minimal.svg";
import reasoningAutoUrl from "./assets/reasoning-auto.svg";
import styles from "./Icon.module.css";

export const iconNames = [
  "arrow-down",
  "unselected",
  "chevron-left",
  "selected",
  "delete",
  "waitlist-message",
  "creative",
  "ultimate",
  "standard",
  "minimal",
  "reasoning-auto",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-up-right",
  "bell",
  "book-open",
  "book-search",
  "browser",
  "calendar-clock",
  "check-circle",
  "check-fill",
  "check-line",
  "chevron-down",
  "chevron-right",
  "chevron-up",
  "circle",
  "circle-arrow-right",
  "clock",
  "code",
  "command-mac",
  "commit",
  "device-mac",
  "download",
  "duplicate",
  "edit",
  "extension",
  "eye",
  "file-search-corner",
  "file-text",
  "file-up",
  "file-x-2",
  "files",
  "filter",
  "floating-window",
  "folder",
  "folder-open",
  "folder-search",
  "gear",
  "git",
  "git-pull-request",
  "history",
  "hourglass",
  "image",
  "info",
  "layers",
  "layers-plus",
  "level",
  "link",
  "list-todo",
  "message-circle-question",
  "message-square",
  "mic",
  "mini-app",
  "more",
  "mouse-pointer",
  "palette",
  "panels-top-left",
  "pin",
  "plus",
  "plug",
  "progress-25",
  "refresh",
  "route",
  "search",
  "scan-eye",
  "session",
  "settings",
  "show-session",
  "side-chat",
  "sidebar-left",
  "sidebar-right",
  "spark",
  "split",
  "square-terminal",
  "star",
  "store",
  "terminal",
  "target",
  "text-search",
  "thinking",
  "turn",
  "upload",
  "user",
  "users",
  "wrench",
  "workflow",
  "xmark",
] as const;

/** Legacy names remain renderable; new previews use the canonical catalog. */
export const iconAliases = { download: "arrow-down", circle: "unselected" } as const;
export const canonicalIconNames = iconNames.filter(name => name !== "turn" && !(name in iconAliases)).sort();

export type IconName = (typeof iconNames)[number];
export type IconSize = "2xs" | "xs" | "sm" | "md" | "lg";
export type IconTone =
  | "inherit"
  | "primary"
  | "secondary"
  | "muted"
  | "disabled"
  | "info"
  | "success"
  | "warning"
  | "danger";

export type IconSource =
  | { glyph: LucideIcon; name?: never }
  | { glyph?: never; name: IconName };

// Brand-derived mode and reasoning marks retain their reviewed SVG geometry.
const iconSources: Partial<Record<IconName, string>> = {
  creative: creativeUrl,
  ultimate: ultimateUrl,
  standard: standardUrl,
  minimal: minimalUrl,
  git: gitUrl,
  thinking: thinkingUrl,
  "reasoning-auto": reasoningAutoUrl,
};

const lineGlyphs = {
  "arrow-down": ArrowDown,
  "unselected": Circle,
  "chevron-left": ChevronLeft,
  "selected": CircleCheck,
  "delete": Trash2,
  "waitlist-message": MessageSquareText,
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  "arrow-up-right": ArrowUpRight,
  "bell": Bell,
  "book-open": BookOpen,
  "book-search": BookSearch,
  "browser": Globe,
  "calendar-clock": CalendarClock,
  "check-circle": CircleCheck,
  "check-fill": CircleCheck,
  "check-line": Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "circle": Circle,
  "circle-arrow-right": CircleArrowRight,
  "clock": Clock,
  "git-pull-request": GitPullRequest,
  "history": History,
  "target": Target,
  "users": Users,
  "code": Code2,
  "command-mac": Command,
  "commit": GitCommitHorizontal,
  "device-mac": Monitor,
  "download": ArrowDown,
  "duplicate": Copy,
  "edit": Pencil,
  "extension": Puzzle,
  "eye": Eye,
  "file-search-corner": FileSearchCorner,
  "file-text": FileText,
  "file-up": FileUp,
  "file-x-2": FileX2,
  "files": Files,
  "filter": ListFilter,
  "floating-window": AppWindow,
  "folder": Folder,
  "folder-open": FolderOpen,
  "folder-search": FolderSearch,
  "gear": Settings,
  "hourglass": Hourglass,
  "image": Image,
  "info": Info,
  "layers": Layers,
  "layers-plus": LayersPlus,
  "level": SlidersVertical,
  "link": Link,
  "list-todo": ListTodo,
  "message-circle-question": MessageCircleQuestionMark,
  "message-square": MessageSquare,
  "mic": Mic,
  "mini-app": Blocks,
  "more": Ellipsis,
  "mouse-pointer": MousePointer,
  "palette": Palette,
  "panels-top-left": PanelsTopLeft,
  "pin": Pin,
  "plus": Plus,
  "plug": Plug,
  "progress-25": LoaderCircle,
  "refresh": RefreshCw,
  "route": Route,
  "search": Search,
  "scan-eye": ScanEye,
  "session": MessageCircle,
  "settings": SlidersHorizontal,
  "show-session": MessagesSquare,
  "side-chat": MessageSquarePlus,
  "sidebar-left": PanelLeft,
  "sidebar-right": PanelRight,
  "spark": Sparkles,
  "split": Split,
  "square-terminal": SquareTerminal,
  "star": Star,
  "store": Store,
  "terminal": Terminal,
  "text-search": TextSearch,
  "turn": Circle,
  "upload": Upload,
  "user": User,
  "wrench": Wrench,
  "workflow": Workflow,
  "xmark": X,
} satisfies Record<Exclude<IconName,
  | "creative" | "ultimate" | "standard" | "minimal" | "git" | "thinking"
  | "reasoning-auto"
>, LucideIcon>;

interface IconBaseProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "aria-label" | "children"> {
  label?: string;
  size?: IconSize;
  tone?: IconTone;
}

export type IconProps = IconBaseProps & IconSource;

export const Icon = forwardRef<HTMLSpanElement, IconProps>(function Icon({
  className,
  glyph: LineGlyph,
  label,
  name,
  size = "lg",
  style,
  tone = "inherit",
  ...props
}, ref) {
  const asset = name ? iconSources[name] : undefined;
  const catalogSource = asset ? `url("${asset}")` : undefined;
  const Glyph = LineGlyph ?? (name && name in lineGlyphs ? lineGlyphs[name as keyof typeof lineGlyphs] : undefined);
  const iconStyle: CSSProperties = catalogSource
    ? {
        ...style,
        WebkitMaskImage: catalogSource,
        maskImage: catalogSource,
      }
    : style ?? {};

  return (
    <span
      {...props}
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      className={classNames(styles.icon, className)}
      data-openbitfun-component="icon"
      data-openbitfun-name={name}
      data-openbitfun-source={asset ? "catalog" : "line"}
      data-openbitfun-artwork={name && name !== "progress-25" && name !== "turn" ? "monochrome" : undefined}
      data-openbitfun-tone={tone}
      data-size={size}
      ref={ref}
      role={label ? "img" : undefined}
      style={iconStyle}
    >
      {Glyph ? (
        <Glyph
          aria-hidden="true"
          focusable="false"
          strokeWidth="var(--openbitfun-control-icon-stroke-width)"
        />
      ) : null}
    </span>
  );
});

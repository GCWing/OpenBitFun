import {
  Activity,
  AlarmClock,
  Bell,
  CalendarClock,
  ChartColumn,
  ChartPie,
  CircleCheck,
  Clock,
  Cloud,
  Code2,
  DollarSign,
  Flag,
  GitPullRequest,
  Globe,
  HardDrive,
  Info,
  LayoutGrid,
  ListChecks,
  Package,
  Rocket,
  Server,
  SquareTerminal,
  Star,
  StickyNote,
  Sun,
  Timer,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { DesktopCardRecord } from '@/infrastructure/api/service-api/DesktopCardAPI';

/** Keep in sync with `DESKTOP_CARD_ICONS` in the core DesktopCard host contract. */
const CARD_ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  alarm: AlarmClock,
  bell: Bell,
  calendar: CalendarClock,
  chart: ChartColumn,
  check: CircleCheck,
  clock: Clock,
  cloud: Cloud,
  code: Code2,
  dollar: DollarSign,
  flag: Flag,
  'git-pull-request': GitPullRequest,
  globe: Globe,
  'hard-drive': HardDrive,
  info: Info,
  list: ListChecks,
  note: StickyNote,
  package: Package,
  'pie-chart': ChartPie,
  rocket: Rocket,
  server: Server,
  star: Star,
  sun: Sun,
  terminal: SquareTerminal,
  timer: Timer,
  'trending-up': TrendingUp,
  zap: Zap,
};

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  countdown: Timer,
  checklist: ListChecks,
  note: StickyNote,
  progress: Activity,
  metrics: Activity,
  chart: ChartColumn,
  cronJob: CalendarClock,
  custom: LayoutGrid,
};

export function desktopCardIcon(card: Pick<DesktopCardRecord, 'icon' | 'template'>): LucideIcon {
  return (card.icon && CARD_ICONS[card.icon])
    || (typeof card.template?.kind === 'string' && TEMPLATE_ICONS[card.template.kind])
    || LayoutGrid;
}

import { Icon, IconButton } from '@openbitfun/ui';
import { Download, Save, Search, Settings, RefreshCw, Plus, Play, Square, Check, Share2, CircleHelp } from 'lucide-react';
import type { MiniAppChromeAction } from '@/infrastructure/api/service-api/MiniAppAPI';
import { actionLabel } from '../../../../../../shared/miniapp-chrome/titlebar';
import { MiniAppActionTooltip } from './MiniAppActionTooltip';

const glyphs = { download: Download, save: Save, search: Search, settings: Settings, refresh: RefreshCw, plus: Plus, play: Play, stop: Square, check: Check, share: Share2, help: CircleHelp };

export function MiniAppChromeActions({ actions, locale, disabled, onAction }: {
  actions: MiniAppChromeAction[];
  locale: string;
  disabled: boolean;
  onAction: (actionId: string) => void;
}) {
  return actions.map(action => {
    const label = actionLabel(action, locale);
    const actionDisabled = disabled || action.enabled === false;
    return <MiniAppActionTooltip key={action.id} content={label} disabled={actionDisabled}>
      <IconButton size="xs" aria-label={label} disabled={actionDisabled}
        icon={<Icon glyph={glyphs[action.icon] ?? CircleHelp} size="sm" />}
        onClick={() => onAction(action.id)} />
    </MiniAppActionTooltip>;
  });
}

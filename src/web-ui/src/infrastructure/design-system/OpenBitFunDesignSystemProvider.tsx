import {
  DesignSystemProvider,
  type ColorScheme,
  type ContrastMode,
  type DensityMode,
} from '@openbitfun/ui';
import {
  useEffect,
  useLayoutEffect,
  useState,
  type PropsWithChildren,
} from 'react';
import { useAppearance } from '@/infrastructure/appearance';
import { getAppearanceOverlayHost } from '@/infrastructure/appearance/runtime/AppearanceOverlayHost';
import { useI18n } from '@/infrastructure/i18n';

const DENSITY: DensityMode = 'compact';
const HIGH_CONTRAST_MEDIA_QUERY = '(prefers-contrast: more), (forced-colors: active)';

function readHighContrastPreference(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(HIGH_CONTRAST_MEDIA_QUERY).matches;
}

function useHighContrastPreference(): boolean {
  const [highContrast, setHighContrast] = useState(readHighContrastPreference);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(HIGH_CONTRAST_MEDIA_QUERY);
    const update = () => setHighContrast(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return highContrast;
}

/**
 * The product-owned UI host. It is the only place where product appearance,
 * locale copy and the document-level portal host enter the independent design
 * system.
 */
export function OpenBitFunDesignSystemProvider({ children }: PropsWithChildren) {
  const colorScheme: ColorScheme = useAppearance().current?.mode ?? 'light';
  const contrast: ContrastMode = useHighContrastPreference() ? 'high' : 'standard';
  const { currentLanguage, t } = useI18n('components');

  useLayoutEffect(() => {
    const root = document.documentElement;
    const attributes = {
      'data-openbitfun-design-system-root': '',
      'data-color-scheme': colorScheme,
      'data-contrast': contrast,
      'data-density': DENSITY,
    } as const;
    const previousValues = new Map(
      Object.keys(attributes).map(name => [name, root.getAttribute(name)]),
    );

    Object.entries(attributes).forEach(([name, value]) => {
      root.setAttribute(name, value);
    });

    return () => {
      previousValues.forEach((value, name) => {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      });
    };
  }, [colorScheme, contrast]);

  return (
    <DesignSystemProvider
      colorScheme={colorScheme}
      contrast={contrast}
      density={DENSITY}
      locale={currentLanguage}
      nativeTooltipPolicy="application"
      messages={{
        clearSelection: t('search.clear'),
        confirmAction: t('dialog.confirm.ok'),
        confirmCancel: t('dialog.confirm.cancel'),
        createValue: t('select.customValueHint'),
        dialogClose: t('modal.close'),
        loading: t('select.loading'),
        noOptions: t('select.emptyText'),
        searchOptions: t('select.search'),
        selectAll: t('select.selectAll'),
        selectPlaceholder: t('select.placeholder'),
        toolCardOpenDetails: t('tooltip.openDetails'),
        toolCardExpandDetails: t('tooltip.expand'),
        toolCardCollapseDetails: t('tooltip.collapse'),
      }}
      portalHost={getAppearanceOverlayHost}
    >
      {children}
    </DesignSystemProvider>
  );
}

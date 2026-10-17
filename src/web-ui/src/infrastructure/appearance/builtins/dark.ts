

import { AppearancePalette } from './AppearancePalette';
import {
  createAccentScale,
  createDarkNeutralBorder,
  createDarkNeutralElement,
  createDarkNeutralScrollbar,
  createGitColors,
  createSemanticColors,
  createSecondaryAccentScale,
  createStandardEasing,
  createStandardRadius,
  createStandardSpacing,
  overlayWhite,
  STATIC_WHITE,
} from './paletteHelpers';
import {
  getDesignSystemThemeNumber,
  getDesignSystemThemeString,
} from './designSystemThemeValues';

const DARK_BACKGROUND_PRIMARY = getDesignSystemThemeString('dark', 'color.surface.canvas');
const DARK_BACKGROUND_SECONDARY = getDesignSystemThemeString('dark', 'color.surface.panel');
const DARK_TEXT_PRIMARY = getDesignSystemThemeString('dark', 'color.content.primary');
const DARK_BUTTON_TEXT = '#c8c8c8';
const DARK_ACCENT = getDesignSystemThemeString('dark', 'color.accent.default');
const DARK_ACCENT_HOVER = getDesignSystemThemeString('dark', 'color.accent.hover');
const DARK_PURPLE = '#8b5cf6';
const DARK_PURPLE_HOVER = '#7c3aed';

export const openBitFunDarkPalette: AppearancePalette = {

  id: 'openbitfun-dark',
  name: 'Dark',
  type: 'dark',
  description: 'Default dark appearance',
  author: 'OpenBitFun Team',
  version: '2.1.0',


  colors: {
    background: {
      primary: DARK_BACKGROUND_PRIMARY,
      secondary: DARK_BACKGROUND_SECONDARY,
      tertiary: DARK_BACKGROUND_PRIMARY,
      elevated: DARK_BACKGROUND_SECONDARY,
      workbench: DARK_BACKGROUND_PRIMARY,
      scene: DARK_BACKGROUND_SECONDARY,
    },

    text: {
      primary: DARK_TEXT_PRIMARY,
      secondary: getDesignSystemThemeString('dark', 'color.content.secondary'),
      muted: getDesignSystemThemeString('dark', 'color.content.muted'),
      disabled: getDesignSystemThemeString('dark', 'color.content.disabled'),
    },

    accent: createAccentScale({ base: DARK_ACCENT, hover: DARK_ACCENT_HOVER }),

    purple: createSecondaryAccentScale({ base: DARK_PURPLE, hover: DARK_PURPLE_HOVER }),

    semantic: createSemanticColors('dark'),

    border: {
      ...createDarkNeutralBorder(),
      subtle: getDesignSystemThemeString('dark', 'color.border.subtle'),
      base: getDesignSystemThemeString('dark', 'color.border.default'),
      strong: getDesignSystemThemeString('dark', 'color.border.strong'),
    },

    element: {
      ...createDarkNeutralElement(),
      subtle: getDesignSystemThemeString('dark', 'color.surface.subtle'),
      soft: getDesignSystemThemeString('dark', 'color.action.quiet.hover'),
      base: getDesignSystemThemeString('dark', 'color.action.neutral.surface'),
      medium: getDesignSystemThemeString('dark', 'color.action.neutral.surfaceHover'),
      strong: getDesignSystemThemeString('dark', 'color.action.neutral.surfacePressed'),
    },

    git: createGitColors('dark', {
      branch: '#a1a1aa',
      branchBg: overlayWhite(0.06),
    }),

    scrollbar: createDarkNeutralScrollbar(),
  },


  effects: {
    shadow: {
      xs: getDesignSystemThemeString('dark', 'shadow.xs'),
      sm: getDesignSystemThemeString('dark', 'shadow.sm'),
      base: getDesignSystemThemeString('dark', 'shadow.base'),
      lg: getDesignSystemThemeString('dark', 'shadow.lg'),
      xl: getDesignSystemThemeString('dark', 'shadow.xl'),
    },

    blur: {
      subtle: getDesignSystemThemeString('dark', 'effect.blur.subtle'),
      base: getDesignSystemThemeString('dark', 'effect.blur.base'),
    },

    radius: createStandardRadius(),

    spacing: createStandardSpacing(),

    opacity: {
      disabled: getDesignSystemThemeNumber('dark', 'opacity.disabled'),
      hover: getDesignSystemThemeNumber('dark', 'opacity.hover'),
      focus: getDesignSystemThemeNumber('dark', 'opacity.focus'),
    },
  },


  motion: {
    duration: {
      instant: '0.08s',
      fast: '0.14s',
      base: '0.22s',
      slow: '0.42s',
    },

    easing: createStandardEasing(),
  },



  components: {
    button: {



      primary: {
        default: {
          background: getDesignSystemThemeString('dark', 'color.action.primary.background'),
          color: getDesignSystemThemeString('dark', 'color.action.primary.content'),
          border: 'transparent',
          shadow: 'none',
        },
        hover: {
          background: getDesignSystemThemeString('dark', 'color.action.primary.hover'),
          color: STATIC_WHITE,
          border: 'transparent',
          shadow: 'none',
          transform: 'none',
        },
        active: {
          background: getDesignSystemThemeString('dark', 'color.action.primary.pressed'),
          color: STATIC_WHITE,
          border: 'transparent',
          shadow: 'none',
          transform: 'none',
        },
      },


      ghost: {
        default: {
          color: '#9a9a9a',
        },
        hover: {
          background: overlayWhite(0.1),
          color: DARK_BUTTON_TEXT,
          border: 'transparent',
        },
      },
    },
  },




  monaco: {
    base: 'vs-dark',
    inherit: true,
    // `vs-dark` has no rule for the `function` token, so function names fall back
    // to the default foreground. Declared function names and call sites use that
    // token (Cangjie, and any other language grammar that emits it).
    rules: [
      { token: 'function', foreground: 'DCDCAA' },
    ],
    colors: {
      background: DARK_BACKGROUND_PRIMARY,
      foreground: DARK_TEXT_PRIMARY,
      lineHighlight: DARK_BACKGROUND_SECONDARY,
      selection: overlayWhite(0.12),
      cursor: DARK_BUTTON_TEXT,
    },
  },
};




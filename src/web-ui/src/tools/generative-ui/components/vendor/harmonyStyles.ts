/**
 * HarmonyOS design resources used by the Harmony GenUI profile.
 *
 * The reference project keeps these rules in its generated sandbox CSS.  The
 * component renderer and the opaque HTML renderer share this resource so a
 * generated OpenUI document and a generated HTML document receive the same
 * visual contract.  Keep the values here host-owned: generated content may
 * use the classes and tokens, but it cannot replace this stylesheet.
 */
const HARMONY_ICON_CSS = Object.entries(HM_ICON_CODEPOINTS)
  .map(([name, code]) => `.hm-icon[data-icon="${name}"]::before { content: "\\${code.toString(16)}"; }`)
  .join('\n');

export const HARMONY_STYLE_RESOURCE_CSS = String.raw`
/* HarmonyOS neutral and accent tokens. */
:where(.gen-ui-application--harmony-genui, .gen-ui-phone-device[data-hm-theme], html[data-hm-theme]) {
  --hm-brand: #007dff;
  --hm-brand-dark: #3f97e9;
  --hm-brand-soft: rgba(0, 125, 255, .10);
  --hm-on-brand: #ffffff;
  --hm-card-bg: #ffffff;
  --hm-panel-bg: #f1f3f5;
  --hm-click-effect: rgba(24, 36, 49, .10);
  --hm-hover: rgba(24, 36, 49, .05);
  --hm-divider: rgba(24, 36, 49, .20);
  --hm-track-bg: rgba(24, 36, 49, .10);
  --hm-knob: #ffffff;
  --hm-text-primary: #182431;
  --hm-text-secondary: rgba(24, 36, 49, .60);
  --hm-text-tertiary: rgba(24, 36, 49, .50);
  --hm-border-primary: rgba(24, 36, 49, .40);
  --hm-border-secondary: rgba(24, 36, 49, .20);
  --hm-border-tertiary: rgba(24, 36, 49, .10);
  --hm-bg-tertiary: rgba(24, 36, 49, .05);
  --hm-text-headline7: 24px;
  --hm-text-headline8: 20px;
  --hm-text-body1: 16px;
  --hm-text-body2: 14px;
  --hm-text-body3: 12px;
  --hm-text-caption: 10px;
  --hm-text-display: 40px;
  --hm-text-display-s: 32px;
  --hm-title-1: var(--hm-text-headline7);
  --hm-title-2: var(--hm-text-body1);
  --hm-title-3: var(--hm-text-body2);
  --hm-space-xs: 4px;
  --hm-space-s: 8px;
  --hm-space-m: 12px;
  --hm-space-l: 16px;
  --hm-space-container: var(--hm-space-l);
  --hm-space-group: var(--hm-space-m);
  --hm-space-related: var(--hm-space-s);
  --hm-space-micro: var(--hm-space-xs);
  --hm-space-xl: 24px;
  --hm-control-height: 40px;
  --hm-control-height-s: 28px;
  --hm-control-pad-x: 16px;
  --hm-control-pad-x-s: 12px;
  --hm-icon-size: 24px;
  --hm-list-indent: calc(var(--hm-icon-size) + var(--hm-space-m));
  --hm-toggle-size: 20px;
  --hm-check-border: 1.5px;
  --hm-row-min: 56px;
  --hm-text-gap: 2px;
  --hm-ring: 8px;
  --hm-ring-size: 176px;
  --hm-ring-size-s: 72px;
  --hm-knob-shadow: 0 1px 3px rgba(0,0,0,.20);
  --hm-radius-button: 999px;
  --hm-radius-text-field: 20px;
  --hm-radius-small-button: 14px;
  --hm-radius-panel: 32px;
  --hm-radius-media: 12px;
  --hm-radius-thumbnail: 8px;
  --hm-track: 4px;
  --hm-slider-block: 16px;
  --hm-focus-ring: 2px;
  --hm-action: var(--hm-brand);
  --hm-on-action: var(--hm-on-brand);
  --hm-row-pad-wrap: var(--hm-space-l);
  --hm-group-gap: var(--hm-space-l);
  --hm-tile-pad-x: var(--hm-space-s);
  --hm-tile-gap: var(--hm-space-s);
  --hm-media-ratio: 16 / 9;
  --hm-thumb-size: 64px;
  --hm-primary-value-size: 24px;
  --hm-primary-summary-size: 32px;
  --hm-primary-value-weight: 700;
  --hm-label-col: 72px;
  --hm-text-display: 40px;
  --hm-text-display-s: 32px;
  --hm-chart-1: var(--hm-brand);
  --hm-chart-2: #00bfc9;
  --hm-chart-3: #ff7500;
  --hm-chart-4: #8a2be2;
  --hm-chart-5: #47cc47;
  --hm-chart-6: #e40078;
  --hm-chart-7: #ffbf00;
  --hm-chart-8: #3f56ea;
  --hm-chart-9: #fa2a2d;
  --hm-chart-10: #00aaee;
  --hm-chart-11: #8cd600;
  --hm-chart-muted: rgba(24,36,49,.16);
  --hm-selected-bg: var(--hm-brand-soft);
  --hm-selected-fg: var(--hm-brand);
  --hm-tile-icon: var(--hm-brand);
  --hm-track: 4px;
  --hm-bar: var(--hm-track);

  /* Public names used by Harmony generated HTML. */
  --color-background-primary: var(--hm-card-bg);
  --color-background-secondary: var(--hm-panel-bg);
  --color-background-tertiary: var(--hm-bg-tertiary);
  --color-background-info: rgba(0,125,255,.10);
  --color-background-success: rgba(0,203,135,.10);
  --color-background-warning: rgba(255,117,0,.10);
  --color-background-danger: rgba(250,42,45,.10);
  --color-text-primary: var(--hm-text-primary);
  --color-text-secondary: var(--hm-text-secondary);
  --color-text-tertiary: var(--hm-text-tertiary);
  --color-text-info: var(--hm-brand);
  --color-text-success: #00a874;
  --color-text-warning: #e06700;
  --color-text-danger: #fa2a2d;
  --color-border-primary: var(--hm-border-primary);
  --color-border-secondary: var(--hm-border-secondary);
  --color-border-tertiary: var(--hm-border-tertiary);
  --color-border-info: var(--hm-brand);
  --color-border-success: #00cb87;
  --color-border-warning: #ff7500;
  --color-border-danger: #fa2a2d;
  --font-sans: var(--hm-body-font);
  --font-serif: "Noto Serif SC", Georgia, serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --border-radius-md: 12px;
  --border-radius-lg: 18px;
  --border-radius-xl: 24px;
  --hm-heading-font: "HarmonyOS Sans SC", "HarmonyOS Sans", system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;
  --hm-body-font: "HarmonyOS Sans SC", "HarmonyOS Sans", system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif;

  /* Compatibility aliases for the existing OpenBitFun renderer. */
  --openbitfun-color-content-primary: var(--hm-text-primary);
  --openbitfun-color-content-secondary: var(--hm-text-secondary);
  --openbitfun-color-content-tertiary: var(--hm-text-tertiary);
  --openbitfun-color-accent-default: var(--hm-brand);
  --openbitfun-color-accent-hover: var(--hm-brand-dark);
  --openbitfun-color-border-default: var(--hm-border-tertiary);
  --openbitfun-color-border-strong: var(--hm-border-secondary);
  --openbitfun-color-surface-canvas: var(--hm-panel-bg);
  --openbitfun-color-surface-panel: var(--hm-card-bg);
  --openbitfun-color-surface-subtle: var(--hm-bg-tertiary);
  --openbitfun-color-status-info-content: #007dff;
  --openbitfun-color-status-success-content: #00a874;
  --openbitfun-color-status-warning-content: #e06700;
  --openbitfun-color-status-danger-content: #fa2a2d;
  --openbitfun-type-body-xs-font-size: var(--hm-text-body3);
  --openbitfun-type-body-sm-font-size: var(--hm-text-body2);
  --openbitfun-type-body-md-font-size: var(--hm-text-body1);
  --openbitfun-type-body-lg-font-size: var(--hm-text-headline8);
  --openbitfun-type-heading-panel-font-size: var(--hm-text-body1);
  --openbitfun-type-heading-section-font-size: var(--hm-text-headline8);
  --openbitfun-type-heading-page-font-size: var(--hm-text-headline7);
  --openbitfun-type-display-lg-font-size: 32px;
  --openbitfun-type-body-xs-line-height: 1.4;
  --openbitfun-type-body-sm-line-height: 1.45;
  --openbitfun-type-body-md-line-height: 1.5;
  --openbitfun-type-heading-page-line-height: 1.25;
  --openbitfun-type-heading-page-font-weight: 500;
  --openbitfun-type-heading-section-font-weight: 500;
  --openbitfun-type-heading-panel-font-weight: 500;
  --openbitfun-type-label-selected-font-weight: 500;
  --openbitfun-radius-md: var(--hm-radius-text-field);
  --openbitfun-radius-lg: 18px;
  --openbitfun-radius-xl: 24px;
  --openbitfun-space-1: 4px;
  --openbitfun-space-2: 8px;
  --openbitfun-space-3: 12px;
  --openbitfun-space-4: 16px;
}

:where(.gen-ui-application--harmony-genui[data-hm-theme="indigo"], html[data-hm-theme="indigo"]) { --hm-brand: #5d69d9; --hm-brand-dark: #7f8ff0; --hm-brand-soft: rgba(93,105,217,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="purple"], html[data-hm-theme="purple"]) { --hm-brand: #9957c4; --hm-brand-dark: #b47dda; --hm-brand-soft: rgba(153,87,196,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="rose"], html[data-hm-theme="rose"]) { --hm-brand: #c6467b; --hm-brand-dark: #dd6e98; --hm-brand-soft: rgba(198,70,123,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="orange"], html[data-hm-theme="orange"]) { --hm-brand: #c2520b; --hm-brand-dark: #dc7a4c; --hm-brand-soft: rgba(194,82,11,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="brown"], html[data-hm-theme="brown"]) { --hm-brand: #996a44; --hm-brand-dark: #b88f6e; --hm-brand-soft: rgba(153,106,68,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="green"], html[data-hm-theme="green"]) { --hm-brand: #3a8357; --hm-brand-dark: #6ca881; --hm-brand-soft: rgba(58,131,87,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="teal"], html[data-hm-theme="teal"]) { --hm-brand: #118186; --hm-brand-dark: #5aa7ab; --hm-brand-soft: rgba(17,129,134,.12); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="ink"], html[data-hm-theme="ink"]) { --hm-brand: #222222; --hm-brand-dark: #e6e6e6; --hm-brand-soft: rgba(34,34,34,.10); }

/* The reference system casts the neutral page, text and dark surfaces toward
   the selected accent. Keep the cast explicit so a browser that does not
   implement OKLCH still gets the same stable Harmony palette. */
:where(.gen-ui-application--harmony-genui[data-hm-theme="blue"], html[data-hm-theme="blue"]) { --hm-panel-bg:#eaf4ff; --hm-text-primary:#182431; --hm-text-secondary:rgba(24,36,49,.60); --hm-text-tertiary:rgba(24,36,49,.50); --hm-divider:rgba(24,36,49,.20); --hm-track-bg:rgba(24,36,49,.10); --hm-bg-tertiary:rgba(24,36,49,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="indigo"], html[data-hm-theme="indigo"]) { --hm-panel-bg:#eff2ff; --hm-text-primary:#1e2231; --hm-text-secondary:rgba(30,34,49,.60); --hm-text-tertiary:rgba(30,34,49,.50); --hm-divider:rgba(30,34,49,.20); --hm-track-bg:rgba(30,34,49,.10); --hm-bg-tertiary:rgba(30,34,49,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="purple"], html[data-hm-theme="purple"]) { --hm-panel-bg:#f6f0fc; --hm-text-primary:#271f2e; --hm-text-secondary:rgba(39,31,46,.60); --hm-text-tertiary:rgba(39,31,46,.50); --hm-divider:rgba(39,31,46,.20); --hm-track-bg:rgba(39,31,46,.10); --hm-bg-tertiary:rgba(39,31,46,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="rose"], html[data-hm-theme="rose"]) { --hm-panel-bg:#feeff3; --hm-text-primary:#2f1d23; --hm-text-secondary:rgba(47,29,35,.60); --hm-text-tertiary:rgba(47,29,35,.50); --hm-divider:rgba(47,29,35,.20); --hm-track-bg:rgba(47,29,35,.10); --hm-bg-tertiary:rgba(47,29,35,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="orange"], html[data-hm-theme="orange"]) { --hm-panel-bg:#feefe9; --hm-text-primary:#2f1e17; --hm-text-secondary:rgba(47,30,23,.60); --hm-text-tertiary:rgba(47,30,23,.50); --hm-divider:rgba(47,30,23,.20); --hm-track-bg:rgba(47,30,23,.10); --hm-bg-tertiary:rgba(47,30,23,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="brown"], html[data-hm-theme="brown"]) { --hm-panel-bg:#fcf0e7; --hm-text-primary:#2e1f14; --hm-text-secondary:rgba(46,31,20,.60); --hm-text-tertiary:rgba(46,31,20,.50); --hm-divider:rgba(46,31,20,.20); --hm-track-bg:rgba(46,31,20,.10); --hm-bg-tertiary:rgba(46,31,20,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="green"], html[data-hm-theme="green"]) { --hm-panel-bg:#eaf7ee; --hm-text-primary:#17271c; --hm-text-secondary:rgba(23,39,28,.60); --hm-text-tertiary:rgba(23,39,28,.50); --hm-divider:rgba(23,39,28,.20); --hm-track-bg:rgba(23,39,28,.10); --hm-bg-tertiary:rgba(23,39,28,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="teal"], html[data-hm-theme="teal"]) { --hm-panel-bg:#e6f7f7; --hm-text-primary:#0f2728; --hm-text-secondary:rgba(15,39,40,.60); --hm-text-tertiary:rgba(15,39,40,.50); --hm-divider:rgba(15,39,40,.20); --hm-track-bg:rgba(15,39,40,.10); --hm-bg-tertiary:rgba(15,39,40,.05); }
:where(.gen-ui-application--harmony-genui[data-hm-theme="ink"], html[data-hm-theme="ink"]) { --hm-panel-bg:#f3f3f3; --hm-text-primary:#232323; --hm-text-secondary:rgba(35,35,35,.60); --hm-text-tertiary:rgba(35,35,35,.50); --hm-divider:rgba(35,35,35,.20); --hm-track-bg:rgba(35,35,35,.10); --hm-bg-tertiary:rgba(35,35,35,.05); }

@media (prefers-color-scheme: dark) {
  :where(.gen-ui-application--harmony-genui[data-hm-scheme="auto"], html[data-hm-scheme="auto"]) {
    --hm-panel-bg: #000000;
    --hm-card-bg: #4d5054;
    --hm-text-primary: rgba(255,255,255,.86);
    --hm-text-secondary: rgba(255,255,255,.60);
    --hm-text-tertiary: rgba(255,255,255,.50);
    --hm-border-primary: rgba(255,255,255,.40);
    --hm-border-secondary: rgba(255,255,255,.20);
    --hm-border-tertiary: rgba(255,255,255,.10);
    --hm-bg-tertiary: rgba(255,255,255,.10);
    --hm-brand: var(--hm-brand-dark);
    --hm-brand-soft: color-mix(in srgb, var(--hm-brand) 16%, transparent);
    --hm-divider: rgba(255,255,255,.20);
    --hm-track-bg: rgba(255,255,255,.10);
    --hm-hover: rgba(255,255,255,.10);
    --hm-chart-2: #5aada0;
    --hm-chart-3: #db6b42;
    --hm-chart-4: #8c55c2;
    --hm-chart-5: #5ba854;
    --hm-chart-6: #d64966;
    --hm-chart-7: #d1a738;
    --hm-chart-8: #5f58c7;
    --hm-chart-9: #d94838;
    --hm-chart-10: #4796c4;
    --hm-chart-11: #86ad53;
    --hm-chart-muted: rgba(255,255,255,.16);
    --openbitfun-color-status-info-content: var(--color-text-info);
    --openbitfun-color-status-success-content: var(--color-text-success);
    --openbitfun-color-status-warning-content: var(--color-text-warning);
    --openbitfun-color-status-danger-content: var(--color-text-danger);
  }
}

/* A pinned dark presentation is used for immersive subjects such as cinema,
   music and astronomy, independently of the host OS preference. */
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"], .gen-ui-phone-device[data-hm-scheme="dark"], html[data-hm-scheme="dark"]) {
  --hm-panel-bg: #000000;
  --hm-card-bg: #4d5054;
  --hm-text-primary: rgba(255,255,255,.86);
  --hm-text-secondary: rgba(255,255,255,.60);
  --hm-text-tertiary: rgba(255,255,255,.50);
  --hm-border-primary: rgba(255,255,255,.40);
  --hm-border-secondary: rgba(255,255,255,.20);
  --hm-border-tertiary: rgba(255,255,255,.10);
  --hm-bg-tertiary: rgba(255,255,255,.10);
  --hm-brand: var(--hm-brand-dark);
  --hm-brand-soft: color-mix(in srgb, var(--hm-brand) 16%, transparent);
  --hm-divider: rgba(255,255,255,.20);
  --hm-track-bg: rgba(255,255,255,.10);
  --hm-hover: rgba(255,255,255,.10);
  --hm-chart-2: #5aada0;
  --hm-chart-3: #db6b42;
  --hm-chart-4: #8c55c2;
  --hm-chart-5: #5ba854;
  --hm-chart-6: #d64966;
  --hm-chart-7: #d1a738;
  --hm-chart-8: #5f58c7;
  --hm-chart-9: #d94838;
  --hm-chart-10: #4796c4;
  --hm-chart-11: #86ad53;
  --hm-chart-muted: rgba(255,255,255,.16);
  --openbitfun-color-status-info-content: var(--color-text-info);
  --openbitfun-color-status-success-content: var(--color-text-success);
  --openbitfun-color-status-warning-content: var(--color-text-warning);
  --openbitfun-color-status-danger-content: var(--color-text-danger);
  --color-background-info: rgba(63,151,233,.16);
  --color-background-success: rgba(0,179,119,.16);
  --color-background-warning: rgba(186,85,0,.22);
  --color-background-danger: rgba(230,69,72,.16);
  --color-text-info: #3f97e9;
  --color-text-success: #00b377;
  --color-text-warning: #e08a3c;
  --color-text-danger: #e64548;
  --color-border-info: #3f97e9;
  --color-border-success: #00b377;
  --color-border-warning: #ba5500;
  --color-border-danger: #e64548;
}

:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="blue"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="blue"], html[data-hm-scheme="dark"][data-hm-theme="blue"]) { --hm-panel-bg:#14191e; --hm-card-bg:#2a3138; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="indigo"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="indigo"], html[data-hm-scheme="dark"][data-hm-theme="indigo"]) { --hm-panel-bg:#17181e; --hm-card-bg:#2d2f38; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="purple"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="purple"], html[data-hm-scheme="dark"][data-hm-theme="purple"]) { --hm-panel-bg:#1a171c; --hm-card-bg:#322e36; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="rose"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="rose"], html[data-hm-scheme="dark"][data-hm-theme="rose"]) { --hm-panel-bg:#1d1618; --hm-card-bg:#372d30; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="orange"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="orange"], html[data-hm-scheme="dark"][data-hm-theme="orange"]) { --hm-panel-bg:#1d1714; --hm-card-bg:#372d29; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="brown"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="brown"], html[data-hm-scheme="dark"][data-hm-theme="brown"]) { --hm-panel-bg:#1d1713; --hm-card-bg:#362e28; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="green"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="green"], html[data-hm-scheme="dark"][data-hm-theme="green"]) { --hm-panel-bg:#141a16; --hm-card-bg:#2a322c; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="teal"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="teal"], html[data-hm-scheme="dark"][data-hm-theme="teal"]) { --hm-panel-bg:#121a1a; --hm-card-bg:#273233; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="ink"], .gen-ui-phone-device[data-hm-scheme="dark"][data-hm-theme="ink"], html[data-hm-scheme="dark"][data-hm-theme="ink"]) { --hm-panel-bg:#181818; --hm-card-bg:#303030; }
:where(.gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="orange"], .gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="brown"], .gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="green"], .gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="teal"], .gen-ui-application--harmony-genui[data-hm-scheme="dark"][data-hm-theme="ink"], html[data-hm-scheme="dark"]) { --hm-text-primary:rgba(255,255,255,.86); --hm-text-secondary:rgba(255,255,255,.60); --hm-text-tertiary:rgba(255,255,255,.50); --hm-divider:rgba(255,255,255,.20); --hm-track-bg:rgba(255,255,255,.10); --hm-bg-tertiary:rgba(255,255,255,.10); }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) {
  color: var(--hm-text-primary);
  font-family: var(--hm-body-font);
  font-size: var(--hm-text-body1);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
:where(.gen-ui-application--harmony-genui[data-hm-font="serif"], .gen-ui-application--harmony-genui [data-hm-font="serif"], html[data-hm-theme][data-hm-font="serif"], html[data-hm-theme] [data-hm-font="serif"]) { --hm-heading-font: "Songti SC", "Noto Serif CJK SC", Georgia, serif; }
:where(.gen-ui-application--harmony-genui[data-hm-font="handwritten"], .gen-ui-application--harmony-genui [data-hm-font="handwritten"], html[data-hm-theme][data-hm-font="handwritten"], html[data-hm-theme] [data-hm-font="handwritten"]) { --hm-heading-font: "Kaiti SC", KaiTi, cursive; }
:where(.gen-ui-application--harmony-genui[data-hm-font="tech"], .gen-ui-application--harmony-genui [data-hm-font="tech"], html[data-hm-theme][data-hm-font="tech"], html[data-hm-theme] [data-hm-font="tech"]) { --hm-heading-font: "ZCOOL QingKe HuangYou", var(--hm-body-font); }

/* Component path: map the existing OpenUI component DOM to Harmony anatomy. */
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-col { min-width: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-col.gen-ui-oi-flow { gap: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-flow > * + * { margin-top: var(--hm-space-xl); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-row { gap: var(--hm-space-s); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-grid { gap: var(--hm-space-m); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-card {
  padding: var(--hm-space-l);
  gap: var(--hm-space-m);
  border: 0;
  border-radius: var(--border-radius-xl, 24px);
  background: var(--hm-card-bg);
  color: var(--hm-text-primary);
  font-size: var(--hm-text-body1);
  line-height: 1.5;
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-card.is-soft { background: var(--hm-bg-tertiary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-card .gen-ui-oi-card { padding: var(--hm-space-m); border-radius: 18px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-divider { margin: 0; border-top: 1px solid var(--hm-divider); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title { font-family: var(--hm-heading-font); color: var(--hm-text-primary); font-weight: 500; line-height: 1.25; letter-spacing: normal; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title-3xl { font-size: 32px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title-2xl { font-size: 24px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title-xl,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title-lg { font-size: 20px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title-md { font-size: 16px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-title-sm { font-size: 14px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-text { color: var(--hm-text-primary); font-size: var(--hm-text-body1); line-height: 1.5; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-text-xs,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-caption { color: var(--hm-text-secondary); font-size: var(--hm-text-body3); line-height: 1.45; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-text-sm { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-text-lg { font-size: var(--hm-text-headline8); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-label { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); line-height: 1.4; font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-badge { min-height: 24px; padding: 0 8px; border-radius: 12px; background: var(--hm-bg-tertiary); color: var(--hm-text-secondary); font-size: var(--hm-text-body3); line-height: 24px; font-weight: 400; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-badge-info { background: rgba(0,125,255,.10); color: var(--openbitfun-color-status-info-content); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-badge-success { background: rgba(0,203,135,.10); color: var(--openbitfun-color-status-success-content); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-badge-warning { background: rgba(255,117,0,.10); color: var(--openbitfun-color-status-warning-content); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-badge-danger { background: rgba(250,42,45,.10); color: var(--openbitfun-color-status-danger-content); }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list { gap: 0; padding: 4px 12px; border-radius: 24px; background: var(--hm-card-bg); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list > li { min-height: var(--hm-row-min); padding: var(--hm-space-s) 0; column-gap: var(--hm-space-m); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list > li + li { border-top: 1px solid var(--hm-divider); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list-marker { color: var(--hm-text-secondary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list-item .gen-ui-oi-list-title { color: var(--hm-text-primary); font-size: var(--hm-text-body1); font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list-item .gen-ui-oi-list-description { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list-body { min-width: 0; flex: 1; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list-marker { flex: none; min-width: var(--hm-icon-size); text-align: center; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-list-item { padding: var(--hm-space-s) 0; }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-icon-button,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-pressable { font-family: var(--hm-body-font); border-radius: var(--hm-radius-button); font-size: var(--hm-text-body1); font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button { min-height: var(--hm-control-height); padding: 0 var(--hm-control-pad-x); background: var(--hm-brand); color: var(--hm-on-brand); border: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-outline { background: var(--hm-bg-tertiary); color: var(--hm-text-primary); border: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-soft { background: var(--hm-brand-soft); color: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-ghost,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-text { background: transparent; color: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-danger { background: #fa2a2d; color: #fff; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-success { background: #00a874; color: #fff; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button.is-block { display: flex; width: 100%; justify-content: center; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button .hm-icon { margin-inline-end: var(--hm-space-xs); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-sm { min-height: var(--hm-control-height-s); padding: 0 var(--hm-control-pad-x-s); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-button-lg { min-height: 44px; font-size: var(--hm-text-body1); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-icon-button { width: var(--hm-control-height); height: var(--hm-control-height); padding: 0; border: 0; background: var(--hm-bg-tertiary); color: var(--hm-text-primary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-icon-button-solid { background: var(--hm-brand); color: var(--hm-on-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-icon-button-ghost { background: transparent; color: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-pressable { border: 0; background: var(--hm-card-bg); color: inherit; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-pressable.is-selected { background: var(--hm-brand-soft); color: var(--hm-brand); }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field { gap: var(--hm-space-s); color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field input,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field select,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field textarea { box-sizing: border-box; min-height: var(--hm-control-height); width: 100%; border: 0; border-radius: var(--hm-radius-text-field); padding: 0 var(--hm-control-pad-x); background: var(--hm-bg-tertiary); color: var(--hm-text-primary); font: inherit; font-size: var(--hm-text-body1); outline: none; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field textarea { min-height: 80px; padding-block: 10px; resize: vertical; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field input:focus-visible,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field select:focus-visible,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-field textarea:focus-visible { box-shadow: 0 0 0 var(--hm-focus-ring) var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-segmented { display: flex; gap: 2px; padding: 2px; border: 0; border-radius: var(--hm-radius-button); background: var(--hm-bg-tertiary); overflow-x: auto; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-segmented > button { flex: 1 1 0; min-width: max-content; height: var(--hm-control-height-s); padding: 0 var(--hm-space-s); border: 0; border-radius: var(--hm-radius-button); background: transparent; color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-segmented > button.is-selected { background: var(--hm-card-bg); color: var(--hm-text-primary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-slider { gap: var(--hm-space-s); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-slider-head { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-slider-head output { color: var(--hm-text-primary); font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-slider input[type="range"] { height: 20px; background: transparent; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-slider input[type="range"]::-webkit-slider-runnable-track { height: var(--hm-track); border: 0; border-radius: 2px; background: linear-gradient(to right, var(--hm-brand) calc(var(--hm-p, 0) * 100%), var(--hm-track-bg) 0); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-slider input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--hm-slider-block); height: var(--hm-slider-block); margin-top: -6px; border: 0; border-radius: 50%; background: var(--hm-knob); box-shadow: 0 1px 3px rgba(0,0,0,.20); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-check,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-radio label { color: var(--hm-text-primary); font-size: var(--hm-text-body1); }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-image { margin: 0; border-radius: var(--hm-radius-media) !important; overflow: hidden; background: var(--hm-bg-tertiary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-image img { display: block; width: 100%; height: 100%; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-chart { margin: 0; padding: 0; color: var(--hm-text-primary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-chart svg { max-width: 100%; height: auto; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-chart-grid { stroke: var(--hm-divider); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-chart text { fill: var(--hm-text-secondary); font-size: var(--hm-text-body3); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-chart-legend { color: var(--hm-text-secondary); font-size: var(--hm-text-body3); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-oi-chart {
  --openbitfun-color-accent-default: var(--hm-chart-1);
  --openbitfun-color-status-info-content: var(--hm-chart-2);
  --openbitfun-color-status-warning-content: var(--hm-chart-3);
  --openbitfun-color-status-success-content: var(--hm-chart-5);
  --openbitfun-color-status-danger-content: var(--hm-chart-9);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-metric { gap: var(--hm-space-xs); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-metric > strong { color: var(--hm-text-primary); font-size: 24px; font-weight: 500; line-height: 1.25; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-metric > span { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-steps { gap: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-steps > li { grid-template-columns: 24px minmax(0, 1fr); gap: var(--hm-space-m); min-height: var(--hm-row-min); padding: var(--hm-space-s) 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-step-number { width: 24px; height: 24px; border: 1.5px solid var(--hm-border-primary); border-radius: 50%; color: var(--hm-text-secondary); font-size: var(--hm-text-body3); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-steps > li[data-status="complete"] .gen-ui-step-number { border-color: var(--hm-brand); background: var(--hm-brand-soft); color: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-steps > li[aria-current="step"] .gen-ui-step-number { border-color: var(--hm-brand); color: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-step-status { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }

/* Shared Harmony anatomy. The HTML renderer and trusted OpenUI renderer use
   the same class vocabulary, so a generated document can move between them
   without losing the HarmonyOS proportions or control states. */
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-icon {
  flex: none; width: var(--hm-icon-size); height: var(--hm-icon-size);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--hm-text-primary);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-icon svg { width: var(--hm-icon-size); height: var(--hm-icon-size); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-text {
  flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--hm-text-gap);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-title { color: var(--hm-text-primary); font-size: var(--hm-text-body1); font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-subtitle { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-trailing {
  flex: none; display: inline-flex; align-items: center; gap: var(--hm-space-s);
  color: var(--hm-text-tertiary); font-size: var(--hm-text-body2);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-header {
  color: var(--hm-text-secondary); font-size: var(--hm-text-body2); font-weight: 500;
  padding: var(--hm-space-s) var(--hm-space-m) var(--hm-space-xs);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item ~ .list-item:has(> .list-item-icon:not([hidden], [data-hm-gone])) {
  border-top: 0; position: relative;
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item ~ .list-item:has(> .list-item-icon:not([hidden], [data-hm-gone]))::before {
  content: ""; position: absolute; top: 0; left: var(--hm-list-indent); right: 0; height: 1px; background: var(--hm-divider);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-icon:empty,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .list-item-icon:has([data-icon-missing], [data-hm-gone]) { display: none !important; }

/* HarmonyOS checkbox/radio and ToggleType.Switch. Keep the native controls
   accessible and clickable; only their paint is replaced. */
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) input:is([type="checkbox"]:not(.switch), [type="radio"]) {
  appearance: none; -webkit-appearance: none; flex: none; width: var(--hm-toggle-size); height: var(--hm-toggle-size);
  margin: 0; padding: 0; border: var(--hm-check-border) solid var(--hm-border-primary); border-radius: 50%;
  background: transparent no-repeat center / 100%; cursor: pointer;
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) input:is([type="checkbox"]:not(.switch), [type="radio"]):checked {
  border-color: var(--hm-brand); background-color: var(--hm-brand);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M5.5 10.2l3 3 6-6.4' fill='none' stroke='%23fff' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) input:is([type="checkbox"]:not(.switch), [type="radio"]):focus-visible {
  outline: var(--hm-focus-ring) solid var(--hm-brand); outline-offset: var(--hm-focus-ring);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(input[type="checkbox"], button).switch {
  position: relative; flex: none; width: calc(var(--hm-toggle-size) * 1.8); height: var(--hm-toggle-size);
  min-width: 0; min-height: 0; padding: 0; border: 0; border-radius: calc(var(--hm-toggle-size) / 2);
  appearance: none; -webkit-appearance: none; background: var(--hm-border-secondary); font-size: 0; cursor: pointer;
  transition: background .2s;
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(input[type="checkbox"], button).switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: calc(var(--hm-toggle-size) - 4px); height: calc(var(--hm-toggle-size) - 4px);
  border-radius: 50%; background: var(--hm-knob); box-shadow: var(--hm-knob-shadow); transition: transform .2s;
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(input[type="checkbox"]:checked, button[aria-checked="true"]).switch { background: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(input[type="checkbox"]:checked, button[aria-checked="true"]).switch::after { transform: translateX(calc(var(--hm-toggle-size) * .8)); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(input[type="checkbox"], button).switch:focus-visible { outline: var(--hm-focus-ring) solid var(--hm-brand); outline-offset: var(--hm-focus-ring); }

/* High-level layout primitives used by Harmony prompts and hand-authored HTML. */
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-plan { --hm-part-row-padding: var(--hm-space-l); --hm-part-text-gap: var(--hm-space-xs); --hm-list-edge-padding: var(--hm-space-l); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-plan[data-density="compact"] { --hm-part-row-padding: var(--hm-space-m); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-plan .list > .list-item { padding-block: var(--hm-part-row-padding); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-plan .list-item > .list-item-text { gap: var(--hm-part-text-gap); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-plan .list-item-title { white-space: normal; overflow: visible; text-overflow: clip; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-records .hm-record-priority { flex-direction: column; align-items: stretch; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-record-priority-head,
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-primary-stat { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; gap: var(--hm-space-m); width: 100%; min-width: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-record-priority-head { grid-template-columns: minmax(0, 1fr) fit-content(45%); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-record-metric { display: flex; align-items: baseline; justify-content: flex-end; gap: 4px; min-width: 0; text-align: end; overflow-wrap: anywhere; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-record-metric-value { font-size: var(--hm-primary-value-size); font-weight: var(--hm-primary-value-weight); line-height: 1.3; font-variant-numeric: tabular-nums; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-primary-stat { grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); align-items: center; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-primary-stat > .note { grid-column: 1 / -1; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-catalog .list-item-title { white-space: normal; overflow: visible; text-overflow: clip; }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .icon-circle {
  flex: none; width: var(--hm-control-height); height: var(--hm-control-height); border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center; background: var(--hm-bg-tertiary); color: var(--hm-text-primary);
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .icon-circle.brand { background: var(--hm-brand-soft); color: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .icon-circle.success { background: var(--color-background-success); color: var(--color-text-success); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .icon-circle.warning { background: var(--color-background-warning); color: var(--color-text-warning); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .icon-circle.danger { background: var(--color-background-danger); color: var(--color-text-danger); }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .chips { display: flex; gap: var(--hm-space-s); overflow-x: auto; scrollbar-width: none; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .chips > .chip { flex: none; height: var(--hm-control-height-s); min-height: var(--hm-control-height-s); padding: 0 var(--hm-control-pad-x-s); border-radius: var(--hm-radius-small-button); background: var(--hm-card-bg); color: var(--hm-text-primary); font-size: var(--hm-text-body2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .chips > .chip:is(.active, .selected, .brand, .on, [aria-selected="true"], [aria-pressed="true"], [aria-checked="true"]) { background: var(--hm-brand); color: var(--hm-on-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .progress { height: var(--hm-bar); border-radius: calc(var(--hm-bar) / 2); background: var(--hm-track-bg); overflow: hidden; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .progress-bar { height: 100%; max-width: 100%; border-radius: inherit; background: var(--hm-text-secondary); transition: width .3s; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(.progress.brand .progress-bar, .progress-bar.brand) { background: var(--hm-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .progress.success .progress-bar { background: var(--color-text-success); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .progress.warning .progress-bar { background: var(--color-text-warning); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .progress.danger .progress-bar { background: var(--color-text-danger); }

:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .steps { list-style: none; padding: 0; display: flex; flex-direction: column; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step { position: relative; display: flex; gap: var(--hm-space-m); min-height: var(--hm-row-min); padding: var(--hm-space-s) 0 var(--hm-space-l); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step:last-child { padding-bottom: 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step::before { content: ""; position: absolute; left: calc(var(--hm-icon-size) / 2 - 1px); top: calc(var(--hm-icon-size) + 8px); bottom: 0; width: 2px; background: var(--hm-divider); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step:last-child::before { display: none; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step-dot { flex: none; width: var(--hm-icon-size); height: var(--hm-icon-size); display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--hm-bg-tertiary); color: var(--hm-text-secondary); font-size: var(--hm-text-body3); font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step.done .step-dot { color: var(--hm-text-primary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step.current .step-dot { background: var(--hm-brand); color: var(--hm-on-brand); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--hm-text-gap); padding-top: 1px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .step-title { font-weight: 500; }

/* Progress rings are the one centered visual exception in a Harmony card. */
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring { position: relative; display: grid; place-items: center; width: var(--hm-ring-size); max-width: 100%; aspect-ratio: 1; margin-inline: auto; align-self: center; flex: none; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(.row, .row.between) > .hero-ring { margin-inline: 0; width: var(--hm-ring-size-s); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring > svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) svg.hero-ring { transform: rotate(-90deg); overflow: visible; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(.hero-ring > svg, svg.hero-ring) circle { fill: none; stroke-width: calc(var(--hm-ring) * 120 / 160); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring-track { stroke: var(--hm-track-bg); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring-bar { stroke: var(--hm-brand); stroke-linecap: round; stroke-dasharray: calc(var(--value, 0) * 100) 100; transition: stroke-dasharray .3s; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring-label { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; text-align: center; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring-value { font-size: var(--hm-text-display); font-weight: 500; line-height: 1.15; font-variant-numeric: tabular-nums; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hero-ring-caption { color: var(--hm-text-secondary); font-size: var(--hm-text-body3); }

/* Timeline and media primitives keep generated data dense without becoming
   cramped on the 328px content column. */
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .timeline { list-style: none; padding: 0; display: flex; flex-direction: column; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .timeline > li + li { border-top: 1px solid var(--hm-divider); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .tl-item { display: grid; grid-template-columns: var(--hm-label-col) minmax(0, 1fr) auto; min-height: var(--hm-row-min); align-items: start; gap: var(--hm-space-m); padding: var(--hm-space-m) 0; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .tl-time { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); font-variant-numeric: tabular-nums; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .tl-body { min-width: 0; display: flex; flex-direction: column; gap: var(--hm-text-gap); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .tl-title { font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .media { position: relative; display: block; margin: 0; overflow: hidden; aspect-ratio: var(--hm-media-ratio); border-radius: var(--hm-radius-media); background: var(--hm-bg-tertiary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .media > img { display: block; width: 100%; height: 100%; max-width: none; object-fit: cover; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .media.square { aspect-ratio: 1; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .media.tall { aspect-ratio: 3 / 4; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) :is(.row, .list-item) > .media { flex: none; width: var(--hm-thumb-size); height: var(--hm-thumb-size); aspect-ratio: 1; border-radius: var(--hm-radius-thumbnail); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot { margin: 0; min-width: 0; max-width: 560px; margin-inline: auto; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot figcaption { margin-bottom: var(--hm-space-m); color: var(--hm-text-secondary); font-size: var(--hm-text-body2); font-weight: 500; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot svg { display: block; width: 100%; max-width: 100%; height: auto; overflow: visible; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-plot-data { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl { font-family: var(--hm-body-font); font-size: var(--hm-text-body3); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-grid line { stroke: var(--hm-divider); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-axes line { stroke: var(--hm-text-secondary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot text { fill: var(--hm-text-secondary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s { fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dash { stroke-dasharray: 6 4; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot { stroke: var(--hm-card-bg); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s0 { stroke: var(--hm-chart-1); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot.hm-pl-s0 { fill: var(--hm-chart-1); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s1 { stroke: var(--hm-chart-3); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot.hm-pl-s1 { fill: var(--hm-chart-3); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s2 { stroke: var(--hm-chart-5); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot.hm-pl-s2 { fill: var(--hm-chart-5); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s3 { stroke: var(--hm-chart-2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot.hm-pl-s3 { fill: var(--hm-chart-2); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s4 { stroke: var(--hm-chart-9); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot.hm-pl-s4 { fill: var(--hm-chart-9); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-s5 { stroke: var(--hm-text-primary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-dot.hm-pl-s5 { fill: var(--hm-text-primary); }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-rule { stroke: var(--hm-text-secondary); fill: none; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .gen-ui-plot .hm-pl-mark { fill: var(--hm-text-primary); }

/* The HTML document path uses the same small anatomy as the reference
   Harmony examples. These selectors are intentionally scoped to a Harmony
   document, so free HTML and the host application keep their own styles. */
:where(html[data-hm-theme]) *,
:where(.gen-ui-application--harmony-genui) * { box-sizing: border-box; }
:where(html[data-hm-theme]) [data-hm-action="ink"],
:where(.gen-ui-application--harmony-genui) [data-hm-action="ink"] { --hm-action: #000000; --hm-on-action: #ffffff; }
:where(html[data-hm-theme]) [data-hm-action="success"],
:where(.gen-ui-application--harmony-genui) [data-hm-action="success"] { --hm-action: #00a874; --hm-on-action: #ffffff; }
:where(html[data-hm-theme]) [data-hm-action="danger"],
:where(.gen-ui-application--harmony-genui) [data-hm-action="danger"] { --hm-action: #fa2a2d; --hm-on-action: #ffffff; }
:where(html[data-hm-theme]) button[data-hm-action],
:where(.gen-ui-application--harmony-genui) button[data-hm-action] { background: var(--hm-action); color: var(--hm-on-action); }
:where(html[data-hm-theme]) h1,
:where(html[data-hm-theme]) h2,
:where(html[data-hm-theme]) h3,
:where(html[data-hm-theme]) h4,
:where(html[data-hm-theme]) h5,
:where(html[data-hm-theme]) h6 { margin: 0; }
:where(html[data-hm-theme]) button,
:where(.gen-ui-application--harmony-genui) button { cursor: pointer; transition: background .15s, transform .12s; }
:where(html[data-hm-theme]) button:hover,
:where(.gen-ui-application--harmony-genui) button:hover { background: var(--hm-hover); }
:where(html[data-hm-theme]) button:active,
:where(.gen-ui-application--harmony-genui) button:active { background: var(--hm-click-effect); transform: scale(.96); }
:where(html[data-hm-theme]) button:focus-visible,
:where(.gen-ui-application--harmony-genui) button:focus-visible { outline: var(--hm-focus-ring) solid var(--hm-brand); outline-offset: var(--hm-focus-ring); }
:where(html[data-hm-theme]) button:disabled,
:where(.gen-ui-application--harmony-genui) button:disabled { opacity: .4; cursor: not-allowed; transform: none; }
:where(html[data-hm-theme]) .page { padding-bottom: var(--hm-space-l); }
:where(html[data-hm-theme]) .page > * + * { margin-top: 0; }
:where(html[data-hm-theme]) .page-header + .card { margin-top: 0; }
:where(html[data-hm-theme]) .card { overflow-wrap: break-word; }
:where(html[data-hm-theme]) .card > * + * { margin-top: var(--hm-space-m); }
:where(html[data-hm-theme]) .card > .card-title + *,
:where(html[data-hm-theme]) .card > .section-title:first-child + * { margin-top: 0; }
:where(html[data-hm-theme]) .section-title { padding: var(--hm-space-s) var(--hm-space-xs) 0; color: var(--hm-text-secondary); font-size: var(--hm-text-body2); font-weight: 500; }
:where(html[data-hm-theme]) .card > .section-title:first-child { padding: 0 0 var(--hm-space-s); }
:where(html[data-hm-theme]) .card-title { display: block; margin-bottom: var(--hm-space-s); }
:where(html[data-hm-theme]) .part { padding-top: var(--hm-space-m); border-top: 1px solid var(--hm-divider); }
:where(html[data-hm-theme]) .row > .card-title,
:where(html[data-hm-theme]) .row > .section-title { margin: 0; padding-block: 0; }
:where(html[data-hm-theme]) .button-row { display: flex; flex-direction: row; gap: var(--hm-space-m); }
:where(html[data-hm-theme]) .button-row > button { flex: 1; }
:where(html[data-hm-theme]) .icon-btn { width: var(--hm-control-height); height: var(--hm-control-height); padding: 0; display: inline-flex; align-items: center; justify-content: center; }
:where(html[data-hm-theme]) button.small,
:where(html[data-hm-theme]) button[data-size="small"] { min-height: var(--hm-control-height-s); height: var(--hm-control-height-s); padding-inline: var(--hm-control-pad-x-s); border-radius: var(--hm-radius-small-button); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .summary { display: flex; flex-direction: column; gap: var(--hm-space-xs); }
:where(html[data-hm-theme]) .eyebrow { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .hero-value { font-size: 32px; font-weight: 500; line-height: 1.15; font-variant-numeric: tabular-nums; }
:where(html[data-hm-theme]) .num { font-variant-numeric: tabular-nums; }
:where(html[data-hm-theme]) .stat { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 2px; row-gap: var(--hm-space-xs); }
:where(html[data-hm-theme]) .stat > :not(.stat-value, .stat-unit) { flex: 1 0 100%; }
:where(html[data-hm-theme]) .stat-label { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .stat-value { font-size: var(--hm-text-headline7); font-weight: 500; font-variant-numeric: tabular-nums; }
:where(html[data-hm-theme]) .stat-unit,
:where(html[data-hm-theme]) .stat-note { color: var(--hm-text-secondary); font-size: var(--hm-text-body3); }
:where(html[data-hm-theme]) .kv { display: flex; justify-content: space-between; align-items: baseline; gap: var(--hm-space-m); padding: 6px 0; font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .kv > :first-child { color: var(--hm-text-secondary); }
:where(html[data-hm-theme]) .kv > :last-child { margin-left: auto; font-weight: 500; font-variant-numeric: tabular-nums; }
:where(html[data-hm-theme]) .empty { padding: var(--hm-space-xl) var(--hm-space-l); color: var(--hm-text-secondary); text-align: center; font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .note { padding: 0 var(--hm-space-xs); }
:where(html[data-hm-theme]) .tag { min-height: 24px; padding: 0 8px; }
:where(html[data-hm-theme]) .tag.success { background: rgba(0,203,135,.10); color: #00a874; }
:where(html[data-hm-theme]) .tag.warning { background: rgba(255,117,0,.10); color: #e06700; }
:where(html[data-hm-theme]) .tag.danger { background: rgba(250,42,45,.10); color: #fa2a2d; }
:where(html[data-hm-theme]) .tag.neutral { background: var(--hm-bg-tertiary); color: var(--hm-text-secondary); }
:where(html[data-hm-theme]) .tag.brand { background: var(--hm-brand-soft); color: var(--hm-brand); }
:where(html[data-hm-theme]) .segmented { gap: 2px; padding: 2px; border-radius: var(--hm-radius-button); background: var(--hm-bg-tertiary); }
:where(html[data-hm-theme]) .segmented > button { min-height: var(--hm-control-height-s); height: var(--hm-control-height-s); padding: 0 var(--hm-space-s); border: 0; background: transparent; color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .segmented > button:is(.active, .selected, [aria-selected="true"], [aria-pressed="true"]) { background: var(--hm-card-bg); color: var(--hm-text-primary); }
:where(html[data-hm-theme]) input[type="text"],
:where(html[data-hm-theme]) input[type="number"],
:where(html[data-hm-theme]) input[type="email"],
:where(html[data-hm-theme]) input[type="search"],
:where(html[data-hm-theme]) input[type="date"],
:where(html[data-hm-theme]) input[type="time"],
:where(html[data-hm-theme]) textarea,
:where(html[data-hm-theme]) select { min-width: 0; max-width: 100%; height: var(--hm-control-height); min-height: var(--hm-control-height); border: 0; border-radius: var(--hm-radius-text-field); padding: 0 var(--hm-control-pad-x); background: var(--hm-bg-tertiary); color: var(--hm-text-primary); font: var(--hm-text-body1)/1.4 var(--hm-body-font); transition: background .15s, box-shadow .15s; }
:where(html[data-hm-theme]) textarea { height: auto; min-height: 80px; padding-block: 10px; resize: vertical; }
:where(html[data-hm-theme]) input:hover,
:where(html[data-hm-theme]) textarea:hover,
:where(html[data-hm-theme]) select:hover { background: var(--hm-hover); }
:where(html[data-hm-theme]) input:focus-visible,
:where(html[data-hm-theme]) textarea:focus-visible,
:where(html[data-hm-theme]) select:focus-visible { outline: 0; box-shadow: 0 0 0 var(--hm-focus-ring) var(--hm-brand); }
:where(html[data-hm-theme]) .field { display: flex; flex-direction: column; gap: var(--hm-space-s); color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .field > input,
:where(html[data-hm-theme]) .field > select,
:where(html[data-hm-theme]) .field > textarea { width: 100%; }
:where(html[data-hm-theme]) .slider-row { display: flex; flex-direction: column; gap: var(--hm-space-s); }
:where(html[data-hm-theme]) input[type="range"] { width: 100%; height: 20px; accent-color: var(--hm-brand); background: transparent; }
:where(html[data-hm-theme]) input[type="range"]::-webkit-slider-runnable-track { height: var(--hm-track); border: 0; border-radius: 2px; background: var(--hm-track-bg); }
:where(html[data-hm-theme]) input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--hm-slider-block); height: var(--hm-slider-block); margin-top: -6px; border: 0; border-radius: 50%; background: var(--hm-knob); box-shadow: 0 1px 3px rgba(0,0,0,.20); }
:where(html[data-hm-theme]) img { max-width: 100%; height: auto; }
:where(html[data-hm-theme]) .media { display: block; margin: 0; overflow: hidden; aspect-ratio: 16 / 9; border-radius: var(--hm-radius-media); background: var(--hm-bg-tertiary); }
:where(html[data-hm-theme]) .media > img { display: block; width: 100%; height: 100%; max-width: none; object-fit: cover; }
:where(html[data-hm-theme]) .media.square { aspect-ratio: 1; }
:where(html[data-hm-theme]) .media.tall { aspect-ratio: 3 / 4; }
:where(html[data-hm-theme]) .media-credit { display: none; }
:where(html[data-hm-theme]) .disclosure { color: var(--hm-text-primary); }
:where(html[data-hm-theme]) .page > .disclosure { padding: var(--hm-space-xs) var(--hm-space-l); border-radius: 24px; background: var(--hm-card-bg); }
:where(html[data-hm-theme]) .disclosure > summary { display: flex; align-items: center; justify-content: space-between; min-height: var(--hm-control-height); cursor: pointer; font-weight: 500; }
:where(html[data-hm-theme]) .error { color: #fa2a2d; font-size: var(--hm-text-body3); }

/* HTML document path: the same HarmonyOS building blocks as the reference app. */
:where(html[data-hm-theme]) { background: var(--hm-panel-bg); color: var(--hm-text-primary); font-family: var(--hm-body-font); }
:where(html[data-hm-theme]) body { margin: 0; min-height: 100%; background: var(--hm-panel-bg); color: var(--hm-text-primary); font: var(--hm-text-body1)/1.5 var(--hm-body-font); }
:where(html[data-hm-theme]) .page { display: flex; flex-direction: column; gap: var(--hm-space-m); padding: 0 0 var(--hm-space-l); }
:where(html[data-hm-theme]) .page-header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--hm-space-m); padding: var(--hm-space-l) 0 var(--hm-space-xs); }
:where(html[data-hm-theme]) h1, :where(html[data-hm-theme]) h2, :where(html[data-hm-theme]) h3, :where(html[data-hm-theme]) .card-title { margin: 0; font-family: var(--hm-heading-font); font-weight: 500; }
:where(html[data-hm-theme]) h1 { font-size: var(--hm-text-headline7); line-height: 1.25; }
:where(html[data-hm-theme]) h2, :where(html[data-hm-theme]) .card-title { font-size: var(--hm-text-headline8); line-height: 1.3; }
:where(html[data-hm-theme]) h3 { font-size: var(--hm-text-body1); }
:where(html[data-hm-theme]) .card { padding: var(--hm-space-l); border-radius: 24px; background: var(--hm-card-bg); }
:where(html[data-hm-theme]) .stack { display: flex; flex-direction: column; gap: var(--hm-space-m); }
:where(html[data-hm-theme]) .row { display: flex; align-items: center; gap: var(--hm-space-s); min-width: 0; }
:where(html[data-hm-theme]) .row.between { justify-content: space-between; }
:where(html[data-hm-theme]) .grid-2, :where(html[data-hm-theme]) .grid-3 { display: grid; gap: var(--hm-space-m); }
:where(html[data-hm-theme]) .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
:where(html[data-hm-theme]) .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--hm-space-s); }
:where(html[data-hm-theme]) .muted, :where(html[data-hm-theme]) .subtitle { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .note, :where(html[data-hm-theme]) .caption, :where(html[data-hm-theme]) small { color: var(--hm-text-secondary); font-size: var(--hm-text-body3); }
:where(html[data-hm-theme]) .list { margin: 0; padding: 4px 12px; border-radius: 24px; background: var(--hm-card-bg); list-style: none; }
:where(html[data-hm-theme]) .list-item { display: flex; align-items: center; gap: var(--hm-space-m); min-height: var(--hm-row-min); padding: var(--hm-space-s) 0; }
:where(html[data-hm-theme]) .list-item + .list-item { border-top: 1px solid var(--hm-divider); }
:where(html[data-hm-theme]) .list-item-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
:where(html[data-hm-theme]) .list-item-title { font-size: var(--hm-text-body1); font-weight: 500; }
:where(html[data-hm-theme]) .list-item-subtitle { color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .list-item-trailing { color: var(--hm-text-tertiary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .tag { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 12px; background: var(--hm-bg-tertiary); color: var(--hm-text-secondary); font-size: var(--hm-text-body3); }
:where(html[data-hm-theme]) .tag.brand { background: var(--hm-brand-soft); color: var(--hm-brand); }
:where(html[data-hm-theme]) button { min-height: var(--hm-control-height); padding: 0 var(--hm-control-pad-x); border: 0; border-radius: var(--hm-radius-button); background: var(--hm-bg-tertiary); color: var(--hm-text-primary); font: 500 var(--hm-text-body1)/1 var(--hm-body-font); }
:where(html[data-hm-theme]) button.primary { background: var(--hm-action); color: var(--hm-on-action); }
:where(html[data-hm-theme]) button.text { padding-inline: 4px; background: transparent; color: var(--hm-brand); }
:where(html[data-hm-theme]) input, :where(html[data-hm-theme]) select, :where(html[data-hm-theme]) textarea { min-height: var(--hm-control-height); border: 0; border-radius: var(--hm-radius-text-field); padding: 0 var(--hm-control-pad-x); background: var(--hm-bg-tertiary); color: var(--hm-text-primary); font: var(--hm-text-body1)/1.4 var(--hm-body-font); }
:where(html[data-hm-theme]) textarea { min-height: 80px; padding-block: 10px; }
:where(html[data-hm-theme]) .field { display: flex; flex-direction: column; gap: var(--hm-space-s); color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .segmented { display: flex; gap: 2px; padding: 2px; border-radius: var(--hm-radius-button); background: var(--hm-bg-tertiary); }
:where(html[data-hm-theme]) .segmented > button { flex: 1 1 0; min-width: 0; min-height: var(--hm-control-height-s); background: transparent; color: var(--hm-text-secondary); font-size: var(--hm-text-body2); }
:where(html[data-hm-theme]) .segmented > button.active, :where(html[data-hm-theme]) .segmented > button[aria-selected="true"] { background: var(--hm-card-bg); color: var(--hm-text-primary); }
:where(html[data-hm-theme]) hr { height: 1px; border: 0; background: var(--hm-divider); }
:where(html[data-hm-theme]) a { color: var(--hm-brand); text-decoration: none; }
:where(html[data-hm-theme]) .hm-icon { display: inline-flex; width: 1em; height: 1em; align-items: center; justify-content: center; color: currentColor; }
` + `
@font-face { font-family: "HM Symbol"; src: url("/fonts/hm-symbol/HMSymbolVF.ttf") format("truetype"); font-display: block; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-icon,
:where(html[data-hm-theme]) .hm-icon {
  font-family: "HM Symbol"; font-style: normal; font-weight: 400;
  line-height: 1; font-size: 24px; -webkit-font-smoothing: antialiased;
}
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-icon.small,
:where(html[data-hm-theme]) .hm-icon.small { font-size: 16px; }
:where(.gen-ui-application--harmony-genui, html[data-hm-theme]) .hm-icon.large,
:where(html[data-hm-theme]) .hm-icon.large { font-size: 32px; }
${HARMONY_ICON_CSS}`;

export const HARMONY_STYLE_RESOURCE_IDS = ['openbitfun-harmony-components', 'harmony-theme-tokens'] as const;
import { HM_ICON_CODEPOINTS } from './hm-icons';


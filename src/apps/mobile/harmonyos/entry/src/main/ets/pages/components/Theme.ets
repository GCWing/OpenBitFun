export const PAGE_BG: ResourceColor = $r('app.color.page_bg');
/** PAGE_BG at zero alpha, per theme — the transparent end of a fade-out. */
export const PAGE_BG_FADE: ResourceColor = $r('app.color.page_bg_fade');
/**
 * PAGE_BG at partial alpha, for a surface the transcript scrolls underneath.
 * It is the floor under `backgroundBlurStyle`, not a replacement for it: the
 * blur carries the effect, this keeps the text on top readable on a build or a
 * device where the blur does not land.
 */
export const PAGE_BG_OVERLAY: ResourceColor = $r('app.color.page_bg_overlay');
export const TRANSPARENT: ResourceColor = $r('app.color.transparent');
export const INK: ResourceColor = $r('app.color.ink');
export const MUTED: ResourceColor = $r('app.color.muted');
export const SUBTLE: ResourceColor = $r('app.color.subtle');
export const LINE: ResourceColor = $r('app.color.line');
export const CARD: ResourceColor = $r('app.color.card');
/** CARD at partial alpha, for a card that floats over scrolling content. */
export const CARD_OVERLAY: ResourceColor = $r('app.color.card_overlay');
export const ACCENT: ResourceColor = $r('app.color.accent');
export const FILE_LINK: ResourceColor = $r('app.color.file_link');
export const PRIMARY_ACTION: ResourceColor = $r('app.color.primary_action');
export const CONTENT_ON_ACTION: ResourceColor = $r('app.color.content_on_action');
export const CONNECT_HERO_BG: ResourceColor = $r('app.color.connect_hero_bg');
export const CONNECT_HERO_ACCENT: ResourceColor = $r('app.color.connect_hero_accent');
export const CONNECT_HERO_SECONDARY: ResourceColor = $r('app.color.connect_hero_secondary');
export const CONNECT_HERO_SURFACE: ResourceColor = $r('app.color.connect_hero_surface');
export const CONNECT_SCAN_ACCENT: ResourceColor = $r('app.color.connect_scan_accent');
export const SCRIM: ResourceColor = $r('app.color.scrim');
export const SHELL_SCRIM: ResourceColor = $r('app.color.shell_scrim');
export const MEDIA_BACKGROUND: ResourceColor = $r('app.color.media_background');
export const MEDIA_SCRIM: ResourceColor = $r('app.color.media_scrim');
export const MEDIA_CONTROL_BACKGROUND: ResourceColor = $r('app.color.media_control_background');
export const TOAST_BACKGROUND: ResourceColor = $r('app.color.toast_background');
export const SHADOW_FAINT: ResourceColor = $r('app.color.shadow_faint');
export const SHADOW_SUBTLE: ResourceColor = $r('app.color.shadow_subtle');
export const SHADOW_MEDIUM: ResourceColor = $r('app.color.shadow_medium');
export const SHADOW_STRONG: ResourceColor = $r('app.color.shadow_strong');
export const FLOATING_BORDER: ResourceColor = $r('app.color.floating_border');
export const SOFT: ResourceColor = $r('app.color.soft');
export const FLOATING_PANEL_BG: ResourceColor = $r('app.color.floating_panel_bg');
export const STATUS_SUCCESS: ResourceColor = $r('app.color.status_success');
export const STATUS_DANGER: ResourceColor = $r('app.color.status_danger');
export const STATUS_WARNING: ResourceColor = $r('app.color.status_warning');
export const CODE_LINE_NUMBER: ResourceColor = $r('app.color.code_line_number');
export const CODE_KEYWORD: ResourceColor = $r('app.color.code_keyword');
export const CODE_STRING: ResourceColor = $r('app.color.code_string');
export const CODE_NUMBER: ResourceColor = $r('app.color.code_number');
export const CODE_COMMENT: ResourceColor = $r('app.color.code_comment');
export const CODE_FUNCTION: ResourceColor = $r('app.color.code_function');
export const CODE_TYPE: ResourceColor = $r('app.color.code_type');
export const CODE_CONSTANT: ResourceColor = $r('app.color.code_constant');
export const CODE_PROPERTY: ResourceColor = $r('app.color.code_property');
export const CODE_TARGET_BG: ResourceColor = $r('app.color.code_target_bg');

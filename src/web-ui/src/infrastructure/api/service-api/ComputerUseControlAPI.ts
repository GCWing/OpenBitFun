import { api } from './ApiClient';

export interface ComputerUseControlSnapshot {
  supported: boolean;
  generation: number;
  target_revision?: number;
  owner: string | null;
  mode: 'observe' | 'background' | 'foreground';
  state: string;
  target: string | null;
  action: string | null;
  sequence: number;
  reason: string | null;
  pointer: { x: number; y: number; click: boolean; sequence?: number; occurred_at_ms?: number;
    last_click?: { x: number; y: number; sequence: number; occurred_at_ms: number } | null } | null;
  capabilities: string[];
  sharing?: {
    phase: 'selecting' | 'starting' | 'shared';
    requested_mode: 'observe' | 'background' | 'foreground';
    target_label: string | null;
    control_enabled: boolean;
    authorization_revision: number;
    remembered?: boolean;
    grant_note?: string | null;
  } | null;
  background_observation?: {
    sequence: number;
    foreground_unchanged: boolean;
    cursor_unchanged: boolean | null;
    window_order_unchanged: boolean | null;
    scope: string;
  } | null;
}

export type ComputerUsePermissionKind = 'accessibility' | 'screen_recording' | 'input_posting' | 'input_monitoring';
export interface ComputerUsePermission {
  kind: ComputerUsePermissionKind;
  state: 'granted' | 'required' | 'session_required' | 'not_required' | 'unavailable';
  requestable: boolean;
  settings_url: string | null;
  detail: string;
}
export interface ComputerUsePermissions {
  platform: string;
  process_id: number;
  executable: string | null;
  permissions: ComputerUsePermission[];
  prompts_requested: boolean;
}
export interface ComputerUsePermissionReceipt {
  kind: ComputerUsePermissionKind;
  already_granted: boolean;
  current_granted: boolean;
  request_api_invoked: boolean;
  prompt_requested: boolean;
  prompt_visibility_observed: boolean;
  api_returned_granted: boolean | null;
  requires_user_action: boolean;
  restart_may_be_required: boolean;
  permission: ComputerUsePermission;
  permission_owner: string;
}
export interface ComputerUseShareTarget {
  id: string;
  selection_id: string;
  unavailable_reason?: string | null;
  pid: number | null;
  window_id: number | null;
  application: string;
  title: string;
  bundle_id: string | null;
  background_pointer: boolean;
  background_semantic: boolean;
  selection_required: boolean;
}
export interface ComputerUseGrantIdentity {
  bundle_id: string | null;
  executable: string;
  executable_sha256: string;
  input_mode: string;
  [extension: string]: unknown;
}
export interface ComputerUseGrant {
  identity: ComputerUseGrantIdentity;
  application_name: string;
  granted_at_unix_ms: number;
}

export interface ComputerUseControlPreview {
  generation: number;
  target_revision?: number;
  target: string;
  image_base64: string;
  mime_type: string;
  width: number;
  height: number;
  origin_x: number;
  origin_y: number;
  span_width: number;
  span_height: number;
}

export interface ComputerUseSharedFrame {
  screenshot_id: string;
  image_base64: string;
  mime_type: string;
  width: number;
  height: number;
  content: { left: number; top: number; width: number; height: number };
  bounds: { left: number; top: number; width: number; height: number } | null;
}
export type PreviewPoint = { kind: 'image_xy'; x: number; y: number; screenshot_id: string };
export type PreviewInput =
  | { action: 'app_click'; target: PreviewPoint; click_count: number; mouse_button: string; modifier_keys: string[] }
  | { action: 'app_drag'; from: PreviewPoint; to: PreviewPoint; mouse_button: string; duration_ms: number }
  | { action: 'app_scroll'; focus: PreviewPoint; dx: number; dy: number }
  | { action: 'app_type_text'; text: string }
  | { action: 'app_key_chord'; keys: string[] };
const sharedScope = (snapshot: ComputerUseControlSnapshot) => ({ generation: snapshot.generation,
  target_revision: snapshot.target_revision ?? 0, authorization_revision: snapshot.sharing?.authorization_revision ?? 0 });

export const computerUseControlAPI = {
  status: () => api.invoke<ComputerUseControlSnapshot>('computer_use_control_status'),
  stop: (generation: number) => api.invoke<ComputerUseControlSnapshot>(
    'computer_use_control_stop', { request: { generation } },
  ),
  preview: (generation: number) => api.invoke<ComputerUseControlPreview | null>(
    'computer_use_control_preview', { request: { generation } },
  ),
  permissions: () => api.invoke<{ permissions?: ComputerUsePermissions }>('computer_use_get_status'),
  requestPermission: (kind: ComputerUsePermissionKind) => api.invoke<ComputerUsePermissionReceipt>(
    'computer_use_request_permission', { request: { kind } },
  ),
  openPermissionSettings: (kind: ComputerUsePermissionKind) => api.invoke<void>(
    'computer_use_open_system_settings', { request: { pane: kind } },
  ),
  requestShare: (mode: ComputerUseControlSnapshot['mode'] = 'background', owner?: string) => api.invoke<ComputerUseControlSnapshot>(
    'computer_use_share_request', { request: { mode, ...(owner ? { owner } : {}) } },
  ),
  targets: () => api.invoke<ComputerUseShareTarget[]>('computer_use_share_targets'),
  startShare: (generation: number, target: string, mode: ComputerUseControlSnapshot['mode']) => api.invoke<ComputerUseControlSnapshot>(
    'computer_use_share_start', { request: { generation, target, mode } },
  ),
  control: (snapshot: ComputerUseControlSnapshot, enabled: boolean, remember = false) => api.invoke<ComputerUseControlSnapshot>(
    'computer_use_share_control', { request: { generation: snapshot.generation, target_revision: snapshot.target_revision ?? 0,
      authorization_revision: snapshot.sharing?.authorization_revision ?? 0, enabled, remember } },
  ),
  grants: () => api.invoke<ComputerUseGrant[]>('computer_use_share_grants'),
  forgetGrant: (identity: ComputerUseGrantIdentity) => api.invoke<string | null>(
    'computer_use_share_forget_grant', { request: { identity } },
  ),
  observeShare: (snapshot: ComputerUseControlSnapshot) => api.invoke<{
    control: ComputerUseControlSnapshot; frame: ComputerUseSharedFrame | null; tree: string | null;
  }>('computer_use_share_observe', { request: sharedScope(snapshot) }),
  inputShare: (snapshot: ComputerUseControlSnapshot, input: PreviewInput) => api.invoke<ComputerUseControlSnapshot>(
    'computer_use_share_input', { request: { ...sharedScope(snapshot), input } },
  ),
};

/** Reject points outside the captured content rather than clamping to an edge. */
export function projectControlPointer(
  frame: ComputerUseControlPreview,
  pointer: ComputerUseControlSnapshot['pointer'],
): { x: number; y: number; click: boolean } | null {
  if (!pointer || ![frame.origin_x, frame.origin_y, frame.span_width, frame.span_height,
    pointer.x, pointer.y].every(Number.isFinite) || frame.span_width <= 0 || frame.span_height <= 0) return null;
  const x = (pointer.x - frame.origin_x) / frame.span_width;
  const y = (pointer.y - frame.origin_y) / frame.span_height;
  return x >= 0 && x < 1 && y >= 0 && y < 1 ? { x, y, click: pointer.click } : null;
}

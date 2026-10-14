// The static surface has no direct filesystem, shell or main-app connection.
export function invoke(command, payload) {
  return window.__TAURI__.core.invoke(command, payload);
}

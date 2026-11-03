// The path the app is served under, set at build time. Unset, the app runs at the root. On
// openui.com the docs app proxies a path such as /demo/intelligent-ui to this deployment. The
// upstream package reads NEXT_PUBLIC_BASE_PATH through Next.js; BitFun runs in Vite/Tauri, so
// this browser module must only read Vite's import.meta.env and must never reference Node's
// process global. VITE_BASE_PATH is the product name; the other keys keep deployments that
// already use the upstream naming convention working when they explicitly expose it to Vite.
const env = import.meta.env as Record<string, string | undefined>;
const configuredBasePath = env.VITE_BASE_PATH ?? env.VITE_NEXT_PUBLIC_BASE_PATH ?? env.NEXT_PUBLIC_BASE_PATH;
export const BASE_PATH = configuredBasePath?.replace(/\/+$/, "") ?? "";

export const withBase = (path: string) => `${BASE_PATH}${path}`;

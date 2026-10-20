// Compile production WGC/UIA/MSAA/control modules without linking the desktop shell.
// Cross-host mode checks types only; it never claims native Windows execution.
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
if (process.platform !== 'win32' && !check) {
  throw new Error('Native tests require Windows. Use --check --target x86_64-pc-windows-msvc for a compile-only check.');
}
const dir = await mkdtemp(join(tmpdir(), 'openbitfun-windows-native-'));
const source = (path) => JSON.stringify(resolve(root, path));
try {
  const host = await readFile(join(root, 'src/crates/assembly/core/src/agentic/tools/computer_use_host.rs'), 'utf8');
  const lease = host.match(/pub trait ComputerUseActionLease:[\s\S]*?\n\}/)?.[0];
  if (!lease) throw new Error('The production lease trait could not be extracted.');
  await writeFile(join(dir, 'Cargo.toml'), `[package]
name = "windows-computer-use-native-tests"
version = "0.0.0"
edition = "2021"
[workspace]
[lib]
path = "lib.rs"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha1 = "0.10"
sha2 = "0.10"
tempfile = "3"
log = "0.4"
tokio = { version = "1", default-features = false, features = ["rt-multi-thread", "macros", "sync", "time"] }
screenshots = "0.8"
base64 = "0.22"
image = { version = "0.25", default-features = false, features = ["jpeg", "png"] }
windows = { version = "0.61", features = [
  "Foundation", "Graphics_Capture", "Graphics_DirectX", "Graphics_DirectX_Direct3D11",
  "Win32_Foundation", "Win32_Graphics_Direct3D", "Win32_Graphics_Direct3D11",
  "Win32_Graphics_Dwm", "Win32_Graphics_Dxgi", "Win32_Graphics_Dxgi_Common", "Win32_Graphics_Gdi",
  "Win32_System_Com", "Win32_System_Ole", "Win32_System_Variant", "Win32_System_LibraryLoader",
  "Win32_System_Threading", "Win32_System_WinRT", "Win32_System_WinRT_Direct3D11",
  "Win32_System_WinRT_Graphics_Capture", "Win32_UI_Accessibility", "Win32_UI_Input_KeyboardAndMouse",
  "Win32_UI_WindowsAndMessaging", "Win32_UI_Shell"
] }
${check ? '' : '[build-dependencies]\ncc = "1"\n'}
`);
  if (!check) {
    await writeFile(join(dir, 'build.rs'), `fn main() {
      cc::Build::new()
        .file(${source('src/apps/desktop/src/computer_use/pointer_motion.c')})
        .std("c11")
        .compile("computer_use_pointer_motion");
    }`);
  }
  await copyFile(join(root, 'Cargo.lock'), join(dir, 'Cargo.lock'));
  // Only the error-category constructors are adapted to the portable error
  // envelope. Every native API, DTO, cache, lease and algorithm is production code.
  await writeFile(join(dir, 'lib.rs'), `#![allow(dead_code, unused_imports)]
extern crate self as openbitfun_core;
extern crate self as openbitfun_agent_tools;
#[path = ${source('src/crates/execution/tool-contracts/src/computer_use.rs')}]
pub mod computer_use_contract;
#[path = ${source('src/crates/execution/tool-contracts/src/computer_use_control.rs')}]
pub mod computer_use_control;
#[path = ${source('src/crates/execution/tool-contracts/src/computer_use_permissions.rs')}]
pub mod computer_use_permissions;
impl computer_use_contract::ComputerUseContractError {
  pub fn service(message: impl Into<String>) -> Self { Self::tool(message) }
  pub fn io(message: impl Into<String>) -> Self { Self::tool(message) }
}
pub mod agentic { pub mod tools { pub mod computer_use_host {
    pub use crate::computer_use_contract::*;
    ${lease}
}}}
pub mod util { pub mod errors {
    pub use crate::computer_use_contract::{ComputerUseContractError as OpenBitFunError, ComputerUseContractResult as OpenBitFunResult};
}}
mod computer_use {
  ${['control_session', 'process_identity', 'grants', 'permissions', 'windows_list_apps', 'windows_window_target', 'windows_ax_ui', 'windows_ax_shortcuts', 'provider_worker', 'windows_msaa', 'windows_capture', 'windows_wgc_capture', 'windows_pointer_feedback', 'ui_locate_common', 'ax_snapshot_digest'].map(name => `#[path = ${source(`src/apps/desktop/src/computer_use/${name}.rs`)}] mod ${name};`).join('\n  ')}
  mod desktop_host {
    struct DesktopComputerUseHost;
    #[path = ${source('src/apps/desktop/src/computer_use/desktop_host/foreground.rs')}] mod foreground;
    use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
    #[path = ${source('src/apps/desktop/src/computer_use/desktop_host/background_guard.rs')}] mod background_guard;
    #[path = ${source('src/apps/desktop/src/computer_use/desktop_host/windows_launch.rs')}] mod windows_launch;
  }
}
`);
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn('cargo', [check ? 'check' : 'test', '--offline', '--manifest-path', join(dir, 'Cargo.toml'), check ? '--tests' : '--lib', ...args], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? join(root, 'target/windows-computer-use-native') },
    });
    child.on('error', reject);
    child.on('close', code => resolveExit(code ?? 1));
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}

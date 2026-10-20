// Run production data modules without linking Tauri or calling OS automation.
import { mkdtemp, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'openbitfun-computer-context-'));
const source = (path) => JSON.stringify(resolve(root, path));
try {
  await writeFile(join(dir, 'Cargo.toml'), `[package]
name = "computer-use-context-tests"
version = "0.0.0"
edition = "2021"
[workspace]
[lib]
path = "lib.rs"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha1 = "0.10"
`);
  await copyFile(join(root, 'Cargo.lock'), join(dir, 'Cargo.lock'));
  // The compatibility path re-exports the actual production DTOs. There are
  // no replacement algorithms, fake screenshots, or native-host stubs here.
  await writeFile(join(dir, 'lib.rs'), `#![allow(dead_code)]
extern crate self as openbitfun_core;
extern crate self as openbitfun_agent_tools;
#[path = ${source('src/crates/execution/tool-contracts/src/computer_use.rs')}]
pub mod computer_use_contract;
pub use computer_use_contract as computer_use;
#[path = ${source('src/crates/execution/tool-contracts/src/computer_use_control.rs')}]
pub mod computer_use_control;
#[path = ${source('src/crates/execution/tool-contracts/src/computer_use_geometry.rs')}]
pub mod computer_use_geometry;
#[path = ${source('src/apps/desktop/src/computer_use/control_session/admission.rs')}]
mod control_admission;
#[path = ${source('src/apps/desktop/src/computer_use/observation_cache.rs')}]
mod observation_cache;
pub mod agentic { pub mod tools { pub mod computer_use_host {
    pub use crate::computer_use_contract::*;
}}}
mod screen_ocr { pub use crate::computer_use_contract::OcrTextMatch; }
#[path = ${source('src/apps/desktop/src/computer_use/ocr_context.rs')}]
mod ocr_context;
#[path = ${source('src/apps/desktop/src/computer_use/interactive_filter.rs')}]
mod interactive_filter;
#[path = ${source('src/apps/desktop/src/computer_use/ax_snapshot_digest.rs')}]
mod ax_snapshot_digest;
#[path = ${source('src/apps/desktop/src/computer_use/windows_window_target.rs')}]
mod windows_window_target;
#[path = ${source('src/crates/assembly/core/src/agentic/tools/browser_control/snapshot_context.rs')}]
mod snapshot_context;
`);
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn('cargo', ['test', '--offline', '--manifest-path', join(dir, 'Cargo.toml'), '--lib', ...process.argv.slice(2)], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, CARGO_TARGET_DIR: join(root, 'target/computer-use-context') },
    });
    child.on('error', reject);
    child.on('close', (code) => resolveExit(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(dir, { recursive: true, force: true });
}

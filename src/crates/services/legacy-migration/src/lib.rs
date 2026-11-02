//! Offline, source-read-only import primitives for legacy BitFun data.

mod diagnostics;
mod directory;
mod engine;
mod error;
mod handoff;
mod onboarding;
mod paths;
mod probe;
mod reset;
mod sqlite;
mod storage;
mod tasks;

pub use diagnostics::{export_failure_diagnostics, release_observation};
pub use directory::{copy_directory, visit_directory};
pub use engine::{
    compute_plan_hash, CancellationToken, CrashInjector, CrashPoint, DomainContext, DomainScan,
    LegacyDomainAdapter, MigrationEngine, NoCrashInjection,
};
pub use error::{LegacyMigrationError, LegacyMigrationResult};
pub use handoff::{
    blocking_writer_processes, blocking_writer_processes_for_product, launch_trusted_executable,
    HandoffDisposition, HandoffStore, TrustedExecutable, TrustedInstallationResolver,
    ValidatedHandoff, WriterProcess,
};
pub use onboarding::MigrationOnboardingStore;
pub use paths::{MigrationRoots, LEGACY_PRODUCT_ID};
pub use probe::{probe_legacy_source, ProbeLimits};
pub use reset::{plan_target_reset, reset_target_data, ResetDirectory, TargetResetResult};
pub use sqlite::{snapshot_sqlite_read_only, validate_sqlite};
pub use storage::{atomic_write_bytes, atomic_write_json, MigrationLayout, MigrationLock};
pub use tasks::{list_tasks, load_task, save_task, SavedMigrationTask};

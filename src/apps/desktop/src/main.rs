// Keep secondary launches from flashing a console window before the single-instance
// plugin redirects them back to the existing desktop process.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Tokio reads this value while creating its worker threads. Setting it in
    // the async body is too late, because the runtime has already been built.
    std::env::set_var("RUST_MIN_STACK", "8388608"); // 8 MiB worker stacks

    // Size worker threads dynamically according to host hardware (bounded between 2 and 8)
    // to prevent over-allocation on dual-core and under-utilization on multi-core systems.
    let worker_threads = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 8))
        .unwrap_or(4);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .expect("failed to build Tokio runtime");
    runtime.block_on(openbitfun_desktop_lib::run());
}

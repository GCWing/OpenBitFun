// An actual main-thread run loop is required by the production host dispatcher.
// libtest runs tests on worker threads and cannot provide this contract.
#[cfg(target_os = "macos")]
fn main() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    if std::env::var_os("OPENBITFUN_ROUNDTRIP_FIXTURE_PID").is_none()
        && std::env::var_os("OPENBITFUN_INPUT_FIXTURE_PID").is_none()
        && std::env::var_os("OPENBITFUN_CUA_PROBE_PID").is_none()
        && std::env::var_os("OPENBITFUN_CUA_SELF_TEST").is_none()
    {
        eprintln!(
            "Run node scripts/test-macos-control-roundtrip.mjs, or set OPENBITFUN_CUA_PROBE_PID for the scoped JSONL probe"
        );
        std::process::exit(2);
    }
    unsafe extern "C" {
        static kCFRunLoopDefaultMode: *const std::ffi::c_void;
        fn CFRunLoopRunInMode(
            mode: *const std::ffi::c_void,
            seconds: f64,
            return_after_source: bool,
        ) -> i32;
    }
    let (sender, receiver) = mpsc::channel();
    let app: *mut objc2::runtime::AnyObject =
        unsafe { objc2::msg_send![objc2::class!(NSApplication), sharedApplication] };
    let _: bool = unsafe { objc2::msg_send![app, setActivationPolicy: 2isize] };
    let _self_window = std::env::var_os("OPENBITFUN_CUA_SELF_TEST").map(|_| {
        let _: bool = unsafe { objc2::msg_send![app, setActivationPolicy: 1isize] };
        let _: () = unsafe { objc2::msg_send![app, finishLaunching] };
        self_webview::create()
    });
    if let Some(path) = std::env::var_os("OPENBITFUN_INPUT_HOST_READY") {
        std::fs::write(path, b"ready").unwrap();
    }
    let self_test = _self_window.is_some();
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap()
                .block_on(openbitfun_desktop_lib::run_native_computer_use_roundtrip_fixture());
        });
        let ok = result.is_ok();
        if self_test {
            // Own-process accessibility and input need a real AppKit event
            // loop. Exit only this disposable fixture after control cleanup.
            dispatch::Queue::main().exec_async(move || std::process::exit(if ok { 0 } else { 1 }));
        }
        let _ = sender.send(ok);
    });
    if self_test {
        let _: () = unsafe { objc2::msg_send![app, run] };
        return;
    }
    let limit = if std::env::var_os("OPENBITFUN_CUA_PROBE_PID").is_some() {
        std::env::var("OPENBITFUN_CUA_PROBE_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|seconds| (1..=1800).contains(seconds))
            .unwrap_or(600)
            + 15 // Leave the worker time to revoke control and clean up.
    } else {
        45
    };
    let deadline = Instant::now() + Duration::from_secs(limit);
    loop {
        match receiver.try_recv() {
            Ok(true) => return,
            Ok(false) | Err(mpsc::TryRecvError::Disconnected) => std::process::exit(1),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            eprintln!("FAIL native tool driver exceeded {limit} seconds while the real main run loop was active");
            std::process::exit(1);
        }
        unsafe {
            CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(target_os = "macos")]
#[path = "fixtures/computer_use_self_webview.rs"]
mod self_webview;
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Native Computer Use roundtrip requires macOS");
    std::process::exit(2);
}

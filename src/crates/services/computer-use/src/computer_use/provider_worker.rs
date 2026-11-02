//! Bounded admission and cancellation for a thread-affine native provider.
//!
//! A caller deadline cannot interrupt foreign code. Keep the worker occupied
//! until that code actually returns, and fence input that has not been submitted.

use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    mpsc::{self, RecvTimeoutError, SyncSender},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const READING: u8 = 0;
const INPUT_SUBMITTED: u8 = 1;
const ABANDONED: u8 = 2;
const INPUT_UNKNOWN: u8 = 3;
const CANCEL_POLL: Duration = Duration::from_millis(50);
const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const CLEANING: u8 = 2;

pub(super) struct Request {
    operation: &'static str,
    started: Instant,
    deadline: Instant,
    state: AtomicU8,
    response_accepted: AtomicBool,
    phase: Mutex<&'static str>,
}

impl Request {
    fn new(operation: &'static str, timeout: Duration) -> Self {
        let started = Instant::now();
        Self {
            operation,
            started,
            deadline: started + timeout,
            state: AtomicU8::new(READING),
            response_accepted: AtomicBool::new(false),
            phase: Mutex::new("queued"),
        }
    }

    pub(super) fn checkpoint(&self, phase: &'static str) -> Result<(), String> {
        self.check()?;
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = phase;
        Ok(())
    }

    /// A native observation may be cached just before the caller rejects its
    /// reply. Only the caller can publish acceptance; an accepted observation
    /// remains usable beyond the completed request's execution deadline.
    pub(super) fn response_accepted(&self) -> bool {
        self.response_accepted.load(Ordering::Acquire)
    }

    pub(super) fn check(&self) -> Result<(), String> {
        if Instant::now() >= self.deadline {
            return Err(self.abandon("AX_PROVIDER_TIMEOUT"));
        }
        if self.state.load(Ordering::Acquire) >= ABANDONED {
            return Err(self.abandon("AX_REQUEST_CANCELLED"));
        }
        Ok(())
    }

    /// Linearization point immediately before the single native input call.
    /// Abandonment wins against input that is still in provider preflight.
    pub(super) fn begin_input(&self, phase: &'static str) -> Result<(), String> {
        self.checkpoint(phase)?;
        self.state
            .compare_exchange(
                READING,
                INPUT_SUBMITTED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map(|_| ())
            .map_err(|_| self.abandon("AX_REQUEST_CANCELLED"))
    }

    /// A provider may report a transport failure after accepting the input.
    /// Such an error is not evidence that retrying the action would be safe.
    pub(super) fn input_failure(&self) -> Option<String> {
        matches!(
            self.state.load(Ordering::Acquire),
            INPUT_SUBMITTED | INPUT_UNKNOWN
        )
        .then(|| self.failure_message("AX_NATIVE_INPUT_FAILED", true))
    }

    fn abandon(&self, reason: &str) -> String {
        // The abandonment bit maps READING to ABANDONED and INPUT_SUBMITTED
        // to INPUT_UNKNOWN, preserving both terminal states on repeated calls.
        let previous = self.state.fetch_or(ABANDONED, Ordering::AcqRel);
        self.failure_message(
            reason,
            previous == INPUT_SUBMITTED || previous == INPUT_UNKNOWN,
        )
    }

    fn failure_message(&self, reason: &str, input_unknown: bool) -> String {
        let phase = *self.phase.lock().unwrap_or_else(|e| e.into_inner());
        let detail = format!(
            "{reason}; operation={}, phase={}, elapsed_ms={}",
            self.operation,
            phase,
            self.started.elapsed().as_millis()
        );
        if input_unknown {
            format!("[INPUT_OUTCOME_UNKNOWN] {detail}. Native input may still complete. Do not repeat the input; observe the target after the provider recovers. No retry was sent")
        } else {
            let code = if reason.starts_with("AX_") {
                reason
            } else {
                "AX_REQUEST_CANCELLED"
            };
            format!("[{code}] {detail}. No input was submitted. The provider must return before another UIA request can run")
        }
    }
}

struct BusyPermit(Arc<AtomicU8>);
impl Drop for BusyPermit {
    fn drop(&mut self) {
        self.0.store(IDLE, Ordering::Release);
    }
}

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

pub(super) struct Worker<S> {
    sender: SyncSender<Job<S>>,
    busy: Arc<AtomicU8>,
}

impl<S: 'static> Worker<S> {
    /// State is created, used and dropped on the provider thread; it need not
    /// be Send. In particular, retained COM interfaces never cross apartments.
    pub(super) fn new(initialize: impl FnOnce() -> S + Send + 'static) -> Self {
        let (sender, receiver) = mpsc::sync_channel::<Job<S>>(1);
        std::thread::spawn(move || {
            let mut state = initialize();
            while let Ok(job) = receiver.recv() {
                job(&mut state);
            }
        });
        Self {
            sender,
            busy: Arc::new(AtomicU8::new(IDLE)),
        }
    }

    /// Release thread-affine state promptly when idle. Never queue cleanup
    /// behind an occupied provider or make the stopping caller wait for it.
    pub(super) fn try_cleanup(&self, cleanup: impl FnOnce(&mut S) + Send + 'static) -> bool {
        if self
            .busy
            .compare_exchange(IDLE, CLEANING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        let permit = BusyPermit(self.busy.clone());
        self.sender
            .try_send(Box::new(move |state| {
                cleanup(state);
                drop(permit);
            }))
            .is_ok()
    }

    pub(super) fn run<T: Send + 'static, E: Send + 'static>(
        &self,
        operation: &'static str,
        timeout: Duration,
        mut allowed: impl FnMut() -> Result<(), String>,
        work: impl FnOnce(&mut S, Arc<Request>) -> Result<T, E> + Send + 'static,
    ) -> Result<Result<T, E>, String> {
        allowed()?;
        let request = Arc::new(Request::new(operation, timeout));
        loop {
            match self.busy.compare_exchange(IDLE, RUNNING, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => break,
                Err(CLEANING) => {
                    // Stop/start can be adjacent. Await idle COM cleanup within
                    // this request's deadline instead of reporting a false busy
                    // provider or queuing input behind an unbounded release.
                    request.checkpoint("cleanup")?;
                    if let Err(reason) = allowed() { return Err(request.abandon(&reason)); }
                    std::thread::sleep(CANCEL_POLL.min(request.deadline.saturating_duration_since(Instant::now())));
                }
                Err(_) => return Err("[AX_PROVIDER_BUSY] The previous native UIA call has not returned. No request was queued and no input was sent; wait for the target application to recover".into()),
            }
        }
        let permit = BusyPermit(self.busy.clone());
        let worker_request = request.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        self.sender
            .try_send(Box::new(move |state| {
                let result = work(state, worker_request);
                // Releasing admission here, rather than on caller timeout, bounds
                // native threads and ensures that no second call overlaps this one.
                drop(permit);
                let _ = sender.send(result);
            }))
            .map_err(|_| "[AX_WORKER_UNAVAILABLE] UIA worker stopped".to_string())?;
        loop {
            if let Err(reason) = allowed() {
                return Err(request.abandon(&reason));
            }
            request.check()?;
            let remaining = request.deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining.min(CANCEL_POLL)) {
                Ok(result) => {
                    if let Err(reason) = allowed() {
                        return Err(request.abandon(&reason));
                    }
                    request.check()?;
                    if result.is_ok() {
                        request.response_accepted.store(true, Ordering::Release);
                    }
                    return Ok(result);
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(request.abandon("AX_WORKER_UNAVAILABLE"))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const TEST_TIMEOUT: Duration = Duration::from_secs(1);

    #[test]
    fn blocked_preflight_times_out_without_late_input_or_queued_work() {
        let worker = Worker::new(|| 0usize);
        let (release, blocked) = mpsc::channel();
        let (done, completed) = mpsc::channel();
        let inputs = Arc::new(AtomicUsize::new(0));
        let input_count = inputs.clone();
        let result = worker.run(
            "invoke",
            TEST_TIMEOUT,
            || Ok(()),
            move |state, request| {
                request.checkpoint("pattern_lookup")?;
                blocked.recv().unwrap();
                let result = request.begin_input("invoke");
                if result.is_ok() {
                    input_count.fetch_add(1, Ordering::SeqCst);
                }
                *state += 1;
                done.send(()).unwrap();
                result
            },
        );
        assert!(result.unwrap_err().contains("AX_PROVIDER_TIMEOUT"));
        assert_eq!(inputs.load(Ordering::SeqCst), 0);
        let busy = worker.run(
            "observe",
            TEST_TIMEOUT,
            || Ok(()),
            |_, _| Ok::<_, String>(()),
        );
        assert!(busy.unwrap_err().contains("AX_PROVIDER_BUSY"));
        assert!(!worker.try_cleanup(|state| *state = 99));
        release.send(()).unwrap();
        completed.recv_timeout(Duration::from_secs(2)).unwrap();
        // Only the real provider completion releases admission. No replacement
        // worker or queued action is allowed while the caller is timed out.
        let start = Instant::now();
        while worker.busy.load(Ordering::Acquire) != IDLE {
            assert!(start.elapsed() < Duration::from_secs(2));
            std::thread::yield_now();
        }
        assert_eq!(
            worker
                .run(
                    "observe",
                    TEST_TIMEOUT,
                    || Ok(()),
                    |state, _| Ok::<_, String>(*state)
                )
                .unwrap()
                .unwrap(),
            1
        );
        assert_eq!(inputs.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn input_that_has_entered_the_provider_has_unknown_outcome_and_is_never_replayed() {
        let worker = Worker::new(|| ());
        let (release, blocked) = mpsc::channel();
        let inputs = Arc::new(AtomicUsize::new(0));
        let input_count = inputs.clone();
        let result = worker.run(
            "invoke",
            TEST_TIMEOUT,
            || Ok(()),
            move |_, request| {
                request.begin_input("invoke")?;
                input_count.fetch_add(1, Ordering::SeqCst);
                blocked.recv().unwrap();
                Ok::<_, String>(())
            },
        );
        assert!(result.unwrap_err().contains("INPUT_OUTCOME_UNKNOWN"));
        assert_eq!(inputs.load(Ordering::SeqCst), 1);
        release.send(()).unwrap();
    }

    #[test]
    fn stop_releases_waiter_before_deadline_and_fences_late_preflight() {
        let worker = Arc::new(Worker::new(|| ()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let caller_cancelled = cancelled.clone();
        let (entered, waiting) = mpsc::channel();
        let (release, blocked) = mpsc::channel();
        let (done, completed) = mpsc::channel();
        let caller = std::thread::spawn(move || {
            worker.run(
                "invoke",
                Duration::from_secs(30),
                || {
                    if caller_cancelled.load(Ordering::Acquire) {
                        Err("CONTROL_STOPPED".into())
                    } else {
                        Ok(())
                    }
                },
                move |_, request| {
                    entered.send(()).unwrap();
                    blocked.recv().unwrap();
                    let result = request.begin_input("invoke");
                    done.send(result.is_err()).unwrap();
                    result
                },
            )
        });
        waiting.recv_timeout(Duration::from_secs(2)).unwrap();
        let stopped = Instant::now();
        cancelled.store(true, Ordering::Release);
        assert!(caller
            .join()
            .unwrap()
            .unwrap_err()
            .contains("CONTROL_STOPPED"));
        assert!(stopped.elapsed() < Duration::from_secs(2));
        release.send(()).unwrap();
        assert!(completed.recv_timeout(Duration::from_secs(2)).unwrap());
    }

    #[test]
    fn native_state_is_owned_by_one_thread_and_does_not_need_send() {
        let worker = Worker::new(|| (std::rc::Rc::new(7), std::thread::current().id()));
        let result = worker
            .run(
                "observe",
                Duration::from_secs(2),
                || Ok(()),
                |state, request| {
                    request.check()?;
                    assert_eq!(state.1, std::thread::current().id());
                    Ok::<_, String>(*state.0)
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(result, 7);
    }

    #[test]
    fn a_provider_error_after_input_does_not_claim_that_nothing_happened() {
        let request = Request::new("invoke", Duration::from_secs(2));
        assert!(request.input_failure().is_none());
        request.begin_input("invoke").unwrap();
        let error = request.input_failure().unwrap();
        assert!(error.contains("INPUT_OUTCOME_UNKNOWN"));
        assert!(request.begin_input("retry").is_err());
    }

    #[test]
    fn an_observation_cached_before_a_rejected_reply_is_never_accepted() {
        let worker = Worker::new(|| None::<Arc<Request>>);
        let cancelled = Arc::new(AtomicBool::new(false));
        let provider_cancelled = cancelled.clone();
        let (published, cached) = mpsc::sync_channel(1);
        let result = worker.run(
            "observe",
            Duration::from_secs(5),
            || {
                if cancelled.load(Ordering::Acquire) {
                    Err("CONTROL_STOPPED".into())
                } else {
                    Ok(())
                }
            },
            move |state, request| {
                *state = Some(request.clone());
                published.send(request).unwrap();
                // Publication on the native thread does not guarantee that
                // the reply survived the caller's final authority check.
                provider_cancelled.store(true, Ordering::Release);
                Ok::<_, String>(())
            },
        );
        assert!(result.unwrap_err().contains("CONTROL_STOPPED"));
        assert!(!cached
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .response_accepted());
    }

    #[test]
    fn only_a_successful_reply_is_accepted_for_retained_observations() {
        let worker = Worker::new(|| ());
        let request = worker
            .run(
                "observe",
                Duration::from_secs(5),
                || Ok(()),
                |_, request| {
                    assert!(!request.response_accepted());
                    Ok::<_, String>(request)
                },
            )
            .unwrap()
            .unwrap();
        assert!(request.response_accepted());
        let (published, cached) = mpsc::sync_channel(1);
        let error = worker
            .run(
                "observe",
                Duration::from_secs(5),
                || Ok(()),
                move |_, request| {
                    published.send(request).unwrap();
                    Err::<(), _>("provider failure")
                },
            )
            .unwrap()
            .unwrap_err();
        assert_eq!(error, "provider failure");
        assert!(!cached
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .response_accepted());
    }

    #[test]
    fn idle_cleanup_releases_native_state_on_its_owning_thread_without_another_request() {
        struct NativeState {
            owner: std::thread::ThreadId,
            _not_send: std::rc::Rc<()>,
            dropped: SyncSender<bool>,
        }
        impl Drop for NativeState {
            fn drop(&mut self) {
                self.dropped
                    .send(self.owner == std::thread::current().id())
                    .unwrap();
            }
        }
        let (dropped, receipt) = mpsc::sync_channel(1);
        let worker = Worker::new(move || {
            Some(NativeState {
                owner: std::thread::current().id(),
                _not_send: std::rc::Rc::new(()),
                dropped,
            })
        });
        assert!(worker.try_cleanup(|state| *state = None));
        assert!(receipt.recv_timeout(Duration::from_secs(2)).unwrap());
    }

    #[test]
    fn a_new_request_waits_for_idle_cleanup_without_a_spurious_busy_error() {
        let worker = Arc::new(Worker::new(|| 0usize));
        let (release, blocked) = mpsc::channel();
        assert!(worker.try_cleanup(move |state| {
            blocked.recv().unwrap();
            *state = 42;
        }));
        let (waiting, ready) = mpsc::sync_channel(1);
        let caller = std::thread::spawn(move || {
            let mut checks = 0;
            worker.run(
                "observe",
                Duration::from_secs(5),
                || {
                    checks += 1;
                    if checks == 2 {
                        waiting.send(()).unwrap();
                    }
                    Ok(())
                },
                |state, _| Ok::<_, String>(*state),
            )
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        release.send(()).unwrap();
        assert_eq!(caller.join().unwrap().unwrap().unwrap(), 42);
    }
}

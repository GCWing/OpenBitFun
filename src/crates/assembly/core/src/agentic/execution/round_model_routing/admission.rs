//! Host-local Router service capacity. No request payload or Session state is shared.

use super::{parse_env_usize, OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::router_summary_queue::{RouterSummaryPermit, RouterSummaryQueue};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use tokio::sync::Semaphore;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouterAdmissionLimits {
    pub max_concurrent: usize,
    pub max_queued: usize,
}

impl Default for RouterAdmissionLimits {
    fn default() -> Self {
        Self {
            max_concurrent: 2,
            max_queued: 32,
        }
    }
}

impl RouterAdmissionLimits {
    pub fn from_env() -> OpenBitFunResult<Self> {
        let defaults = Self::default();
        let limits = Self {
            max_concurrent: parse_env_usize(
                "OPENBITFUN_ROUND_ROUTER_MAX_CONCURRENT",
                defaults.max_concurrent,
            )?,
            max_queued: parse_env_usize("OPENBITFUN_ROUND_ROUTER_MAX_QUEUED", defaults.max_queued)?,
        };
        limits.validate()?;
        Ok(limits)
    }

    fn validate(self) -> OpenBitFunResult<usize> {
        self.max_concurrent
            .checked_add(self.max_queued)
            .filter(|total| self.max_concurrent > 0 && *total <= Semaphore::MAX_PERMITS)
            .ok_or_else(|| {
                OpenBitFunError::Configuration(
                    "Router concurrency must be positive and total admission capacity must fit the runtime semaphore limit".into(),
                )
            })
    }
}

pub(super) struct RouterAdmission {
    limits: RouterAdmissionLimits,
    queue: Arc<RouterSummaryQueue<()>>,
}

pub(super) struct RouterPermit {
    _permit: RouterSummaryPermit<()>,
    // Keep the service registry entry alive if a client is rebuilt during work.
    _admission: Arc<RouterAdmission>,
}

impl std::fmt::Debug for RouterPermit {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("RouterPermit")
    }
}

impl RouterAdmission {
    fn new(limits: RouterAdmissionLimits) -> OpenBitFunResult<Self> {
        limits.validate()?;
        Ok(Self {
            limits,
            queue: RouterSummaryQueue::new(limits.max_concurrent, limits.max_queued),
        })
    }

    /// Registry keys come from the adapter's canonical endpoint, never a model,
    /// Session, prompt or API key. Weak entries disappear once all clients leave.
    pub(super) fn shared(
        service_identity: &str,
        limits: RouterAdmissionLimits,
    ) -> OpenBitFunResult<Arc<Self>> {
        static SERVICES: OnceLock<Mutex<HashMap<String, Weak<RouterAdmission>>>> = OnceLock::new();
        let mut services = SERVICES.get_or_init(Default::default).lock().map_err(|_| {
            OpenBitFunError::Configuration("Router admission registry is unavailable".into())
        })?;
        services.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = services.get(service_identity).and_then(Weak::upgrade) {
            if gate.limits != limits {
                return Err(OpenBitFunError::Configuration(
                    "Router capacity changed while this service is in use; restart the execution host to apply new limits".into(),
                ));
            }
            return Ok(gate);
        }
        let gate = Arc::new(Self::new(limits)?);
        services.insert(service_identity.to_string(), Arc::downgrade(&gate));
        Ok(gate)
    }

    /// Give each anonymous test request an independent fair-share participant.
    #[cfg(test)]
    pub(super) async fn acquire(
        self: &Arc<Self>,
        deadline: Instant,
    ) -> OpenBitFunResult<RouterPermit> {
        self.acquire_for(&uuid::Uuid::new_v4().to_string(), deadline)
            .await
    }

    /// Dropping this future removes its waiter and returns its total slot.
    /// The caller uses the same deadline for the subsequent HTTP request.
    pub(super) async fn acquire_for(
        self: &Arc<Self>,
        root_session_id: &str,
        deadline: Instant,
    ) -> OpenBitFunResult<RouterPermit> {
        if Instant::now() >= deadline {
            return Err(OpenBitFunError::Http(
                "Router deadline expired before admission".into(),
            ));
        }
        // Classifier requests are never coalesced; only their root task is shared.
        let (_, ticket) = self
            .queue
            .submit_for(root_session_id, uuid::Uuid::new_v4().to_string(), ())
            .map_err(|_| {
                OpenBitFunError::Http(
                    "Router waiting queue is full for this root task or service".into(),
                )
            })?;
        let (_, permit) = tokio::time::timeout_at(deadline, ticket.start())
            .await
            .map_err(|_| {
                OpenBitFunError::Http("Router deadline expired while waiting in the queue".into())
            })?
            .ok_or_else(|| OpenBitFunError::Http("Router admission was cancelled".into()))?;
        // Tokio timeouts poll a ready inner future first. A permit becoming ready
        // at the deadline must not start another classifier call after its budget.
        if Instant::now() >= deadline {
            return Err(OpenBitFunError::Http(
                "Router deadline expired while waiting in the queue".into(),
            ));
        }
        Ok(RouterPermit {
            _permit: permit,
            _admission: self.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn gate(concurrent: usize, queued: usize) -> Arc<RouterAdmission> {
        Arc::new(
            RouterAdmission::new(RouterAdmissionLimits {
                max_concurrent: concurrent,
                max_queued: queued,
            })
            .unwrap(),
        )
    }

    fn poll_once<F: std::future::Future>(
        future: std::pin::Pin<&mut F>,
    ) -> std::task::Poll<F::Output> {
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        future.poll(&mut context)
    }

    fn deadline() -> Instant {
        Instant::now() + Duration::from_secs(10)
    }

    #[tokio::test]
    async fn queued_sessions_are_fifo_and_total_work_is_bounded() {
        let gate = gate(1, 2);
        let first_session = gate.acquire(deadline()).await.unwrap();
        let mut second_session = Box::pin(gate.acquire(deadline()));
        let mut third_session = Box::pin(gate.acquire(deadline()));
        assert!(poll_once(second_session.as_mut()).is_pending());
        assert!(poll_once(third_session.as_mut()).is_pending());
        assert!(gate
            .acquire(deadline())
            .await
            .unwrap_err()
            .to_string()
            .contains("queue is full"));
        drop(first_session);
        assert!(poll_once(third_session.as_mut()).is_pending());
        let second = second_session.await.unwrap();
        assert!(poll_once(third_session.as_mut()).is_pending());
        drop(second);
        drop(third_session.await.unwrap());
        assert_eq!(gate.queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelling_a_queued_session_removes_it_and_releases_capacity() {
        let gate = gate(1, 1);
        let first = gate.acquire(deadline()).await.unwrap();
        let mut cancelled = Box::pin(gate.acquire(deadline()));
        assert!(poll_once(cancelled.as_mut()).is_pending());
        drop(cancelled);
        let mut next = Box::pin(gate.acquire(deadline()));
        assert!(poll_once(next.as_mut()).is_pending());
        drop(first);
        drop(next.await.unwrap());
        assert_eq!(gate.queue.available_permits(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn queue_deadline_does_not_wait_for_another_sessions_task() {
        let gate = gate(1, 1);
        let first = gate.acquire(deadline()).await.unwrap();
        let error = gate
            .acquire(Instant::now() + Duration::from_secs(1))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("deadline expired while waiting"));
        assert_eq!(gate.queue.available_permits(), 0);
        drop(first);
        assert!(gate.acquire(deadline()).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_permit_released_at_the_deadline_does_not_admit_an_expired_request() {
        let gate = gate(1, 1);
        let first = gate.acquire(deadline()).await.unwrap();
        let mut waiting = Box::pin(gate.acquire(Instant::now() + Duration::from_secs(1)));
        assert!(poll_once(waiting.as_mut()).is_pending());
        tokio::time::advance(Duration::from_secs(1)).await;
        drop(first);
        assert!(waiting.await.is_err());
        assert_eq!(gate.queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn sibling_classifiers_cannot_starve_another_root_or_coalesce() {
        let gate = gate(1, 8);
        let active = gate.acquire_for("a", deadline()).await.unwrap();
        let mut a1 = Box::pin(gate.acquire_for("a", deadline()));
        let mut a2 = Box::pin(gate.acquire_for("a", deadline()));
        let mut b = Box::pin(gate.acquire_for("b", deadline()));
        assert!(poll_once(a1.as_mut()).is_pending());
        assert!(poll_once(a2.as_mut()).is_pending());
        assert!(gate.acquire_for("a", deadline()).await.is_err());
        assert!(poll_once(b.as_mut()).is_pending());
        drop(active);
        assert!(poll_once(a1.as_mut()).is_pending());
        let permit = b.await.unwrap();
        drop(permit);
        assert!(poll_once(a2.as_mut()).is_pending());
        drop(a1.await.unwrap());
        drop(a2.await.unwrap());
        assert_eq!(gate.queue.available_permits(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn expired_root_waiter_releases_its_share_for_a_new_child() {
        let gate = gate(1, 4);
        let active = gate.acquire_for("busy", deadline()).await.unwrap();
        let mut expiring = Box::pin(gate.acquire_for("a", Instant::now() + Duration::from_secs(1)));
        assert!(poll_once(expiring.as_mut()).is_pending());
        assert!(gate.acquire_for("a", deadline()).await.is_err());
        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(expiring.await.unwrap_err().to_string().contains("deadline"));
        let mut next = Box::pin(gate.acquire_for("a", deadline()));
        assert!(poll_once(next.as_mut()).is_pending());
        drop(active);
        drop(next.await.unwrap());
        assert_eq!(gate.queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancelled_root_waiter_releases_share_without_resetting_other_roots() {
        let gate = gate(1, 4);
        let active = gate.acquire_for("a", deadline()).await.unwrap();
        let mut a = Box::pin(gate.acquire_for("a", deadline()));
        let mut b = Box::pin(gate.acquire_for("b", deadline()));
        assert!(poll_once(a.as_mut()).is_pending());
        assert!(poll_once(b.as_mut()).is_pending());
        drop(a);
        let mut a = Box::pin(gate.acquire_for("a", deadline()));
        assert!(poll_once(a.as_mut()).is_pending());
        drop(active);
        assert!(poll_once(a.as_mut()).is_pending());
        drop(b.await.unwrap());
        drop(a.await.unwrap());
        assert_eq!(gate.queue.available_permits(), 1);
    }

    #[tokio::test]
    async fn independent_services_do_not_block_each_other_and_rebuilt_clients_share() {
        let key = uuid::Uuid::new_v4().to_string();
        let limits = RouterAdmissionLimits {
            max_concurrent: 1,
            max_queued: 0,
        };
        let original = RouterAdmission::shared(&key, limits).unwrap();
        let rebuilt = RouterAdmission::shared(&key, limits).unwrap();
        assert!(Arc::ptr_eq(&original, &rebuilt));
        let _first = original.acquire(deadline()).await.unwrap();
        assert!(rebuilt.acquire(deadline()).await.is_err());
        let other = RouterAdmission::shared(&format!("{key}-other"), limits).unwrap();
        assert!(other.acquire(deadline()).await.is_ok());
        assert!(RouterAdmission::shared(&key, RouterAdmissionLimits::default()).is_err());
    }

    #[tokio::test]
    async fn active_permit_keeps_service_capacity_shared_after_its_client_is_dropped() {
        let key = uuid::Uuid::new_v4().to_string();
        let limits = RouterAdmissionLimits {
            max_concurrent: 1,
            max_queued: 0,
        };
        let original = RouterAdmission::shared(&key, limits).unwrap();
        let permit = original.acquire_for("a", deadline()).await.unwrap();
        drop(original);
        let rebuilt = RouterAdmission::shared(&key, limits).unwrap();
        assert!(rebuilt.acquire_for("b", deadline()).await.is_err());
        assert!(RouterAdmission::shared(&key, RouterAdmissionLimits::default()).is_err());
        drop(permit);
        assert!(rebuilt.acquire_for("b", deadline()).await.is_ok());
    }

    #[test]
    fn invalid_capacity_never_panics_or_builds_an_unbounded_queue() {
        assert!(RouterAdmission::new(RouterAdmissionLimits {
            max_concurrent: 0,
            max_queued: 1
        })
        .is_err());
        assert!(RouterAdmission::new(RouterAdmissionLimits {
            max_concurrent: usize::MAX,
            max_queued: 1
        })
        .is_err());
    }

    fn router_config(
        endpoint: String,
        directory: &std::path::Path,
    ) -> super::super::HttpRoundModelRouterConfig {
        let tokenizer_path = directory.join("tokenizer.json");
        std::fs::write(&tokenizer_path, r#"{"version":"1.0","truncation":null,"padding":null,"added_tokens":[],"normalizer":null,"pre_tokenizer":{"type":"Whitespace"},"post_processor":null,"decoder":null,"model":{"type":"WordLevel","vocab":{"[UNK]":0},"unk_token":"[UNK]"}}"#).unwrap();
        super::super::HttpRoundModelRouterConfig {
            endpoint,
            model: "fixture".into(),
            system_prompt: "fixed system".into(),
            api_key: None,
            timeout: Duration::from_secs(5),
            admission: RouterAdmissionLimits {
                max_concurrent: 1,
                max_queued: 2,
            },
            recent_rounds: 3,
            simple_threshold: 0.7,
            trace_path: Some(directory.join("router.jsonl")),
            context: super::super::RouterContextConfig {
                summary_enabled: false,
                ..Default::default()
            },
            tokenizer_path: Some(tokenizer_path),
            proxy: None,
            custom_headers: Default::default(),
            skip_ssl_verify: false,
        }
    }

    fn request(session: &str) -> super::super::RoundModelRouteRequest {
        super::super::RoundModelRouteRequest {
            session_id: session.into(),
            root_session_id: session.into(),
            parent_session_id: None,
            dialog_turn_id: format!("{session}-turn"),
            turn_index: 0,
            round_index: 0,
            agent_type: "code".into(),
            original_user_input: format!("TASK_{session}"),
            messages: Vec::new(),
            prepared_context: None,
        }
    }

    fn read_request(stream: &std::net::TcpStream) -> serde_json::Value {
        use std::io::{BufRead, Read};
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn respond(stream: &mut std::net::TcpStream) {
        use std::io::Write;
        let response = serde_json::json!({"choices": [{
            "message": {"content": "{\"simple_type\":\"simple\"}"},
            "logprobs": {"content": [
                {"bytes": b"{\"simple_type\":\"".to_vec(), "top_logprobs": []},
                {"bytes": b"simple".to_vec(), "top_logprobs": [
                    {"token": "token_id:22944", "logprob": -0.2},
                    {"token": "token_id:6280", "logprob": -1.4}
                ]},
                {"bytes": b"\"}".to_vec(), "top_logprobs": []}
            ]}, "token_ids": [1, 22944, 2]
        }]})
        .to_string();
        // A cancelled/deadline-expired client may have already closed its socket.
        let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response);
    }

    #[tokio::test]
    async fn rebuilt_router_clients_share_fifo_capacity_and_keep_session_payloads_isolated() {
        use super::super::{HttpRoundModelRouter, RoundModelRoute, RoundModelRouter};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let directory = tempfile::tempdir().unwrap();
        let config = router_config(endpoint, directory.path());
        let router = Arc::new(HttpRoundModelRouter::new(config.clone()).unwrap());
        let mut changed = config.clone();
        changed.api_key = Some("rotated-key".into());
        changed.model = "another-router-model".into();
        let rebuilt = HttpRoundModelRouter::new(changed).unwrap();
        assert!(Arc::ptr_eq(&router.admission, &rebuilt.admission));
        let (arrived, first_arrived) = tokio::sync::oneshot::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let mut payloads = Vec::new();
            let (mut first, _) = listener.accept().unwrap();
            payloads.push(read_request(&first));
            arrived.send(()).unwrap();
            wait_release.recv_timeout(Duration::from_secs(5)).unwrap();
            respond(&mut first);
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                payloads.push(read_request(&stream));
                respond(&mut stream);
            }
            payloads
        });
        let first_router = router.clone();
        let first = tokio::spawn(async move { first_router.select_model(request("A")).await });
        first_arrived.await.unwrap();
        let mut cancelled = Box::pin(rebuilt.select_model(request("B")));
        let mut next = Box::pin(router.select_model(request("C")));
        assert!(poll_once(cancelled.as_mut()).is_pending());
        assert!(poll_once(next.as_mut()).is_pending());
        let error = rebuilt.select_model(request("D")).await.unwrap_err();
        assert!(error.to_string().contains("queue is full"));
        drop(cancelled);
        let mut last = Box::pin(rebuilt.select_model(request("E")));
        assert!(poll_once(last.as_mut()).is_pending());
        release.send(()).unwrap();
        assert_eq!(first.await.unwrap().unwrap(), RoundModelRoute::Economy);
        let (next, last) = tokio::join!(next, last);
        assert_eq!(next.unwrap(), RoundModelRoute::Economy);
        assert_eq!(last.unwrap(), RoundModelRoute::Economy);
        let payloads = server.join().unwrap();
        for (payload, session) in payloads.iter().zip(["A", "C", "E"]) {
            let prompt = payload["messages"][1]["content"].as_str().unwrap();
            assert!(prompt.contains(&format!("TASK_{session}")));
            assert!(!prompt.contains("TASK_B") && !prompt.contains("TASK_D"));
        }
        let events: Vec<serde_json::Value> = std::fs::read_to_string(config.trace_path.unwrap())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let cancelled = events
            .iter()
            .find(|event| event["event"] == "router_cancelled" && event["session_id"] == "B")
            .unwrap();
        assert_eq!(cancelled["phase"], "queued");
        assert!(cancelled["queue_wait_ms"].is_u64());
        assert!(
            !events
                .iter()
                .any(|event| event["event"] == "router_request_admitted"
                    && event["session_id"] == "B")
        );
        for event in events.iter().filter(|event| {
            event["event"] == "router_decision" || event["event"] == "router_failure"
        }) {
            assert!(event["queue_wait_ms"].is_u64());
        }
    }

    #[tokio::test]
    async fn classifier_deadline_includes_queue_time_instead_of_restarting_after_admission() {
        use super::super::{HttpRoundModelRouter, RoundModelRouter};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let directory = tempfile::tempdir().unwrap();
        let mut config = router_config(endpoint, directory.path());
        config.timeout = Duration::from_secs(1);
        let router = HttpRoundModelRouter::new(config).unwrap();
        let first = router.admission.acquire(deadline()).await.unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&stream);
            std::thread::sleep(Duration::from_millis(600));
            respond(&mut stream);
        });
        let waiting = router.select_model(request("waiting"));
        let release = async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            drop(first);
        };
        let (result, ()) = tokio::join!(waiting, release);
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("deadline expired during classification"));
        server.join().unwrap();
        assert!(router.admission.acquire(deadline()).await.is_ok());
    }

    #[tokio::test]
    async fn cancelling_an_in_flight_classifier_releases_host_capacity() {
        use super::super::{HttpRoundModelRouter, RoundModelRouter};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let directory = tempfile::tempdir().unwrap();
        let router =
            Arc::new(HttpRoundModelRouter::new(router_config(endpoint, directory.path())).unwrap());
        let (arrived, arrival) = tokio::sync::oneshot::channel();
        let (release, wait_release) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&stream);
            arrived.send(()).unwrap();
            wait_release.recv_timeout(Duration::from_secs(5)).unwrap();
            respond(&mut stream);
        });
        let running_router = router.clone();
        let running =
            tokio::spawn(async move { running_router.select_model(request("cancelled")).await });
        arrival.await.unwrap();
        running.abort();
        assert!(running.await.unwrap_err().is_cancelled());
        assert!(router.admission.acquire(deadline()).await.is_ok());
        release.send(()).unwrap();
        server.join().unwrap();
        let events: Vec<serde_json::Value> =
            std::fs::read_to_string(directory.path().join("router.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        let cancelled = events
            .iter()
            .find(|event| event["event"] == "router_cancelled")
            .unwrap();
        assert_eq!(cancelled["phase"], "classifying");
        assert!(cancelled["queue_wait_ms"].is_u64());
    }
}

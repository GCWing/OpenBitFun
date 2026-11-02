//! Time-window coalescing of streamed text chunks before transport emit.
//!
//! The agent stream emits one `TextChunk` / `ThinkingChunk` event per provider
//! chunk ([`openbitfun_events::AgenticEvent`]). Forwarding every chunk to the
//! WebView costs one Tauri IPC message (JSON serialization, WebView2 boundary
//! crossing, JS parse + dispatch) and, when peer devices are attached, one
//! end-to-end encrypted relay message. This module merges chunks of the same
//! stream (session / turn / round / attempt / contentType / reasoningKind) within a short
//! window so the frontend still receives content-equivalent events at a
//! fraction of the message rate.
//!
//! Semantics:
//! - Text chunks accumulate by appending; thinking chunks append and OR their
//!   `is_end` flag.
//! - A non-chunk event flushes all pending merged events first, then passes
//!   through unchanged, so text always precedes completion / error /
//!   cancellation for the same stream.
//! - Nothing is dropped: the merged payload is identical to what the frontend
//!   would have accumulated itself.
//! - Buffering is per stream, so concurrently streaming sessions do not flush
//!   each other's pending text.
//! - Merged events are delivered in first-arrival order of their streams, so
//!   the original FIFO sequence is preserved: for the same stream the producer
//!   emits thinking chunks before text chunks, and `flush` therefore emits the
//!   merged thinking event before the merged text event.

use openbitfun_core_types::ReasoningContentKind;
use openbitfun_events::AgenticEvent;
use std::collections::HashMap;
use std::time::Duration;

/// Decide which flush deadline to keep after a batch of queued events has been
/// drained by the event loop.
///
/// Pure scheduling decision so the arm/keep/clear rules of the 50ms coalescing
/// window are unit-testable without a live tokio task:
/// - Buffered chunks and no running deadline: arm `now + window`.
/// - Buffered chunks and a running deadline: keep the original deadline so the
///   window is not extended by a steady chunk stream.
/// - Nothing buffered: no deadline.
pub fn next_flush_deadline(
    pending: bool,
    deadline: Option<tokio::time::Instant>,
    now: tokio::time::Instant,
    window: Duration,
) -> Option<tokio::time::Instant> {
    if pending {
        Some(deadline.unwrap_or(now + window))
    } else {
        None
    }
}

/// Maximum time a streamed chunk waits in the coalescer before being emitted
/// as a merged event.
pub const TEXT_CHUNK_COALESCE_WINDOW_MS: u64 = 50;

// ---------------------------------------------------------------------------
// Rate-adaptive window
// ---------------------------------------------------------------------------
//
// The window grows with the measured stream rate so that fast streams merge
// more chunks per message (their latency is hidden by the frontend typewriter
// backlog) while slow streams keep a small window (their latency is directly
// visible as boundary stalls). The window is a throttle, not a debounce: it is
// fixed at arm time and never extended by a steady stream.

/// Smallest window, used for slow streams (thinking phases, low-throughput
/// models). Keeps first-char latency and boundary stalls minimal.
pub const WINDOW_MIN_MS: u64 = 30;

/// Largest window, reached only by fast streams (body text peaks). Bounds the
/// worst-case text delivery delay and the crash-loss window.
pub const WINDOW_MAX_MS: u64 = 100;

/// Window used when the measured rate equals `WINDOW_REF_CPS`; matches the
/// previous fixed 50ms behavior at the measured median rate of a typical
/// streaming session, so average-speed streams see no regression.
pub const WINDOW_BASE_MS: u64 = 50;

/// Reference stream rate (chars/sec) at which the window equals
/// `WINDOW_BASE_MS`. Calibrated to the measured median rate of real sessions
/// (~87 tokens/sec of Chinese text at ~0.92 chars/token).
pub const WINDOW_REF_CPS: f64 = 80.0;

/// EMA smoothing factor applied to the measured instant rate.
const RATE_EMA_ALPHA: f64 = 0.7;

/// A window longer than this resets the rate estimate instead of blending it;
/// used to forget the previous stream's rate after an idle gap.
const RATE_EMA_RESET_MS: u128 = 1000;

/// Map a measured stream rate (chars/sec) to the coalescing window.
///
/// Linear in the rate, clamped to `[WINDOW_MIN_MS, WINDOW_MAX_MS]`:
/// `window = base * (rate / ref)`.
pub fn next_window(rate_cps: f64) -> Duration {
    let window_ms = WINDOW_BASE_MS as f64 * (rate_cps.max(0.0) / WINDOW_REF_CPS);
    Duration::from_millis(window_ms.clamp(WINDOW_MIN_MS as f64, WINDOW_MAX_MS as f64) as u64)
}

/// Blend a freshly measured stream rate into the EMA estimate.
///
/// `flushed_chars` is the content emitted by one window flush and `elapsed`
/// the duration of that window. A long window (idle gap, stream restart)
/// resets the estimate to the instant rate instead of blending.
pub fn update_rate_ema(previous: f64, flushed_chars: usize, elapsed: Duration) -> f64 {
    let elapsed_ms = elapsed.as_millis().max(1) as f64;
    let instant_cps = flushed_chars as f64 * 1000.0 / elapsed_ms;
    if elapsed.as_millis() > RATE_EMA_RESET_MS {
        instant_cps
    } else {
        RATE_EMA_ALPHA * instant_cps + (1.0 - RATE_EMA_ALPHA) * previous
    }
}

/// Initial EMA value: the reference rate, so the very first window of a
/// session behaves exactly like the previous fixed 50ms window.
pub const INITIAL_RATE_EMA_CPS: f64 = WINDOW_REF_CPS;

/// Stable merge key for one streaming text/thinking stream.
type ChunkStreamKey = (
    String,
    String,
    String,
    String,
    bool,
    Option<ReasoningContentKind>,
);

fn resolve_attempt_token(attempt_id: &Option<String>, attempt_index: Option<u32>) -> String {
    if let Some(id) = attempt_id {
        if !id.is_empty() {
            return id.clone();
        }
    }
    match attempt_index {
        Some(index) => format!("idx-{index}"),
        None => "none".to_string(),
    }
}

enum PendingChunk {
    Text {
        session_id: String,
        turn_id: String,
        round_id: String,
        attempt_id: Option<String>,
        attempt_index: Option<u32>,
        text: String,
    },
    Thinking {
        session_id: String,
        turn_id: String,
        round_id: String,
        attempt_id: Option<String>,
        attempt_index: Option<u32>,
        content: String,
        reasoning_kind: Option<ReasoningContentKind>,
        is_end: bool,
    },
}

impl PendingChunk {
    fn into_event(self) -> AgenticEvent {
        match self {
            PendingChunk::Text {
                session_id,
                turn_id,
                round_id,
                attempt_id,
                attempt_index,
                text,
            } => AgenticEvent::TextChunk {
                session_id,
                turn_id,
                round_id,
                attempt_id,
                attempt_index,
                text,
            },
            PendingChunk::Thinking {
                session_id,
                turn_id,
                round_id,
                attempt_id,
                attempt_index,
                content,
                reasoning_kind,
                is_end,
            } => AgenticEvent::ThinkingChunk {
                session_id,
                turn_id,
                round_id,
                attempt_id,
                attempt_index,
                content,
                reasoning_kind,
                is_end,
            },
        }
    }
}

/// Coalesces streamed text/thinking chunks within a short time window.
pub struct TextChunkCoalescer {
    pending: HashMap<ChunkStreamKey, PendingChunk>,
    /// First-arrival order of the buffered stream keys. Kept in sync with
    /// `pending` (a key is pushed exactly when its entry is inserted) so that
    /// `flush` reproduces the producer's FIFO sequence instead of reordering
    /// streams by key.
    order: Vec<ChunkStreamKey>,
    /// Total content characters buffered since the last flush. Used by the
    /// caller to measure the stream rate for the adaptive window.
    buffered_chars: usize,
}

impl Default for TextChunkCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

impl TextChunkCoalescer {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            order: Vec::new(),
            buffered_chars: 0,
        }
    }

    /// Whether the coalescer currently holds at least one buffered chunk.
    pub fn is_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Content characters buffered since the last flush (0 once flushed).
    pub fn buffered_chars(&self) -> usize {
        self.buffered_chars
    }

    /// Feed one event and return the events that must be delivered immediately.
    ///
    /// Text/thinking chunks of the same stream are buffered (an empty vector is
    /// returned); a chunk of a different stream is buffered independently. Any
    /// non-chunk event first flushes all pending merged events, then passes
    /// through unchanged.
    pub fn push(&mut self, event: AgenticEvent) -> Vec<AgenticEvent> {
        match event {
            AgenticEvent::TextChunk {
                session_id,
                turn_id,
                round_id,
                attempt_id,
                attempt_index,
                text,
            } => {
                let key = (
                    session_id.clone(),
                    turn_id.clone(),
                    round_id.clone(),
                    resolve_attempt_token(&attempt_id, attempt_index),
                    false,
                    None,
                );
                match self.pending.get_mut(&key) {
                    Some(PendingChunk::Text { text: pending, .. }) => {
                        pending.push_str(&text);
                        self.buffered_chars += text.chars().count();
                        Vec::new()
                    }
                    _ => {
                        let len = text.chars().count();
                        self.pending.insert(
                            key.clone(),
                            PendingChunk::Text {
                                session_id,
                                turn_id,
                                round_id,
                                attempt_id,
                                attempt_index,
                                text,
                            },
                        );
                        self.order.push(key);
                        self.buffered_chars += len;
                        Vec::new()
                    }
                }
            }
            AgenticEvent::ThinkingChunk {
                session_id,
                turn_id,
                round_id,
                attempt_id,
                attempt_index,
                content,
                reasoning_kind,
                is_end,
            } => {
                let key = (
                    session_id.clone(),
                    turn_id.clone(),
                    round_id.clone(),
                    resolve_attempt_token(&attempt_id, attempt_index),
                    true,
                    reasoning_kind,
                );
                match self.pending.get_mut(&key) {
                    Some(PendingChunk::Thinking {
                        content: pending,
                        is_end: pending_is_end,
                        ..
                    }) => {
                        pending.push_str(&content);
                        *pending_is_end |= is_end;
                        self.buffered_chars += content.chars().count();
                        Vec::new()
                    }
                    _ => {
                        let len = content.chars().count();
                        self.pending.insert(
                            key.clone(),
                            PendingChunk::Thinking {
                                session_id,
                                turn_id,
                                round_id,
                                attempt_id,
                                attempt_index,
                                content,
                                reasoning_kind,
                                is_end,
                            },
                        );
                        self.order.push(key);
                        self.buffered_chars += len;
                        Vec::new()
                    }
                }
            }
            other => {
                let mut events = self.flush();
                events.push(other);
                events
            }
        }
    }

    /// Emit all buffered chunks as merged events and clear the buffer.
    ///
    /// Merged events are emitted in first-arrival order of their streams, which
    /// restores the FIFO sequence the frontend relied on: for the same stream
    /// the producer emits thinking chunks before text chunks, so the merged
    /// thinking event (with its OR'd `is_end`) precedes the merged text event
    /// even though they buffer under separate keys.
    pub fn flush(&mut self) -> Vec<AgenticEvent> {
        let mut events = Vec::with_capacity(self.order.len());
        for key in self.order.drain(..) {
            if let Some(chunk) = self.pending.remove(&key) {
                events.push(chunk.into_event());
            }
        }
        self.buffered_chars = 0;
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_chunk(
        session_id: &str,
        turn_id: &str,
        round_id: &str,
        attempt_id: Option<&str>,
        attempt_index: Option<u32>,
        text: &str,
    ) -> AgenticEvent {
        AgenticEvent::TextChunk {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            round_id: round_id.to_string(),
            attempt_id: attempt_id.map(str::to_string),
            attempt_index,
            text: text.to_string(),
        }
    }

    fn thinking_chunk(
        session_id: &str,
        turn_id: &str,
        round_id: &str,
        attempt_id: Option<&str>,
        attempt_index: Option<u32>,
        content: &str,
        is_end: bool,
    ) -> AgenticEvent {
        AgenticEvent::ThinkingChunk {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            round_id: round_id.to_string(),
            attempt_id: attempt_id.map(str::to_string),
            attempt_index,
            content: content.to_string(),
            reasoning_kind: None,
            is_end,
        }
    }

    fn typed_thinking_chunk(
        content: &str,
        reasoning_kind: ReasoningContentKind,
        is_end: bool,
    ) -> AgenticEvent {
        AgenticEvent::ThinkingChunk {
            session_id: "s".to_string(),
            turn_id: "t".to_string(),
            round_id: "r".to_string(),
            attempt_id: None,
            attempt_index: None,
            content: content.to_string(),
            reasoning_kind: Some(reasoning_kind),
            is_end,
        }
    }

    #[test]
    fn merges_same_stream_text_chunks() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, Some(1), "hello "))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, Some(1), "world"))
            .is_empty());

        let events = coalescer.flush();
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgenticEvent::TextChunk { text, .. } => assert_eq!(text, "hello world"),
            other => panic!("expected TextChunk, got {other:?}"),
        }
    }

    #[test]
    fn merges_same_stream_thinking_chunks_and_ors_is_end() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "think ", false))
            .is_empty());
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "more", false))
            .is_empty());
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "", true))
            .is_empty());

        let events = coalescer.flush();
        assert_eq!(events.len(), 1);
        match &events[0] {
            AgenticEvent::ThinkingChunk {
                content, is_end, ..
            } => {
                assert_eq!(content, "think more");
                assert!(is_end);
            }
            other => panic!("expected ThinkingChunk, got {other:?}"),
        }
    }

    #[test]
    fn keeps_text_and_thinking_streams_separate() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "think", false))
            .is_empty());
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "", true))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "answer "))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "text"))
            .is_empty());

        let events = coalescer.flush();
        assert_eq!(events.len(), 2);
        // Same-stream delivery must follow the producer's FIFO order: the
        // merged thinking event (with its OR'd is_end) precedes the merged
        // text event. Regression guard for the flush-order reversal where
        // text was emitted before thinking.
        match &events[0] {
            AgenticEvent::ThinkingChunk {
                content, is_end, ..
            } => {
                assert_eq!(content, "think");
                assert!(is_end);
            }
            other => panic!("expected ThinkingChunk first, got {other:?}"),
        }
        match &events[1] {
            AgenticEvent::TextChunk { text, .. } => assert_eq!(text, "answer text"),
            other => panic!("expected TextChunk second, got {other:?}"),
        }
    }

    #[test]
    fn keeps_reasoning_text_and_summary_streams_separate() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(typed_thinking_chunk(
                "private chain",
                ReasoningContentKind::Reasoning,
                false,
            ))
            .is_empty());
        assert!(coalescer
            .push(typed_thinking_chunk(
                "display summary",
                ReasoningContentKind::Summary,
                false,
            ))
            .is_empty());

        let events = coalescer.flush();
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            AgenticEvent::ThinkingChunk {
                content,
                reasoning_kind: Some(ReasoningContentKind::Reasoning),
                ..
            } if content == "private chain"
        ));
        assert!(matches!(
            &events[1],
            AgenticEvent::ThinkingChunk {
                content,
                reasoning_kind: Some(ReasoningContentKind::Summary),
                ..
            } if content == "display summary"
        ));
    }

    #[test]
    fn flush_preserves_first_arrival_order_across_streams() {
        let mut coalescer = TextChunkCoalescer::new();
        // The "z" stream starts buffering before the "a" stream; flush must
        // follow arrival order, not lexicographic key order.
        assert!(coalescer
            .push(text_chunk("s", "t", "z", None, None, "z-first"))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s", "t", "a", None, None, "a-second"))
            .is_empty());

        let events = coalescer.flush();
        assert_eq!(events.len(), 2);
        assert!(matches!(&events[0], AgenticEvent::TextChunk { round_id, .. } if round_id == "z"));
        assert!(matches!(&events[1], AgenticEvent::TextChunk { round_id, .. } if round_id == "a"));
    }

    #[test]
    fn different_stream_chunks_are_buffered_independently() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(text_chunk("s1", "t", "r", None, None, "a"))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s2", "t", "r", None, None, "b"))
            .is_empty());

        let events = coalescer.flush();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn non_chunk_event_flushes_pending_text_first() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "final "))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "words"))
            .is_empty());

        let events = coalescer.push(AgenticEvent::DialogTurnCompleted {
            session_id: "s".to_string(),
            turn_id: "t".to_string(),
            total_rounds: 1,
            total_tools: 0,
            duration_ms: 10,
            partial_recovery_reason: None,
            success: Some(true),
            finish_reason: Some("stop".to_string()),
            has_final_response: Some(true),
            background_delivery: None,
        });

        assert_eq!(events.len(), 2);
        assert!(
            matches!(&events[0], AgenticEvent::TextChunk { text, .. } if text == "final words")
        );
        assert!(matches!(
            &events[1],
            AgenticEvent::DialogTurnCompleted { .. }
        ));
        assert!(!coalescer.is_pending());
    }

    #[test]
    fn flush_clears_buffer() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "x"))
            .is_empty());
        assert_eq!(coalescer.flush().len(), 1);
        assert!(coalescer.flush().is_empty());
        assert!(!coalescer.is_pending());
    }

    #[test]
    fn preserves_attempt_identity_on_merged_event() {
        let mut coalescer = TextChunkCoalescer::new();
        assert!(coalescer
            .push(text_chunk("s", "t", "r", Some("attempt-7"), Some(3), "a"))
            .is_empty());
        assert!(coalescer
            .push(text_chunk("s", "t", "r", Some("attempt-7"), Some(3), "b"))
            .is_empty());

        let events = coalescer.flush();
        match &events[0] {
            AgenticEvent::TextChunk {
                attempt_id,
                attempt_index,
                text,
                ..
            } => {
                assert_eq!(attempt_id.as_deref(), Some("attempt-7"));
                assert_eq!(*attempt_index, Some(3));
                assert_eq!(text, "ab");
            }
            other => panic!("expected TextChunk, got {other:?}"),
        }
    }

    #[test]
    fn arms_deadline_when_pending_without_one() {
        let now = tokio::time::Instant::now();
        let window = Duration::from_millis(TEXT_CHUNK_COALESCE_WINDOW_MS);
        assert_eq!(
            next_flush_deadline(true, None, now, window),
            Some(now + window)
        );
    }

    #[test]
    fn keeps_existing_deadline_when_pending() {
        let now = tokio::time::Instant::now();
        let window = Duration::from_millis(TEXT_CHUNK_COALESCE_WINDOW_MS);
        let existing = now + Duration::from_millis(10);
        assert_eq!(
            next_flush_deadline(true, Some(existing), now, window),
            Some(existing)
        );
    }

    #[test]
    fn clears_deadline_when_buffer_drained() {
        let now = tokio::time::Instant::now();
        let window = Duration::from_millis(TEXT_CHUNK_COALESCE_WINDOW_MS);
        let existing = now + Duration::from_millis(10);
        assert_eq!(
            next_flush_deadline(false, Some(existing), now, window),
            None
        );
        assert_eq!(next_flush_deadline(false, None, now, window), None);
    }

    #[test]
    fn window_is_base_at_reference_rate() {
        assert_eq!(
            next_window(WINDOW_REF_CPS),
            Duration::from_millis(WINDOW_BASE_MS)
        );
    }

    #[test]
    fn window_grows_with_rate_and_clamps() {
        // Slow stream: clamped to the minimum (smaller than the fixed 50ms).
        assert_eq!(next_window(0.0), Duration::from_millis(WINDOW_MIN_MS));
        assert_eq!(next_window(10.0), Duration::from_millis(WINDOW_MIN_MS));
        // Double the reference rate -> double the window (within the cap).
        assert_eq!(
            next_window(WINDOW_REF_CPS * 2.0),
            Duration::from_millis(100)
        );
        // Fast stream: clamped to the maximum.
        assert_eq!(
            next_window(WINDOW_REF_CPS * 10.0),
            Duration::from_millis(WINDOW_MAX_MS)
        );
        // Negative rates are treated as zero.
        assert_eq!(next_window(-5.0), Duration::from_millis(WINDOW_MIN_MS));
    }

    #[test]
    fn rate_ema_blends_instant_rate() {
        // 40 chars flushed over a 50ms window -> 800 chars/sec instant.
        let blended = update_rate_ema(INITIAL_RATE_EMA_CPS, 40, Duration::from_millis(50));
        let expected = 0.7 * 800.0 + 0.3 * INITIAL_RATE_EMA_CPS;
        assert!((blended - expected).abs() < 1e-9);
    }

    #[test]
    fn rate_ema_resets_after_idle_gap() {
        // A window longer than the reset threshold replaces the estimate with
        // the instant rate instead of blending (stream restart).
        let reset = update_rate_ema(INITIAL_RATE_EMA_CPS, 80, Duration::from_millis(1000));
        assert!((reset - 80.0).abs() < 1e-9);
    }

    #[test]
    fn buffered_chars_tracks_pending_content() {
        let mut coalescer = TextChunkCoalescer::new();
        assert_eq!(coalescer.buffered_chars(), 0);
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "abcd"))
            .is_empty());
        assert_eq!(coalescer.buffered_chars(), 4);
        // Merging into the same stream accumulates.
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "ef"))
            .is_empty());
        assert_eq!(coalescer.buffered_chars(), 6);
        // Thinking content counts too.
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "xyz", false))
            .is_empty());
        assert_eq!(coalescer.buffered_chars(), 9);
        // Flush drains and resets the counter.
        assert_eq!(coalescer.flush().len(), 2);
        assert_eq!(coalescer.buffered_chars(), 0);
    }

    #[test]
    fn buffered_chars_counts_unicode_not_bytes() {
        let mut coalescer = TextChunkCoalescer::new();
        // "中文" is 2 Unicode characters but 6 UTF-8 bytes.
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "中文"))
            .is_empty());
        assert_eq!(coalescer.buffered_chars(), 2);
        assert!(coalescer
            .push(text_chunk("s", "t", "r", None, None, "a"))
            .is_empty());
        assert_eq!(coalescer.buffered_chars(), 3);
        assert!(coalescer
            .push(thinking_chunk("s", "t", "r", None, None, "世界", false))
            .is_empty());
        assert_eq!(coalescer.buffered_chars(), 5);
        assert_eq!(coalescer.flush().len(), 2);
        assert_eq!(coalescer.buffered_chars(), 0);
    }

    #[test]
    fn rate_ema_resets_after_long_idle_gap() {
        // A window longer than the reset threshold must replace the estimate
        // with the instant rate. Use a previous estimate that differs from the
        // instant rate so the reset is observable.
        let reset = update_rate_ema(160.0, 80, Duration::from_millis(2000));
        // 80 chars over 2000 ms -> 40 chars/sec; reset should discard the old 160.
        assert!((reset - 40.0).abs() < 1e-9);
    }
}

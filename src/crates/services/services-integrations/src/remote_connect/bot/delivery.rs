//! Bounded, resumable text delivery shared by the IM provider clients.
//!
//! A long reply is split into provider-sized chunks. Each chunk is retried a
//! bounded number of times with exponential backoff, honouring a provider
//! `retry_after` hint. When a chunk still cannot be sent, the error carries the
//! unsent remainder ([`UndeliveredText`]) so the caller can keep it and resume
//! from the failed chunk instead of resending (or losing) the whole reply.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::hash::Hash;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

/// A provider send failure with its retry classification.
#[derive(Debug, Clone)]
pub struct SendFailure {
    pub retryable: bool,
    pub retry_after: Option<Duration>,
    pub message: String,
}

impl SendFailure {
    pub fn permanent(message: impl Into<String>) -> Self {
        Self {
            retryable: false,
            retry_after: None,
            message: message.into(),
        }
    }

    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            retryable: true,
            retry_after: None,
            message: message.into(),
        }
    }

    /// Classify an HTTP status: 429 and 5xx are worth retrying.
    pub fn from_status(
        status: u16,
        retry_after: Option<Duration>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            retryable: status == 429 || (500..600).contains(&status),
            retry_after,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SendFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for SendFailure {}

/// Retry classification of an arbitrary send error. Only explicit provider
/// classifications and connection failures are retried: a timed-out request
/// may already have been delivered, so it is not resent blindly.
pub fn classify_send_error(error: &anyhow::Error) -> (bool, Option<Duration>) {
    if let Some(failure) = error.downcast_ref::<SendFailure>() {
        return (failure.retryable, failure.retry_after);
    }
    if let Some(error) = error.downcast_ref::<reqwest::Error>() {
        return (error.is_connect(), None);
    }
    (false, None)
}

/// The part of a reply that was not delivered.
#[derive(Debug, Clone)]
pub struct UndeliveredText {
    pub delivered_chunks: usize,
    pub remaining: Vec<String>,
    pub cause: String,
}

impl UndeliveredText {
    pub fn remaining_text(&self) -> String {
        self.remaining.concat()
    }
}

impl std::fmt::Display for UndeliveredText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} of {} message part(s) undelivered after retries: {}",
            self.remaining.len(),
            self.delivered_chunks + self.remaining.len(),
            self.cause
        )
    }
}

impl std::error::Error for UndeliveredText {}

/// The text still owed to the user after `error`: the undelivered chunks when
/// the error came from [`send_chunks`], otherwise the whole `original` text.
pub fn undelivered_remainder(error: &anyhow::Error, original: &str) -> String {
    error
        .downcast_ref::<UndeliveredText>()
        .map(UndeliveredText::remaining_text)
        .unwrap_or_else(|| original.to_string())
}

#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    /// Total attempts per chunk, including the first.
    pub attempts: u32,
    pub base_delay: Duration,
    pub max_delay: Duration,
    /// A provider asking to wait longer than this ends the attempt: the reply
    /// is kept for later instead of blocking the chat's delivery task.
    pub max_retry_after: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 4,
            base_delay: Duration::from_secs(1),
            max_delay: Duration::from_secs(8),
            max_retry_after: Duration::from_secs(60),
        }
    }
}

impl RetryPolicy {
    fn backoff(&self, failed_attempts: u32) -> Duration {
        let factor = 1u32
            .checked_shl(failed_attempts.saturating_sub(1))
            .unwrap_or(u32::MAX);
        self.base_delay.saturating_mul(factor).min(self.max_delay)
    }
}

/// Send `chunks` in order. A chunk that fails is retried per `policy`; once it
/// cannot be delivered, later chunks are not attempted (they would arrive out
/// of order) and the error is an [`UndeliveredText`] starting at that chunk.
pub async fn send_chunks<F, Fut>(
    chunks: Vec<String>,
    policy: &RetryPolicy,
    mut send: F,
) -> anyhow::Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    for (index, chunk) in chunks.iter().enumerate() {
        let mut failed_attempts = 0u32;
        loop {
            let error = match send(chunk.clone()).await {
                Ok(()) => break,
                Err(error) => error,
            };
            failed_attempts += 1;
            let (retryable, retry_after) = classify_send_error(&error);
            let delay = retry_after.unwrap_or_else(|| policy.backoff(failed_attempts));
            if !retryable || failed_attempts >= policy.attempts || delay > policy.max_retry_after {
                return Err(anyhow::Error::new(UndeliveredText {
                    delivered_chunks: index,
                    remaining: chunks[index..].to_vec(),
                    cause: error.to_string(),
                }));
            }
            log::warn!(
                "Bot message part {} of {} failed, retrying in {}ms: {error}",
                index + 1,
                chunks.len(),
                delay.as_millis()
            );
            tokio::time::sleep(delay).await;
        }
    }
    Ok(())
}

/// Split `text` into parts of at most `max_bytes`, preferring a line break in
/// the last quarter of each window. Splitting is lossless: the parts
/// concatenate back to `text`.
pub fn chunk_text(text: &str, max_bytes: usize) -> Vec<String> {
    let max_bytes = max_bytes.max(4);
    let mut out = Vec::new();
    let mut rest = text;
    while rest.len() > max_bytes {
        let mut cut = max_bytes;
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        if let Some(newline) = rest[..cut].rfind('\n') {
            if newline + 1 >= cut - cut / 4 {
                cut = newline + 1;
            }
        }
        out.push(rest[..cut].to_string());
        rest = &rest[cut..];
    }
    if !rest.is_empty() || out.is_empty() {
        out.push(rest.to_string());
    }
    out
}

/// Replies kept per chat after delivery failed, oldest first.
const MAX_HELD_REPLIES_PER_CHAT: usize = 8;
/// Bytes kept per chat; older replies are dropped first.
const MAX_HELD_BYTES_PER_CHAT: usize = 256 * 1024;
/// A held reply older than this is no longer worth resending.
const HELD_REPLY_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Final replies that could not be delivered, resent with the chat's next
/// inbound message.
///
/// Kept in memory only: the answer itself is persisted in the session history
/// (and reachable with `/resume`), and bot persistence holds credentials and
/// chat selection, not conversation content.
pub struct HeldReplies<K> {
    chats: StdMutex<HashMap<K, VecDeque<(Instant, String)>>>,
}

impl<K: Eq + Hash + Clone> Default for HeldReplies<K> {
    fn default() -> Self {
        Self {
            chats: StdMutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash + Clone> HeldReplies<K> {
    /// Keep `text` for `chat`. Returns how many older replies were dropped.
    pub fn hold(&self, chat: &K, text: String) -> usize {
        if text.trim().is_empty() {
            return 0;
        }
        let mut chats = self.chats.lock().unwrap_or_else(|p| p.into_inner());
        let queue = chats.entry(chat.clone()).or_default();
        queue.push_back((Instant::now(), text));
        let mut dropped = 0;
        while queue.len() > MAX_HELD_REPLIES_PER_CHAT
            || (queue.len() > 1
                && queue.iter().map(|(_, text)| text.len()).sum::<usize>()
                    > MAX_HELD_BYTES_PER_CHAT)
        {
            queue.pop_front();
            dropped += 1;
        }
        dropped
    }

    /// Take every unexpired reply held for `chat`, oldest first.
    pub fn take(&self, chat: &K) -> Vec<String> {
        let mut chats = self.chats.lock().unwrap_or_else(|p| p.into_inner());
        chats
            .remove(chat)
            .into_iter()
            .flatten()
            .filter(|(held_at, _)| held_at.elapsed() <= HELD_REPLY_TTL)
            .map(|(_, text)| text)
            .collect()
    }

    /// Put replies that still could not be delivered back in front of anything
    /// held meanwhile, preserving order.
    pub fn restore(&self, chat: &K, texts: Vec<String>) {
        if texts.is_empty() {
            return;
        }
        let mut chats = self.chats.lock().unwrap_or_else(|p| p.into_inner());
        let queue = chats.entry(chat.clone()).or_default();
        let now = Instant::now();
        for text in texts.into_iter().rev() {
            queue.push_front((now, text));
        }
        while queue.len() > MAX_HELD_REPLIES_PER_CHAT {
            queue.pop_front();
        }
    }

    pub fn is_empty(&self, chat: &K) -> bool {
        self.chats
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(chat)
            .is_none_or(VecDeque::is_empty)
    }

    /// Forget every held reply, e.g. when the account identity changes.
    pub fn clear(&self) {
        self.chats.lock().unwrap_or_else(|p| p.into_inner()).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fast_policy() -> RetryPolicy {
        RetryPolicy {
            attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(2),
            max_retry_after: Duration::from_millis(50),
        }
    }

    #[tokio::test]
    async fn transient_failure_is_retried_and_chunks_stay_in_order() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let failures = Arc::new(Mutex::new(1));
        let chunks = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let result = send_chunks(chunks, &fast_policy(), |chunk| {
            let sent = sent.clone();
            let failures = failures.clone();
            async move {
                if chunk == "b" {
                    let mut left = failures.lock().unwrap();
                    if *left > 0 {
                        *left -= 1;
                        return Err(anyhow::Error::new(SendFailure::from_status(
                            429,
                            Some(Duration::from_millis(1)),
                            "rate limited",
                        )));
                    }
                }
                sent.lock().unwrap().push(chunk);
                Ok(())
            }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(*sent.lock().unwrap(), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn exhausted_chunk_reports_the_unsent_remainder_for_resume() {
        let sent = Arc::new(Mutex::new(Vec::new()));
        let attempts = Arc::new(Mutex::new(0));
        let chunks = vec!["one ".to_string(), "two ".to_string(), "three".to_string()];
        let error = send_chunks(chunks, &fast_policy(), |chunk| {
            let sent = sent.clone();
            let attempts = attempts.clone();
            async move {
                if chunk == "two " {
                    *attempts.lock().unwrap() += 1;
                    return Err(anyhow::Error::new(SendFailure::transient("HTTP 502")));
                }
                sent.lock().unwrap().push(chunk);
                Ok(())
            }
        })
        .await
        .unwrap_err();
        assert_eq!(*attempts.lock().unwrap(), 3);
        assert_eq!(*sent.lock().unwrap(), vec!["one "]);
        let undelivered = error.downcast_ref::<UndeliveredText>().unwrap();
        assert_eq!(undelivered.delivered_chunks, 1);
        assert_eq!(undelivered_remainder(&error, "ignored"), "two three");
    }

    #[tokio::test]
    async fn permanent_failure_and_long_retry_after_are_not_retried() {
        for failure in [
            SendFailure::permanent("bad request"),
            SendFailure::from_status(429, Some(Duration::from_secs(3600)), "flood"),
        ] {
            let attempts = Arc::new(Mutex::new(0));
            let error = send_chunks(vec!["x".into()], &fast_policy(), |_| {
                let attempts = attempts.clone();
                let failure = failure.clone();
                async move {
                    *attempts.lock().unwrap() += 1;
                    Err(anyhow::Error::new(failure))
                }
            })
            .await
            .unwrap_err();
            assert_eq!(*attempts.lock().unwrap(), 1);
            assert_eq!(undelivered_remainder(&error, "x"), "x");
        }
        assert_eq!(
            undelivered_remainder(&anyhow::anyhow!("plain"), "whole"),
            "whole"
        );
    }

    #[test]
    fn chunking_is_lossless_and_prefers_line_breaks() {
        let text = format!("{}\n{}", "a".repeat(90), "b".repeat(50));
        let chunks = chunk_text(&text, 100);
        assert_eq!(chunks[0], format!("{}\n", "a".repeat(90)));
        assert_eq!(chunks.concat(), text);
        let cjk = "图".repeat(50);
        let chunks = chunk_text(&cjk, 10);
        assert!(chunks.iter().all(|chunk| chunk.len() <= 10));
        assert_eq!(chunks.concat(), cjk);
        assert_eq!(chunk_text("", 10), vec![String::new()]);
    }

    #[test]
    fn held_replies_are_bounded_and_restored_in_order() {
        let held = HeldReplies::<String>::default();
        let chat = "chat".to_string();
        for index in 0..(MAX_HELD_REPLIES_PER_CHAT + 2) {
            held.hold(&chat, format!("reply {index}"));
        }
        let taken = held.take(&chat);
        assert_eq!(taken.len(), MAX_HELD_REPLIES_PER_CHAT);
        assert_eq!(taken[0], "reply 2");
        assert!(held.is_empty(&chat));
        held.hold(&chat, "newer".into());
        held.restore(&chat, vec!["older".into()]);
        assert_eq!(held.take(&chat), vec!["older", "newer"]);
        assert_eq!(held.hold(&chat, "   ".into()), 0);
        assert!(held.is_empty(&chat));
    }
}

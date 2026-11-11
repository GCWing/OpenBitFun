//! Pairing authorization gate shared by the Telegram, Feishu and Weixin bots.
//!
//! A chat is authorized only by state that says it completed pairing; a chat
//! without such state is unpaired. Everything an adapter does for an unpaired
//! chat is decided here: the gate owns the pending pairing codes, limits wrong
//! codes per chat, and bounds the replies an unpaired chat can cause.

use super::locale::{strings_for, BotLanguage};
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

/// How long a pairing code shown on the host stays valid.
pub(crate) const PAIRING_CODE_TTL_SECS: i64 = 300;

/// Wrong codes one chat may send against the pending code. Reaching the limit
/// locks that chat out until the code expires, is used, or is replaced. This
/// throttles authentication guesses; it is unrelated to agent execution.
pub(crate) const MAX_WRONG_PAIRING_CODES: u8 = 5;

/// Explanatory replies one unpaired chat receives before the bot stops
/// answering it. The count starts again when the explanation changes (a code
/// is issued, used or expires) or after the chat stayed quiet.
pub(crate) const MAX_UNPAIRED_NOTICES: u8 = 3;

/// An unpaired chat that stayed silent this long is answered again.
pub(crate) const UNPAIRED_QUIET_SECS: i64 = 10 * 60;

/// Unpaired chats tracked individually. Chats beyond it share one record, so
/// neither memory, replies, nor guesses grow with the number of strangers.
pub(crate) const MAX_TRACKED_UNPAIRED_CHATS: usize = 4096;

/// What an adapter tells an unpaired chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnpairedReply {
    /// `/start` while a pairing code is pending.
    Welcome,
    /// A pairing code is pending and the chat has not sent one.
    EnterCode,
    /// The chat sent a code that is not the pending one.
    WrongCode { attempts_left: u8 },
    /// The chat used up its attempts for the pending code.
    LockedOut,
    /// No chat is connected and no pairing code is pending.
    NoActiveCode,
    /// Another chat owns the connection and no pairing code is pending.
    ConnectedElsewhere,
}

/// How an adapter handles one message from an unpaired chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnpairedDecision {
    /// The chat presented a valid, unexpired, unused code, which is now
    /// consumed. The adapter completes pairing for this chat.
    Pair,
    Reply(UnpairedReply),
    /// The chat already got its replies; answering again would be spam.
    Silent,
}

#[derive(Debug, Default, Clone, Copy)]
struct UnpairedChat {
    /// Gate phase the counters below belong to.
    phase: u64,
    last_seen_at: i64,
    notices: u8,
    wrong_codes: u8,
}

impl UnpairedChat {
    fn refresh(&mut self, phase: u64, now: i64) {
        if self.phase != phase {
            self.phase = phase;
            self.notices = 0;
            self.wrong_codes = 0;
        } else if now.saturating_sub(self.last_seen_at) >= UNPAIRED_QUIET_SECS {
            self.notices = 0;
        }
        self.last_seen_at = now;
    }
}

#[derive(Default)]
struct GateState {
    /// Pending codes and when each was issued.
    codes: HashMap<String, i64>,
    /// Advances when a code is issued and when the last pending code is used
    /// or expires. Counters of an older phase are reset on next use, so a
    /// lockout lasts exactly as long as the code it protected.
    phase: u64,
    chats: HashMap<String, UnpairedChat>,
    /// Shared by the chats that arrive while every record is in use.
    overflow: UnpairedChat,
}

impl GateState {
    /// Drops expired codes and reports whether a usable one is still pending.
    fn expire_codes(&mut self, now: i64) -> bool {
        if self.codes.is_empty() {
            return false;
        }
        self.codes
            .retain(|_, issued_at| now.saturating_sub(*issued_at) < PAIRING_CODE_TTL_SECS);
        if self.codes.is_empty() {
            self.phase = self.phase.wrapping_add(1);
        }
        !self.codes.is_empty()
    }

    /// Consumes the pending code equal to `candidate`.
    fn take_code(&mut self, candidate: &str) -> bool {
        let Some(code) = self
            .codes
            .keys()
            .find(|code| constant_time_eq(code.as_bytes(), candidate.as_bytes()))
            .cloned()
        else {
            return false;
        };
        self.codes.remove(&code);
        if self.codes.is_empty() {
            self.phase = self.phase.wrapping_add(1);
        }
        true
    }

    fn chat(&mut self, chat: &str, now: i64) -> &mut UnpairedChat {
        let phase = self.phase;
        if !self.chats.contains_key(chat) && self.chats.len() >= MAX_TRACKED_UNPAIRED_CHATS {
            // Only chats that went quiet make room. A record that still
            // counts wrong codes was seen within the code lifetime, which is
            // shorter than the quiet period, so cycling through many chats
            // can never reset an attempt counter.
            self.chats
                .retain(|_, record| now.saturating_sub(record.last_seen_at) < UNPAIRED_QUIET_SECS);
        }
        let record =
            if self.chats.contains_key(chat) || self.chats.len() < MAX_TRACKED_UNPAIRED_CHATS {
                self.chats.entry(chat.to_string()).or_default()
            } else {
                &mut self.overflow
            };
        record.refresh(phase, now);
        record
    }
}

pub(crate) struct PairingGate {
    state: StdMutex<GateState>,
}

impl PairingGate {
    pub(crate) fn new() -> Self {
        Self {
            state: StdMutex::new(GateState::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Makes `code` the pairing code the host is showing right now.
    pub(crate) fn register(&self, code: &str) {
        self.register_issued_at(code, now_secs());
    }

    pub(crate) fn register_issued_at(&self, code: &str, issued_at: i64) {
        let mut gate = self.lock();
        gate.codes.clear();
        gate.codes.insert(code.to_string(), issued_at);
        gate.phase = gate.phase.wrapping_add(1);
    }

    /// Compatibility entry point for host-side verification. Inbound messages
    /// use `evaluate`, which also checks the requesting chat's attempt budget.
    pub(crate) fn consume(&self, code: &str) -> bool {
        let mut gate = self.lock();
        gate.expire_codes(now_secs()) && gate.take_code(code)
    }

    /// Decides one message from a chat that has not completed pairing.
    /// `connected_elsewhere` says whether another chat owns the connection.
    pub(crate) fn evaluate(
        &self,
        chat: &str,
        text: &str,
        connected_elsewhere: bool,
    ) -> UnpairedDecision {
        self.evaluate_at(chat, text, connected_elsewhere, now_secs())
    }

    fn evaluate_at(
        &self,
        chat: &str,
        text: &str,
        connected_elsewhere: bool,
        now: i64,
    ) -> UnpairedDecision {
        let mut gate = self.lock();
        let code_pending = gate.expire_codes(now);
        let text = text.trim();

        if code_pending && is_pairing_code(text) {
            if gate.chat(chat, now).wrong_codes >= MAX_WRONG_PAIRING_CODES {
                // A locked out chat is not even compared with the code: the
                // limit cannot be bypassed and the code is not consumed.
                return UnpairedDecision::Silent;
            }
            if gate.take_code(text) {
                gate.chats.remove(chat);
                return UnpairedDecision::Pair;
            }
            let record = gate.chat(chat, now);
            record.wrong_codes += 1;
            return UnpairedDecision::Reply(if record.wrong_codes >= MAX_WRONG_PAIRING_CODES {
                UnpairedReply::LockedOut
            } else {
                UnpairedReply::WrongCode {
                    attempts_left: MAX_WRONG_PAIRING_CODES - record.wrong_codes,
                }
            });
        }

        let record = gate.chat(chat, now);
        if record.wrong_codes >= MAX_WRONG_PAIRING_CODES || record.notices >= MAX_UNPAIRED_NOTICES {
            return UnpairedDecision::Silent;
        }
        record.notices += 1;
        UnpairedDecision::Reply(if !code_pending {
            if connected_elsewhere {
                UnpairedReply::ConnectedElsewhere
            } else {
                UnpairedReply::NoActiveCode
            }
        } else if text == "/start" {
            UnpairedReply::Welcome
        } else {
            UnpairedReply::EnterCode
        })
    }

    #[cfg(test)]
    pub(crate) fn tracks(&self, chat: &str) -> bool {
        self.lock().chats.contains_key(chat)
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// A pairing code attempt is exactly six ASCII digits.
fn is_pairing_code(text: &str) -> bool {
    text.len() == 6 && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

impl UnpairedReply {
    /// The reply in the host's language. The host can be Desktop or the CLI
    /// daemon, so the new wording says "on your computer".
    pub(crate) fn text(self, language: BotLanguage) -> String {
        match self {
            Self::Welcome => strings_for(language).welcome.to_string(),
            Self::EnterCode => strings_for(language).need_pairing.to_string(),
            Self::WrongCode { attempts_left } => match language {
                BotLanguage::ZhCN => format!(
                    "\u{914d}\u{5bf9}\u{7801}\u{4e0d}\u{6b63}\u{786e}\u{3002}\u{8bf7}\u{6838}\u{5bf9}\u{7535}\u{8111}\u{4e0a} OpenBitFun \u{663e}\u{793a}\u{7684}\u{914d}\u{5bf9}\u{7801}\u{540e}\u{91cd}\u{8bd5}\u{3002}\u{5269}\u{4f59}\u{5c1d}\u{8bd5}\u{6b21}\u{6570}\u{ff1a}{attempts_left}\u{3002}"
                ),
                BotLanguage::ZhTW => format!(
                    "\u{914d}\u{5c0d}\u{78bc}\u{4e0d}\u{6b63}\u{78ba}\u{3002}\u{8acb}\u{6838}\u{5c0d}\u{96fb}\u{8166}\u{4e0a} OpenBitFun \u{986f}\u{793a}\u{7684}\u{914d}\u{5c0d}\u{78bc}\u{5f8c}\u{91cd}\u{8a66}\u{3002}\u{5269}\u{9918}\u{5617}\u{8a66}\u{6b21}\u{6578}\u{ff1a}{attempts_left}\u{3002}"
                ),
                BotLanguage::EnUS => format!(
                    "Incorrect pairing code. Check the code shown by OpenBitFun on your computer and try again. Attempts left: {attempts_left}."
                ),
            },
            Self::LockedOut => match language {
                BotLanguage::ZhCN => {
                    "\u{914d}\u{5bf9}\u{7801}\u{9519}\u{8bef}\u{6b21}\u{6570}\u{8fc7}\u{591a}\u{ff0c}\u{6b64}\u{804a}\u{5929}\u{5df2}\u{65e0}\u{6cd5}\u{518d}\u{4f7f}\u{7528}\u{5f53}\u{524d}\u{914d}\u{5bf9}\u{7801}\u{3002}\u{8bf7}\u{5728}\u{7535}\u{8111}\u{4e0a}\u{7684} OpenBitFun \u{4e2d}\u{91cd}\u{65b0}\u{5f00}\u{59cb}\u{914d}\u{5bf9}\u{ff0c}\u{4ee5}\u{83b7}\u{53d6}\u{65b0}\u{7684}\u{914d}\u{5bf9}\u{7801}\u{3002}"
                }
                BotLanguage::ZhTW => {
                    "\u{914d}\u{5c0d}\u{78bc}\u{932f}\u{8aa4}\u{6b21}\u{6578}\u{904e}\u{591a}\u{ff0c}\u{6b64}\u{804a}\u{5929}\u{5df2}\u{7121}\u{6cd5}\u{518d}\u{4f7f}\u{7528}\u{76ee}\u{524d}\u{7684}\u{914d}\u{5c0d}\u{78bc}\u{3002}\u{8acb}\u{5728}\u{96fb}\u{8166}\u{4e0a}\u{7684} OpenBitFun \u{4e2d}\u{91cd}\u{65b0}\u{958b}\u{59cb}\u{914d}\u{5c0d}\u{ff0c}\u{4ee5}\u{53d6}\u{5f97}\u{65b0}\u{7684}\u{914d}\u{5c0d}\u{78bc}\u{3002}"
                }
                BotLanguage::EnUS => {
                    "Too many incorrect pairing codes. This chat can no longer use the current pairing code. Start pairing again from OpenBitFun on your computer to get a new code."
                }
            }
            .to_string(),
            Self::NoActiveCode => match language {
                BotLanguage::ZhCN => {
                    "\u{6b64}\u{673a}\u{5668}\u{4eba}\u{5f53}\u{524d}\u{6ca1}\u{6709}\u{53ef}\u{7528}\u{7684}\u{914d}\u{5bf9}\u{7801}\u{3002}\u{8bf7}\u{5728}\u{7535}\u{8111}\u{4e0a}\u{7684} OpenBitFun \u{4e2d}\u{5f00}\u{59cb}\u{914d}\u{5bf9}\u{ff0c}\u{7136}\u{540e}\u{53d1}\u{9001}\u{5176}\u{663e}\u{793a}\u{7684} 6 \u{4f4d}\u{914d}\u{5bf9}\u{7801}\u{3002}"
                }
                BotLanguage::ZhTW => {
                    "\u{6b64}\u{6a5f}\u{5668}\u{4eba}\u{76ee}\u{524d}\u{6c92}\u{6709}\u{53ef}\u{7528}\u{7684}\u{914d}\u{5c0d}\u{78bc}\u{3002}\u{8acb}\u{5728}\u{96fb}\u{8166}\u{4e0a}\u{7684} OpenBitFun \u{4e2d}\u{958b}\u{59cb}\u{914d}\u{5c0d}\u{ff0c}\u{7136}\u{5f8c}\u{50b3}\u{9001}\u{5176}\u{986f}\u{793a}\u{7684} 6 \u{4f4d}\u{914d}\u{5c0d}\u{78bc}\u{3002}"
                }
                BotLanguage::EnUS => {
                    "There is no active pairing code for this bot. Start pairing from OpenBitFun on your computer, then send the 6-digit pairing code it shows."
                }
            }
            .to_string(),
            Self::ConnectedElsewhere => match language {
                BotLanguage::ZhCN => {
                    "\u{6b64}\u{673a}\u{5668}\u{4eba}\u{5df2}\u{8fde}\u{63a5}\u{5230}\u{53e6}\u{4e00}\u{4e2a}\u{804a}\u{5929}\u{ff0c}\u{4e0d}\u{63a5}\u{53d7}\u{6b64}\u{804a}\u{5929}\u{7684}\u{6d88}\u{606f}\u{3002}\u{5982}\u{9700}\u{5728}\u{8fd9}\u{91cc}\u{4f7f}\u{7528}\u{ff0c}\u{8bf7}\u{5728}\u{7535}\u{8111}\u{4e0a}\u{7684} OpenBitFun \u{4e2d}\u{4e3a}\u{6b64}\u{804a}\u{5929}\u{8fdb}\u{884c}\u{914d}\u{5bf9}\u{3002}"
                }
                BotLanguage::ZhTW => {
                    "\u{6b64}\u{6a5f}\u{5668}\u{4eba}\u{5df2}\u{9023}\u{63a5}\u{5230}\u{53e6}\u{4e00}\u{500b}\u{804a}\u{5929}\u{ff0c}\u{4e0d}\u{63a5}\u{53d7}\u{6b64}\u{804a}\u{5929}\u{7684}\u{8a0a}\u{606f}\u{3002}\u{5982}\u{9700}\u{5728}\u{9019}\u{88e1}\u{4f7f}\u{7528}\u{ff0c}\u{8acb}\u{5728}\u{96fb}\u{8166}\u{4e0a}\u{7684} OpenBitFun \u{4e2d}\u{70ba}\u{6b64}\u{804a}\u{5929}\u{9032}\u{884c}\u{914d}\u{5c0d}\u{3002}"
                }
                BotLanguage::EnUS => {
                    "This bot is already connected to another chat and does not accept messages from this one. To use it here, pair this chat from OpenBitFun on your computer."
                }
            }
            .to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "482913";
    const T0: i64 = 1_800_000_000;

    fn gate_with_code() -> PairingGate {
        let gate = PairingGate::new();
        gate.register_issued_at(CODE, T0);
        gate
    }

    fn wrong(attempts_left: u8) -> UnpairedDecision {
        UnpairedDecision::Reply(UnpairedReply::WrongCode { attempts_left })
    }

    fn reply(reply: UnpairedReply) -> UnpairedDecision {
        UnpairedDecision::Reply(reply)
    }

    #[test]
    fn valid_code_pairs_exactly_once() {
        let gate = gate_with_code();
        assert_eq!(
            gate.evaluate_at("owner", &format!(" {CODE}\n"), false, T0 + 10),
            UnpairedDecision::Pair
        );
        // The used code is gone: a second chat is told the truth instead of
        // being asked for a code that no longer exists.
        assert_eq!(
            gate.evaluate_at("second", CODE, true, T0 + 11),
            reply(UnpairedReply::ConnectedElsewhere)
        );
        assert_eq!(
            gate.evaluate_at("third", CODE, false, T0 + 12),
            reply(UnpairedReply::NoActiveCode)
        );
        assert!(!gate.tracks("owner"));
    }

    #[test]
    fn code_expires_after_its_lifetime() {
        let gate = gate_with_code();
        assert_eq!(
            gate.evaluate_at("late", CODE, false, T0 + PAIRING_CODE_TTL_SECS),
            reply(UnpairedReply::NoActiveCode)
        );

        let gate = gate_with_code();
        assert_eq!(
            gate.evaluate_at("in-time", CODE, false, T0 + PAIRING_CODE_TTL_SECS - 1),
            UnpairedDecision::Pair
        );
    }

    #[test]
    fn replacing_a_code_revokes_the_previous_code() {
        let gate = gate_with_code();
        gate.register_issued_at("735144", T0 + 1);
        assert_eq!(gate.evaluate_at("old-holder", CODE, true, T0 + 2), wrong(4));
        assert_eq!(
            gate.evaluate_at("owner", "735144", true, T0 + 2),
            UnpairedDecision::Pair
        );
        assert!(!gate.lock().expire_codes(T0 + 3));
    }

    #[test]
    fn wrong_codes_lock_out_one_chat_without_burning_the_code() {
        let gate = gate_with_code();
        for attempts_left in (1..MAX_WRONG_PAIRING_CODES).rev() {
            assert_eq!(
                gate.evaluate_at("stranger", "000000", false, T0 + 1),
                wrong(attempts_left)
            );
        }
        assert_eq!(
            gate.evaluate_at("stranger", "000000", false, T0 + 2),
            reply(UnpairedReply::LockedOut)
        );
        // Locked out: silent for guesses, the right code and anything else.
        assert_eq!(
            gate.evaluate_at("stranger", "000001", false, T0 + 3),
            UnpairedDecision::Silent
        );
        assert_eq!(
            gate.evaluate_at("stranger", CODE, false, T0 + 3),
            UnpairedDecision::Silent
        );
        assert_eq!(
            gate.evaluate_at("stranger", "let me in", false, T0 + 3),
            UnpairedDecision::Silent
        );

        // Another chat is unaffected and the code is still usable.
        assert_eq!(
            gate.evaluate_at("owner", "111111", false, T0 + 4),
            wrong(MAX_WRONG_PAIRING_CODES - 1)
        );
        assert_eq!(
            gate.evaluate_at("owner", CODE, false, T0 + 5),
            UnpairedDecision::Pair
        );
    }

    #[test]
    fn lockout_ends_with_the_code_it_protected() {
        let lock_out = |gate: &PairingGate, now: i64| {
            for _ in 0..MAX_WRONG_PAIRING_CODES {
                gate.evaluate_at("chat", "000000", false, now);
            }
            assert_eq!(
                gate.evaluate_at("chat", CODE, false, now),
                UnpairedDecision::Silent
            );
        };

        // A new code from the host gives every chat a fresh set of attempts.
        let gate = gate_with_code();
        lock_out(&gate, T0 + 1);
        gate.register_issued_at("735144", T0 + 20);
        assert_eq!(
            gate.evaluate_at("chat", "000000", false, T0 + 21),
            wrong(MAX_WRONG_PAIRING_CODES - 1)
        );
        assert_eq!(
            gate.evaluate_at("chat", "735144", false, T0 + 22),
            UnpairedDecision::Pair
        );

        // After expiry the chat is told there is nothing left to guess.
        let gate = gate_with_code();
        lock_out(&gate, T0 + 1);
        assert_eq!(
            gate.evaluate_at("chat", "000000", false, T0 + PAIRING_CODE_TTL_SECS),
            reply(UnpairedReply::NoActiveCode)
        );
    }

    #[test]
    fn six_digits_without_a_pending_code_are_not_attempts() {
        let gate = PairingGate::new();
        for _ in 0..20 {
            gate.evaluate_at("chat", "000000", true, T0);
        }
        gate.register_issued_at(CODE, T0 + 1);
        assert_eq!(
            gate.evaluate_at("chat", "000000", true, T0 + 2),
            wrong(MAX_WRONG_PAIRING_CODES - 1)
        );
    }

    #[test]
    fn only_six_ascii_digits_count_as_a_code_attempt() {
        let gate = gate_with_code();
        for text in ["48291", "4829133", "48291a", "\u{ff14}82913", "482 913"] {
            assert_eq!(
                gate.evaluate_at(text, text, false, T0 + 1),
                reply(UnpairedReply::EnterCode),
                "{text:?}"
            );
        }
        assert!(constant_time_eq(b"482913", b"482913"));
        assert!(!constant_time_eq(b"482913", b"482914"));
        assert!(!constant_time_eq(b"482913", b"48291"));
    }

    #[test]
    fn notices_tell_the_truth_about_what_the_chat_can_do() {
        let gate = gate_with_code();
        assert_eq!(
            gate.evaluate_at("a", "/start", false, T0 + 1),
            reply(UnpairedReply::Welcome)
        );
        assert_eq!(
            gate.evaluate_at("b", "hello", true, T0 + 1),
            reply(UnpairedReply::EnterCode)
        );

        let gate = PairingGate::new();
        assert_eq!(
            gate.evaluate_at("a", "/start", false, T0),
            reply(UnpairedReply::NoActiveCode)
        );
        assert_eq!(
            gate.evaluate_at("b", "/start", true, T0),
            reply(UnpairedReply::ConnectedElsewhere)
        );
        assert_eq!(
            gate.evaluate_at("c", "", true, T0),
            reply(UnpairedReply::ConnectedElsewhere)
        );
    }

    #[test]
    fn notices_are_bounded_until_the_chat_goes_quiet_or_the_situation_changes() {
        let gate = PairingGate::new();
        let mut replies = 0;
        for second in 0..500 {
            if gate.evaluate_at("chat", "hello", true, T0 + second) != UnpairedDecision::Silent {
                replies += 1;
            }
        }
        assert_eq!(replies, usize::from(MAX_UNPAIRED_NOTICES));

        // Still chatty: the quiet period is measured from the last message.
        let last = T0 + 499;
        assert_eq!(
            gate.evaluate_at("chat", "hello", true, last + UNPAIRED_QUIET_SECS - 1),
            UnpairedDecision::Silent
        );
        // Quiet for the whole period: the explanation is given again.
        let last = last + UNPAIRED_QUIET_SECS - 1;
        assert_eq!(
            gate.evaluate_at("chat", "hello", true, last + UNPAIRED_QUIET_SECS),
            reply(UnpairedReply::ConnectedElsewhere)
        );

        // A code issued by the host changes what the chat should do, so the
        // new explanation is delivered even to a chat that was muted.
        let now = last + UNPAIRED_QUIET_SECS;
        for _ in 0..10 {
            gate.evaluate_at("chat", "hello", true, now);
        }
        gate.register_issued_at(CODE, now);
        assert_eq!(
            gate.evaluate_at("chat", "hello", true, now + 1),
            reply(UnpairedReply::EnterCode)
        );
    }

    #[test]
    fn tracking_is_bounded_and_overflow_chats_share_one_budget() {
        let gate = gate_with_code();
        for index in 0..MAX_TRACKED_UNPAIRED_CHATS {
            assert_eq!(
                gate.evaluate_at(&format!("chat-{index}"), "000000", false, T0 + 1),
                wrong(MAX_WRONG_PAIRING_CODES - 1)
            );
        }
        // Every record is in use by a chat that guessed: later chats share
        // the overflow record, so the table and the guesses stay bounded.
        for attempts_left in (1..MAX_WRONG_PAIRING_CODES).rev() {
            assert_eq!(
                gate.evaluate_at(&format!("late-{attempts_left}"), "000000", false, T0 + 2),
                wrong(attempts_left)
            );
        }
        assert_eq!(
            gate.evaluate_at("late-last", "000000", false, T0 + 2),
            reply(UnpairedReply::LockedOut)
        );
        assert_eq!(
            gate.evaluate_at("late-after", CODE, false, T0 + 2),
            UnpairedDecision::Silent
        );
        assert_eq!(gate.lock().chats.len(), MAX_TRACKED_UNPAIRED_CHATS);
        assert!(!gate.tracks("late-after"));
        // A tracked chat keeps its own attempts and can still pair.
        assert_eq!(
            gate.evaluate_at("chat-0", CODE, false, T0 + 3),
            UnpairedDecision::Pair
        );
        assert_eq!(
            gate.evaluate_at("recent", "hello", false, T0 + 4),
            reply(UnpairedReply::NoActiveCode)
        );
        assert_eq!(gate.lock().chats.len(), MAX_TRACKED_UNPAIRED_CHATS);

        // Records of chats that went quiet make room again.
        let later = T0 + 3 + UNPAIRED_QUIET_SECS;
        assert_eq!(
            gate.evaluate_at("newcomer", "hello", false, later),
            reply(UnpairedReply::NoActiveCode)
        );
        assert!(gate.tracks("recent"));
        assert!(gate.tracks("newcomer"));
        assert_eq!(gate.lock().chats.len(), 2);
    }

    #[test]
    fn every_reply_is_localized_for_each_supported_language() {
        let has_cjk = |text: &str| text.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
        for reply in [
            UnpairedReply::Welcome,
            UnpairedReply::EnterCode,
            UnpairedReply::WrongCode { attempts_left: 3 },
            UnpairedReply::LockedOut,
            UnpairedReply::NoActiveCode,
            UnpairedReply::ConnectedElsewhere,
        ] {
            let english = reply.text(BotLanguage::EnUS);
            let simplified = reply.text(BotLanguage::ZhCN);
            let traditional = reply.text(BotLanguage::ZhTW);
            assert!(!has_cjk(&english), "{reply:?}: {english}");
            assert!(has_cjk(&simplified), "{reply:?}");
            assert!(has_cjk(&traditional), "{reply:?}");
            assert_ne!(simplified, traditional, "{reply:?}");
            for text in [&english, &simplified, &traditional] {
                assert!(!text.trim().is_empty());
                assert!(!text.contains('{'), "unformatted placeholder: {text}");
            }
        }
        for language in [BotLanguage::EnUS, BotLanguage::ZhCN, BotLanguage::ZhTW] {
            assert!(UnpairedReply::WrongCode { attempts_left: 3 }
                .text(language)
                .contains('3'));
            for reply in [
                UnpairedReply::WrongCode { attempts_left: 3 },
                UnpairedReply::LockedOut,
                UnpairedReply::NoActiveCode,
                UnpairedReply::ConnectedElsewhere,
            ] {
                assert!(reply.text(language).contains("OpenBitFun"));
            }
        }
    }
}

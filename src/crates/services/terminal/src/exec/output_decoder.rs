//! Decode each process stream before merging or retaining its output.

use chardetng::EncodingDetector;
use encoding_rs::{Decoder, Encoding, IBM866, WINDOWS_1252};

/// Pipe reads and PTY frames need not end at a character boundary. Keep the
/// unfinished suffix across reads (and tool polls), rather than guessing a new
/// encoding for an otherwise valid UTF-8 chunk.
#[derive(Default)]
pub(super) struct OutputDecoder {
    pending: Vec<u8>,
    fallback: Option<Decoder>,
}

impl OutputDecoder {
    pub(super) fn push(&mut self, bytes: &[u8]) -> String {
        if let Some(decoder) = self.fallback.as_mut() {
            return decode_fallback(decoder, bytes, false);
        }

        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                let text = text.to_owned();
                self.pending.clear();
                text
            }
            Err(error) if error.error_len().is_none() => {
                let boundary = error.valid_up_to();
                let text = String::from_utf8_lossy(&self.pending[..boundary]).into_owned();
                self.pending.drain(..boundary);
                text
            }
            Err(_) => {
                // Retain the existing GBK / Windows code-page compatibility,
                // but only after a real UTF-8 error, never an incomplete suffix.
                // A stateful decoder also preserves split legacy characters.
                let mut decoder = detect_encoding(&self.pending).new_decoder_without_bom_handling();
                let text = decode_fallback(&mut decoder, &self.pending, false);
                self.pending.clear();
                self.fallback = Some(decoder);
                text
            }
        }
    }

    pub(super) fn finish(mut self) -> String {
        if let Some(decoder) = self.fallback.as_mut() {
            return decode_fallback(decoder, &[], true);
        }
        // Only EOF makes an unfinished UTF-8 scalar malformed. Do not reinterpret
        // it as a different encoding or silently discard it.
        String::from_utf8_lossy(&self.pending).into_owned()
    }
}

fn decode_fallback(decoder: &mut Decoder, bytes: &[u8], last: bool) -> String {
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .expect("process output decode capacity overflow");
    let mut text = String::with_capacity(capacity);
    let (_, read, _) = decoder.decode_to_string(bytes, &mut text, last);
    debug_assert_eq!(read, bytes.len());
    text
}

fn detect_encoding(bytes: &[u8]) -> &'static Encoding {
    let mut detector = EncodingDetector::new();
    // This is a stream prefix, not EOF: a legacy multibyte character may also
    // straddle the read boundary and must remain a viable encoding candidate.
    detector.feed(bytes, false);
    let (encoding, _is_confident) = detector.guess_assess(None, true);

    if encoding == IBM866 && looks_like_windows_1252_punctuation(bytes) {
        return WINDOWS_1252;
    }

    encoding
}

const WINDOWS_1252_PUNCT_BYTES: [u8; 8] = [0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x99];

fn looks_like_windows_1252_punctuation(bytes: &[u8]) -> bool {
    let mut saw_extended_punctuation = false;
    let mut saw_ascii_word = false;

    for &byte in bytes {
        if byte >= 0xA0 {
            return false;
        }
        if (0x80..=0x9F).contains(&byte) {
            if !WINDOWS_1252_PUNCT_BYTES.contains(&byte) {
                return false;
            }
            saw_extended_punctuation = true;
        }
        if byte.is_ascii_alphabetic() {
            saw_ascii_word = true;
        }
    }

    saw_extended_punctuation && saw_ascii_word
}

#[cfg(test)]
mod tests {
    use super::OutputDecoder;
    use encoding_rs::GBK;

    #[test]
    fn utf8_survives_every_split_and_single_byte_reads() {
        let expected = "ASCII / 中文，é😀 / end";
        for split in 0..=expected.len() {
            let mut decoder = OutputDecoder::default();
            let mut text = decoder.push(&expected.as_bytes()[..split]);
            text.push_str(&decoder.push(&expected.as_bytes()[split..]));
            text.push_str(&decoder.finish());
            assert_eq!(text, expected, "split at byte {split}");
        }

        let mut decoder = OutputDecoder::default();
        let mut text = String::new();
        for byte in expected.as_bytes() {
            text.push_str(&decoder.push(&[*byte]));
        }
        text.push_str(&decoder.finish());
        assert_eq!(text, expected);
    }

    #[test]
    fn incomplete_utf8_waits_for_more_bytes_and_flushes_only_at_eof() {
        let mut decoder = OutputDecoder::default();
        assert_eq!(decoder.push(b"ready\xef\xbc"), "ready");
        assert_eq!(decoder.push(b""), "");
        assert_eq!(decoder.push(b"\x8c"), "，");
        assert_eq!(decoder.push(b"tail\xf0\x9f"), "tail");
        assert_eq!(decoder.finish(), "\u{fffd}");
    }

    #[test]
    fn legacy_gbk_output_preserves_decoder_state_across_reads() {
        let expected = "小游戏平台小游戏平台";
        let (bytes, _, had_errors) = GBK.encode(expected);
        assert!(!had_errors);
        let mut decoder = OutputDecoder::default();
        // Supply enough text for detection, ending on a GBK lead byte.
        let mut text = decoder.push(&bytes[..9]);
        for byte in &bytes[9..] {
            text.push_str(&decoder.push(&[*byte]));
        }
        text.push_str(&decoder.finish());
        assert_eq!(text, expected);
    }

    #[test]
    fn legacy_windows_1252_punctuation_remains_supported() {
        let mut decoder = OutputDecoder::default();
        assert_eq!(decoder.push(b"\x93\x94 test \x96 dash"), "“” test – dash");
        assert_eq!(decoder.finish(), "");
    }

    #[test]
    fn legacy_gbk_incomplete_character_is_flushed_at_eof() {
        let (bytes, _, _) = GBK.encode("小游戏平台");
        let mut decoder = OutputDecoder::default();
        assert_eq!(decoder.push(&bytes[..9]), "小游戏平");
        assert_eq!(decoder.finish(), "\u{fffd}");
    }
}

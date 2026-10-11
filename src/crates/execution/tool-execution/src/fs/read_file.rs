use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};

#[derive(Debug, PartialEq, Eq)]
pub struct ReadFileResult {
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub content: String,
    pub hit_total_char_limit: bool,
    /// True when the returned view omits characters from selected lines.
    pub content_truncated: bool,
    /// Selected source lines whose contents were clipped by the per-line limit.
    pub truncated_lines: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadFilePresentation {
    pub result_for_assistant: String,
    pub lines_read: usize,
    pub next_offset: Option<usize>,
}

fn read_file_lines_read(result: &ReadFileResult) -> usize {
    if result.total_lines == 0 || result.end_line < result.start_line {
        0
    } else {
        result.end_line - result.start_line + 1
    }
}

pub fn build_read_file_presentation(
    logical_path: &str,
    result: &ReadFileResult,
) -> ReadFilePresentation {
    let lines_read = read_file_lines_read(result);
    let mut result_for_assistant = if result.total_lines == 0 {
        format!("{logical_path} is empty (0 lines).")
    } else if lines_read == 0 {
        format!(
            "No lines from {logical_path} fit within the Read output limit ({} total lines). Use another inspection method; a smaller line window cannot make a single line fit.",
            result.total_lines,
        )
    } else {
        format!(
            "Read lines {}-{} from {} ({} total lines)\n<file_content>\n{}\n</file_content>",
            result.start_line, result.end_line, logical_path, result.total_lines, result.content
        )
    };

    let has_more = lines_read > 0 && result.end_line < result.total_lines;
    let next_start_line = has_more.then_some(result.end_line + 1);
    if let Some(next_start) = next_start_line {
        if result.hit_total_char_limit {
            result_for_assistant.push_str(&format!(
                "\n\n[Output truncated after reaching the Read tool size limit. Use offset={} and limit to continue reading.]",
                next_start
            ));
        } else {
            result_for_assistant.push_str(&format!(
                "\n\n[Showing lines {}-{} of {} total. Use offset={} and limit to continue reading.]",
                result.start_line, result.end_line, result.total_lines, next_start
            ));
        }
    }
    if !result.truncated_lines.is_empty() {
        result_for_assistant.push_str(&format!(
            "\n\n[Lines {:?} contain truncated text. offset/limit cannot restore those characters. Use another inspection method before copying source text for Edit.]",
            result.truncated_lines,
        ));
    }

    ReadFilePresentation {
        result_for_assistant,
        lines_read,
        next_offset: next_start_line,
    }
}

/// Read a local file only when it fits within `max_bytes`.
///
/// The limit is enforced from handle metadata and again while reading so a growing file cannot
/// make the caller retain an unbounded buffer.
pub fn read_file_bytes_bounded(
    file_path: &str,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let file = File::open(file_path)
        .map_err(|error| format!("Failed to read file {file_path}: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Failed to inspect file {file_path}: {error}"))?;
    if metadata.len() > max_bytes as u64 {
        return Ok(None);
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read file {file_path}: {error}"))?;
    Ok((bytes.len() <= max_bytes).then_some(bytes))
}

/// Read a file through the provider's byte stream using the same parser as
/// local files and converted documents. No seek or remote text command is needed.
pub async fn read_file_from_reader<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    source: &str,
    start_line: usize,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
) -> Result<ReadFileResult, String> {
    read_async_text(
        reader,
        source,
        start_line,
        limit,
        max_line_chars,
        max_total_chars,
        false,
    )
    .await
}

pub async fn read_file_tail_from_reader<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    source: &str,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
) -> Result<ReadFileResult, String> {
    read_async_text(
        reader,
        source,
        1,
        limit,
        max_line_chars,
        max_total_chars,
        true,
    )
    .await
}

async fn read_async_text<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    source: &str,
    start_line: usize,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
    tail: bool,
) -> Result<ReadFileResult, String> {
    use tokio::io::AsyncReadExt;
    let mut decoder = ReadTextDecoder::new(ReadLineSelection::new(
        start_line,
        limit,
        max_line_chars,
        max_total_chars,
        tail,
    )?);
    let mut buffer = [0_u8; 8192];
    loop {
        // An async provider may use Interrupted for cancellation. Do not retry
        // ready errors in a tight loop and prevent the owning task from yielding.
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Failed to read {source}: {error}"))?;
        if count == 0 {
            break;
        }
        decoder
            .push_bytes(&buffer[..count])
            .map_err(|error| format!("Failed to read {source}: {error}"))?;
    }
    decoder
        .finish()
        .map_err(|error| format!("Failed to read {source}: {error}"))?
        .finish()
}

/// start_line: starts from 1
pub fn read_file(
    file_path: &str,
    start_line: usize,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
) -> Result<ReadFileResult, String> {
    let file = File::open(file_path)
        .map_err(|error| format!("Failed to read file {file_path}: {error}"))?;
    read_buffered_text(
        BufReader::new(file),
        &format!("file {file_path}"),
        start_line,
        limit,
        max_line_chars,
        max_total_chars,
        false,
    )
}

/// Page decoded text with the same line numbering and budgets as file streams.
pub fn read_text(
    text: &str,
    start_line: usize,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
) -> Result<ReadFileResult, String> {
    read_buffered_text(
        BufReader::new(text.as_bytes()),
        "converted document",
        start_line,
        limit,
        max_line_chars,
        max_total_chars,
        false,
    )
}

pub fn read_file_tail(
    file_path: &str,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
) -> Result<ReadFileResult, String> {
    let file = File::open(file_path)
        .map_err(|error| format!("Failed to read file {file_path}: {error}"))?;
    read_buffered_text(
        BufReader::new(file),
        &format!("file {file_path}"),
        1,
        limit,
        max_line_chars,
        max_total_chars,
        true,
    )
}

pub fn read_text_tail(
    text: &str,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
) -> Result<ReadFileResult, String> {
    read_buffered_text(
        BufReader::new(text.as_bytes()),
        "converted document",
        1,
        limit,
        max_line_chars,
        max_total_chars,
        true,
    )
}

fn read_buffered_text<R: BufRead>(
    mut reader: R,
    source: &str,
    start_line: usize,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
    tail: bool,
) -> Result<ReadFileResult, String> {
    let mut decoder = ReadTextDecoder::new(ReadLineSelection::new(
        start_line,
        limit,
        max_line_chars,
        max_total_chars,
        tail,
    )?);
    let mut buffer = [0_u8; 8192];
    loop {
        let count = match reader.read(&mut buffer) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result.map_err(|error| format!("Failed to read {source}: {error}"))?,
        };
        if count == 0 {
            break;
        }
        decoder
            .push_bytes(&buffer[..count])
            .map_err(|error| format!("Failed to read {source}: {error}"))?;
    }
    decoder
        .finish()
        .map_err(|error| format!("Failed to read {source}: {error}"))?
        .finish()
}

/// Validate every byte while retaining at most one bounded line prefix. A
/// newline-free file must not allocate its full size before presentation limits
/// can apply. Only an incomplete UTF-8 scalar and a possible CRLF carry across
/// chunks; both sync and async readers use this same decoder.
struct ReadTextDecoder {
    selection: ReadLineSelection,
    line: String,
    line_chars: usize,
    line_truncated: bool,
    has_line: bool,
    pending_cr: bool,
    utf8_tail: [u8; 4],
    utf8_tail_len: usize,
}

impl ReadTextDecoder {
    fn new(selection: ReadLineSelection) -> Self {
        Self {
            selection,
            line: String::new(),
            line_chars: 0,
            line_truncated: false,
            has_line: false,
            pending_cr: false,
            utf8_tail: [0; 4],
            utf8_tail_len: 0,
        }
    }

    fn push_bytes(&mut self, mut bytes: &[u8]) -> Result<(), String> {
        while self.utf8_tail_len > 0 && !bytes.is_empty() {
            self.utf8_tail[self.utf8_tail_len] = bytes[0];
            self.utf8_tail_len += 1;
            bytes = &bytes[1..];
            match std::str::from_utf8(&self.utf8_tail[..self.utf8_tail_len]) {
                Ok(text) => {
                    let character = text.chars().next().expect("completed UTF-8 scalar");
                    self.utf8_tail_len = 0;
                    self.push_char(character);
                }
                Err(error) if error.error_len().is_none() && self.utf8_tail_len < 4 => {}
                Err(_) => return Err("stream did not contain valid UTF-8".to_string()),
            }
        }
        match std::str::from_utf8(bytes) {
            Ok(text) => self.push_text(text),
            Err(error) => {
                let valid = error.valid_up_to();
                self.push_text(std::str::from_utf8(&bytes[..valid]).expect("valid UTF-8 prefix"));
                if error.error_len().is_some() {
                    return Err("stream did not contain valid UTF-8".to_string());
                }
                let tail = &bytes[valid..];
                self.utf8_tail[..tail.len()].copy_from_slice(tail);
                self.utf8_tail_len = tail.len();
            }
        }
        Ok(())
    }

    fn push_text(&mut self, text: &str) {
        for character in text.chars() {
            self.push_char(character);
        }
    }

    fn push_char(&mut self, character: char) {
        if character == '\n' {
            self.pending_cr = false;
            self.finish_line();
            return;
        }
        self.has_line = true;
        if self.pending_cr {
            self.retain_char('\r');
        }
        self.pending_cr = character == '\r';
        if !self.pending_cr {
            self.retain_char(character);
        }
    }

    fn retain_char(&mut self, character: char) {
        if self.line_chars < self.selection.max_line_chars {
            self.line.push(character);
            self.line_chars += 1;
        } else {
            self.line_truncated = true;
        }
    }

    fn finish_line(&mut self) {
        self.selection
            .push(std::mem::take(&mut self.line), self.line_truncated);
        self.line_chars = 0;
        self.line_truncated = false;
        self.has_line = false;
    }

    fn finish(mut self) -> Result<ReadLineSelection, String> {
        if self.utf8_tail_len != 0 {
            return Err("stream did not contain valid UTF-8".to_string());
        }
        if self.pending_cr {
            self.retain_char('\r');
        }
        if self.has_line {
            self.finish_line();
        }
        Ok(self.selection)
    }
}

/// Shared line selection, Unicode truncation, numbering and output budget.
/// Tail buffering retains truncated lines rather than the entire original lines.
struct ReadLineSelection {
    start_line: usize,
    end_line: usize,
    limit: usize,
    max_line_chars: usize,
    max_total_chars: usize,
    total_lines: usize,
    selected_lines: Vec<String>,
    selected_chars: usize,
    hit_total_char_limit: bool,
    content_truncated: bool,
    truncated_lines: Vec<usize>,
    tail_lines: Option<VecDeque<(usize, String, bool)>>,
}

impl ReadLineSelection {
    fn new(
        start_line: usize,
        limit: usize,
        max_line_chars: usize,
        max_total_chars: usize,
        tail: bool,
    ) -> Result<Self, String> {
        if start_line == 0 {
            return Err("`start_line` should start from 1".to_string());
        }
        if limit == 0 {
            return Err("`limit` can't be 0".to_string());
        }
        if max_total_chars == 0 {
            return Err("`max_total_chars` can't be 0".to_string());
        }
        let end_line = start_line
            .checked_add(limit.saturating_sub(1))
            .ok_or_else(|| "Requested line range is too large".to_string())?;
        Ok(Self {
            start_line,
            end_line,
            limit,
            max_line_chars,
            max_total_chars,
            total_lines: 0,
            selected_lines: Vec::new(),
            selected_chars: 0,
            hit_total_char_limit: false,
            content_truncated: false,
            truncated_lines: Vec::new(),
            tail_lines: tail.then(VecDeque::new),
        })
    }

    fn push(&mut self, line: String, truncated: bool) {
        self.total_lines += 1;
        if self.tail_lines.is_none()
            && (self.total_lines < self.start_line
                || self.total_lines > self.end_line
                || self.hit_total_char_limit)
        {
            return;
        }
        let line = if truncated {
            format!("{line} [truncated]")
        } else {
            line
        };
        if let Some(tail_lines) = &mut self.tail_lines {
            if tail_lines.len() == self.limit {
                tail_lines.pop_front();
            }
            tail_lines.push_back((self.total_lines, line, truncated));
        } else {
            self.select(self.total_lines, line, truncated);
        }
    }

    fn select(&mut self, line_number: usize, line: String, truncated: bool) {
        let rendered = format!("{line_number:>6}\t{line}");
        let next_chars = self
            .selected_chars
            .saturating_add(usize::from(!self.selected_lines.is_empty()))
            .saturating_add(rendered.chars().count());
        if next_chars > self.max_total_chars {
            self.hit_total_char_limit = true;
            self.content_truncated = true;
        } else {
            self.content_truncated |= truncated;
            if truncated {
                self.truncated_lines.push(line_number);
            }
            self.selected_chars = next_chars;
            self.selected_lines.push(rendered);
        }
    }

    fn finish(mut self) -> Result<ReadFileResult, String> {
        if self.total_lines == 0 {
            return Ok(ReadFileResult {
                start_line: 0,
                end_line: 0,
                total_lines: 0,
                content: String::new(),
                hit_total_char_limit: false,
                content_truncated: false,
                truncated_lines: Vec::new(),
            });
        }
        if let Some(tail_lines) = self.tail_lines.take() {
            self.start_line = self
                .total_lines
                .saturating_sub(self.limit)
                .saturating_add(1);
            for (number, line, truncated) in tail_lines {
                self.select(number, line, truncated);
                if self.hit_total_char_limit {
                    break;
                }
            }
        }
        if self.start_line > self.total_lines {
            return Err(format!(
                "`start_line` {} is larger than the number of lines in the file: {}",
                self.start_line, self.total_lines
            ));
        }
        let end_line = if self.selected_lines.is_empty() {
            self.start_line - 1
        } else {
            self.start_line
                .saturating_add(self.selected_lines.len())
                .saturating_sub(1)
        };
        Ok(ReadFileResult {
            start_line: self.start_line,
            end_line,
            total_lines: self.total_lines,
            content: self.selected_lines.join("\n"),
            hit_total_char_limit: self.hit_total_char_limit,
            content_truncated: self.content_truncated,
            truncated_lines: self.truncated_lines,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_read_file_presentation, read_file, read_file_bytes_bounded, read_file_lines_read,
        read_file_tail, read_text, read_text_tail, ReadFileResult,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn truncation_facts_describe_only_the_returned_view() {
        let text = "abcdef\nlast\n";
        let truncated = read_text(text, 1, 2, 4, 100).unwrap();
        assert!(truncated.content_truncated);
        assert_eq!(truncated.truncated_lines, vec![1]);
        assert!(!truncated.hit_total_char_limit);
        let tail = read_text_tail(text, 1, 4, 100).unwrap();
        assert!(
            !tail.content_truncated,
            "an evicted long line does not truncate the tail view"
        );
        let offset = read_text(text, 2, 1, 4, 100).unwrap();
        assert!(!offset.content_truncated);
        assert!(offset.truncated_lines.is_empty());
        assert!(tail.truncated_lines.is_empty());
        let budget = read_text(text, 1, 2, 50, 14).unwrap();
        assert!(budget.hit_total_char_limit);
        assert!(budget.content_truncated);
        assert!(budget.truncated_lines.is_empty());
        assert!(
            !read_text("literal [truncated]", 1, 1, 100, 100)
                .unwrap()
                .content_truncated
        );
    }

    #[test]
    fn chunk_decoder_preserves_unicode_crlf_and_unterminated_lines() {
        for (source, max_chars, expected, count) in [
            (
                "中😀文\r\nlast",
                2,
                "     1\t中😀 [truncated]\n     2\tla [truncated]",
                2,
            ),
            ("one\r\r\nlast\r", 50, "     1\tone\r\n     2\tlast\r", 2),
            ("\r\n\n😀", 50, "     1\t\n     2\t\n     3\t😀", 3),
            ("😀\r\n", 1, "     1\t😀", 1),
            ("", 50, "", 0),
        ] {
            for chunk_size in 1..=source.len().max(1) {
                let selection =
                    super::ReadLineSelection::new(1, 10, max_chars, 1000, false).unwrap();
                let mut decoder = super::ReadTextDecoder::new(selection);
                for chunk in source.as_bytes().chunks(chunk_size) {
                    decoder.push_bytes(chunk).unwrap();
                }
                let actual = decoder.finish().unwrap().finish().unwrap();
                assert_eq!(
                    actual.content, expected,
                    "chunk_size={chunk_size}, source={source:?}"
                );
                assert_eq!(actual.total_lines, count);
            }
        }
    }

    #[test]
    fn newline_free_stream_retention_is_bounded_and_invalid_tail_is_rejected() {
        let selection = super::ReadLineSelection::new(1, 1, 3, 100, false).unwrap();
        let mut decoder = super::ReadTextDecoder::new(selection);
        let chunk = "中😀文".repeat(1024);
        for _ in 0..128 {
            // Split a four-byte character on every iteration, including after
            // the visible prefix is full. The source line exceeds one MiB.
            decoder.push_bytes(&chunk.as_bytes()[..4]).unwrap();
            decoder.push_bytes(&chunk.as_bytes()[4..]).unwrap();
            assert_eq!(decoder.line, "中😀文");
            assert!(decoder.line.capacity() <= 32);
            assert!(decoder.utf8_tail_len <= 3);
        }
        assert!(decoder.push_bytes(b"\xff").is_err());

        let selection = super::ReadLineSelection::new(1, 1, 3, 100, false).unwrap();
        let mut decoder = super::ReadTextDecoder::new(selection);
        decoder.push_bytes(b"visible\xf0\x9f").unwrap();
        assert!(
            decoder.finish().is_err(),
            "an incomplete scalar at EOF is invalid even after truncation"
        );
    }

    #[tokio::test]
    async fn long_async_line_crosses_chunks_and_preserves_tail_and_invalid_suffix() {
        let source = format!("{}\r\nlast😀", "中😀文".repeat(8192));
        let actual = super::read_file_from_reader(source.as_bytes(), "stream", 1, 1, 3, 100)
            .await
            .unwrap();
        assert_eq!(actual.content, "     1\t中😀文 [truncated]");
        assert_eq!(actual.total_lines, 2);
        assert_eq!(actual.end_line, 1);
        assert!(actual.content_truncated);
        let tail = super::read_file_tail_from_reader(source.as_bytes(), "stream", 1, 50, 100)
            .await
            .unwrap();
        assert_eq!(tail.content, "     2\tlast😀");
        assert!(!tail.content_truncated);
        let mut invalid = source.into_bytes();
        invalid.extend_from_slice(b"\xff");
        let error = super::read_file_from_reader(invalid.as_slice(), "stream", 1, 1, 3, 100)
            .await
            .unwrap_err();
        assert!(error.contains("valid UTF-8"));
    }

    #[tokio::test]
    async fn async_streams_preserve_unicode_crlf_windows_and_tail() {
        use tokio::io::AsyncWriteExt;
        let source = "first\r\n中😀文\r\nlast";
        let (reader, mut writer) = tokio::io::duplex(1);
        let producer = tokio::spawn(async move {
            for byte in source.as_bytes() {
                writer.write_all(&[*byte]).await.unwrap();
            }
        });
        let result = super::read_file_from_reader(reader, "stream", 2, 1, 2, 100)
            .await
            .unwrap();
        producer.await.unwrap();
        assert_eq!(result.content, "     2\t中😀 [truncated]");
        assert_eq!(result.total_lines, 3);
        assert_eq!(result, read_text(source, 2, 1, 2, 100).unwrap());
        let tail = super::read_file_tail_from_reader(source.as_bytes(), "stream", 2, 50, 100)
            .await
            .unwrap();
        assert_eq!(tail.content, "     2\t中😀文\n     3\tlast");
        assert_eq!(tail, read_text_tail(source, 2, 50, 100).unwrap());
        let empty = super::read_file_from_reader(&b""[..], "stream", 1, 3, 50, 100)
            .await
            .unwrap();
        assert_eq!(empty.total_lines, 0);
    }

    #[tokio::test]
    async fn async_streams_reject_invalid_utf8_outside_the_selected_window() {
        let error =
            super::read_file_from_reader(&b"visible\n\xffhidden"[..], "stream", 1, 1, 50, 100)
                .await
                .unwrap_err();
        assert!(error.contains("Failed to read stream"), "{error}");
    }

    #[tokio::test]
    async fn async_stream_failure_after_a_complete_visible_line_is_not_success() {
        struct FailingReader(bool);
        impl tokio::io::AsyncRead for FailingReader {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                if self.0 {
                    return std::task::Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::ConnectionReset,
                        "connection lost",
                    )));
                }
                self.0 = true;
                buf.put_slice(b"visible\n");
                std::task::Poll::Ready(Ok(()))
            }
        }
        let error = super::read_file_from_reader(FailingReader(false), "stream", 1, 1, 50, 100)
            .await
            .unwrap_err();
        assert!(error.contains("connection lost"), "{error}");
    }

    #[tokio::test]
    async fn async_interrupted_read_returns_without_a_ready_retry_loop() {
        struct AlwaysInterrupted(bool);
        impl tokio::io::AsyncRead for AlwaysInterrupted {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                _buffer: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                // Fail immediately if a regression retries rather than hanging
                // the single executor poll (which a timeout could not stop).
                assert!(!self.0, "async Interrupted must not be retried");
                self.0 = true;
                std::task::Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "workspace read cancelled",
                )))
            }
        }
        let error = super::read_file_from_reader(AlwaysInterrupted(false), "stream", 1, 1, 50, 100)
            .await
            .unwrap_err();
        assert!(error.contains("workspace read cancelled"));
    }

    static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn write_temp_file(contents: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time went backwards")
            .as_nanos();
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let process_id = std::process::id();
        let path = std::env::temp_dir().join(format!(
            "openbitfun-read-file-test-{process_id}-{timestamp}-{counter}.txt"
        ));
        fs::write(&path, contents).expect("temp file should be written");
        path
    }

    #[test]
    fn truncates_when_total_char_budget_is_hit() {
        let path = write_temp_file("abcdefghijklmnopqrstuvwxyz\nsecond line\nthird line\n");

        let result = read_file(path.to_str().expect("utf-8 path"), 1, 10, 10, 30)
            .expect("read should succeed");

        fs::remove_file(&path).expect("temp file should be deleted");

        assert_eq!(result.start_line, 1);
        assert_eq!(result.end_line, 1);
        assert!(result.hit_total_char_limit);
        assert_eq!(result.content, "     1\tabcdefghij [truncated]");
    }

    #[test]
    fn reads_multiple_lines_when_budget_allows() {
        let path = write_temp_file("one\ntwo\nthree\n");

        let result = read_file(path.to_str().expect("utf-8 path"), 1, 10, 50, 100)
            .expect("read should succeed");

        fs::remove_file(&path).expect("temp file should be deleted");

        assert_eq!(result.end_line, 3);
        assert!(!result.hit_total_char_limit);
        assert_eq!(result.content, "     1\tone\n     2\ttwo\n     3\tthree");
    }

    #[test]
    fn bounded_byte_read_rejects_a_file_before_returning_oversized_content() {
        let path = write_temp_file("12345");

        let rejected = read_file_bytes_bounded(path.to_str().expect("utf-8 path"), 4)
            .expect("bounded read should succeed");
        let accepted = read_file_bytes_bounded(path.to_str().expect("utf-8 path"), 5)
            .expect("bounded read should succeed");

        fs::remove_file(&path).expect("temp file should be deleted");

        assert!(rejected.is_none());
        assert_eq!(accepted, Some(b"12345".to_vec()));
    }

    #[test]
    fn decoded_text_reuses_normal_window_and_tail_semantics() {
        let text = "one\ntwo\nthree\nfour\n";

        let window = read_text(text, 2, 2, 50, 100).expect("window should read");
        let tail = read_text_tail(text, 2, 50, 100).expect("tail should read");

        assert_eq!(window.start_line, 2);
        assert_eq!(window.end_line, 3);
        assert_eq!(window.total_lines, 4);
        assert_eq!(window.content, "     2\ttwo\n     3\tthree");
        assert_eq!(tail.start_line, 3);
        assert_eq!(tail.end_line, 4);
        assert_eq!(tail.content, "     3\tthree\n     4\tfour");
    }

    #[test]
    fn read_file_presentation_reports_continuation_window() {
        let result = ReadFileResult {
            start_line: 1,
            end_line: 2,
            total_lines: 4,
            content: "     1\tone\n     2\ttwo".to_string(),
            hit_total_char_limit: false,
            content_truncated: false,
            truncated_lines: Vec::new(),
        };

        let presentation = build_read_file_presentation("src/lib.rs", &result);

        assert_eq!(presentation.lines_read, 2);
        assert_eq!(presentation.next_offset, Some(3));
        assert!(presentation
            .result_for_assistant
            .contains("Read lines 1-2 from src/lib.rs (4 total lines)"));
        assert!(presentation
            .result_for_assistant
            .contains("Use offset=3 and limit to continue reading."));
    }

    #[test]
    fn reads_tail_window_with_original_line_numbers() {
        let path = write_temp_file("one\ntwo\nthree\nfour\nfive\n");

        let result = read_file_tail(path.to_str().expect("utf-8 path"), 2, 50, 100)
            .expect("tail read should succeed");

        fs::remove_file(&path).expect("temp file should be deleted");

        assert_eq!(result.start_line, 4);
        assert_eq!(result.end_line, 5);
        assert_eq!(result.total_lines, 5);
        assert_eq!(result.content, "     4\tfour\n     5\tfive");
    }

    #[test]
    fn read_file_lines_read_handles_empty_files() {
        let result = ReadFileResult {
            start_line: 0,
            end_line: 0,
            total_lines: 0,
            content: String::new(),
            hit_total_char_limit: false,
            content_truncated: false,
            truncated_lines: Vec::new(),
        };

        assert_eq!(read_file_lines_read(&result), 0);
        let presentation = build_read_file_presentation("empty.txt", &result);
        assert_eq!(presentation.next_offset, None);
        assert!(presentation.result_for_assistant.contains("is empty"));
    }

    #[test]
    fn a_line_that_cannot_fit_does_not_skip_to_the_next_line() {
        let result = read_text("abcdefghij\nnext\n", 1, 2, 100, 10).unwrap();
        let presentation = build_read_file_presentation("long.txt", &result);
        assert!(result.content.is_empty());
        assert_eq!(presentation.lines_read, 0);
        assert_eq!(presentation.next_offset, None);
        assert!(presentation.result_for_assistant.contains("No lines"));
        assert!(!presentation.result_for_assistant.contains("offset=2"));
    }

    #[test]
    fn clipped_line_guidance_does_not_promise_paging_can_restore_characters() {
        let result = read_text("abcdefghij\nnext\n", 1, 1, 4, 100).unwrap();
        let presentation = build_read_file_presentation("long.txt", &result);
        assert_eq!(presentation.next_offset, Some(2));
        assert!(presentation
            .result_for_assistant
            .contains("Lines [1] contain truncated text"));
        assert!(presentation
            .result_for_assistant
            .contains("cannot restore those characters"));
    }
}

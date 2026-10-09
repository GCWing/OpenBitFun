//! # OpenBitFun tool-call JSON repair
//!
//! A local MIT-licensed fork of `jsonrepair-rs` 0.2.5 for streamed tool
//! arguments. The tool-call profile preserves Markdown-like `#` content rather
//! than treating it as a configuration-file comment.
//!
//! Port of the JavaScript [jsonrepair](https://github.com/josdejong/jsonrepair) library.
//!
//! ## Usage
//!
//! ```
//! use openbitfun_tool_call_jsonrepair::jsonrepair;
//!
//! // Fix single quotes (whitespace preserved)
//! let result = jsonrepair("{'name': 'John'}").unwrap();
//! assert_eq!(result, r#"{"name": "John"}"#);
//!
//! // Fix trailing commas
//! let result = jsonrepair(r#"{"a": 1, "b": 2,}"#).unwrap();
//! assert_eq!(result, r#"{"a": 1, "b": 2}"#);
//!
//! // Convert Python keywords
//! let result = jsonrepair(r#"{"flag": True, "value": None}"#).unwrap();
//! assert_eq!(result, r#"{"flag": true, "value": null}"#);
//! ```

mod chars;
mod error;
mod parser;

#[cfg(feature = "serde")]
pub use error::JsonRepairParseError;
pub use error::{JsonRepairError, JsonRepairErrorKind};

/// Options controlling repair behavior.
///
/// The default policy keeps the historical forgiving behavior of
/// [`jsonrepair`]. Use [`RepairOptions::strict`] when callers want valid JSON
/// pass-through and an error for any input that would require repair.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct RepairOptions {
    strict: bool,
}

impl RepairOptions {
    /// Return the default forgiving repair policy.
    pub fn new() -> Self {
        Self::default()
    }

    /// Return an options value that rejects any input requiring repair.
    pub fn strict() -> Self {
        Self { strict: true }
    }

    /// Enable or disable strict mode.
    pub fn with_strict(mut self, strict: bool) -> Self {
        self.strict = strict;
        self
    }

    /// Whether strict mode is enabled.
    pub fn is_strict(&self) -> bool {
        self.strict
    }
}

/// Error returned by writer-based repair helpers.
#[derive(Debug)]
#[non_exhaustive]
pub enum JsonRepairWriteError {
    /// The input could not be repaired safely.
    Repair(JsonRepairError),
    /// The repaired JSON could not be written to the destination.
    Write(std::io::Error),
}

impl std::fmt::Display for JsonRepairWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Repair(err) => err.fmt(f),
            Self::Write(err) => write!(f, "failed to write repaired JSON: {err}"),
        }
    }
}

impl std::error::Error for JsonRepairWriteError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Repair(err) => Some(err),
            Self::Write(err) => Some(err),
        }
    }
}

impl From<JsonRepairError> for JsonRepairWriteError {
    fn from(err: JsonRepairError) -> Self {
        Self::Repair(err)
    }
}

impl From<std::io::Error> for JsonRepairWriteError {
    fn from(err: std::io::Error) -> Self {
        Self::Write(err)
    }
}

/// Error returned by reader-to-writer repair helpers.
#[derive(Debug)]
#[non_exhaustive]
pub enum JsonRepairStreamError {
    /// The input stream could not be read as UTF-8 text.
    Read(std::io::Error),
    /// The input could not be repaired safely.
    Repair(JsonRepairError),
    /// The repaired JSON could not be written to the destination.
    Write(std::io::Error),
}

impl std::fmt::Display for JsonRepairStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(err) => write!(f, "failed to read JSON input: {err}"),
            Self::Repair(err) => err.fmt(f),
            Self::Write(err) => write!(f, "failed to write repaired JSON: {err}"),
        }
    }
}

impl std::error::Error for JsonRepairStreamError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Read(err) => Some(err),
            Self::Repair(err) => Some(err),
            Self::Write(err) => Some(err),
        }
    }
}

/// Repair a broken JSON string and write the valid JSON to a writer.
///
/// This is a writer convenience API. It repairs the input first, then writes
/// the repaired JSON bytes to the provided [`std::io::Write`] destination.
pub fn jsonrepair_to_writer<W>(input: &str, writer: &mut W) -> Result<(), JsonRepairWriteError>
where
    W: std::io::Write + ?Sized,
{
    jsonrepair_to_writer_with_options(input, writer, RepairOptions::default())
}

/// Repair a broken JSON string using options and write the valid JSON to a writer.
pub fn jsonrepair_to_writer_with_options<W>(
    input: &str,
    writer: &mut W,
    options: RepairOptions,
) -> Result<(), JsonRepairWriteError>
where
    W: std::io::Write + ?Sized,
{
    let repaired = jsonrepair_with_options(input, options)?;
    writer.write_all(repaired.as_bytes())?;
    Ok(())
}

/// Repair JSON-like text from a reader and write valid JSON to a writer.
///
/// This is the first streaming-oriented API surface: callers can connect files,
/// stdin, stdout, sockets, or buffers without receiving an owned repaired
/// [`String`]. The current parser still needs the complete input and repaired
/// output buffered inside the crate before writing; this preserves exact repair
/// behavior while leaving room for a future lower-memory parser.
pub fn jsonrepair_reader_to_writer<R, W>(
    mut reader: R,
    writer: &mut W,
) -> Result<(), JsonRepairStreamError>
where
    R: std::io::Read,
    W: std::io::Write + ?Sized,
{
    jsonrepair_reader_to_writer_with_options(&mut reader, writer, RepairOptions::default())
}

/// Repair JSON-like text from a reader using options and write valid JSON to a writer.
pub fn jsonrepair_reader_to_writer_with_options<R, W>(
    mut reader: R,
    writer: &mut W,
    options: RepairOptions,
) -> Result<(), JsonRepairStreamError>
where
    R: std::io::Read,
    W: std::io::Write + ?Sized,
{
    let mut input = String::new();
    reader
        .read_to_string(&mut input)
        .map_err(JsonRepairStreamError::Read)?;

    let repaired =
        jsonrepair_with_options(&input, options).map_err(JsonRepairStreamError::Repair)?;
    writer
        .write_all(repaired.as_bytes())
        .map_err(JsonRepairStreamError::Write)?;

    Ok(())
}

/// Repair a broken JSON string, returning valid JSON.
///
/// Handles 30+ categories of issues including:
/// - Single/curly quotes → double quotes
/// - Trailing/missing commas
/// - Comments (`//`, `/* */`, `#`)
/// - Python keywords (`True`, `False`, `None`)
/// - JavaScript keywords (`undefined`, `NaN`, `Infinity`)
/// - Markdown code fences
/// - JSONP wrappers
/// - Unquoted keys and strings
/// - Truncated JSON (auto-closes brackets)
/// - String concatenation (`"a" + "b"`)
/// - Invalid escape sequences
/// - Leading zeros, truncated numbers
/// - MongoDB constructors (`ObjectId(...)`)
/// - NDJSON (newline-delimited JSON)
/// - Ellipsis operators (`...`)
///
/// Returns `Err(JsonRepairError)` if the input cannot be repaired.
pub fn jsonrepair(input: &str) -> Result<String, JsonRepairError> {
    jsonrepair_with_options(input, RepairOptions::default())
}

/// Repair a JSON string using explicit options.
///
/// With default options, this behaves exactly like [`jsonrepair`]. With
/// [`RepairOptions::strict`], valid JSON is returned unchanged and any input
/// that would require repair returns [`JsonRepairErrorKind::StrictModeViolation`].
pub fn jsonrepair_with_options(
    input: &str,
    options: RepairOptions,
) -> Result<String, JsonRepairError> {
    let repairer = parser::JsonRepairer::new(input);
    let repaired = repairer.repair()?;

    if options.strict {
        reject_if_changed(input, &repaired)?;
    }

    Ok(repaired)
}

/// Repair malformed streamed tool arguments.
///
/// This profile deliberately does not recognize `#`, `//`, or `/* ... */` as
/// comments. Tool arguments are JSON, and a missing opening quote before a
/// Markdown heading must be repaired as string content rather than discarded.
/// The result is syntactic only; callers must parse and schema-validate it
/// before execution.
pub fn repair_tool_call_json(input: &str) -> Result<String, JsonRepairError> {
    parser::JsonRepairer::new_tool_call(input).repair()
}

/// Repair a broken JSON string and parse it into [`serde_json::Value`].
///
/// This helper is available with the `serde` feature.
#[cfg(feature = "serde")]
pub fn jsonrepair_value(input: &str) -> Result<serde_json::Value, JsonRepairParseError> {
    jsonrepair_parse(input)
}

/// Repair a broken JSON string using options and parse it into [`serde_json::Value`].
///
/// This helper is available with the `serde` feature.
#[cfg(feature = "serde")]
pub fn jsonrepair_value_with_options(
    input: &str,
    options: RepairOptions,
) -> Result<serde_json::Value, JsonRepairParseError> {
    jsonrepair_parse_with_options(input, options)
}

/// Repair a broken JSON string and deserialize it into the requested type.
///
/// This helper is available with the `serde` feature.
#[cfg(feature = "serde")]
pub fn jsonrepair_parse<T>(input: &str) -> Result<T, JsonRepairParseError>
where
    T: serde::de::DeserializeOwned,
{
    jsonrepair_parse_with_options(input, RepairOptions::default())
}

/// Repair a broken JSON string using options and deserialize it into the requested type.
///
/// This helper is available with the `serde` feature.
#[cfg(feature = "serde")]
pub fn jsonrepair_parse_with_options<T>(
    input: &str,
    options: RepairOptions,
) -> Result<T, JsonRepairParseError>
where
    T: serde::de::DeserializeOwned,
{
    let repaired = jsonrepair_with_options(input, options)?;
    serde_json::from_str(&repaired).map_err(JsonRepairParseError::from)
}

#[cfg(test)]
mod tests {
    use super::repair_tool_call_json;

    #[test]
    fn tool_call_profile_preserves_hash_prefixed_unquoted_string_values() {
        let repaired = repair_tool_call_json(r##"{"plan": # Markdown heading"}"##)
            .expect("repair should succeed");
        let value: serde_json::Value =
            serde_json::from_str(&repaired).expect("repaired output should be JSON");

        assert_eq!(value["plan"], "# Markdown heading");
    }
}

fn reject_if_changed(input: &str, repaired: &str) -> Result<(), JsonRepairError> {
    if input == repaired {
        return Ok(());
    }

    let position = first_difference(input, repaired);
    let (line, column) = line_column(input, position);
    Err(JsonRepairError::with_kind(
        "Strict mode rejected input that requires JSON repair",
        position,
        JsonRepairErrorKind::StrictModeViolation,
    )
    .with_location(line, column))
}

fn first_difference(left: &str, right: &str) -> usize {
    for (index, (left_char, right_char)) in left.chars().zip(right.chars()).enumerate() {
        if left_char != right_char {
            return index;
        }
    }

    left.chars().count().min(right.chars().count())
}

fn line_column(input: &str, position: usize) -> (usize, usize) {
    let mut line = 1;
    let mut column = 1;

    for (index, ch) in input.chars().enumerate() {
        if index == position {
            break;
        }
        if ch == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }

    (line, column)
}

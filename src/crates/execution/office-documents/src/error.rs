//! Error type shared by every office format.

use std::fmt;

/// Stable, machine-readable failure classes. The tool layer forwards
/// [`OfficeErrorKind::code`] to the model so it can branch on the reason
/// instead of parsing the message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeErrorKind {
    /// An operation or its fields are malformed.
    InvalidOperation,
    /// An index, cell address, or range lies outside the document.
    OutOfRange,
    /// A named target (sheet, element) does not exist.
    NotFound,
    /// The file extension or package is not a supported office format.
    UnsupportedFormat,
    /// The package carries no editable source model.
    NotGenerated,
    /// The package changed after this engine last wrote it.
    ExternallyModified,
    /// The package cannot be read as a zip/OOXML container.
    CorruptPackage,
    /// An image source could not be decoded.
    InvalidImage,
    /// A size or count limit was exceeded.
    LimitExceeded,
}

impl OfficeErrorKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidOperation => "invalid_operation",
            Self::OutOfRange => "out_of_range",
            Self::NotFound => "not_found",
            Self::UnsupportedFormat => "unsupported_format",
            Self::NotGenerated => "not_generated",
            Self::ExternallyModified => "externally_modified",
            Self::CorruptPackage => "corrupt_package",
            Self::InvalidImage => "invalid_image",
            Self::LimitExceeded => "limit_exceeded",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficeError {
    pub kind: OfficeErrorKind,
    pub message: String,
    /// Zero-based position of the failing operation inside its batch.
    pub operation_index: Option<usize>,
    pub operation: Option<String>,
}

impl OfficeError {
    pub fn new(kind: OfficeErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            operation_index: None,
            operation: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(OfficeErrorKind::InvalidOperation, message)
    }

    pub fn out_of_range(message: impl Into<String>) -> Self {
        Self::new(OfficeErrorKind::OutOfRange, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(OfficeErrorKind::NotFound, message)
    }

    pub fn limit(message: impl Into<String>) -> Self {
        Self::new(OfficeErrorKind::LimitExceeded, message)
    }

    pub fn corrupt(message: impl Into<String>) -> Self {
        Self::new(OfficeErrorKind::CorruptPackage, message)
    }

    /// Pins the error to one operation of a batch.
    pub fn at_operation(mut self, index: usize, operation: &str) -> Self {
        self.operation_index = Some(index);
        self.operation = Some(operation.to_string());
        self
    }
}

impl fmt::Display for OfficeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match (&self.operation_index, &self.operation) {
            (Some(index), Some(operation)) => write!(
                formatter,
                "operation #{index} `{operation}` failed ({}): {}",
                self.kind.code(),
                self.message
            ),
            _ => write!(formatter, "{} ({})", self.message, self.kind.code()),
        }
    }
}

impl std::error::Error for OfficeError {}

pub type OfficeResult<T> = Result<T, OfficeError>;

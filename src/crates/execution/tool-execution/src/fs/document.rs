//! Document path recognition and optional provider-neutral Markdown conversion.

mod selection;
pub use selection::DocumentPageSelection;
#[cfg(feature = "document-read")]
mod office;
#[cfg(feature = "document-read")]
mod text_pages;
#[cfg(feature = "document-read")]
pub use text_pages::TEXT_CHUNK_CHARS;

#[cfg(feature = "document-read")]
use std::collections::VecDeque;
#[cfg(feature = "document-read")]
use std::fmt;
use std::path::Path;
#[cfg(feature = "document-read")]
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(feature = "document-read")]
use anydoc::Format;
#[cfg(feature = "document-read")]
use sha2::{Digest, Sha256};
#[cfg(feature = "document-read")]
use tokio::sync::Semaphore;

/// Maximum source-document size accepted by the Read tool conversion path.
#[cfg(feature = "document-read")]
pub const MAX_DOCUMENT_INPUT_BYTES: usize = 64 * 1024 * 1024;

/// Maximum retained Markdown for one conversion and across the in-memory conversion cache.
#[cfg(feature = "document-read")]
pub const MAX_DOCUMENT_MARKDOWN_BYTES: usize = 16 * 1024 * 1024;

#[cfg(feature = "document-read")]
const MAX_DOCUMENT_CACHE_ENTRIES: usize = 4;

/// Extensions recognized as documents even when conversion support is not compiled.
pub const SUPPORTED_DOCUMENT_EXTENSIONS: &[&str] = &[
    "doc", "docx", "docm", "odt", "pdf", "pptx", "pptm", "ppsx", "ppsm", "ppt", "pps", "pot",
    "rtf", "epub", "xlsx", "xlsm", "xlsb", "xls", "ods", "odp", "csv",
];

/// A document representation that can be paged by the normal Read primitives.
#[cfg(feature = "document-read")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConvertedDocument {
    pub markdown: Arc<str>,
    pub source_format: &'static str,
    pub pdf_coverage: Option<PdfTextCoverage>,
    pub pagination: DocumentPagination,
}

/// Selectable source units (or explicitly synthetic text chunks), not the returned line window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPagination {
    pub page_kind: &'static str,
    pub page_count: usize,
    pub selected_pages: String,
    pub selected_page_count: usize,
    pub next_page: Option<u32>,
}

#[cfg(feature = "document-read")]
impl DocumentPagination {
    fn new(
        kind: &'static str,
        count: usize,
        selection: Option<&DocumentPageSelection>,
    ) -> Result<Self, DocumentConversionError> {
        let pages = selection
            .map(|selection| selection.resolve(count))
            .transpose()
            .map_err(|error| DocumentConversionError::new("invalidPages", error))?;
        let last = pages.as_ref().and_then(|pages| pages.last()).copied();
        Ok(Self {
            page_kind: kind,
            page_count: count,
            selected_pages: selection
                .map(ToString::to_string)
                .unwrap_or_else(|| match count {
                    0 => String::new(),
                    1 => "1".to_string(),
                    _ => format!("1-{count}"),
                }),
            selected_page_count: pages.as_ref().map_or(count, Vec::len),
            next_page: last
                .filter(|last| (*last as usize) < count)
                .and_then(|last| last.checked_add(1)),
        })
    }
}

/// Source-page coverage, independent of the line window returned from the extracted Markdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfTextCoverage {
    pub page_count: usize,
    pub extracted_pages: Vec<u32>,
    pub pages_needing_ocr: Vec<u32>,
}

impl PdfTextCoverage {
    pub fn status(&self) -> &'static str {
        if self.extracted_pages.is_empty() {
            "needs_ocr"
        } else if self.pages_needing_ocr.is_empty() {
            "complete"
        } else {
            "partial"
        }
    }

    /// Bound the model-facing summary while retaining all page IDs in the coverage metadata.
    pub fn ocr_page_ranges(&self, max_ranges: usize) -> String {
        let mut ranges = Vec::new();
        let mut pages = self.pages_needing_ocr.iter().copied().peekable();
        while let Some(start) = pages.peek().copied() {
            if ranges.len() == max_ranges {
                ranges.push(format!("... ({} more pages)", pages.len()));
                break;
            }
            pages.next();
            let mut end = start;
            while pages
                .peek()
                .is_some_and(|page| Some(*page) == end.checked_add(1))
            {
                end = pages.next().expect("consecutive page");
            }
            ranges.push(if end == start {
                start.to_string()
            } else {
                format!("{start}-{end}")
            });
        }
        ranges.join(", ")
    }
}

#[cfg(feature = "document-read")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct DocumentCacheKey {
    source_sha256: [u8; 32],
    format: Format,
    selection: Option<DocumentPageSelection>,
}

#[cfg(feature = "document-read")]
struct DocumentCacheEntry {
    key: DocumentCacheKey,
    document: ConvertedDocument,
}

#[cfg(feature = "document-read")]
#[derive(Default)]
struct DocumentCache {
    entries: VecDeque<DocumentCacheEntry>,
    retained_markdown_bytes: usize,
}

#[cfg(feature = "document-read")]
impl DocumentCache {
    fn get(&mut self, key: &DocumentCacheKey) -> Option<ConvertedDocument> {
        let index = self.entries.iter().position(|entry| &entry.key == key)?;
        let entry = self.entries.remove(index)?;
        let document = entry.document.clone();
        self.entries.push_back(entry);
        Some(document)
    }

    fn insert(&mut self, key: DocumentCacheKey, document: ConvertedDocument) {
        let markdown_bytes = document.markdown.len();
        if markdown_bytes > MAX_DOCUMENT_MARKDOWN_BYTES {
            return;
        }

        while self.entries.len() >= MAX_DOCUMENT_CACHE_ENTRIES
            || self.retained_markdown_bytes.saturating_add(markdown_bytes)
                > MAX_DOCUMENT_MARKDOWN_BYTES
        {
            let Some(evicted) = self.entries.pop_front() else {
                break;
            };
            self.retained_markdown_bytes = self
                .retained_markdown_bytes
                .saturating_sub(evicted.document.markdown.len());
        }

        self.retained_markdown_bytes = self.retained_markdown_bytes.saturating_add(markdown_bytes);
        self.entries.push_back(DocumentCacheEntry { key, document });
    }
}

/// Provider-neutral document conversion failure.
#[cfg(feature = "document-read")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentConversionError {
    code: &'static str,
    message: String,
}

#[cfg(feature = "document-read")]
impl DocumentConversionError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

#[cfg(feature = "document-read")]
impl fmt::Display for DocumentConversionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

#[cfg(feature = "document-read")]
impl std::error::Error for DocumentConversionError {}

/// Whether the path extension names a supported document format.
pub fn is_supported_document_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_DOCUMENT_EXTENSIONS
                .iter()
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

/// Convert document bytes on the blocking pool. Conversion is serialized process-wide because
/// parsers can temporarily retain substantially more decompressed data than the source file.
#[cfg(feature = "document-read")]
pub async fn convert_document_to_markdown(
    bytes: Vec<u8>,
    path_hint: String,
) -> Result<ConvertedDocument, DocumentConversionError> {
    convert_document_pages_to_markdown(bytes, path_hint, None).await
}

/// Select document units before applying the caller's Markdown line window.
#[cfg(feature = "document-read")]
pub async fn convert_document_pages_to_markdown(
    bytes: Vec<u8>,
    path_hint: String,
    selection: Option<DocumentPageSelection>,
) -> Result<ConvertedDocument, DocumentConversionError> {
    if bytes.len() > MAX_DOCUMENT_INPUT_BYTES {
        return Err(DocumentConversionError::new(
            "resourceLimit",
            format!(
                "document is larger than the {} MiB Read limit",
                MAX_DOCUMENT_INPUT_BYTES / (1024 * 1024)
            ),
        ));
    }

    let permit = document_conversion_semaphore()
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| {
            DocumentConversionError::new(
                "runtime",
                "document conversion is unavailable because its worker was closed",
            )
        })?;

    tokio::task::spawn_blocking(move || {
        // Keep the permit inside the blocking task. If the async caller is cancelled, the parser
        // still occupies its bounded slot until the synchronous conversion actually exits.
        let _permit = permit;
        convert_document_pages_to_markdown_sync(&bytes, &path_hint, selection.as_ref())
    })
    .await
    .map_err(|error| {
        DocumentConversionError::new(
            "runtime",
            format!("document conversion worker failed: {error}"),
        )
    })?
}

#[cfg(feature = "document-read")]
fn document_conversion_semaphore() -> &'static Arc<Semaphore> {
    static SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEMAPHORE.get_or_init(|| Arc::new(Semaphore::new(1)))
}

#[cfg(feature = "document-read")]
fn convert_document_pages_to_markdown_sync(
    bytes: &[u8],
    path_hint: &str,
    selection: Option<&DocumentPageSelection>,
) -> Result<ConvertedDocument, DocumentConversionError> {
    let format = Format::from_bytes(bytes)
        .or_else(|| Format::from_path(Path::new(path_hint)))
        .ok_or_else(|| {
            DocumentConversionError::new(
                "unsupported",
                "file content and extension do not identify a supported document format",
            )
        })?;
    let cache_key = DocumentCacheKey {
        source_sha256: Sha256::digest(bytes).into(),
        format,
        selection: selection.cloned(),
    };
    if let Some(document) = document_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&cache_key)
    {
        return Ok(document);
    }

    let source_format = format_name(format);
    let (markdown, pdf_coverage, pagination) = if format == Format::Pdf {
        let (markdown, coverage) = extract_pdf_text(bytes, selection)?;
        let pagination = DocumentPagination::new("pdf_page", coverage.page_count, selection)?;
        (markdown, Some(coverage), pagination)
    } else if let Some(index) = office::OfficePageIndex::read(bytes, format)? {
        let pagination = DocumentPagination::new(index.page_kind, index.page_count(), selection)?;
        let selected_bytes = selection
            .map(|selection| index.select(bytes, selection))
            .transpose()?;
        let markdown =
            anydoc::to_markdown_bytes(selected_bytes.as_deref().unwrap_or(bytes), format)
                .map_err(|error| DocumentConversionError::new(error.code(), error.to_string()))?;
        (markdown, None, pagination)
    } else {
        let markdown = anydoc::to_markdown_bytes(bytes, format)
            .map_err(|error| DocumentConversionError::new(error.code(), error.to_string()))?;
        let (markdown, pagination) = text_pages::select_text(markdown, selection)?;
        (markdown, None, pagination)
    };
    if markdown.len() > MAX_DOCUMENT_MARKDOWN_BYTES {
        return Err(DocumentConversionError::new(
            "resourceLimit",
            format!(
                "converted Markdown is larger than the {} MiB Read limit",
                MAX_DOCUMENT_MARKDOWN_BYTES / (1024 * 1024)
            ),
        ));
    }

    let document = ConvertedDocument {
        markdown: Arc::from(markdown),
        source_format,
        pdf_coverage,
        pagination,
    };
    document_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(cache_key, document.clone());
    Ok(document)
}

/// anydoc's PDF convenience API rejects the whole document when any page needs OCR.
/// Use the same parser's page API to retain reliable text and explicitly mark gaps.
#[cfg(feature = "document-read")]
fn extract_pdf_text(
    bytes: &[u8],
    selection: Option<&DocumentPageSelection>,
) -> Result<(String, PdfTextCoverage), DocumentConversionError> {
    let map_error = |error: pdf_inspector::PdfError| {
        let code = match &error {
            pdf_inspector::PdfError::Encrypted => "encrypted",
            pdf_inspector::PdfError::Io(_) => "io",
            _ => "malformed",
        };
        DocumentConversionError::new(code, error.to_string())
    };
    // Validate against the parsed source page tree before passing zero-based indices to the
    // backend, which otherwise returns an OCR placeholder for a nonexistent page.
    let source_page_count = selection
        .map(|_| {
            pdf_inspector::classify_pdf_mem(bytes)
                .map(|classification| classification.page_count as usize)
                .map_err(map_error)
        })
        .transpose()?;
    let selected_pages = selection
        .map(|selection| selection.resolve(source_page_count.unwrap_or(0)))
        .transpose()
        .map_err(|error| DocumentConversionError::new("invalidPages", error))?
        .map(|pages| pages.into_iter().map(|page| page - 1).collect::<Vec<_>>());
    let extraction = pdf_inspector::extract_pages_markdown_mem(bytes, selected_pages.as_deref())
        .map_err(map_error)?;
    if extraction.pages.is_empty() {
        return Err(DocumentConversionError::new(
            "malformed",
            "PDF contains no pages",
        ));
    }
    let mut coverage = PdfTextCoverage {
        page_count: source_page_count.unwrap_or(extraction.pages.len()),
        extracted_pages: Vec::new(),
        pages_needing_ocr: Vec::new(),
    };
    let mut markdown = String::new();
    for page in extraction.pages {
        let number = page.page + 1;
        markdown.push_str(&format!("## PDF page {number}\n\n"));
        if page.needs_ocr || page.markdown.trim().is_empty() {
            coverage.pages_needing_ocr.push(number);
            markdown.push_str(
                "[No reliable text extracted. This page needs OCR or visual inspection.]\n\n",
            );
        } else {
            coverage.extracted_pages.push(number);
            markdown.push_str(page.markdown.trim_end());
            markdown.push_str("\n\n");
        }
        if markdown.len() > MAX_DOCUMENT_MARKDOWN_BYTES {
            return Err(DocumentConversionError::new(
                "resourceLimit",
                "extracted PDF Markdown exceeds the Read output budget",
            ));
        }
    }
    Ok((markdown, coverage))
}

#[cfg(feature = "document-read")]
fn document_cache() -> &'static Mutex<DocumentCache> {
    static CACHE: OnceLock<Mutex<DocumentCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(DocumentCache::default()))
}

#[cfg(feature = "document-read")]
fn format_name(format: Format) -> &'static str {
    match format {
        Format::Doc => "doc",
        Format::Docx => "docx",
        Format::Odt => "odt",
        Format::Pdf => "pdf",
        Format::Ppt => "ppt",
        Format::Pptx => "pptx",
        Format::Rtf => "rtf",
        Format::Epub => "epub",
        Format::Excel => "excel",
        Format::Ods => "ods",
        Format::Odp => "odp",
        Format::Csv => "csv",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "document-read")]
    fn convert_document_to_markdown_sync(
        bytes: &[u8],
        path: &str,
    ) -> Result<ConvertedDocument, DocumentConversionError> {
        convert_document_pages_to_markdown_sync(bytes, path, None)
    }

    #[test]
    fn pdf_gap_summary_is_bounded_without_losing_page_metadata() {
        let coverage = PdfTextCoverage {
            page_count: 5000,
            extracted_pages: (1..5000).step_by(2).collect(),
            pages_needing_ocr: (2..=5000).step_by(2).collect(),
        };
        let summary = coverage.ocr_page_ranges(8);
        assert_eq!(summary, "2, 4, 6, 8, 10, 12, 14, 16, ... (2492 more pages)");
        assert_eq!(coverage.pages_needing_ocr.len(), 2500);
        assert_eq!(coverage.status(), "partial");

        let coverage = PdfTextCoverage {
            page_count: 5,
            extracted_pages: vec![3],
            pages_needing_ocr: vec![1, 2, 4, 5],
        };
        assert_eq!(coverage.ocr_page_ranges(1), "1-2, ... (2 more pages)");
        assert_eq!(coverage.ocr_page_ranges(2), "1-2, 4-5");
    }

    #[test]
    fn recognizes_all_supported_extension_families() {
        for path in [
            "report.doc",
            "report.DOCX",
            "report.docm",
            "slides.ppt",
            "slides.ppsx",
            "sheet.xlsb",
            "sheet.xlsx",
            "document.odt",
            "sheet.ods",
            "slides.odp",
            "notes.rtf",
            "book.epub",
            "table.csv",
            "paper.pdf",
        ] {
            assert!(is_supported_document_path(path), "{path}");
        }
        assert!(!is_supported_document_path("src/lib.rs"));
        assert!(!is_supported_document_path("README.md"));
    }

    #[cfg(feature = "document-read")]
    #[test]
    fn recognized_extensions_match_anydoc() {
        for extension in SUPPORTED_DOCUMENT_EXTENSIONS {
            assert!(Format::from_extension(extension).is_some(), "{extension}");
        }
    }

    #[cfg(feature = "document-read")]
    #[test]
    fn content_detection_takes_precedence_over_a_wrong_extension_hint() {
        let converted =
            convert_document_to_markdown_sync(br"{\rtf1\ansi Hello from RTF}", "mislabelled.pdf")
                .expect("RTF should convert");

        assert_eq!(converted.source_format, "rtf");
        assert!(converted.markdown.contains("Hello from RTF"));
    }

    #[cfg(feature = "document-read")]
    #[test]
    fn csv_uses_the_path_hint_because_it_has_no_content_signature() {
        let converted =
            convert_document_to_markdown_sync(b"name,value\nalpha,1\nbeta,2\n", "table.csv")
                .expect("CSV should convert");

        assert_eq!(converted.source_format, "csv");
        assert!(converted.markdown.contains("| name | value |"));
        assert!(converted.markdown.contains("| alpha | 1 |"));
    }

    #[cfg(feature = "document-read")]
    #[test]
    fn rtf_math_is_preserved_as_latex_without_escaping_plain_prices() {
        let converted = convert_document_to_markdown_sync(
            br"{\rtf1\ansi Formula: {\mmath{\*\moMath{\mf{\mnum{\mr x}}{\mden{\mr y}}}}}\par Price: $20.00\par}",
            "formula.rtf",
        )
        .expect("RTF formula should convert");

        assert!(
            converted.markdown.contains(r"$\frac{x}{y}$"),
            "{}",
            converted.markdown
        );
        assert!(
            converted.markdown.contains("Price: $20.00"),
            "{}",
            converted.markdown
        );
    }

    #[cfg(feature = "document-read")]
    #[test]
    fn repeated_conversion_reuses_cached_markdown_for_offset_reads() {
        let first =
            convert_document_to_markdown_sync(br"{\rtf1\ansi Cached document}", "cached.rtf")
                .expect("first conversion");
        let second =
            convert_document_to_markdown_sync(br"{\rtf1\ansi Cached document}", "cached.rtf")
                .expect("second conversion");

        assert!(Arc::ptr_eq(&first.markdown, &second.markdown));
    }
}

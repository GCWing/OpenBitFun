//! Portable OOXML document engine for agent tools.
//!
//! Agent-facing formats were developed with reference to GenOffice
//! (Copyright 2026 Mainfunc, Inc.; Apache-2.0). See this crate's README.md,
//! LICENSE-GENOFFICE.txt, and NOTICE-GENOFFICE.txt for sources and attribution.
//!
//! A document is an editable JSON model (Word blocks, workbook sheets, or a
//! slide deck of positioned elements). Operations edit the model atomically,
//! and the whole package is re-rendered from it. The model travels inside the
//! package, so a later call can reopen the file and keep editing it one batch
//! at a time instead of producing everything in a single call.

pub mod common;
pub mod docx;
mod error;
mod font_contract;
mod guide;
pub mod image;
mod operation_contract;
mod package;
pub mod pptx;
pub mod xlsx;
mod xml;

pub use error::{OfficeError, OfficeErrorKind, OfficeResult};
pub use font_contract::{settings_schema, validate_font_input};
pub use guide::guide;
pub use operation_contract::{
    operation_recovery_hint, operation_schema, validate_operation_headers,
};

use common::{merge_patch, operation_name, UnknownFields};
use docx::DocxDocument;
use package::{read_source, read_zip, SourceEnvelope, SOURCE_PART, SOURCE_SCHEMA, SOURCE_VERSION};
use pptx::PptxDocument;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use xlsx::XlsxDocument;

/// Bytes of image sources referenced by operations, keyed by the exact
/// source string. Data URLs are decoded by the engine and need no entry.
pub type ImageSources = HashMap<String, Vec<u8>>;

const MAX_OPERATIONS_PER_BATCH: usize = 200;
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeFormat {
    Docx,
    Xlsx,
    Pptx,
}

impl OfficeFormat {
    pub fn from_path(path: &str) -> Option<Self> {
        let extension = path.rsplit_once('.')?.1;
        Self::from_name(extension)
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "docx" | "word" => Some(Self::Docx),
            "xlsx" | "excel" => Some(Self::Xlsx),
            "pptx" | "powerpoint" => Some(Self::Pptx),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
        }
    }

    /// The unit `read` pages over and structural operations address.
    pub const fn unit(self) -> &'static str {
        match self {
            Self::Docx => "block",
            Self::Xlsx => "sheet",
            Self::Pptx => "slide",
        }
    }

    pub fn operations(self) -> &'static [&'static str] {
        match self {
            Self::Docx => docx::ops::OPERATIONS,
            Self::Xlsx => xlsx::ops::OPERATIONS,
            Self::Pptx => pptx::ops::OPERATIONS,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Model {
    Docx(Box<DocxDocument>),
    Xlsx(Box<XlsxDocument>),
    Pptx(Box<PptxDocument>),
}

impl Model {
    fn format(&self) -> OfficeFormat {
        match self {
            Model::Docx(_) => OfficeFormat::Docx,
            Model::Xlsx(_) => OfficeFormat::Xlsx,
            Model::Pptx(_) => OfficeFormat::Pptx,
        }
    }

    fn referenced_assets(&self) -> BTreeSet<String> {
        match self {
            Model::Docx(doc) => doc
                .blocks
                .iter()
                .filter_map(|block| match block {
                    docx::Block::Image(image) => image.asset.clone(),
                    _ => None,
                })
                .collect(),
            Model::Pptx(deck) => deck.referenced_assets(),
            Model::Xlsx(_) => BTreeSet::new(),
        }
    }

    fn media_dir(&self) -> &'static str {
        match self {
            Model::Docx(_) => "word/media/",
            Model::Pptx(_) => "ppt/media/",
            Model::Xlsx(_) => "xl/media/",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Detail {
    /// Compact listing: kind, preview text, and counts.
    #[default]
    Outline,
    /// The stored model of each unit, suitable for editing and echoing back.
    Full,
}

#[derive(Debug, Clone, Default)]
pub struct ReadRequest {
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    pub detail: Detail,
    /// Workbook only: page over rows of this sheet instead of the sheet list.
    pub sheet: Option<String>,
    /// Workbook only: an A1 range of `sheet` to read.
    pub range: Option<String>,
}

impl ReadRequest {
    pub(crate) fn window(&self, total: usize, default_limit: usize) -> (usize, usize) {
        let offset = self.offset.unwrap_or(0).min(total);
        let limit = self.limit.unwrap_or(default_limit).clamp(1, 500);
        (offset, limit)
    }
}

#[derive(Debug, Clone, Default)]
pub struct OpenOptions {
    /// Rebuild from the embedded source even when another program changed
    /// the rendered parts since this engine last wrote them.
    pub discard_external_changes: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ApplyReport {
    pub applied: usize,
    pub changes: Vec<String>,
    pub warnings: Vec<String>,
}

/// Mutable state shared by the operations of one batch.
pub(crate) struct ApplyContext<'a> {
    images: &'a ImageSources,
    assets: &'a mut BTreeMap<String, Vec<u8>>,
    changes: Vec<String>,
    warnings: Vec<String>,
    /// Units (slides) whose layout should be audited after the batch.
    pub(crate) touched: BTreeSet<usize>,
}

impl ApplyContext<'_> {
    pub(crate) fn note(&mut self, change: String) {
        self.changes.push(change);
    }

    pub(crate) fn warn(&mut self, warning: String) {
        self.warnings.push(warning);
    }

    /// Embeds an image and returns its asset name. An `asset` that is already
    /// embedded wins over `src`, so echoing a read result back keeps working
    /// after the original file is gone.
    pub(crate) fn resolve_image(
        &mut self,
        src: Option<&str>,
        asset: Option<&str>,
        path: &str,
    ) -> OfficeResult<String> {
        if let Some(asset) = asset {
            if self.assets.contains_key(asset) {
                return Ok(asset.to_string());
            }
            if src.is_none() {
                return Err(OfficeError::not_found(format!(
                    "{path}: asset `{asset}` is not embedded in this document; pass `src` with a file path or data URL instead"
                )));
            }
        }
        let src = src.ok_or_else(|| {
            OfficeError::invalid(format!("{path}: image needs `src` or an embedded `asset`"))
        })?;
        let bytes = match image::decode_data_url(src) {
            Some(decoded) => decoded?,
            None => self.images.get(src).cloned().ok_or_else(|| {
                OfficeError::new(
                    OfficeErrorKind::InvalidImage,
                    format!("{path}: image `{src}` was not loaded; use an absolute local file path or a data URL"),
                )
            })?,
        };
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(OfficeError::limit(format!(
                "{path}: image `{src}` is larger than {} MB",
                MAX_IMAGE_BYTES / 1024 / 1024
            )));
        }
        let info = image::sniff(&bytes).map_err(|err| common::prefix(err, path, "src"))?;
        let name = image::asset_name(&bytes, info.kind);
        self.assets.entry(name.clone()).or_insert(bytes);
        Ok(name)
    }
}

/// An open, editable office document.
#[derive(Debug, Clone)]
pub struct OfficeDocument {
    model: Model,
    assets: BTreeMap<String, Vec<u8>>,
    revision: u64,
    created: Option<String>,
    modified: Option<String>,
    envelope_extra: BTreeMap<String, Value>,
}

impl OfficeDocument {
    /// A new empty document. `settings` is a partial document-level object
    /// (page/styles for Word, slide size/theme for decks, properties for all).
    pub fn new(format: OfficeFormat, settings: Option<&Value>) -> OfficeResult<Self> {
        let model = match format {
            OfficeFormat::Docx => {
                let mut doc: DocxDocument =
                    with_settings(DocxDocument::default(), settings, "blocks")?;
                doc.page.validate()?;
                doc.styles.validate()?;
                doc.blocks.clear();
                Model::Docx(Box::new(doc))
            }
            OfficeFormat::Xlsx => {
                let mut book: XlsxDocument =
                    with_settings(XlsxDocument::default(), settings, "sheets")?;
                book.sheets.clear();
                Model::Xlsx(Box::new(book))
            }
            OfficeFormat::Pptx => {
                let mut deck: PptxDocument =
                    with_settings(PptxDocument::default(), settings, "slides")?;
                deck.validate_settings()?;
                deck.slides.clear();
                Model::Pptx(Box::new(deck))
            }
        };
        Ok(Self {
            model,
            assets: BTreeMap::new(),
            revision: 0,
            created: None,
            modified: None,
            envelope_extra: BTreeMap::new(),
        })
    }

    /// Reopens a package written by this engine.
    pub fn open(bytes: &[u8], options: &OpenOptions) -> OfficeResult<Self> {
        let entries = read_zip(bytes)?;
        let envelope = read_source(&entries, options.discard_external_changes)?;
        let format = OfficeFormat::from_name(&envelope.format).ok_or_else(|| {
            OfficeError::new(
                OfficeErrorKind::UnsupportedFormat,
                format!("unknown embedded format `{}`", envelope.format),
            )
        })?;
        let model = match format {
            OfficeFormat::Docx => Model::Docx(Box::new(from_source(envelope.document.clone())?)),
            OfficeFormat::Xlsx => Model::Xlsx(Box::new(from_source(envelope.document.clone())?)),
            OfficeFormat::Pptx => Model::Pptx(Box::new(from_source(envelope.document.clone())?)),
        };
        let mut assets = BTreeMap::new();
        for name in model.referenced_assets() {
            let path = format!("{}{name}", model.media_dir());
            let bytes = entries.get(&path).ok_or_else(|| {
                OfficeError::corrupt(format!(
                    "embedded picture {path} is missing from the package"
                ))
            })?;
            assets.insert(name, bytes.clone());
        }
        Ok(Self {
            model,
            assets,
            revision: envelope.revision,
            created: envelope.created,
            modified: envelope.modified,
            envelope_extra: envelope.extra,
        })
    }

    pub fn format(&self) -> OfficeFormat {
        self.model.format()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// Records the write time (RFC 3339) for the document properties.
    pub fn touch(&mut self, now: &str) {
        if self.created.is_none() {
            self.created = Some(now.to_string());
        }
        self.modified = Some(now.to_string());
    }

    /// Applies a batch atomically: either every operation succeeds or the
    /// document is left unchanged.
    pub fn apply(
        &mut self,
        operations: &[Value],
        images: &ImageSources,
    ) -> OfficeResult<ApplyReport> {
        if operations.len() > MAX_OPERATIONS_PER_BATCH {
            return Err(OfficeError::limit(format!(
                "a batch is limited to {MAX_OPERATIONS_PER_BATCH} operations; split it across calls"
            )));
        }
        validate_operation_headers(self.format(), operations)?;
        let mut model = self.model.clone();
        let mut assets = self.assets.clone();
        let mut ctx = ApplyContext {
            images,
            assets: &mut assets,
            changes: Vec::new(),
            warnings: Vec::new(),
            touched: BTreeSet::new(),
        };
        for (index, operation) in operations.iter().enumerate() {
            let name = operation_name(operation)
                .map_err(|err| err.at_operation(index, "?"))?
                .to_string();
            let result = match &mut model {
                Model::Docx(doc) => docx::ops::apply(doc, &name, operation, &mut ctx),
                Model::Xlsx(book) => xlsx::ops::apply(book, &name, operation, &mut ctx),
                Model::Pptx(deck) => pptx::ops::apply(deck, &name, operation, &mut ctx),
            };
            result.map_err(|err| err.at_operation(index, &name))?;
        }
        let mut warnings = ctx.warnings;
        let changes = ctx.changes;
        if let Model::Pptx(deck) = &model {
            warnings.extend(deck.audit(Some(&ctx.touched)));
        }
        if let Model::Xlsx(book) = &model {
            warnings.extend(book.warnings());
        }
        let referenced = model.referenced_assets();
        assets.retain(|name, _| referenced.contains(name));
        self.model = model;
        self.assets = assets;
        self.revision += 1;
        Ok(ApplyReport {
            applied: operations.len(),
            changes,
            warnings,
        })
    }

    /// Renders the complete package, including the embedded source.
    pub fn to_bytes(&self) -> OfficeResult<Vec<u8>> {
        let created = self.created.as_deref();
        let modified = self.modified.as_deref();
        let (mut parts, document) = match &self.model {
            Model::Docx(doc) => (
                docx::render::render(doc, &self.assets, created, modified)?,
                to_source(doc)?,
            ),
            Model::Xlsx(book) => (
                xlsx::render::render(book, created, modified)?,
                to_source(book)?,
            ),
            Model::Pptx(deck) => (
                pptx::render::render(deck, &self.assets, created, modified)?,
                to_source(deck)?,
            ),
        };
        let envelope = SourceEnvelope {
            schema: SOURCE_SCHEMA.to_string(),
            version: SOURCE_VERSION,
            format: self.format().as_str().to_string(),
            revision: self.revision,
            fingerprint: parts.fingerprint(),
            created: self.created.clone(),
            modified: self.modified.clone(),
            document,
            extra: self.envelope_extra.clone(),
        };
        let source = serde_json::to_vec(&envelope)
            .map_err(|err| OfficeError::corrupt(format!("cannot serialize the source: {err}")))?;
        parts.add(SOURCE_PART, source);
        parts.into_zip()
    }

    /// A page of the document's structure.
    pub fn read(&self, request: &ReadRequest) -> OfficeResult<Value> {
        let mut view = match &self.model {
            Model::Docx(doc) => docx::read(doc, request),
            Model::Xlsx(book) => xlsx::read(book, request)?,
            Model::Pptx(deck) => pptx::read(deck, request),
        };
        if let Some(object) = view.as_object_mut() {
            object.insert("format".to_string(), json!(self.format().as_str()));
            object.insert("revision".to_string(), json!(self.revision));
        }
        Ok(view)
    }

    /// Unit counts for tool results.
    pub fn summary(&self) -> Value {
        match &self.model {
            Model::Docx(doc) => json!({ "blocks": doc.blocks.len() }),
            Model::Xlsx(book) => json!({
                "sheets": book.sheets.len(),
                "sheet_names": book.sheets.iter().map(|sheet| sheet.name.clone()).collect::<Vec<_>>(),
            }),
            Model::Pptx(deck) => json!({ "slides": deck.slides.len() }),
        }
    }

    /// Layout findings for the whole document (decks: geometry and overflow).
    pub fn audit(&self) -> Vec<String> {
        match &self.model {
            Model::Pptx(deck) => deck.audit(None),
            Model::Xlsx(book) => book.warnings(),
            Model::Docx(_) => Vec::new(),
        }
    }
}

fn to_source<T: Serialize>(model: &T) -> OfficeResult<Value> {
    serde_json::to_value(model)
        .map_err(|err| OfficeError::corrupt(format!("cannot serialize the document model: {err}")))
}

fn from_source<T: DeserializeOwned>(value: Value) -> OfficeResult<T> {
    serde_json::from_value(value).map_err(|err| {
        OfficeError::corrupt(format!("the embedded document model is invalid: {err}"))
    })
}

fn with_settings<T>(base: T, settings: Option<&Value>, content_key: &str) -> OfficeResult<T>
where
    T: Serialize + DeserializeOwned + UnknownFields,
{
    let Some(settings) = settings.filter(|value| !value.is_null()) else {
        return Ok(base);
    };
    if !settings.is_object() {
        return Err(OfficeError::invalid("settings must be an object"));
    }
    validate_font_input(settings, "settings")?;
    if settings.get(content_key).is_some() {
        return Err(OfficeError::invalid(format!(
            "settings cannot carry `{content_key}`; add content with operations"
        )));
    }
    let mut value = to_source(&base)?;
    merge_patch(&mut value, settings);
    let parsed: T = serde_json::from_value(value)
        .map_err(|err| OfficeError::invalid(format!("settings: {err}")))?;
    let mut unknown = Vec::new();
    parsed.unknown_fields("settings", &mut unknown);
    if !unknown.is_empty() {
        return Err(OfficeError::invalid(format!(
            "unknown settings field(s): {}",
            unknown.join(", ")
        )));
    }
    Ok(parsed)
}

/// Image sources the host must load before [`OfficeDocument::apply`]:
/// `src`/`url`/`path` of image objects that carry no embedded `asset`, plus
/// pictures referenced from Markdown. Data URLs are excluded.
pub fn collect_image_sources(operations: &[Value]) -> Vec<String> {
    fn push_source(object: &serde_json::Map<String, Value>, out: &mut Vec<String>) {
        if object.get("asset").and_then(Value::as_str).is_some() {
            return;
        }
        for key in ["src", "url", "path"] {
            if let Some(src) = object.get(key).and_then(Value::as_str) {
                out.push(src.to_string());
                return;
            }
        }
    }
    fn walk(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(object) => {
                let is_image = object.get("type").and_then(Value::as_str) == Some("image");
                if is_image {
                    push_source(object, out);
                }
                // Element patches carry no `type`; a new `src` replaces the picture.
                if let Some(patches) = object.get("update_elements").and_then(Value::as_array) {
                    for patch in patches.iter().filter_map(Value::as_object) {
                        push_source(patch, out);
                    }
                }
                if let Some(markdown) = object.get("markdown").and_then(Value::as_str) {
                    out.extend(docx::markdown_image_sources(markdown));
                }
                for child in object.values() {
                    walk(child, out);
                }
            }
            Value::Array(items) => items.iter().for_each(|item| walk(item, out)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    for operation in operations {
        walk(operation, &mut found);
    }
    let mut seen = BTreeSet::new();
    found
        .into_iter()
        .filter(|src| !src.starts_with("data:"))
        .filter(|src| seen.insert(src.clone()))
        .collect()
}

#[cfg(test)]
pub(crate) mod test_support {
    pub(crate) fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }
}

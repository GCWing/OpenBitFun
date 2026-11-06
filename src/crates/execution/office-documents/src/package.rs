//! OPC package plumbing: zip IO, shared parts, and the embedded source model.
//!
//! Every package this crate writes carries its editable model in a private
//! part (`openbitfun/genoffice.json`) reached through a package-level
//! relationship. Office applications ignore unknown relationships, so the file
//! opens normally; this crate reads the part back to apply later edits.

use crate::common::DocumentProperties;
use crate::error::{OfficeError, OfficeErrorKind, OfficeResult};
use crate::xml::{esc, XML_HEADER};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};

pub(crate) const SOURCE_PART: &str = "openbitfun/genoffice.json";
pub(crate) const SOURCE_REL_TYPE: &str =
    "http://schemas.openbitfun.com/genoffice/2026/relationships/source";
pub(crate) const SOURCE_CONTENT_TYPE: &str = "application/vnd.openbitfun.genoffice+json";
pub(crate) const SOURCE_SCHEMA: &str = "openbitfun.genoffice";
pub(crate) const SOURCE_VERSION: u32 = 1;

const MAX_PACKAGE_ENTRIES: usize = 4096;
const MAX_ENTRY_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

const REL_OFFICE_DOCUMENT: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const REL_CORE: &str =
    "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const REL_APP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";

/// The JSON stored in [`SOURCE_PART`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SourceEnvelope {
    pub schema: String,
    pub version: u32,
    pub format: String,
    #[serde(default)]
    pub revision: u64,
    /// Hash of the rendered parts; a mismatch means another program changed
    /// the document after this engine wrote it.
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    pub document: Value,
    /// Forward-compatible envelope fields written by newer versions.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Rendered package parts in write order.
#[derive(Debug, Default)]
pub(crate) struct Parts {
    entries: Vec<(String, Vec<u8>)>,
}

impl Parts {
    pub(crate) fn add(&mut self, name: impl Into<String>, bytes: impl Into<Vec<u8>>) {
        self.entries.push((name.into(), bytes.into()));
    }

    pub(crate) fn add_xml(&mut self, name: impl Into<String>, xml: String) {
        self.add(name, xml.into_bytes());
    }

    pub(crate) fn fingerprint(&self) -> String {
        fingerprint(
            self.entries
                .iter()
                .map(|(name, bytes)| (name.as_str(), bytes.as_slice())),
        )
    }

    pub(crate) fn into_zip(self) -> OfficeResult<Vec<u8>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default());
        for (name, bytes) in self.entries {
            writer
                .start_file(name.as_str(), options)
                .map_err(|err| OfficeError::corrupt(format!("cannot write {name}: {err}")))?;
            writer
                .write_all(&bytes)
                .map_err(|err| OfficeError::corrupt(format!("cannot write {name}: {err}")))?;
        }
        let cursor = writer
            .finish()
            .map_err(|err| OfficeError::corrupt(format!("cannot finish package: {err}")))?;
        Ok(cursor.into_inner())
    }
}

/// Parts that count toward the fingerprint: everything this engine renders
/// except the source part itself and document properties, which Office
/// applications rewrite on every save.
fn fingerprinted(name: &str) -> bool {
    name != SOURCE_PART && !name.starts_with("docProps/")
}

pub(crate) fn fingerprint<'a>(entries: impl Iterator<Item = (&'a str, &'a [u8])>) -> String {
    let mut selected: Vec<(&str, &[u8])> =
        entries.filter(|(name, _)| fingerprinted(name)).collect();
    selected.sort_by(|a, b| a.0.cmp(b.0));
    let mut hasher = Sha256::new();
    for (name, bytes) in selected {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Reads every entry of a package, refusing archives that inflate past the
/// limits before materializing them.
pub(crate) fn read_zip(bytes: &[u8]) -> OfficeResult<BTreeMap<String, Vec<u8>>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|err| OfficeError::corrupt(format!("not a zip package: {err}")))?;
    if archive.len() > MAX_PACKAGE_ENTRIES {
        return Err(OfficeError::limit(format!(
            "package has {} entries; the limit is {MAX_PACKAGE_ENTRIES}",
            archive.len()
        )));
    }
    let mut total = 0u64;
    let mut entries = BTreeMap::new();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|err| OfficeError::corrupt(format!("unreadable zip entry: {err}")))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        if file.size() > MAX_ENTRY_BYTES {
            return Err(OfficeError::limit(format!(
                "package entry {name} is too large"
            )));
        }
        let mut buffer = Vec::with_capacity(file.size() as usize);
        (&mut file)
            .take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut buffer)
            .map_err(|err| OfficeError::corrupt(format!("cannot read {name}: {err}")))?;
        if buffer.len() as u64 > MAX_ENTRY_BYTES {
            return Err(OfficeError::limit(format!(
                "package entry {name} is too large"
            )));
        }
        total += buffer.len() as u64;
        if total > MAX_TOTAL_BYTES {
            return Err(OfficeError::limit("package inflates past the size limit"));
        }
        entries.insert(name, buffer);
    }
    Ok(entries)
}

/// Extracts and verifies the embedded source of an opened package.
pub(crate) fn read_source(
    entries: &BTreeMap<String, Vec<u8>>,
    discard_external_changes: bool,
) -> OfficeResult<SourceEnvelope> {
    let Some(source) = entries.get(SOURCE_PART) else {
        return Err(OfficeError::new(
            OfficeErrorKind::NotGenerated,
            "this file was not created by GenOfficeFile (or another program re-saved it and dropped the editable source); read it with the Read tool and create a new file instead",
        ));
    };
    let envelope: SourceEnvelope = serde_json::from_slice(source).map_err(|err| {
        OfficeError::corrupt(format!("the embedded source is not valid JSON: {err}"))
    })?;
    if envelope.schema != SOURCE_SCHEMA {
        return Err(OfficeError::corrupt(format!(
            "unexpected source schema `{}`",
            envelope.schema
        )));
    }
    if envelope.version > SOURCE_VERSION {
        return Err(OfficeError::new(
            OfficeErrorKind::UnsupportedFormat,
            format!(
                "the file was written by a newer GenOfficeFile (source version {}); this version understands up to {SOURCE_VERSION}",
                envelope.version
            ),
        ));
    }
    let actual = fingerprint(
        entries
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice())),
    );
    if !discard_external_changes
        && !envelope.fingerprint.is_empty()
        && actual != envelope.fingerprint
    {
        return Err(OfficeError::new(
            OfficeErrorKind::ExternallyModified,
            "the file was changed by another program after GenOfficeFile last wrote it; editing would discard those changes. Read it with the Read tool and recreate it, or pass discard_external_changes=true to rebuild from the last GenOfficeFile state",
        ));
    }
    Ok(envelope)
}

/// `[Content_Types].xml` builder.
#[derive(Debug, Default)]
pub(crate) struct ContentTypes {
    defaults: BTreeMap<String, String>,
    overrides: Vec<(String, String)>,
}

impl ContentTypes {
    pub(crate) fn new() -> Self {
        let mut types = Self {
            defaults: BTreeMap::new(),
            overrides: Vec::new(),
        };
        types.extension(
            "rels",
            "application/vnd.openxmlformats-package.relationships+xml",
        );
        types.extension("xml", "application/xml");
        types
    }

    pub(crate) fn extension(&mut self, extension: &str, content_type: &str) {
        self.defaults
            .insert(extension.to_string(), content_type.to_string());
    }

    pub(crate) fn part(&mut self, part_name: &str, content_type: &str) {
        self.overrides
            .push((format!("/{part_name}"), content_type.to_string()));
    }

    pub(crate) fn xml(&self) -> String {
        let mut xml = String::from(XML_HEADER);
        xml.push_str(
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        );
        for (extension, content_type) in &self.defaults {
            xml.push_str(&format!(
                "<Default Extension=\"{extension}\" ContentType=\"{content_type}\"/>"
            ));
        }
        for (part, content_type) in &self.overrides {
            xml.push_str(&format!(
                "<Override PartName=\"{}\" ContentType=\"{content_type}\"/>",
                esc(part)
            ));
        }
        xml.push_str("</Types>");
        xml
    }
}

/// Relationship part builder; ids are assigned in insertion order.
#[derive(Debug, Default)]
pub(crate) struct Relationships {
    entries: Vec<(String, String, String, bool)>,
}

impl Relationships {
    pub(crate) fn add(&mut self, rel_type: &str, target: &str) -> String {
        self.push(rel_type, target, false)
    }

    pub(crate) fn add_external(&mut self, rel_type: &str, target: &str) -> String {
        self.push(rel_type, target, true)
    }

    fn push(&mut self, rel_type: &str, target: &str, external: bool) -> String {
        let id = format!("rId{}", self.entries.len() + 1);
        self.entries.push((
            id.clone(),
            rel_type.to_string(),
            target.to_string(),
            external,
        ));
        id
    }

    pub(crate) fn xml(&self) -> String {
        let mut xml = String::from(XML_HEADER);
        xml.push_str(
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        );
        for (id, rel_type, target, external) in &self.entries {
            xml.push_str(&format!(
                "<Relationship Id=\"{id}\" Type=\"{rel_type}\" Target=\"{}\"{}/>",
                esc(target),
                if *external {
                    " TargetMode=\"External\""
                } else {
                    ""
                }
            ));
        }
        xml.push_str("</Relationships>");
        xml
    }
}

/// Adds the parts every package shares: package relationships, document
/// properties, and the embedded source part with its content type.
pub(crate) fn add_common_parts(
    parts: &mut Parts,
    types: &mut ContentTypes,
    main_part: &str,
    properties: &DocumentProperties,
    created: Option<&str>,
    modified: Option<&str>,
    application: &str,
) {
    let mut rels = Relationships::default();
    rels.add(REL_OFFICE_DOCUMENT, main_part);
    rels.add(REL_CORE, "docProps/core.xml");
    rels.add(REL_APP, "docProps/app.xml");
    rels.add(SOURCE_REL_TYPE, SOURCE_PART);
    parts.add_xml("_rels/.rels", rels.xml());

    types.part(
        "docProps/core.xml",
        "application/vnd.openxmlformats-package.core-properties+xml",
    );
    types.part(
        "docProps/app.xml",
        "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    );
    types.part(SOURCE_PART, SOURCE_CONTENT_TYPE);
    parts.add_xml("docProps/core.xml", core_xml(properties, created, modified));
    parts.add_xml("docProps/app.xml", app_xml(application));
}

fn core_xml(
    properties: &DocumentProperties,
    created: Option<&str>,
    modified: Option<&str>,
) -> String {
    let mut xml = String::from(XML_HEADER);
    xml.push_str("<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">");
    let mut field = |tag: &str, value: &Option<String>| {
        if let Some(value) = value {
            xml.push_str(&format!("<{tag}>{}</{tag}>", esc(value)));
        }
    };
    field("dc:title", &properties.title);
    field("dc:subject", &properties.subject);
    field("dc:creator", &properties.author);
    field("cp:keywords", &properties.keywords);
    field("dc:description", &properties.description);
    field("cp:category", &properties.category);
    if let Some(author) = &properties.author {
        xml.push_str(&format!(
            "<cp:lastModifiedBy>{}</cp:lastModifiedBy>",
            esc(author)
        ));
    }
    if let Some(created) = created {
        xml.push_str(&format!(
            "<dcterms:created xsi:type=\"dcterms:W3CDTF\">{}</dcterms:created>",
            esc(created)
        ));
    }
    if let Some(modified) = modified {
        xml.push_str(&format!(
            "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">{}</dcterms:modified>",
            esc(modified)
        ));
    }
    xml.push_str("</cp:coreProperties>");
    xml
}

fn app_xml(application: &str) -> String {
    format!(
        "{XML_HEADER}<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><Application>{}</Application></Properties>",
        esc(application)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_ignores_source_and_properties() {
        let a = fingerprint(
            [
                ("word/document.xml", b"a".as_slice()),
                (SOURCE_PART, b"x".as_slice()),
            ]
            .into_iter(),
        );
        let b = fingerprint(
            [
                ("docProps/core.xml", b"changed".as_slice()),
                ("word/document.xml", b"a".as_slice()),
                (SOURCE_PART, b"y".as_slice()),
            ]
            .into_iter(),
        );
        assert_eq!(a, b);
        let c = fingerprint([("word/document.xml", b"b".as_slice())].into_iter());
        assert_ne!(a, c);
    }

    #[test]
    fn zip_round_trip() {
        let mut parts = Parts::default();
        parts.add("a.xml", b"<a/>".to_vec());
        let bytes = parts.into_zip().unwrap();
        let entries = read_zip(&bytes).unwrap();
        assert_eq!(
            entries.get("a.xml").map(Vec::as_slice),
            Some(b"<a/>".as_slice())
        );
    }
}

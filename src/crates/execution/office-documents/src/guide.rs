//! Operation references returned by the tool's `guide` action.

use crate::OfficeFormat;

const DOCX: &str = include_str!("guides/docx.md");
const XLSX: &str = include_str!("guides/xlsx.md");
const PPTX: &str = include_str!("guides/pptx.md");

/// The full operation and field reference for one format.
pub fn guide(format: OfficeFormat) -> &'static str {
    match format {
        OfficeFormat::Docx => DOCX,
        OfficeFormat::Xlsx => XLSX,
        OfficeFormat::Pptx => PPTX,
    }
}

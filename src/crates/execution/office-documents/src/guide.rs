//! Operation references returned by the tool's `guide` action.

use crate::OfficeFormat;

const DOCX: &str = concat!(
    include_str!("guides/docx.md"),
    "\n",
    include_str!("guides/verification.md")
);
const XLSX: &str = concat!(
    include_str!("guides/xlsx.md"),
    "\n",
    include_str!("guides/verification.md")
);
const PPTX: &str = concat!(
    include_str!("guides/pptx.md"),
    "\n",
    include_str!("guides/verification.md")
);

/// The full operation and field reference for one format.
pub fn guide(format: OfficeFormat) -> &'static str {
    match format {
        OfficeFormat::Docx => DOCX,
        OfficeFormat::Xlsx => XLSX,
        OfficeFormat::Pptx => PPTX,
    }
}

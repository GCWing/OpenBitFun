//! Zcode selects its source path and identity for the OpenCode-compatible store reader.
use openbitfun_opencode_adapter::session::OpenCodeSessionReader;
use openbitfun_product_domains::session_import::*;
use std::path::PathBuf;

pub const SOURCE_REVISION: &str = "zcode-session-sqlite-v1";

#[derive(Clone)]
pub struct ZcodeSessionReader {
    pub zcode_home: PathBuf,
}

impl Default for ZcodeSessionReader {
    fn default() -> Self {
        Self::new(
            dirs::home_dir()
                .map(|home| home.join(".zcode"))
                .unwrap_or_default(),
        )
    }
}

impl ZcodeSessionReader {
    pub fn new(zcode_home: PathBuf) -> Self {
        Self { zcode_home }
    }

    fn reader(&self) -> OpenCodeSessionReader {
        OpenCodeSessionReader::compatible_store(
            self.zcode_home.join("cli/db/db.sqlite"),
            "zcode",
            "Zcode",
            SOURCE_REVISION,
        )
    }

    pub fn discover(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        self.reader().discover(cursor, limit, query)
    }

    pub fn discover_all(&self) -> Result<ExternalSessionCatalog, String> {
        self.reader().discover_all()
    }

    pub fn read_candidate(
        &self,
        candidate_id: &str,
        mode: ExternalSessionImportMode,
    ) -> Result<ExternalSessionDocument, String> {
        self.reader().read_candidate(candidate_id, mode)
    }
}

#[cfg(test)]
mod tests;

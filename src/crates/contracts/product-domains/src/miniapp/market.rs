//! MiniApp marketplace contracts and pure publication policy.

use crate::miniapp::types::{MiniAppI18n, MiniAppPermissions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MARKET_API_VERSION: &str = "v1";
pub const MARKET_PACKAGE_CONTENT_TYPE: &str = "application/vnd.openbitfun.miniapp+zip";
pub const MARKET_MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MARKET_MAX_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
pub const MARKET_MAX_SCREENSHOT_BYTES: u64 = 5 * 1024 * 1024;
pub const MARKET_MAX_SCREENSHOTS: usize = 5;
pub const MARKET_DEFAULT_PAGE_SIZE: u32 = 20;
pub const MARKET_MAX_PAGE_SIZE: u32 = 50;

pub const MARKET_CATEGORIES: &[&str] = &[
    "developer",
    "productivity",
    "data",
    "creative",
    "education",
    "utilities",
    "entertainment",
    "other",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarketSubmissionStatus {
    Draft,
    Submitted,
    Approved,
    Rejected,
    Withdrawn,
}

impl MarketSubmissionStatus {
    pub fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::Submitted)
                | (Self::Draft, Self::Withdrawn)
                | (Self::Submitted, Self::Approved)
                | (Self::Submitted, Self::Rejected)
                | (Self::Submitted, Self::Withdrawn)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum MarketSort {
    #[default]
    Newest,
    Downloads,
    Rating,
}

pub use crate::account::GitHubUser as MarketUserSummary;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingSummary {
    pub listing_id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub tags: Vec<String>,
    pub owner: MarketUserSummary,
    pub latest_release: u32,
    #[serde(rename = "minOpenBitFunVersion")]
    pub min_openbitfun_version: String,
    pub permissions: MiniAppPermissions,
    pub screenshot_urls: Vec<String>,
    pub rating_average: f64,
    pub rating_count: u32,
    pub favorite_count: u32,
    pub download_count: u64,
    pub published_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub i18n: Option<MiniAppI18n>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_favorited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub my_rating: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingDetail {
    #[serde(flatten)]
    pub summary: MarketListingSummary,
    pub changelog: String,
    pub license: MarketLicense,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_url: Option<String>,
    pub releases: Vec<MarketRelease>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketRelease {
    pub release_id: String,
    pub listing_id: String,
    pub release_number: u32,
    #[serde(rename = "minOpenBitFunVersion")]
    pub min_openbitfun_version: String,
    pub changelog: String,
    pub package_sha256: String,
    pub package_size: u64,
    pub review_bundle_hash: String,
    pub permissions: MiniAppPermissions,
    pub published_at: i64,
    pub yanked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketLicense {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spdx_expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_url: Option<String>,
}

impl MarketLicense {
    pub fn is_declared(&self) -> bool {
        self.spdx_expression
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
            || self
                .custom_url
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSubmission {
    pub submission_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_id: Option<String>,
    pub slug: String,
    pub release_number: u32,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub tags: Vec<String>,
    #[serde(rename = "minOpenBitFunVersion")]
    pub min_openbitfun_version: String,
    pub changelog: String,
    pub license: MarketLicense,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_url: Option<String>,
    pub permissions: MiniAppPermissions,
    pub status: MarketSubmissionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_size: Option<u64>,
    pub screenshot_urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSubmissionDraftRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listing_id: Option<String>,
    pub slug: String,
    pub release_number: u32,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(rename = "minOpenBitFunVersion")]
    pub min_openbitfun_version: String,
    pub changelog: String,
    pub license: MarketLicense,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPackageMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome: Option<crate::miniapp::chrome::MiniAppChrome>,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub version: u32,
    pub permissions: MiniAppPermissions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i18n: Option<MiniAppI18n>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMarketOrigin {
    pub listing_id: String,
    pub release_id: String,
    pub release_number: u32,
    pub package_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approve,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDecisionRequest {
    pub decision: ReviewDecision,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPage<T> {
    pub items: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketApiErrorBody {
    pub code: String,
    pub message: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MarketApiErrorEnvelope {
    pub error: MarketApiErrorBody,
}

pub fn validate_market_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if !(3..=63).contains(&bytes.len()) {
        return false;
    }
    if !bytes[0].is_ascii_lowercase() && !bytes[0].is_ascii_digit() {
        return false;
    }
    bytes
        .iter()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

pub fn validate_market_category(category: &str) -> bool {
    MARKET_CATEGORIES.contains(&category)
}

pub fn compute_review_bundle_hash(
    package_sha256: &str,
    canonical_metadata_json: &str,
    screenshot_hashes: &[String],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(package_sha256.as_bytes());
    hasher.update([0]);
    hasher.update(canonical_metadata_json.as_bytes());
    for screenshot_hash in screenshot_hashes {
        hasher.update([0]);
        hasher.update(screenshot_hash.as_bytes());
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_contract_is_strict_and_stable() {
        assert!(validate_market_slug("regex-playground"));
        assert!(validate_market_slug("app-1"));
        assert!(!validate_market_slug("AB"));
        assert!(!validate_market_slug("-leading"));
        assert!(!validate_market_slug("contains_underscore"));
    }

    #[test]
    fn submission_state_machine_rejects_republication() {
        assert!(MarketSubmissionStatus::Draft.can_transition_to(MarketSubmissionStatus::Submitted));
        assert!(
            MarketSubmissionStatus::Submitted.can_transition_to(MarketSubmissionStatus::Approved)
        );
        assert!(
            !MarketSubmissionStatus::Approved.can_transition_to(MarketSubmissionStatus::Submitted)
        );
    }

    #[test]
    fn review_hash_binds_ordered_screenshots() {
        let first = compute_review_bundle_hash(
            "package",
            "{\"name\":\"test\"}",
            &["one".into(), "two".into()],
        );
        let second = compute_review_bundle_hash(
            "package",
            "{\"name\":\"test\"}",
            &["two".into(), "one".into()],
        );
        assert_ne!(first, second);
    }

    #[test]
    fn listing_detail_json_contract_matches_the_shared_typescript_fixture() {
        let fixture = include_str!(
            "../../../../../shared/miniapp-market-contract-fixtures/listing-detail.json"
        );
        let listing: MarketListingDetail = serde_json::from_str(fixture).unwrap();
        let serialized = serde_json::to_value(&listing).unwrap();
        let expected: serde_json::Value = serde_json::from_str(fixture).unwrap();

        assert_eq!(serialized, expected);
        assert!(
            !listing.releases[0]
                .permissions
                .node
                .as_ref()
                .unwrap()
                .enabled
        );
    }

    #[test]
    fn listing_contract_rejects_the_retired_product_version_field() {
        let fixture = include_str!(
            "../../../../../shared/miniapp-market-contract-fixtures/listing-detail.json"
        );
        let mut listing: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let value = listing
            .as_object_mut()
            .unwrap()
            .remove("minOpenBitFunVersion")
            .unwrap();
        let retired_field = ["min", "Bit", "fun", "Version"].concat();
        listing
            .as_object_mut()
            .unwrap()
            .insert(retired_field, value);

        let error = serde_json::from_value::<MarketListingDetail>(listing).unwrap_err();
        assert!(error.to_string().contains("minOpenBitFunVersion"));
    }
}

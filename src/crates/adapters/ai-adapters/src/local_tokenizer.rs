//! Local, operator-supplied Hugging Face tokenizer. No downloads or model execution.

use anyhow::{anyhow, Result};
use std::path::Path;

pub struct LocalTokenizer(tokenizers::Tokenizer);

impl LocalTokenizer {
    pub fn from_file(path: &Path) -> Result<Self> {
        let tokenizer = tokenizers::Tokenizer::from_file(path)
            .map_err(|error| anyhow!("Cannot load tokenizer: {error}"))?;
        Self::from_tokenizer(tokenizer)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let tokenizer = tokenizers::Tokenizer::from_bytes(bytes)
            .map_err(|error| anyhow!("Cannot load embedded tokenizer: {error}"))?;
        Self::from_tokenizer(tokenizer)
    }

    fn from_tokenizer(mut tokenizer: tokenizers::Tokenizer) -> Result<Self> {
        // Counting must never inherit padding/truncation saved by a training pipeline.
        tokenizer.with_padding(None);
        tokenizer
            .with_truncation(None)
            .map_err(|error| anyhow!("Cannot disable tokenizer truncation: {error}"))?;
        Ok(Self(tokenizer))
    }

    pub fn count(&self, text: &str) -> Result<usize> {
        self.0
            .encode(text, false)
            .map(|encoding| encoding.len())
            .map_err(|error| anyhow!("Cannot tokenize input: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokenizers::models::wordlevel::WordLevel;
    use tokenizers::pre_tokenizers::whitespace::WhitespaceSplit;
    use tokenizers::{PaddingParams, PaddingStrategy, TruncationParams};

    #[test]
    fn counts_real_tokens_without_saved_padding_or_truncation() {
        let model = WordLevel::builder()
            .vocab(
                [
                    ("[UNK]".to_string(), 0),
                    ("hello".to_string(), 1),
                    ("世界".to_string(), 2),
                    ("🦀".to_string(), 3),
                ]
                .into_iter()
                .collect(),
            )
            .unk_token("[UNK]".into())
            .build()
            .unwrap();
        let mut tokenizer = tokenizers::Tokenizer::new(model);
        tokenizer.with_pre_tokenizer(Some(WhitespaceSplit));
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: 1,
                ..Default::default()
            }))
            .unwrap();
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::Fixed(10),
            ..Default::default()
        }));
        let counter = LocalTokenizer::from_tokenizer(tokenizer).unwrap();
        assert_eq!(counter.count("hello 世界 🦀").unwrap(), 3);
        assert_eq!(counter.count("").unwrap(), 0);
        assert_eq!(counter.count(&"hello ".repeat(10_000)).unwrap(), 10_000);
    }

    #[test]
    fn missing_tokenizer_is_an_error_not_a_silent_estimate() {
        assert!(
            LocalTokenizer::from_file(Path::new("/nonexistent/router-tokenizer.json")).is_err()
        );
    }

    #[test]
    fn loads_tokenizer_from_embedded_bytes() {
        let model = WordLevel::builder()
            .vocab(
                [("[UNK]".to_string(), 0), ("hello".to_string(), 1)]
                    .into_iter()
                    .collect(),
            )
            .unk_token("[UNK]".into())
            .build()
            .unwrap();
        let tokenizer = tokenizers::Tokenizer::new(model);
        let bytes = tokenizer.to_string(false).unwrap();
        let counter = LocalTokenizer::from_bytes(bytes.as_bytes()).unwrap();
        assert_eq!(counter.count("hello").unwrap(), 1);
    }
}

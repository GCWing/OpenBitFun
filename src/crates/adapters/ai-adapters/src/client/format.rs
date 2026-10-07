use anyhow::{anyhow, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApiFormat {
    OpenAIChat,
    OpenAIResponses,
    Anthropic,
    Gemini,
    /// Google Cloud Code Assist (`cloudcode-pa.googleapis.com`) used by
    /// `gemini-cli` in personal-OAuth mode. The wire format is the regular
    /// Gemini body, but wrapped as `{ "model", "project", "request": { ... } }`.
    GeminiCodeAssist,
}

impl ApiFormat {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        let normalized = value.trim().to_ascii_lowercase();
        match normalized.as_str() {
            "openai" => Ok(Self::OpenAIChat),
            "response" | "responses" => Ok(Self::OpenAIResponses),
            "anthropic" => Ok(Self::Anthropic),
            "gemini" | "google" => Ok(Self::Gemini),
            "gemini-code-assist" | "gemini_code_assist" | "code-assist" => {
                Ok(Self::GeminiCodeAssist)
            }
            _ => Err(anyhow!("Unknown API format: {}", value)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ApiFormat;

    #[test]
    fn gemini_api_key_format_is_distinct_from_code_assist() {
        for format in ["gemini", "google", " GEMINI "] {
            assert_eq!(ApiFormat::parse(format).unwrap(), ApiFormat::Gemini);
        }
        for format in ["gemini-code-assist", "gemini_code_assist", "code-assist"] {
            assert_eq!(
                ApiFormat::parse(format).unwrap(),
                ApiFormat::GeminiCodeAssist
            );
        }
    }
}

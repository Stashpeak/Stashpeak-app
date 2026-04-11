/// Canonical identifier for a supported AI provider.
///
/// `parse()` is the sole whitelist gate — only strings matched here can
/// ever become a `ProviderId` and therefore can ever reach the OS keychain.
/// Add a variant here when a new provider connector is implemented.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderId {
    OpenAi,
    Anthropic,
    OpenRouter,
    Groq,
}

impl ProviderId {
    /// Parse a user-supplied string into a known provider.
    ///
    /// Returns `Err(value.to_string())` for unrecognised inputs so callers
    /// can form a meaningful error without importing error types from this module.
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "openrouter" => Ok(Self::OpenRouter),
            "groq" => Ok(Self::Groq),
            other => Err(other.to_string()),
        }
    }

    /// Stable lowercase identifier used in keychain keys and API dispatch.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::OpenRouter => "openrouter",
            Self::Groq => "groq",
        }
    }

    /// Human-readable display name for UI surfaces (Quick Add presets, settings).
    #[allow(dead_code)]
    pub(crate) fn display_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OpenAI",
            Self::Anthropic => "Anthropic",
            Self::OpenRouter => "OpenRouter",
            Self::Groq => "Groq",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_providers() {
        assert_eq!(ProviderId::parse("openai").unwrap(), ProviderId::OpenAi);
        assert_eq!(
            ProviderId::parse("anthropic").unwrap(),
            ProviderId::Anthropic
        );
        assert_eq!(
            ProviderId::parse("openrouter").unwrap(),
            ProviderId::OpenRouter
        );
        assert_eq!(ProviderId::parse("groq").unwrap(), ProviderId::Groq);
    }

    #[test]
    fn rejects_unknown_provider() {
        assert_eq!(
            ProviderId::parse("not-a-provider").unwrap_err(),
            "not-a-provider".to_string()
        );
    }

    #[test]
    fn as_str_round_trips() {
        for id in [
            ProviderId::OpenAi,
            ProviderId::Anthropic,
            ProviderId::OpenRouter,
            ProviderId::Groq,
        ] {
            assert_eq!(ProviderId::parse(id.as_str()).unwrap(), id);
        }
    }

    #[test]
    fn all_variants_have_display_name() {
        for id in [
            ProviderId::OpenAi,
            ProviderId::Anthropic,
            ProviderId::OpenRouter,
            ProviderId::Groq,
        ] {
            assert!(!id.display_name().is_empty());
        }
    }
}

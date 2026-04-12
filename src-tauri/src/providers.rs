use rusqlite::OptionalExtension;

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
    Gcp,
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
            "gcp" => Ok(Self::Gcp),
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
            Self::Gcp => "gcp",
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
            Self::Gcp => "Google Cloud",
        }
    }
}

pub fn set_provider_enabled(provider: &str, enabled: bool) -> Result<(), String> {
    let p = ProviderId::parse(provider)?;
    let conn = crate::db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO provider_spend (provider, enabled) VALUES (?1, ?2)
         ON CONFLICT(provider) DO UPDATE SET enabled = excluded.enabled",
        rusqlite::params![p.as_str(), if enabled { 1 } else { 0 }],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn is_provider_enabled(provider: &str) -> Result<bool, String> {
    let p = ProviderId::parse(provider)?;
    let conn = crate::db::connect().map_err(|e| e.to_string())?;
    let val: Option<i32> = conn
        .query_row(
            "SELECT enabled FROM provider_spend WHERE provider = ?1",
            rusqlite::params![p.as_str()],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(val.unwrap_or(1) != 0) // default to 1 (true)
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
        assert_eq!(ProviderId::parse("gcp").unwrap(), ProviderId::Gcp);
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
            ProviderId::Gcp,
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
            ProviderId::Gcp,
        ] {
            assert!(!id.display_name().is_empty());
        }
    }
}

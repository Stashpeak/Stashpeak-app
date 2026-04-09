use keyring::{Entry, Error as KeyringError};
use std::fmt;

const KEYCHAIN_SERVICE: &str = "com.stashpeak.credentials";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderId {
    OpenAi,
    Anthropic,
    OpenRouter,
    Groq,
}

impl ProviderId {
    fn parse(value: &str) -> Result<Self, SecretError> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "anthropic" => Ok(Self::Anthropic),
            "openrouter" => Ok(Self::OpenRouter),
            "groq" => Ok(Self::Groq),
            other => Err(SecretError::InvalidProvider(other.to_string())),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::OpenRouter => "openrouter",
            Self::Groq => "groq",
        }
    }

    fn account_name(self) -> String {
        format!("provider:{}", self.as_str())
    }
}

#[derive(Debug)]
enum CredentialStoreError {
    MissingEntry,
    Backend,
}

trait CredentialStore {
    fn set_password(
        &self,
        service: &str,
        account: &str,
        value: &str,
    ) -> Result<(), CredentialStoreError>;
    fn get_password(&self, service: &str, account: &str) -> Result<String, CredentialStoreError>;
    fn delete_credential(&self, service: &str, account: &str) -> Result<(), CredentialStoreError>;
}

struct KeyringStore;

impl KeyringStore {
    fn entry(service: &str, account: &str) -> Result<Entry, CredentialStoreError> {
        Entry::new(service, account).map_err(map_keyring_error)
    }
}

impl CredentialStore for KeyringStore {
    fn set_password(
        &self,
        service: &str,
        account: &str,
        value: &str,
    ) -> Result<(), CredentialStoreError> {
        Self::entry(service, account)?
            .set_password(value)
            .map_err(map_keyring_error)
    }

    fn get_password(&self, service: &str, account: &str) -> Result<String, CredentialStoreError> {
        Self::entry(service, account)?
            .get_password()
            .map_err(map_keyring_error)
    }

    fn delete_credential(&self, service: &str, account: &str) -> Result<(), CredentialStoreError> {
        Self::entry(service, account)?
            .delete_credential()
            .map_err(map_keyring_error)
    }
}

fn map_keyring_error(err: KeyringError) -> CredentialStoreError {
    match err {
        KeyringError::NoEntry => CredentialStoreError::MissingEntry,
        _ => CredentialStoreError::Backend,
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum SecretError {
    InvalidProvider(String),
    StorageUnavailable,
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProvider(provider) => write!(f, "invalid provider '{provider}'"),
            Self::StorageUnavailable => write!(f, "secure credential storage is unavailable"),
        }
    }
}

impl std::error::Error for SecretError {}

pub fn store_provider_api_key(provider: &str, value: &str) -> Result<(), SecretError> {
    store_provider_api_key_with_store(&KeyringStore, provider, value)
}

pub fn get_provider_api_key(provider: &str) -> Result<Option<String>, SecretError> {
    get_provider_api_key_with_store(&KeyringStore, provider)
}

pub fn delete_provider_api_key(provider: &str) -> Result<(), SecretError> {
    delete_provider_api_key_with_store(&KeyringStore, provider)
}

pub fn has_provider_api_key(provider: &str) -> Result<bool, SecretError> {
    has_provider_api_key_with_store(&KeyringStore, provider)
}

fn store_provider_api_key_with_store(
    store: &dyn CredentialStore,
    provider: &str,
    value: &str,
) -> Result<(), SecretError> {
    let provider = ProviderId::parse(provider)?;
    store
        .set_password(KEYCHAIN_SERVICE, &provider.account_name(), value)
        .map_err(|_| SecretError::StorageUnavailable)
}

fn get_provider_api_key_with_store(
    store: &dyn CredentialStore,
    provider: &str,
) -> Result<Option<String>, SecretError> {
    let provider = ProviderId::parse(provider)?;

    match store.get_password(KEYCHAIN_SERVICE, &provider.account_name()) {
        Ok(value) => Ok(Some(value)),
        Err(CredentialStoreError::MissingEntry) => Ok(None),
        Err(CredentialStoreError::Backend) => Err(SecretError::StorageUnavailable),
    }
}

fn delete_provider_api_key_with_store(
    store: &dyn CredentialStore,
    provider: &str,
) -> Result<(), SecretError> {
    let provider = ProviderId::parse(provider)?;

    match store.delete_credential(KEYCHAIN_SERVICE, &provider.account_name()) {
        Ok(()) | Err(CredentialStoreError::MissingEntry) => Ok(()),
        Err(CredentialStoreError::Backend) => Err(SecretError::StorageUnavailable),
    }
}

fn has_provider_api_key_with_store(
    store: &dyn CredentialStore,
    provider: &str,
) -> Result<bool, SecretError> {
    Ok(get_provider_api_key_with_store(store, provider)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MockStore {
        entries: RefCell<HashMap<(String, String), String>>,
        fail_reads: bool,
        fail_writes: bool,
        fail_deletes: bool,
    }

    impl MockStore {
        fn with_fail_reads() -> Self {
            Self {
                fail_reads: true,
                ..Self::default()
            }
        }

        fn with_fail_writes() -> Self {
            Self {
                fail_writes: true,
                ..Self::default()
            }
        }

        fn with_fail_deletes() -> Self {
            Self {
                fail_deletes: true,
                ..Self::default()
            }
        }
    }

    impl CredentialStore for MockStore {
        fn set_password(
            &self,
            service: &str,
            account: &str,
            value: &str,
        ) -> Result<(), CredentialStoreError> {
            if self.fail_writes {
                return Err(CredentialStoreError::Backend);
            }

            self.entries.borrow_mut().insert(
                (service.to_string(), account.to_string()),
                value.to_string(),
            );
            Ok(())
        }

        fn get_password(
            &self,
            service: &str,
            account: &str,
        ) -> Result<String, CredentialStoreError> {
            if self.fail_reads {
                return Err(CredentialStoreError::Backend);
            }

            self.entries
                .borrow()
                .get(&(service.to_string(), account.to_string()))
                .cloned()
                .ok_or(CredentialStoreError::MissingEntry)
        }

        fn delete_credential(
            &self,
            service: &str,
            account: &str,
        ) -> Result<(), CredentialStoreError> {
            if self.fail_deletes {
                return Err(CredentialStoreError::Backend);
            }

            let removed = self
                .entries
                .borrow_mut()
                .remove(&(service.to_string(), account.to_string()));

            if removed.is_some() {
                Ok(())
            } else {
                Err(CredentialStoreError::MissingEntry)
            }
        }
    }

    #[test]
    fn validates_provider_ids() {
        assert_eq!(ProviderId::parse("openai").unwrap(), ProviderId::OpenAi);
        assert_eq!(
            ProviderId::parse("not-a-provider").unwrap_err(),
            SecretError::InvalidProvider("not-a-provider".to_string())
        );
    }

    #[test]
    fn formats_provider_account_names() {
        assert_eq!(ProviderId::OpenAi.account_name(), "provider:openai");
        assert_eq!(ProviderId::Anthropic.account_name(), "provider:anthropic");
        assert_eq!(ProviderId::OpenRouter.account_name(), "provider:openrouter");
        assert_eq!(ProviderId::Groq.account_name(), "provider:groq");
    }

    #[test]
    fn stores_and_reads_provider_keys() {
        let store = MockStore::default();

        store_provider_api_key_with_store(&store, "openai", "sk-test").unwrap();

        assert_eq!(
            get_provider_api_key_with_store(&store, "openai").unwrap(),
            Some("sk-test".to_string())
        );
    }

    #[test]
    fn delete_removes_provider_keys() {
        let store = MockStore::default();

        store_provider_api_key_with_store(&store, "groq", "groq-key").unwrap();
        delete_provider_api_key_with_store(&store, "groq").unwrap();

        assert_eq!(
            get_provider_api_key_with_store(&store, "groq").unwrap(),
            None
        );
    }

    #[test]
    fn delete_is_ok_when_credential_is_missing() {
        let store = MockStore::default();

        assert_eq!(
            delete_provider_api_key_with_store(&store, "openrouter"),
            Ok(())
        );
    }

    #[test]
    fn has_matches_presence() {
        let store = MockStore::default();

        assert!(!has_provider_api_key_with_store(&store, "anthropic").unwrap());

        store_provider_api_key_with_store(&store, "anthropic", "anth-key").unwrap();

        assert!(has_provider_api_key_with_store(&store, "anthropic").unwrap());
    }

    #[test]
    fn missing_entry_is_not_a_fatal_error() {
        let store = MockStore::default();

        assert_eq!(
            get_provider_api_key_with_store(&store, "openai").unwrap(),
            None
        );
    }

    #[test]
    fn storage_failures_are_reported_without_secret_details() {
        let read_store = MockStore::with_fail_reads();
        let write_store = MockStore::with_fail_writes();
        let delete_store = MockStore::with_fail_deletes();

        assert_eq!(
            get_provider_api_key_with_store(&read_store, "openai").unwrap_err(),
            SecretError::StorageUnavailable
        );
        assert_eq!(
            store_provider_api_key_with_store(&write_store, "openai", "sk-secret").unwrap_err(),
            SecretError::StorageUnavailable
        );
        assert_eq!(
            delete_provider_api_key_with_store(&delete_store, "openai").unwrap_err(),
            SecretError::StorageUnavailable
        );
    }
}

use std::fmt;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::db;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub id: i64,
    pub name: String,
    pub provider: String,
    pub monthly_cost: f64,
    pub currency: String,
    pub billing_period: String,
    pub next_billing_at: Option<String>,
    pub category: String,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionInput {
    pub name: String,
    pub provider: String,
    pub monthly_cost: f64,
    pub currency: String,
    pub billing_period: String,
    pub next_billing_at: Option<String>,
    pub category: String,
    pub notes: String,
}

#[derive(Debug)]
struct ValidatedSubscriptionInput {
    name: String,
    provider: String,
    monthly_cost: f64,
    currency: String,
    billing_period: String,
    next_billing_at: Option<String>,
    category: String,
    notes: String,
}

#[derive(Debug)]
pub enum SubscriptionError {
    Validation(String),
    NotFound(i64),
    Database,
}

impl fmt::Display for SubscriptionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) => write!(f, "{message}"),
            Self::NotFound(id) => write!(f, "subscription {id} not found"),
            Self::Database => write!(f, "subscription storage is unavailable"),
        }
    }
}

impl std::error::Error for SubscriptionError {}

/// Advance any `next_billing_at` dates that are in the past to the next future cycle.
/// Loops so that subscriptions not opened for multiple cycles are fully caught up.
fn advance_past_billing_dates(conn: &Connection) -> rusqlite::Result<()> {
    loop {
        let updated = conn.execute(
            "UPDATE subscriptions \
             SET next_billing_at = date(next_billing_at, '+1 month'), \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') \
             WHERE billing_period = 'monthly' \
               AND next_billing_at IS NOT NULL \
               AND date(next_billing_at) < date('now', 'localtime')",
            [],
        )?;
        if updated == 0 {
            break;
        }
    }

    loop {
        let updated = conn.execute(
            "UPDATE subscriptions \
             SET next_billing_at = date(next_billing_at, '+1 year'), \
                 updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') \
             WHERE billing_period = 'yearly' \
               AND next_billing_at IS NOT NULL \
               AND date(next_billing_at) < date('now', 'localtime')",
            [],
        )?;
        if updated == 0 {
            break;
        }
    }

    Ok(())
}

pub fn list_subscriptions() -> Result<Vec<Subscription>, SubscriptionError> {
    let conn = open_connection()?;
    advance_past_billing_dates(&conn).map_err(|_| SubscriptionError::Database)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
                id,
                name,
                provider,
                monthly_cost,
                currency,
                billing_period,
                next_billing_at,
                category,
                notes,
                created_at,
                updated_at
            FROM subscriptions
            ORDER BY next_billing_at IS NULL, next_billing_at, name COLLATE NOCASE
            "#,
        )
        .map_err(|_| SubscriptionError::Database)?;

    let rows = stmt
        .query_map([], map_subscription)
        .map_err(|_| SubscriptionError::Database)?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| SubscriptionError::Database)
}

pub fn create_subscription(input: SubscriptionInput) -> Result<Subscription, SubscriptionError> {
    let input = validate_input(input)?;
    let conn = open_connection()?;

    conn.execute(
        r#"
        INSERT INTO subscriptions (
            name,
            provider,
            monthly_cost,
            currency,
            billing_period,
            next_billing_at,
            category,
            notes
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
        params![
            input.name,
            input.provider,
            input.monthly_cost,
            input.currency,
            input.billing_period,
            input.next_billing_at,
            input.category,
            input.notes
        ],
    )
    .map_err(|_| SubscriptionError::Database)?;

    fetch_subscription(&conn, conn.last_insert_rowid())
}

pub fn update_subscription(
    id: i64,
    input: SubscriptionInput,
) -> Result<Subscription, SubscriptionError> {
    let input = validate_input(input)?;
    let conn = open_connection()?;

    let updated_rows = conn
        .execute(
            r#"
            UPDATE subscriptions
            SET
                name = ?1,
                provider = ?2,
                monthly_cost = ?3,
                currency = ?4,
                billing_period = ?5,
                next_billing_at = ?6,
                category = ?7,
                notes = ?8,
                updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            WHERE id = ?9
            "#,
            params![
                input.name,
                input.provider,
                input.monthly_cost,
                input.currency,
                input.billing_period,
                input.next_billing_at,
                input.category,
                input.notes,
                id
            ],
        )
        .map_err(|_| SubscriptionError::Database)?;

    if updated_rows == 0 {
        return Err(SubscriptionError::NotFound(id));
    }

    fetch_subscription(&conn, id)
}

pub fn delete_subscription(id: i64) -> Result<(), SubscriptionError> {
    let conn = open_connection()?;
    let deleted_rows = conn
        .execute("DELETE FROM subscriptions WHERE id = ?1", params![id])
        .map_err(|_| SubscriptionError::Database)?;

    if deleted_rows == 0 {
        return Err(SubscriptionError::NotFound(id));
    }

    Ok(())
}

pub fn get_suppressed_link_ids() -> Result<Vec<i64>, SubscriptionError> {
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT subscription_id
            FROM subscription_link_overrides
            WHERE suppress_link = 1
            ORDER BY subscription_id
            "#,
        )
        .map_err(|_| SubscriptionError::Database)?;

    let rows = stmt
        .query_map([], |row| row.get::<_, i64>("subscription_id"))
        .map_err(|_| SubscriptionError::Database)?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| SubscriptionError::Database)
}

pub fn set_subscription_link_suppressed(
    id: i64,
    suppressed: bool,
) -> Result<(), SubscriptionError> {
    let conn = open_connection()?;

    if suppressed {
        conn.execute(
            r#"
            INSERT OR REPLACE INTO subscription_link_overrides (subscription_id, suppress_link)
            VALUES (?1, 1)
            "#,
            params![id],
        )
        .map_err(|_| SubscriptionError::Database)?;
    } else {
        conn.execute(
            "DELETE FROM subscription_link_overrides WHERE subscription_id = ?1",
            params![id],
        )
        .map_err(|_| SubscriptionError::Database)?;
    }

    Ok(())
}

fn open_connection() -> Result<Connection, SubscriptionError> {
    db::connect().map_err(|_| SubscriptionError::Database)
}

fn fetch_subscription(conn: &Connection, id: i64) -> Result<Subscription, SubscriptionError> {
    conn.query_row(
        r#"
        SELECT
            id,
            name,
            provider,
            monthly_cost,
            currency,
            billing_period,
            next_billing_at,
            category,
            notes,
            created_at,
            updated_at
        FROM subscriptions
        WHERE id = ?1
        "#,
        params![id],
        map_subscription,
    )
    .optional()
    .map_err(|_| SubscriptionError::Database)?
    .ok_or(SubscriptionError::NotFound(id))
}

fn map_subscription(row: &Row<'_>) -> rusqlite::Result<Subscription> {
    Ok(Subscription {
        id: row.get("id")?,
        name: row.get("name")?,
        provider: row.get("provider")?,
        monthly_cost: row.get("monthly_cost")?,
        currency: row.get("currency")?,
        billing_period: row.get("billing_period")?,
        next_billing_at: row.get("next_billing_at")?,
        category: row.get("category")?,
        notes: row.get("notes")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn validate_input(
    input: SubscriptionInput,
) -> Result<ValidatedSubscriptionInput, SubscriptionError> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(SubscriptionError::Validation(
            "subscription name is required".to_string(),
        ));
    }

    let provider = input.provider.trim();
    if provider.is_empty() {
        return Err(SubscriptionError::Validation(
            "provider is required".to_string(),
        ));
    }

    if !input.monthly_cost.is_finite() || input.monthly_cost < 0.0 {
        return Err(SubscriptionError::Validation(
            "cost must be a non-negative number".to_string(),
        ));
    }

    let currency = input.currency.trim().to_uppercase();
    if currency.is_empty() {
        return Err(SubscriptionError::Validation(
            "currency is required".to_string(),
        ));
    }

    let billing_period = match input.billing_period.trim() {
        "monthly" => "monthly".to_string(),
        "yearly" | "annual" => "yearly".to_string(),
        _ => {
            return Err(SubscriptionError::Validation(
                "billing period must be monthly or annual".to_string(),
            ))
        }
    };

    let next_billing_at = input
        .next_billing_at
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let category = match input.category.trim() {
        "" => "ai".to_string(),
        value => value.to_string(),
    };

    Ok(ValidatedSubscriptionInput {
        name: name.to_string(),
        provider: provider.to_string(),
        monthly_cost: input.monthly_cost,
        currency,
        billing_period,
        next_billing_at,
        category,
        notes: input.notes.trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> SubscriptionInput {
        SubscriptionInput {
            name: "ChatGPT Plus".to_string(),
            provider: "OpenAI".to_string(),
            monthly_cost: 20.0,
            currency: "usd".to_string(),
            billing_period: "annual".to_string(),
            next_billing_at: Some("2026-05-01".to_string()),
            category: "".to_string(),
            notes: " personal ".to_string(),
        }
    }

    #[test]
    fn normalizes_valid_input() {
        let normalized = validate_input(sample_input()).unwrap();

        assert_eq!(normalized.name, "ChatGPT Plus");
        assert_eq!(normalized.provider, "OpenAI");
        assert_eq!(normalized.currency, "USD");
        assert_eq!(normalized.billing_period, "yearly");
        assert_eq!(normalized.category, "ai");
        assert_eq!(normalized.notes, "personal");
    }

    #[test]
    fn rejects_empty_name() {
        let mut input = sample_input();
        input.name = "   ".to_string();

        assert_eq!(
            validate_input(input).unwrap_err().to_string(),
            "subscription name is required"
        );
    }

    #[test]
    fn rejects_negative_costs() {
        let mut input = sample_input();
        input.monthly_cost = -1.0;

        assert_eq!(
            validate_input(input).unwrap_err().to_string(),
            "cost must be a non-negative number"
        );
    }
}

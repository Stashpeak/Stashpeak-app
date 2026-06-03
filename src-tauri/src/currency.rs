use rusqlite::params;
use serde::Serialize;

use crate::db;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExchangeRate {
    pub from_currency: String,
    pub to_currency: String,
    pub rate: f64,
}

/// Returns all manually-entered exchange rates stored in the DB.
pub fn get_exchange_rates() -> Result<Vec<ExchangeRate>, String> {
    let conn = db::connect().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT from_currency, to_currency, rate FROM exchange_rates ORDER BY from_currency",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ExchangeRate {
                from_currency: row.get(0)?,
                to_currency: row.get(1)?,
                rate: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.map(|r| r.map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()
}

/// Inserts or updates an exchange rate.
/// Both currency codes are uppercased and trimmed before storing.
/// Returns an error if from_currency == to_currency or rate <= 0.
pub fn upsert_exchange_rate(from: String, to: String, rate: f64) -> Result<(), String> {
    let from = from.trim().to_uppercase();
    let to = to.trim().to_uppercase();

    if from.is_empty() || to.is_empty() {
        return Err("currency codes must not be empty".to_string());
    }
    if from == to {
        return Err("from_currency and to_currency must differ".to_string());
    }
    if !rate.is_finite() || rate <= 0.0 {
        return Err("rate must be a positive number".to_string());
    }

    let conn = db::connect().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO exchange_rates (from_currency, to_currency, rate, updated_at)
         VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
         ON CONFLICT(from_currency, to_currency) DO UPDATE
         SET rate = excluded.rate, updated_at = excluded.updated_at",
        params![from, to, rate],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_same_currency() {
        let err = upsert_exchange_rate("USD".into(), "USD".into(), 1.0).unwrap_err();
        assert!(err.contains("must differ"));
    }

    #[test]
    fn rejects_negative_rate() {
        let err = upsert_exchange_rate("USD".into(), "CZK".into(), -1.0).unwrap_err();
        assert!(err.contains("positive"));
    }

    #[test]
    fn rejects_zero_rate() {
        let err = upsert_exchange_rate("USD".into(), "CZK".into(), 0.0).unwrap_err();
        assert!(err.contains("positive"));
    }
}

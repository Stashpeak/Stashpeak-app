use std::fmt;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::db;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductVisibility {
    pub product_id: String,
    pub enabled: bool,
}

#[derive(Debug)]
pub enum ProductError {
    Validation(String),
    Database,
}

impl fmt::Display for ProductError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) => write!(f, "{message}"),
            Self::Database => write!(f, "product visibility storage is unavailable"),
        }
    }
}

impl std::error::Error for ProductError {}

pub fn get_product_visibility() -> Result<Vec<ProductVisibility>, ProductError> {
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT product_id, enabled
            FROM product_visibility
            ORDER BY product_id
            "#,
        )
        .map_err(|_| ProductError::Database)?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProductVisibility {
                product_id: row.get("product_id")?,
                enabled: row.get::<_, i64>("enabled")? != 0,
            })
        })
        .map_err(|_| ProductError::Database)?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|_| ProductError::Database)
}

pub fn set_product_visibility(product_id: String, enabled: bool) -> Result<(), ProductError> {
    let product_id = product_id.trim();
    if product_id.is_empty() {
        return Err(ProductError::Validation(
            "product id is required".to_string(),
        ));
    }

    let conn = open_connection()?;
    conn.execute(
        r#"
        INSERT INTO product_visibility (product_id, enabled)
        VALUES (?1, ?2)
        ON CONFLICT(product_id) DO UPDATE
        SET enabled = excluded.enabled
        "#,
        params![product_id, if enabled { 1 } else { 0 }],
    )
    .map_err(|_| ProductError::Database)?;

    Ok(())
}

fn open_connection() -> Result<Connection, ProductError> {
    db::connect().map_err(|_| ProductError::Database)
}

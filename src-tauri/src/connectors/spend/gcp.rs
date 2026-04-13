use async_trait::async_trait;
use chrono::{Datelike, Utc};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::connectors::{ConnectorError, SpendConnector, SpendData};
use crate::secrets;

const BQ_SCOPE: &str = "https://www.googleapis.com/auth/bigquery.readonly";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

pub struct GcpConnector {
    client: Client,
}

impl GcpConnector {
    pub fn new(client: Client) -> Self {
        Self { client }
    }

    async fn get_access_token(&self, email: &str, private_key: &str) -> Result<String, ConnectorError> {
        #[derive(Serialize)]
        struct Claims {
            iss: String,
            scope: String,
            aud: String,
            exp: usize,
            iat: usize,
        }

        let now = Utc::now().timestamp() as usize;
        let claims = Claims {
            iss: email.to_string(),
            scope: BQ_SCOPE.to_string(),
            aud: TOKEN_URL.to_string(),
            exp: now + 3600,
            iat: now,
        };

        let header = Header::new(Algorithm::RS256);
        let key = EncodingKey::from_rsa_pem(private_key.as_bytes())
            .map_err(|e| ConnectorError::Config(format!("Failed to parse private key: {e}")))?;

        let jwt = encode(&header, &claims, &key)
            .map_err(|e| ConnectorError::Config(format!("Failed to encode JWT: {e}")))?;

        #[derive(Serialize)]
        struct TokenRequest<'a> {
            grant_type: &'a str,
            assertion: &'a str,
        }

        let res = self.client.post(TOKEN_URL)
            .form(&TokenRequest {
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: &jwt,
            })
            .send()
            .await
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        if !res.status().is_success() {
            let body = res.text().await.unwrap_or_default();
            tracing::error!(body, "Failed to get token");
            return Err(ConnectorError::Unauthorized);
        }

        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
        }

        let parsed: TokenResponse = res.json().await.map_err(|e| {
            ConnectorError::ApiError { status: 200, body: format!("Failed to parse token response: {e}") }
        })?;

        Ok(parsed.access_token)
    }

    async fn fetch_month_spend(
        &self,
        token: &str,
        project_id: &str,
        dataset_id: &str,
        table_name: &str,
        year: i32,
        month: u32,
    ) -> Result<f64, ConnectorError> {
        validate_bq_identifier("project_id", project_id)?;
        validate_bq_identifier("dataset_id", dataset_id)?;
        validate_bq_identifier("table_name", table_name)?;
        let invoice_month = validate_invoice_month(year, month)?;

        // Filter globally for Google Cloud AI usage if possible, or just take total project spend
        // Here we just take the total cost for the invoice month.
        // We filter for Gemini/Vertex explicitly to accurately represent the AI connector.
        let query = format!(
            "SELECT sum(cost) as total_cost FROM `{}.{}.{}` WHERE invoice.month = '{}' AND (service.description LIKE '%Vertex AI%' OR service.description LIKE '%Gemini%')",
            project_id, dataset_id, table_name, invoice_month
        );

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct QueryRequest {
            query: String,
            use_legacy_sql: bool,
        }

        let url = format!("https://bigquery.googleapis.com/bigquery/v2/projects/{}/queries", project_id);
        let res = self.client.post(&url)
            .header("Authorization", format!("Bearer {token}"))
            .json(&QueryRequest { query, use_legacy_sql: false })
            .send()
            .await
            .map_err(|e| ConnectorError::Network(e.to_string()))?;

        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();

            // Check if the table was not found
            if body.contains("Not found: Table") {
                return Err(ConnectorError::Config("BigQuery export not yet populated — allow up to 48h after initial setup".into()));
            }

            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err(ConnectorError::Unauthorized);
            }
            return Err(ConnectorError::ApiError { status: status.as_u16(), body });
        }

        #[derive(Deserialize)]
        struct QueryResponse {
            rows: Option<Vec<Row>>,
        }
        #[derive(Deserialize)]
        struct Row {
            f: Vec<Cell>,
        }
        #[derive(Deserialize)]
        struct Cell {
            v: Option<String>,
        }

        let resp: QueryResponse = res.json().await.map_err(|e| ConnectorError::ApiError {
            status: status.as_u16(),
            body: format!("Failed to parse BQ response: {e}"),
        })?;

        if let Some(rows) = resp.rows {
            if let Some(first_row) = rows.first() {
                if let Some(first_cell) = first_row.f.first() {
                    if let Some(val_str) = &first_cell.v {
                        return Ok(val_str.parse::<f64>().unwrap_or(0.0));
                    }
                }
            }
        }

        Ok(0.0) // No rows or null sum means 0 spend
    }
}

fn validate_bq_identifier(field_name: &str, value: &str) -> Result<(), ConnectorError> {
    if value.is_empty() || value.len() > 1024 {
        return Err(ConnectorError::Config(format!(
            "Invalid GCP {field_name}: must be 1-1024 characters"
        )));
    }

    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ConnectorError::Config(format!(
            "Invalid GCP {field_name}: only letters, numbers, underscores, and hyphens are allowed"
        )));
    }

    Ok(())
}

fn validate_invoice_month(year: i32, month: u32) -> Result<String, ConnectorError> {
    if !(0..=9999).contains(&year) {
        return Err(ConnectorError::Config(
            "Invalid invoice month: year must be between 0000 and 9999".into(),
        ));
    }

    if !(1..=12).contains(&month) {
        return Err(ConnectorError::Config(
            "Invalid invoice month: month must be between 01 and 12".into(),
        ));
    }

    Ok(format!("{year:04}{month:02}"))
}

#[derive(Deserialize)]
struct KeychainPayload {
    service_account_key: ServiceAccountKey,
    project_id: String,
    dataset_id: String,
    table_name: String,
}

#[derive(Deserialize)]
struct ServiceAccountKey {
    client_email: String,
    private_key: String,
}

#[async_trait]
impl SpendConnector for GcpConnector {
    fn provider_id(&self) -> &'static str {
        "gcp"
    }

    async fn fetch(&self) -> Result<SpendData, ConnectorError> {
        let payload_str = tauri::async_runtime::spawn_blocking(|| {
            secrets::get_provider_api_key("gcp")
                .map_err(|e| ConnectorError::Config(e.to_string()))
                .and_then(|opt| opt.ok_or(ConnectorError::Unauthorized))
        })
        .await
        .map_err(|e| ConnectorError::Config(format!("keychain task failed: {e}")))??;

        let payload: KeychainPayload = serde_json::from_str(&payload_str)
            .map_err(|e| ConnectorError::Config(format!("Failed to parse GCP keychain payload: {e}")))?;

        // Ensure private key is scrubbed from logs
        crate::logging::remember_secret(&payload.service_account_key.private_key);

        tracing::debug!(
            provider = "gcp",
            project_id = %payload.project_id,
            dataset_id = %payload.dataset_id,
            "fetching token for GCP"
        );

        let token = self.get_access_token(
            &payload.service_account_key.client_email,
            &payload.service_account_key.private_key,
        )
        .await?;

        let now = Utc::now();
        let (prev_year, prev_month) = if now.month() == 1 {
            (now.year() - 1, 12u32)
        } else {
            (now.year(), now.month() - 1)
        };

        let current_month_usd = self.fetch_month_spend(
            &token,
            &payload.project_id,
            &payload.dataset_id,
            &payload.table_name,
            now.year(),
            now.month()
        ).await?;

        let previous_month_usd = self.fetch_month_spend(
            &token,
            &payload.project_id,
            &payload.dataset_id,
            &payload.table_name,
            prev_year,
            prev_month
        ).await?;

        Ok(SpendData {
            current_month_usd,
            previous_month_usd,
            last_activity_at: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_bigquery_identifiers() {
        assert!(validate_bq_identifier("project_id", "my-gcp-project_123").is_ok());
        assert!(validate_bq_identifier("dataset_id", "billing_export").is_ok());
        assert!(validate_bq_identifier("table_name", "gcp_billing_export_v1").is_ok());
    }

    #[test]
    fn rejects_empty_bigquery_identifiers() {
        let err = validate_bq_identifier("project_id", "").unwrap_err();
        assert!(matches!(err, ConnectorError::Config(_)));
        assert_eq!(
            err.to_string(),
            "configuration error: Invalid GCP project_id: must be 1-1024 characters"
        );
    }

    #[test]
    fn rejects_bigquery_identifiers_with_invalid_characters() {
        let err = validate_bq_identifier("table_name", "billing`; DROP TABLE foo;--").unwrap_err();
        assert!(matches!(err, ConnectorError::Config(_)));
        assert_eq!(
            err.to_string(),
            "configuration error: Invalid GCP table_name: only letters, numbers, underscores, and hyphens are allowed"
        );
    }

    #[test]
    fn builds_valid_invoice_months() {
        assert_eq!(validate_invoice_month(2026, 4).unwrap(), "202604");
    }

    #[test]
    fn rejects_invalid_invoice_months() {
        let err = validate_invoice_month(2026, 13).unwrap_err();
        assert!(matches!(err, ConnectorError::Config(_)));
        assert_eq!(
            err.to_string(),
            "configuration error: Invalid invoice month: month must be between 01 and 12"
        );
    }
}

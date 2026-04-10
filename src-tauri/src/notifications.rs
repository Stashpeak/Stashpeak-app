use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::{db, settings};

struct PendingNotification {
    subscription_id: i64,
    billing_date: String,
    name: String,
    currency: String,
    cost: f64,
    billing_period: String,
    days_until: i64,
}

pub fn check_and_notify(app: &AppHandle) {
    let enabled = match settings::get_notifications_enabled() {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("failed to read notifications_enabled: {e}");
            return;
        }
    };
    if !enabled {
        return;
    }

    let days = match settings::get_notification_days_before() {
        Ok(d) => d,
        Err(e) => {
            tracing::error!("failed to read notification settings: {e}");
            return;
        }
    };

    let conn = match db::connect() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("failed to open DB for notification check: {e}");
            return;
        }
    };

    // Find subscriptions renewing between today and `days` days from now (inclusive).
    // Using <= instead of = means missed days are caught on the next app open.
    // Use 'localtime' so comparisons match dates as the user sees them on their system.
    let date_expr = if days == 0 {
        "date('now', 'localtime')".to_string()
    } else {
        format!("date('now', 'localtime', '+{days} days')")
    };

    let query = format!(
        r#"
        SELECT s.id, s.next_billing_at, s.name, s.currency, s.monthly_cost, s.billing_period,
               CAST(julianday(date(s.next_billing_at)) - julianday(date('now', 'localtime')) AS INTEGER) AS days_until
        FROM subscriptions s
        WHERE s.next_billing_at IS NOT NULL
          AND date(s.next_billing_at) >= date('now', 'localtime')
          AND date(s.next_billing_at) <= {date_expr}
          AND NOT EXISTS (
              SELECT 1 FROM notification_log nl
              WHERE nl.subscription_id = s.id
                AND nl.billing_date = s.next_billing_at
          )
        "#
    );

    let mut stmt = match conn.prepare(&query) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("failed to prepare notification query: {e}");
            return;
        }
    };

    let pending: Vec<PendingNotification> = match stmt.query_map([], |row| {
        Ok(PendingNotification {
            subscription_id: row.get(0)?,
            billing_date: row.get(1)?,
            name: row.get(2)?,
            currency: row.get(3)?,
            cost: row.get(4)?,
            billing_period: row.get(5)?,
            days_until: row.get(6)?,
        })
    }) {
        Ok(rows) => rows.filter_map(|r| r.ok()).collect(),
        Err(e) => {
            tracing::error!("failed to query subscriptions for notifications: {e}");
            return;
        }
    };

    for n in pending {
        let when = match n.days_until {
            0 => "today".to_string(),
            1 => "in 1 day".to_string(),
            d => format!("in {d} days"),
        };
        let body = format!(
            "{} renews {} — {} {:.2}/{}",
            n.name, when, n.currency, n.cost, n.billing_period,
        );

        match app.notification().builder().title("Stashpeak").body(&body).show() {
            Ok(_) => {
                tracing::info!("notification sent for subscription {} ({})", n.subscription_id, n.name);
            }
            Err(e) => {
                tracing::error!("failed to send notification for {}: {e}", n.name);
                continue;
            }
        }

        // Log so we don't notify again for this billing cycle.
        if let Err(e) = conn.execute(
            "INSERT OR IGNORE INTO notification_log (subscription_id, billing_date) VALUES (?1, ?2)",
            rusqlite::params![n.subscription_id, n.billing_date],
        ) {
            tracing::error!("failed to log notification for {}: {e}", n.name);
        }
    }
}

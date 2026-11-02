//! Schedule calculation helpers.

use super::types::{CronJob, CronSchedule};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use chrono::{DateTime, Local, TimeZone, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use std::str::FromStr;

pub(super) fn validate_schedule(
    schedule: &CronSchedule,
    created_at_ms: i64,
) -> OpenBitFunResult<()> {
    let _ = compute_next_run_after_ms(schedule, created_at_ms, created_at_ms - 1)?;
    Ok(())
}

pub(super) fn compute_initial_next_run_at_ms(
    job: &CronJob,
    now_ms: i64,
) -> OpenBitFunResult<Option<i64>> {
    match &job.schedule {
        CronSchedule::At { .. } => {
            if job.state.last_enqueued_at_ms.is_some() || job.state.active_turn_id.is_some() {
                return Ok(None);
            }

            parse_at_timestamp_ms(&job.schedule).map(Some)
        }
        _ => compute_next_run_after_ms(&job.schedule, job.created_at_ms, now_ms),
    }
}

pub(super) fn compute_next_run_after_ms(
    schedule: &CronSchedule,
    created_at_ms: i64,
    after_ms: i64,
) -> OpenBitFunResult<Option<i64>> {
    match schedule {
        CronSchedule::At { .. } => {
            let at_ms = parse_at_timestamp_ms(schedule)?;
            if at_ms > after_ms {
                Ok(Some(at_ms))
            } else {
                Ok(None)
            }
        }
        CronSchedule::Every {
            every_ms,
            anchor_ms,
        } => compute_every_next_run_ms(*every_ms, anchor_ms.unwrap_or(created_at_ms), after_ms)
            .map(Some),
        CronSchedule::Cron { expr, tz } => {
            compute_cron_next_run_ms(expr, tz.as_deref(), after_ms).map(Some)
        }
    }
}

fn parse_at_timestamp_ms(schedule: &CronSchedule) -> OpenBitFunResult<i64> {
    let CronSchedule::At { at } = schedule else {
        return Err(OpenBitFunError::validation(
            "parse_at_timestamp_ms requires an 'at' schedule",
        ));
    };

    let parsed = DateTime::parse_from_rfc3339(at).map_err(|error| {
        OpenBitFunError::validation(format!("Invalid ISO-8601 timestamp '{}': {}", at, error))
    })?;
    Ok(parsed.timestamp_millis())
}

fn compute_every_next_run_ms(
    every_ms: u64,
    anchor_ms: i64,
    after_ms: i64,
) -> OpenBitFunResult<i64> {
    if every_ms == 0 {
        return Err(OpenBitFunError::validation(
            "Recurring schedule everyMs must be greater than 0",
        ));
    }

    if anchor_ms > after_ms {
        return Ok(anchor_ms);
    }

    let interval = i128::from(every_ms);
    let anchor = i128::from(anchor_ms);
    let after = i128::from(after_ms);
    let steps = ((after - anchor) / interval) + 1;
    let next = anchor + (steps * interval);

    i64::try_from(next).map_err(|_| {
        OpenBitFunError::service("Recurring schedule next run timestamp overflowed i64")
    })
}

fn compute_cron_next_run_ms(expr: &str, tz: Option<&str>, after_ms: i64) -> OpenBitFunResult<i64> {
    let normalized_expr = normalize_cron_expr(expr)?;
    let schedule = Schedule::from_str(&normalized_expr).map_err(|error| {
        OpenBitFunError::validation(format!("Invalid cron expression '{}': {}", expr, error))
    })?;

    match tz {
        Some(tz_name) => {
            let timezone = parse_timezone(tz_name)?;
            let after = timezone
                .timestamp_millis_opt(after_ms)
                .single()
                .ok_or_else(|| {
                    OpenBitFunError::validation(format!(
                        "Unable to interpret timestamp {} in timezone {}",
                        after_ms, tz_name
                    ))
                })?;

            schedule
                .after(&after)
                .next()
                .map(|next| next.with_timezone(&Utc).timestamp_millis())
                .ok_or_else(|| {
                    OpenBitFunError::validation(format!(
                        "Cron expression '{}' produced no future run time",
                        expr
                    ))
                })
        }
        None => {
            let after = Local
                .timestamp_millis_opt(after_ms)
                .single()
                .ok_or_else(|| {
                    OpenBitFunError::validation(format!(
                        "Unable to interpret local timestamp {}",
                        after_ms
                    ))
                })?;

            schedule
                .after(&after)
                .next()
                .map(|next| next.with_timezone(&Utc).timestamp_millis())
                .ok_or_else(|| {
                    OpenBitFunError::validation(format!(
                        "Cron expression '{}' produced no future run time",
                        expr
                    ))
                })
        }
    }
}

fn parse_timezone(tz_name: &str) -> OpenBitFunResult<Tz> {
    Tz::from_str(tz_name).map_err(|error| {
        OpenBitFunError::validation(format!("Invalid timezone '{}': {}", tz_name, error))
    })
}

fn normalize_cron_expr(expr: &str) -> OpenBitFunResult<String> {
    let fields = expr.split_whitespace().collect::<Vec<_>>();
    match fields.len() {
        5 => Ok(format!("0 {}", expr)),
        6 | 7 => Ok(expr.to_string()),
        other => Err(OpenBitFunError::validation(format!(
            "Cron expression '{}' must contain 5, 6, or 7 fields, found {}",
            expr, other
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::cron::{CronJobPayload, CronJobState, CronJobTarget, CronWorkspaceRef};

    fn sample_job(schedule: CronSchedule) -> CronJob {
        CronJob {
            id: "cron_test".to_string(),
            name: "test".to_string(),
            schedule,
            payload: CronJobPayload {
                text: "hello".to_string(),
            },
            enabled: true,
            target: CronJobTarget::Session {
                session_id: "session_1".to_string(),
                workspace: CronWorkspaceRef {
                    workspace_id: None,
                    workspace_path: "E:/workspace".to_string(),
                    project_workspace_path: None,
                    execution_target: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                },
            },
            created_at_ms: 1_700_000_000_000,
            config_updated_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_000,
            state: CronJobState::default(),
            report_policy: Default::default(),
        }
    }

    #[test]
    fn every_schedule_keeps_anchor_alignment() {
        let next = compute_next_run_after_ms(
            &CronSchedule::Every {
                every_ms: 60_000,
                anchor_ms: Some(1_000),
            },
            1_000,
            181_000,
        )
        .expect("next run");

        assert_eq!(next, Some(241_000));
    }

    #[test]
    fn initial_at_schedule_runs_even_if_time_has_passed() {
        let mut job = sample_job(CronSchedule::At {
            at: "2026-03-17T08:00:00+08:00".to_string(),
        });
        job.created_at_ms = 1_763_667_200_000;

        let next = compute_initial_next_run_at_ms(&job, 1_763_700_000_000).expect("initial next");
        assert_eq!(next, Some(1_773_705_600_000));
    }

    #[test]
    fn cron_schedule_respects_timezone() {
        let after_ms = Utc
            .with_ymd_and_hms(2026, 3, 17, 0, 30, 0)
            .single()
            .expect("valid datetime")
            .timestamp_millis();

        let next = compute_next_run_after_ms(
            &CronSchedule::Cron {
                expr: "0 8 * * *".to_string(),
                tz: Some("Asia/Shanghai".to_string()),
            },
            after_ms,
            after_ms,
        )
        .expect("cron next");

        let expected = Utc
            .with_ymd_and_hms(2026, 3, 18, 0, 0, 0)
            .single()
            .expect("valid datetime")
            .timestamp_millis();

        assert_eq!(next, Some(expected));
    }
}

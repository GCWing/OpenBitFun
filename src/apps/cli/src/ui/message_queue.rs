//! Keyboard presentation of the execution host's queue; no local scheduling.
use crate::ui::theme::{StyleKind, Theme};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use openbitfun_runtime_ports::{
    DialogQueueAction, DialogQueueRequest, DialogQueueSnapshot, DialogQueueStatus,
};
use ratatui::{
    layout::Rect,
    style::Style,
    text::{Line, Span},
    widgets::{Clear, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};

pub(crate) enum QueueAction {
    None,
    Close,
    Refresh,
    Request(DialogQueueRequest),
}

pub(super) struct MessageQueueState {
    pub(super) visible: bool,
    pub(super) generation: u64,
    snapshot: Option<DialogQueueSnapshot>,
    list: ListState,
    error: Option<String>,
    busy: bool,
}
impl MessageQueueState {
    pub(super) fn new() -> Self {
        Self {
            generation: 0,
            visible: false,
            snapshot: None,
            list: ListState::default(),
            error: None,
            busy: false,
        }
    }
    pub(super) fn show(&mut self) {
        let generation = self.generation.wrapping_add(1);
        *self = Self::new();
        self.generation = generation;
        self.visible = true;
    }
    pub(super) fn can_auto_refresh(&self) -> bool {
        self.visible && !self.busy && self.error.is_none()
    }
    pub(super) fn loading(&mut self) {
        self.busy = true;
    }
    pub(super) fn update(&mut self, result: Result<DialogQueueSnapshot, String>) {
        self.busy = false;
        match result {
            Ok(snapshot) => {
                let selected = self
                    .snapshot
                    .as_ref()
                    .and_then(|s| s.items.get(self.list.selected()?))
                    .map(|i| i.turn_id.clone());
                let next = selected
                    .and_then(|id| snapshot.items.iter().position(|i| i.turn_id == id))
                    .unwrap_or(0);
                self.list
                    .select((!snapshot.items.is_empty()).then_some(next));
                self.snapshot = Some(snapshot);
                self.error = None;
            }
            Err(error) => self.error = Some(error),
        }
    }
    pub(super) fn handle_key(&mut self, key: KeyEvent) -> QueueAction {
        if key.code == KeyCode::Esc {
            return QueueAction::Close;
        }
        if self.busy {
            return QueueAction::None;
        }
        if key.code == KeyCode::Char('r') {
            return QueueAction::Refresh;
        }
        let Some(snapshot) = self.snapshot.as_ref() else {
            return QueueAction::None;
        };
        let Some(index) = self.list.selected().filter(|i| *i < snapshot.items.len()) else {
            return QueueAction::None;
        };
        let item = &snapshot.items[index];
        let delta = match key.code {
            KeyCode::Up => -1,
            KeyCode::Down => 1,
            _ => 0,
        };
        if delta != 0 && !key.modifiers.contains(KeyModifiers::SHIFT) {
            self.list.select(Some(
                (index as isize + delta).clamp(0, snapshot.items.len() as isize - 1) as usize,
            ));
            return QueueAction::None;
        }
        if self.error.is_some()
            || !matches!(
                item.status,
                DialogQueueStatus::Queued | DialogQueueStatus::Blocked
            )
        {
            return QueueAction::None;
        }
        let operation_id = uuid::Uuid::new_v4().to_string();
        let action = if delta != 0 {
            if snapshot.supports_reorder != Some(true) || item.status != DialogQueueStatus::Queued {
                return QueueAction::None;
            }
            let movable: Vec<_> = snapshot
                .items
                .iter()
                .filter(|i| i.status == DialogQueueStatus::Queued)
                .collect();
            let position = movable
                .iter()
                .position(|i| i.turn_id == item.turn_id)
                .unwrap();
            if (delta < 0 && position == 0) || (delta > 0 && position + 1 == movable.len()) {
                return QueueAction::None;
            }
            DialogQueueAction::Reorder {
                turn_id: item.turn_id.clone(),
                before_turn_id: if delta < 0 {
                    Some(movable[position - 1].turn_id.clone())
                } else {
                    movable.get(position + 2).map(|i| i.turn_id.clone())
                },
                operation_id,
                expected_revision: snapshot.revision,
            }
        } else {
            match key.code {
                KeyCode::Enter => DialogQueueAction::Promote {
                    turn_id: item.turn_id.clone(),
                    operation_id,
                    expected_active_turn_id: snapshot.active_turn_id.clone(),
                },
                KeyCode::Delete => DialogQueueAction::Cancel {
                    turn_id: item.turn_id.clone(),
                    operation_id,
                },
                _ => return QueueAction::None,
            }
        };
        QueueAction::Request(DialogQueueRequest {
            session_id: snapshot.session_id.clone(),
            queue_epoch: Some(snapshot.queue_epoch.clone()),
            action,
        })
    }
    pub(super) fn render(&mut self, frame: &mut Frame, area: Rect, theme: &Theme) {
        if !self.visible {
            return;
        }
        if area.width < 40 || area.height < 10 {
            frame.render_widget(Clear, area);
            frame.render_widget(
                Paragraph::new("Enlarge terminal to view the queue. Esc closes.")
                    .style(theme.style(StyleKind::Muted))
                    .wrap(Wrap { trim: true }),
                area,
            );
            return;
        }
        let width = area.width.saturating_sub(4).min(88);
        let count = self.snapshot.as_ref().map_or(0, |s| s.items.len());
        let height = (count as u16 * 2 + 6).max(8).min(area.height);
        let popup = Rect::new(
            area.x + (area.width - width) / 2,
            area.y + (area.height - height) / 2,
            width,
            height,
        );
        frame.render_widget(Clear, popup);
        frame.render_widget(
            Paragraph::new("").style(Style::default().bg(theme.background)),
            popup,
        );
        let inner = Rect::new(popup.x + 2, popup.y, width - 4, height);
        frame.render_widget(
            Paragraph::new(format!(
                "Queued messages · {count}{}",
                if self.busy { " · Updating…" } else { "" }
            ))
            .style(theme.style(StyleKind::Primary)),
            Rect { height: 1, ..inner },
        );
        let items = self
            .snapshot
            .as_ref()
            .map(|s| {
                s.items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        let preview = item
                            .display_content
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ");
                        let suffix = if item.attachment_count > 0 {
                            format!("  +{} attachments", item.attachment_count)
                        } else {
                            String::new()
                        };
                        let status = if item.status == DialogQueueStatus::Queued {
                            ""
                        } else {
                            "  [waiting]"
                        };
                        ListItem::new(vec![
                            Line::from(Span::styled(
                                format!("  {}", "─".repeat(inner.width.saturating_sub(2) as usize)),
                                theme.style(StyleKind::Muted),
                            )),
                            Line::from(vec![
                                Span::raw(if self.list.selected() == Some(index) {
                                    "› "
                                } else {
                                    "  "
                                }),
                                Span::raw(preview),
                                Span::styled(
                                    format!("{suffix}{status}"),
                                    theme.style(StyleKind::Muted),
                                ),
                            ])
                            .style(
                                if self.list.selected() == Some(index) {
                                    Style::default()
                                        .bg(theme.primary)
                                        .fg(theme.selection_foreground())
                                } else {
                                    Style::default()
                                },
                            ),
                        ])
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        frame.render_stateful_widget(
            List::new(items),
            Rect::new(inner.x, inner.y + 2, inner.width, height.saturating_sub(6)),
            &mut self.list,
        );
        let notice = self.error.as_deref().unwrap_or_else(|| {
            if self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.supports_reorder != Some(true))
            {
                "Reordering requires an updated execution host."
            } else if count == 0 {
                "No queued messages"
            } else {
                "Order is confirmed by the execution host."
            }
        });
        frame.render_widget(
            Paragraph::new(notice)
                .style(theme.style(StyleKind::Muted))
                .wrap(Wrap { trim: true }),
            Rect::new(inner.x, inner.y + height - 4, inner.width, 2),
        );
        frame.render_widget(
            Paragraph::new("↑↓ Select  ⇧↑↓ Move  ↵ Send now\nDel Remove  r Refresh  Esc Close")
                .style(theme.style(StyleKind::Muted)),
            Rect::new(inner.x, inner.y + height - 2, inner.width, 2),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> MessageQueueState {
        let mut state = MessageQueueState::new();
        state.show();
        state.update(Ok(serde_json::from_value(serde_json::json!({"sessionId":"s","queueEpoch":"e","revision":7,"activeTurnId":"active","supportsReorder":true,"capacity":10,"used":2,"receipt":null,"items":[
            {"turnId":"a","displayContent":"First","previewTruncated":false,"attachmentCount":0,"agentType":"Standard","createdAtMs":0,"status":"queued","reason":null,"targetTurnId":null,"steeringId":null},
            {"turnId":"b","displayContent":"Second","previewTruncated":false,"attachmentCount":0,"agentType":"Standard","createdAtMs":0,"status":"queued","reason":null,"targetTurnId":null,"steeringId":null}
        ]})).unwrap()));
        state
    }
    #[test]
    fn message_queue_moves_use_observed_revision_and_keep_order_until_receipt() {
        let mut state = state();
        let QueueAction::Request(request) =
            state.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT))
        else {
            panic!("move");
        };
        assert_eq!(request.queue_epoch.as_deref(), Some("e"));
        assert!(
            matches!(request.action, DialogQueueAction::Reorder { ref turn_id, before_turn_id: None, expected_revision: 7, .. } if turn_id == "a")
        );
        assert_eq!(state.snapshot.unwrap().items[0].turn_id, "a");
    }
    #[test]
    fn message_queue_render_keeps_inset_separators_and_keyboard_help() {
        for width in [40, 80] {
            let mut state = state();
            let backend = ratatui::backend::TestBackend::new(width, 18);
            let mut terminal = ratatui::Terminal::new(backend).unwrap();
            terminal
                .draw(|frame| state.render(frame, frame.area(), &Theme::dark()))
                .unwrap();
            let buffer = terminal.backend().buffer();
            let rows: Vec<String> = (0..18)
                .map(|y| (0..width).map(|x| buffer[(x, y)].symbol()).collect())
                .collect();
            let first = rows.iter().position(|r| r.contains("First")).unwrap();
            let second = rows.iter().position(|r| r.contains("Second")).unwrap();
            assert!(rows[first].contains("› First"));
            assert!(rows[first - 1].contains('─'));
            assert!(rows[second - 1].contains('─'));
            assert!(!rows[second + 1].contains('─'));
            assert!(rows.iter().any(|r| r.contains("⇧↑↓ Move")));
            assert!(rows.iter().any(|r| r.contains("Esc Close")));
            if width == 80 {
                println!(
                    "QUEUE_PREVIEW_BEGIN\n{}\nQUEUE_PREVIEW_END",
                    rows.join("\n")
                );
            }
        }
    }
    #[test]
    fn message_queue_errors_require_refresh_and_legacy_hosts_cannot_move() {
        let mut state = state();
        assert!(state.can_auto_refresh());
        state.update(Err("Outcome unknown; refresh before retrying".into()));
        assert!(!state.can_auto_refresh());
        assert!(matches!(
            state.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE)),
            QueueAction::None
        ));
        assert!(matches!(
            state.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::NONE)),
            QueueAction::Refresh
        ));
        state.error = None;
        state.snapshot.as_mut().unwrap().supports_reorder = None;
        assert!(matches!(
            state.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::SHIFT)),
            QueueAction::None
        ));
    }
}

pub(crate) enum MouseGestureOutcome {
    None,
    Click(u16, u16),
    CopyText(String),
}

impl ChatView {
    /// Take the pending command (set by mouse click on command menu)
    pub(crate) fn take_pending_command(
        &mut self,
    ) -> Option<crate::ui::command_menu::CommandMenuSelection> {
        self.pending_command.take()
    }

    /// Take the pending theme selection (set by mouse click on theme selector)
    pub(crate) fn take_pending_theme_preview(&mut self) -> Option<ThemeItem> {
        self.pending_theme_preview.take()
    }

    pub(crate) fn take_pending_skill_action(&mut self) -> Option<SkillSelectorAction> {
        self.pending_skill_action.take()
    }

    pub(crate) fn take_pending_agent_action(&mut self) -> Option<AgentSelectorAction> {
        self.pending_agent_action.take()
    }

    pub(crate) fn take_pending_subagent_action(&mut self) -> Option<SubagentSelectorAction> {
        self.pending_subagent_action.take()
    }

    pub(crate) fn handle_mouse_event(&mut self, mouse: &crossterm::event::MouseEvent) -> bool {
        // Popups take priority when visible
        if self.fork_selector.is_visible()
            || self.timeline_selector.is_visible()
            || self.prompt_stash_selector.is_visible()
            || self.message_queue_visible()
        {
            // These conversation-point dialogs are keyboard-driven. Do not let mouse gestures
            // mutate the transcript hidden underneath them.
            return true;
        }
        if self.model_selector.captures_mouse(mouse) {
            self.model_selector.handle_mouse_event(mouse);
            return true;
        }
        if self.theme_selector.captures_mouse(mouse) {
            self.theme_selector.handle_mouse_event(mouse);
            self.pending_theme_preview = self.theme_selector.selected_item().cloned();
            return true;
        }
        if self.agent_selector.captures_mouse(mouse) {
            if let Some(action) = self.agent_selector.handle_mouse_event(mouse) {
                self.pending_agent_action = Some(action);
            }
            return true;
        }
        if self.session_selector.captures_mouse(mouse) {
            self.session_selector.handle_mouse_event(mouse);
            return true;
        }
        if self.skill_selector.captures_mouse(mouse) {
            if let Some(action) = self.skill_selector.handle_mouse_event(mouse) {
                self.pending_skill_action = Some(action);
            }
            return true;
        }
        if self.subagent_selector.captures_mouse(mouse) {
            if let Some(action) = self.subagent_selector.handle_mouse_event(mouse) {
                self.pending_subagent_action = Some(action);
            }
            return true;
        }
        if self.mcp_selector.captures_mouse(mouse) {
            let action = self.mcp_selector.handle_mouse_event(mouse);
            if let McpAction::Toggle(item) = action {
                self.pending_mcp_toggle = Some(item);
            }
            return true;
        }
        if self.command_menu.captures_mouse(mouse) {
            if self.draft_snapshot().has_images() {
                self.status = Some(crate::actions::IMAGE_ATTACHMENTS_REQUIRE_MESSAGE.to_string());
                return true;
            }
            if let Some(cmd) = self.command_menu.handle_mouse_event_with_name(mouse) {
                self.text_input.clear();
                self.refresh_command_menu();
                self.pending_command = Some(cmd);
            }
            return true;
        }
        false
    }

    fn clear_mouse_selection_state(&mut self) {
        self.selection_anchor = None;
        self.selection_focus = None;
        self.selection_mouse_down = None;
        self.selection_dragged = false;
    }

    fn map_mouse_to_selection_point(
        &mut self,
        column: u16,
        row: u16,
        clamp_to_messages_area: bool,
    ) -> Option<TextSelectionPoint> {
        let area = self.messages_area?;
        if area.width == 0 || area.height == 0 || self.visible_plain_lines.is_empty() {
            return None;
        }

        let max_x = area.x.saturating_add(area.width.saturating_sub(1));
        let max_y = area.y.saturating_add(area.height.saturating_sub(1));

        let (x, y) = if clamp_to_messages_area {
            (column.clamp(area.x, max_x), row.clamp(area.y, max_y))
        } else {
            if column < area.x || column > max_x || row < area.y || row > max_y {
                return None;
            }
            (column, row)
        };

        let relative_row = (y - area.y) as usize;
        let list_offset = *self.list_state.offset_mut();
        let mut line = list_offset.saturating_add(relative_row);
        if line >= self.visible_plain_lines.len() {
            line = self.visible_plain_lines.len().saturating_sub(1);
        }

        let relative_col = (x - area.x) as usize;
        let max_col = UnicodeWidthStr::width(self.visible_plain_lines[line].as_str());
        let col = relative_col.min(max_col);

        Some(TextSelectionPoint { line, col })
    }

    fn selection_bounds(&self) -> Option<(TextSelectionPoint, TextSelectionPoint)> {
        let start = self.selection_anchor?;
        let end = self.selection_focus?;
        if (start.line, start.col) <= (end.line, end.col) {
            Some((start, end))
        } else {
            Some((end, start))
        }
    }

    fn display_col_to_byte_idx(s: &str, display_col: usize) -> usize {
        let mut width = 0usize;
        for (idx, ch) in s.char_indices() {
            if width >= display_col {
                return idx;
            }
            let ch_w = UnicodeWidthChar::width(ch).unwrap_or(0);
            if width + ch_w > display_col {
                return idx;
            }
            width += ch_w;
        }
        s.len()
    }

    fn selection_text(&self) -> Option<String> {
        let (start, end) = self.selection_bounds()?;
        if start.line >= self.visible_plain_lines.len()
            || end.line >= self.visible_plain_lines.len()
        {
            return None;
        }

        let mut out: Vec<String> = Vec::new();
        for line_idx in start.line..=end.line {
            let line = &self.visible_plain_lines[line_idx];
            let piece = if start.line == end.line {
                let b0 = Self::display_col_to_byte_idx(line, start.col);
                let b1 = Self::display_col_to_byte_idx(line, end.col);
                line[b0.min(b1)..b0.max(b1)].to_string()
            } else if line_idx == start.line {
                let b0 = Self::display_col_to_byte_idx(line, start.col);
                line[b0..].to_string()
            } else if line_idx == end.line {
                let b1 = Self::display_col_to_byte_idx(line, end.col);
                line[..b1].to_string()
            } else {
                line.clone()
            };
            out.push(piece);
        }

        let text = out.join("\n");
        if text.trim().is_empty() {
            None
        } else {
            Some(text)
        }
    }

    pub(crate) fn begin_mouse_selection(&mut self, column: u16, row: u16) -> bool {
        let Some(point) = self.map_mouse_to_selection_point(column, row, false) else {
            self.clear_mouse_selection_state();
            return false;
        };

        self.selection_anchor = Some(point);
        self.selection_focus = Some(point);
        self.selection_mouse_down = Some((column, row));
        self.selection_dragged = false;
        true
    }

    pub(crate) fn update_mouse_selection(&mut self, column: u16, row: u16) -> bool {
        if self.selection_mouse_down.is_none() {
            return false;
        }

        let Some(point) = self.map_mouse_to_selection_point(column, row, true) else {
            return false;
        };

        if let Some((origin_x, origin_y)) = self.selection_mouse_down {
            if origin_x != column || origin_y != row {
                self.selection_dragged = true;
            }
        }

        self.selection_focus = Some(point);
        true
    }

    pub(crate) fn complete_mouse_selection_or_click(
        &mut self,
        column: u16,
        row: u16,
    ) -> MouseGestureOutcome {
        let Some((origin_x, origin_y)) = self.selection_mouse_down else {
            return MouseGestureOutcome::None;
        };

        let _ = self.update_mouse_selection(column, row);
        let dragged = self.selection_dragged;
        self.selection_mouse_down = None;
        self.selection_dragged = false;

        if dragged {
            let text = self.selection_text();
            self.selection_anchor = None;
            self.selection_focus = None;
            if let Some(text) = text {
                return MouseGestureOutcome::CopyText(text);
            }
            return MouseGestureOutcome::None;
        }

        self.selection_anchor = None;
        self.selection_focus = None;
        MouseGestureOutcome::Click(origin_x, origin_y)
    }

    fn render_mouse_selection_overlay(&mut self, frame: &mut Frame, area: Rect) {
        let Some((start, end)) = self.selection_bounds() else {
            return;
        };
        let dragging =
            self.selection_mouse_down.is_some() && (self.selection_dragged || start != end);
        if !dragging {
            return;
        }

        let list_offset = *self.list_state.offset_mut();
        let visible_rows = area.height as usize;
        if visible_rows == 0 || area.width == 0 {
            return;
        }

        let style =
            ratatui::style::Style::default().add_modifier(ratatui::style::Modifier::REVERSED);

        for line_idx in start.line..=end.line {
            if line_idx < list_offset {
                continue;
            }
            let row = line_idx - list_offset;
            if row >= visible_rows || line_idx >= self.visible_plain_lines.len() {
                continue;
            }

            let line = &self.visible_plain_lines[line_idx];
            let line_width = UnicodeWidthStr::width(line.as_str());

            let (mut col_start, mut col_end) = if start.line == end.line {
                (start.col.min(end.col), start.col.max(end.col))
            } else if line_idx == start.line {
                (start.col, line_width)
            } else if line_idx == end.line {
                (0, end.col)
            } else {
                (0, line_width)
            };

            col_start = col_start.min(area.width as usize);
            col_end = col_end.min(area.width as usize);
            if col_end <= col_start {
                continue;
            }

            let rect = Rect {
                x: area.x.saturating_add(col_start as u16),
                y: area.y.saturating_add(row as u16),
                width: (col_end - col_start) as u16,
                height: 1,
            };
            frame.buffer_mut().set_style(rect, style);
        }
    }

    pub(crate) fn handle_mouse_move(&mut self, _column: u16, row: u16) {
        let area = match self.messages_area {
            Some(a) => a,
            None => return,
        };

        if row < area.y || row >= area.y + area.height {
            self.hovered_thinking_block_id = None;
            return;
        }

        let relative_row = (row - area.y) as usize;
        let list_offset = *self.list_state.offset_mut();
        let absolute_row = list_offset + relative_row;

        // Hover is only tracked while thinking is interactive (Hide mode);
        // in fully-expanded (Show) mode blocks are non-interactive.
        if self.presentation.thinking == crate::config::ThinkingMode::Hide {
            for (block_id, y_start, y_end) in &self.thinking_regions {
                if absolute_row >= *y_start as usize && absolute_row <= *y_end as usize {
                    self.hovered_thinking_block_id = Some(block_id.clone());
                    return;
                }
            }
        }

        self.hovered_thinking_block_id = None;
    }

    /// Handle a mouse click at the given absolute (column, row) coordinates.
    /// Toggles expand/collapse for block tools if the click lands within their region.
    pub(crate) fn handle_mouse_click(&mut self, _column: u16, row: u16) {
        // Convert absolute row to relative row within the messages area
        let area = match self.messages_area {
            Some(a) => a,
            None => return,
        };

        if row < area.y || row >= area.y + area.height {
            return;
        }

        // Calculate the absolute row in the list, accounting for scroll offset
        let relative_row = (row - area.y) as usize;
        let list_offset = *self.list_state.offset_mut();
        let absolute_row = list_offset + relative_row;

        // Check against thinking regions (header line)
        for (block_id, y_start, y_end) in &self.thinking_regions {
            if absolute_row >= *y_start as usize && absolute_row <= *y_end as usize {
                // Per-block expand only applies while thinking defaults to
                // collapsed; in fully-expanded (Show) mode `/thinking` is the
                // sole toggle and clicks are a no-op so manual-expand state
                // is preserved across toggles instead of being polluted.
                if self.presentation.thinking == crate::config::ThinkingMode::Hide {
                    let block_id = block_id.clone();
                    self.thinking_disclosures.toggle(&block_id);
                    self.invalidate_render_cache();
                }
                self.hovered_thinking_block_id = None;
                return;
            }
        }

        // Check against block_tool_regions
        for (tool_id, y_start, y_end) in &self.block_tool_regions {
            if absolute_row >= *y_start as usize && absolute_row <= *y_end as usize {
                let tool_id = tool_id.clone();
                self.tool_disclosures.toggle(&tool_id);
                self.focused_block_tool = Some(tool_id);
                self.invalidate_render_cache();
                break;
            }
        }
    }
}

#[cfg(test)]
mod prompt_stash_mouse_tests {
    use super::*;
    use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

    #[test]
    fn prompt_stash_selector_captures_mouse_before_the_transcript() {
        let directory = tempfile::tempdir().unwrap();
        let store =
            crate::prompt_stash::PromptStashStore::new(directory.path().join("prompt-stash.jsonl"));
        store
            .push(
                &ComposerDraft::from_text("saved prompt"),
                Some("workspace-a"),
                1,
            )
            .unwrap();
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        view.show_prompt_stash_selector(store.list().unwrap());
        let mouse = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 1,
            row: 1,
            modifiers: KeyModifiers::NONE,
        };

        assert!(view.handle_mouse_event(&mouse));
    }
}

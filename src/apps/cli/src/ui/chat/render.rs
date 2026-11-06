fn build_shortcut_display(
    shortcuts: &[(String, &'static str)],
    style: Style,
) -> (Vec<Span<'static>>, String) {
    let mut spans = Vec::new();
    let mut text = String::new();
    for (index, (key, description)) in shortcuts.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" ", style));
            text.push(' ');
        }
        let key_text = format!("[{key}]");
        spans.push(Span::styled(key_text.clone(), style));
        spans.push(Span::styled((*description).to_string(), style));
        text.push_str(&key_text);
        text.push_str(description);
    }
    (spans, text)
}

fn build_shortcut_display_for_width(
    shortcuts: &[(String, &'static str)],
    style: Style,
    max_width: usize,
) -> (Vec<Span<'static>>, String) {
    let (_, full_text) = build_shortcut_display(shortcuts, style);
    if UnicodeWidthStr::width(full_text.as_str()) <= max_width || shortcuts.len() <= 1 {
        return build_shortcut_display(shortcuts, style);
    }

    let last = shortcuts.last().expect("checked non-empty shortcuts");
    let last_width = UnicodeWidthStr::width(format!("[{}]{}", last.0, last.1).as_str());
    let mut used_width = last_width;
    let mut visible = Vec::new();
    for hint in &shortcuts[..shortcuts.len() - 1] {
        let hint_width = UnicodeWidthStr::width(format!("[{}]{}", hint.0, hint.1).as_str());
        if used_width + 1 + hint_width <= max_width {
            visible.push(hint.clone());
            used_width += 1 + hint_width;
        }
    }
    visible.push(last.clone());
    build_shortcut_display(&visible, style)
}

impl ChatView {
    /// Render interface
    pub(crate) fn render(&mut self, frame: &mut Frame, chat_state: &ChatState) {
        let size = frame.area();
        frame.render_widget(
            Block::default().style(Style::default().bg(self.theme.background)),
            size,
        );

        // Dynamic input area height: 2 (borders) + visible content lines, capped at 8+2=10
        let max_input_content_lines: u16 = 8;
        let input_inner_width = size.width.saturating_sub(2); // subtract left+right borders
        let total_visual_lines = self.text_input.visual_line_count(input_inner_width) as u16;
        let content_lines = total_visual_lines.max(1).min(max_input_content_lines);
        let input_height = if self.lineage_inspection_label.is_some() {
            3
        } else {
            content_lines + 2 // +2 for top/bottom borders
        };

        // Calculate shortcuts area height based on content
        let shortcuts_height = Self::calculate_shortcuts_height(
            size.width,
            chat_state,
            self.browse_mode,
            &self.shortcut_hints,
        );
        // Status area can grow for long status messages to avoid horizontal truncation.
        let raw_status_height =
            Self::calculate_status_height(size.width, chat_state, self.status.as_deref());
        // Keep a minimal conversation viewport while allowing status to expand when possible.
        let max_status_height = size
            .height
            .saturating_sub(3 + input_height + shortcuts_height + 3)
            .max(1);
        let status_height = raw_status_height.min(max_status_height);

        // Main layout: header + content + status bar + input + shortcuts
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),                // header
                Constraint::Min(10),                  // messages area
                Constraint::Length(status_height),    // status bar (dynamic)
                Constraint::Length(input_height),     // input area (dynamic)
                Constraint::Length(shortcuts_height), // shortcuts hint (dynamic)
            ])
            .split(size);

        // Render each part
        self.render_header(frame, chunks[0], chat_state);
        self.render_messages(frame, chunks[1], chat_state);
        self.render_status_bar(frame, chunks[2], chat_state);
        if self.lineage_inspection_label.is_some() {
            self.render_lineage_inspection(frame, chunks[3]);
        } else {
            self.render_input(frame, chunks[3], chat_state);
        }
        self.render_command_menu(frame, chunks[1]);
        self.workspace_reference_popup
            .render(frame, chunks[1], &self.theme);
        self.render_model_selector(frame, chunks[1]);
        self.render_agent_selector(frame, chunks[1]);
        self.render_session_selector(frame, chunks[1]);
        self.session_lineage_selector
            .render(frame, chunks[1], &self.theme);
        self.render_fork_selector(frame, chunks[1]);
        self.render_timeline_selector(frame, chunks[1]);
        self.message_queue.render(frame, chunks[1], &self.theme);
        self.prompt_stash_selector
            .render(frame, chunks[1], &self.theme);
        self.export_dialog.render(frame, size, &self.theme);
        self.render_skill_selector(frame, chunks[1]);
        self.render_subagent_selector(frame, chunks[1]);
        self.render_mcp_selector(frame, chunks[1]);
        self.render_mcp_add_dialog(frame, chunks[1]);
        self.render_provider_selector(frame, chunks[1]);
        self.render_model_config_form(frame, chunks[1]);
        self.render_theme_selector(frame, chunks[1]);
        self.render_shortcuts(frame, chunks[4], chat_state);
        self.workspace_diff.render(frame, size, &self.theme);

        // Render permission overlay on top of messages area if active (highest priority)
        if let Some(ref mut prompt) = self.prompt_command_shell_review {
            prompt.render(frame, &self.theme, chunks[1]);
        } else if let Some(ref prompt) = chat_state.permission_prompt {
            render_permission_overlay(frame, prompt, &self.theme, chunks[1]);
        } else if let Some(ref prompt) = chat_state.question_prompt {
            render_question_overlay(frame, prompt, &self.theme, chunks[1]);
        }

        // Command palette overlay (Ctrl+P)
        self.command_palette.render(frame, size, &self.theme);

        // Dedicated login page (full viewport takeover)
        self.login_form.render(frame, size, &self.theme);

        // Info popup overlay (topmost)
        if let Some(ref msg) = self.info_popup {
            let (scroll, max_scroll) = super::widgets::render_info_popup_scrolled(
                frame,
                size,
                msg,
                self.theme.primary,
                self.info_popup_scroll,
            );
            self.info_popup_scroll = scroll;
            self.info_popup_max_scroll = max_scroll;
        }
    }

    fn render_lineage_inspection(&self, frame: &mut Frame, area: Rect) {
        let label = self
            .lineage_inspection_label
            .as_deref()
            .unwrap_or("Subagent");
        frame.render_widget(
            Paragraph::new("Up parent  ←/→ siblings  Esc root")
                .style(self.theme.style(StyleKind::Muted))
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(self.theme.style(StyleKind::Border))
                        .title(format!(" {label} · read-only ")),
                ),
            area,
        );
    }

    fn render_theme_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.theme_selector.render(frame, area, &self.theme);
    }

    /// Render header
    fn render_header(&self, frame: &mut Frame, area: Rect, chat_state: &ChatState) {
        let title = format!(" OpenBitFun CLI v{} ", env!("CARGO_PKG_VERSION"));
        let auto_mode = if chat_state.auto_approve_ask {
            "Auto: on"
        } else {
            "Auto: off"
        };
        let agent_info = format!(" Agent: {} | {} ", chat_state.agent_type, auto_mode);

        let workspace = chat_state
            .workspace
            .as_ref()
            .map(|w| format!("Workspace: {}", w))
            .unwrap_or_else(|| "No workspace".to_string());
        let repository_context = chat_state.workspace_context_label();

        let header = Block::default()
            .borders(Borders::ALL)
            .border_style(self.theme.style(StyleKind::Border))
            .style(Style::default().bg(self.theme.background));

        let title_style = Style::default()
            .fg(self.theme.primary)
            .add_modifier(Modifier::BOLD);

        let text = vec![Line::from(vec![
            Span::styled(&title, title_style),
            Span::raw("  "),
            Span::styled(&agent_info, self.theme.style(StyleKind::Primary)),
            Span::raw("  "),
            Span::styled(repository_context, self.theme.style(StyleKind::Primary)),
            Span::raw("  "),
            Span::styled(&workspace, self.theme.style(StyleKind::Muted)),
        ])];

        let paragraph = Paragraph::new(text)
            .block(header)
            .alignment(Alignment::Center);

        frame.render_widget(paragraph, area);
    }

    fn render_messages(&mut self, frame: &mut Frame, area: Rect, chat_state: &ChatState) {
        let title = if self.browse_mode {
            " Conversation [Browse Mode \u{2195}] ".to_string()
        } else {
            " Conversation ".to_string()
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(self.theme.style(StyleKind::Border))
            .style(Style::default().bg(self.theme.background))
            .title(title);

        let inner = block.inner(area);
        frame.render_widget(block, area);

        // Store messages area for mouse click hit-testing
        self.messages_area = Some(inner);
        // Regions are recalculated each frame for the currently rendered (visible subset) list.
        self.block_tool_regions.clear();
        self.thinking_regions.clear();
        let available_width = inner.width;

        if chat_state.messages.is_empty() {
            let welcome = vec![
                Line::from(""),
                Line::from(Span::styled(
                    "Welcome to OpenBitFun CLI!",
                    self.theme.style(StyleKind::Title),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Enter your request, AI will help you complete programming tasks.",
                    self.theme.style(StyleKind::Info),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "Tip: Use / prefix for quick commands",
                    self.theme.style(StyleKind::Muted),
                )),
            ];

            let paragraph = Paragraph::new(welcome)
                .alignment(Alignment::Center)
                .style(Style::default().bg(self.theme.background))
                .wrap(Wrap { trim: true });

            frame.render_widget(paragraph, inner);
            self.visible_plain_lines.clear();
            self.selection_anchor = None;
            self.selection_focus = None;
            self.selection_mouse_down = None;
            self.selection_dragged = false;
        } else {
            let visible_lines = inner.height as usize;

            // Share one render-cache-backed layout for drawing, scrolling, and timeline jumps.
            let layout = self.ensure_message_layout(chat_state, available_width);
            let total_lines = layout.total_lines;

            // Keep the highlighted timeline point pinned while a running turn grows below it.
            if let Some(message_id) = self.timeline_selector.selected_message_id() {
                if let Some(message_index) = chat_state
                    .messages
                    .iter()
                    .position(|message| message.id == message_id)
                {
                    self.apply_message_jump(&layout.prefix_sum, message_index, visible_lines);
                }
            } else {
                self.maintain_committed_message_anchor(chat_state, &layout, visible_lines);
            }

            if total_lines == 0 {
                return;
            }

            // Reconcile scroll_offset against the freshly computed total_lines.
            // Presentation toggles (e.g. /thinking) invalidate the render cache
            // and shrink total_lines, but leave scroll_offset stale — clamping
            // here prevents the view from being pinned to the top with a frozen
            // scrollbar.
            if self.browse_mode {
                if total_lines <= visible_lines {
                    self.browse_mode = false;
                    self.auto_scroll = true;
                    self.scroll_offset = 0;
                } else {
                    let max_scroll = total_lines.saturating_sub(visible_lines);
                    if self.scroll_offset > max_scroll {
                        self.scroll_offset = max_scroll;
                    }
                }
            }

            // prefix_sum[i] = total lines of messages 0..i (exclusive end).
            let prefix_sum = layout.prefix_sum;

            // ── Step 3: Determine visible line range ──
            let view_start_line = if self.browse_mode {
                if self.scroll_offset >= total_lines {
                    0
                } else {
                    total_lines.saturating_sub(self.scroll_offset + visible_lines)
                }
            } else {
                // Auto-scroll: show bottom
                total_lines.saturating_sub(visible_lines)
            };

            let view_end_line =
                (view_start_line + visible_lines + visible_lines / 2).min(total_lines); // buffer: render half a screen extra

            // ── Step 4: Binary search for visible message range ──
            // Find first message that overlaps [view_start_line, view_end_line)
            let start_msg_idx = match prefix_sum.binary_search(&view_start_line) {
                Ok(i) => i.min(chat_state.messages.len().saturating_sub(1)),
                Err(i) => i.saturating_sub(1),
            };
            let end_msg_idx = match prefix_sum.binary_search(&view_end_line) {
                Ok(i) => i.min(chat_state.messages.len()),
                Err(i) => i.min(chat_state.messages.len()),
            };

            // ── Step 5: Collect ListItems only for visible messages ──
            // We need to include some items before view_start_line from the first
            // visible message (partial message visibility), so we collect from
            // start_msg_idx and let the List widget handle the offset.
            let lines_before_start_msg = prefix_sum[start_msg_idx];
            let offset_within_visible = view_start_line.saturating_sub(lines_before_start_msg);

            let mut messages: Vec<ListItem<'static>> = Vec::new();
            let mut visible_plain_lines: Vec<String> = Vec::new();
            let mut y_cursor: u16 = 0;
            for msg_idx in start_msg_idx..end_msg_idx {
                let msg = &chat_state.messages[msg_idx];
                if let Some(entry) = self.render_cache.get(&msg.id) {
                    messages.extend(entry.items.clone());
                    visible_plain_lines.extend(entry.plain_lines.clone());
                    for (tool_id, y_start, y_end) in &entry.tool_regions {
                        self.block_tool_regions.push((
                            tool_id.clone(),
                            y_cursor.saturating_add(*y_start),
                            y_cursor.saturating_add(*y_end),
                        ));
                    }
                    for (message_id, y_start, y_end) in &entry.thinking_regions {
                        self.thinking_regions.push((
                            message_id.clone(),
                            y_cursor.saturating_add(*y_start),
                            y_cursor.saturating_add(*y_end),
                        ));
                    }
                    y_cursor =
                        y_cursor.saturating_add(entry.items.len().min(u16::MAX as usize) as u16);
                }
            }

            // Apply hover styling (without invalidating per-message render
            // caches). Hover is only shown while thinking is interactive
            // (Hide mode); in fully-expanded (Show) mode blocks are
            // non-interactive so no hover background is applied.
            if self.presentation.thinking == crate::config::ThinkingMode::Hide {
                if let Some(ref hovered_id) = self.hovered_thinking_block_id {
                    for (block_id, y_start, y_end) in &self.thinking_regions {
                        if block_id == hovered_id && y_start == y_end {
                            let idx = *y_start as usize;
                            if idx < messages.len() {
                                messages[idx] = messages[idx]
                                    .clone()
                                    .style(Style::default().bg(self.theme.block_bg_hover));
                            }
                        }
                    }
                }
            }

            self.visible_plain_lines = visible_plain_lines;

            // ── Step 6: Set scroll state ──
            // The List widget receives only the visible subset of items.
            // offset_within_visible tells it how many lines to skip from the top.
            *self.list_state.offset_mut() = offset_within_visible;

            if self.browse_mode {
                let selected_in_subset = offset_within_visible + visible_lines / 2;
                self.list_state.select(Some(
                    selected_in_subset.min(messages.len().saturating_sub(1)),
                ));
            } else if self.auto_scroll {
                self.list_state
                    .select(Some(messages.len().saturating_sub(1)));
                self.scroll_offset = 0;
            }

            // ── Scroll indicator ──
            if self.browse_mode {
                let max_scroll = total_lines.saturating_sub(visible_lines);
                let progress_pct = if max_scroll == 0 {
                    100
                } else {
                    let effective = self.scroll_offset.min(max_scroll);
                    ((max_scroll - effective) * 100 / max_scroll).min(100)
                };

                let scroll_indicator = format!("{}%", progress_pct);
                let indicator_area = Rect {
                    x: inner.x + inner.width.saturating_sub(12),
                    y: inner.y,
                    width: 10,
                    height: 1,
                };

                let indicator_widget = Paragraph::new(scroll_indicator)
                    .style(self.theme.style(StyleKind::Info))
                    .alignment(Alignment::Right);
                frame.render_widget(indicator_widget, indicator_area);
            }

            let list = List::new(messages).highlight_style(Style::default());

            frame.render_stateful_widget(list, inner, &mut self.list_state);
            self.render_mouse_selection_overlay(frame, inner);
        }

        // Note: thinking indicator moved to status bar area (between Conversation and Input)
    }

    /// Render a single message into a list of owned ListItems.
    /// Returns owned items plus message-local clickable regions so results can be cached across frames.
    fn render_message(
        &mut self,
        message: &ChatMessage,
        available_width: u16,
    ) -> MessageRenderResult {
        let mut items: Vec<ListItem<'static>> = Vec::new();
        let mut plain_lines: Vec<String> = Vec::new();
        let mut tool_regions: Vec<(String, u16, u16)> = Vec::new();
        let mut thinking_regions: Vec<(String, u16, u16)> = Vec::new();
        let mut thinking_block_index: usize = 0;

        // Match opencode's TUI style: no explicit "You:" / "Assistant:" prefixes.
        // Instead, differentiate user messages via background color (and a subtle left border).
        let user_bg_style = Style::default().bg(self.theme.background_panel);
        let user_border_style = self
            .theme
            .style(StyleKind::Success)
            .add_modifier(Modifier::BOLD);

        fn blank_line() -> ListItem<'static> {
            ListItem::new(Line::from(Span::raw(String::new())))
        }

        fn user_padding_line(user_bg_style: Style, user_border_style: Style) -> ListItem<'static> {
            ListItem::new(Line::from(vec![
                Span::raw(" ".to_string()),
                Span::styled("\u{258f}".to_string(), user_border_style), // ▏
                Span::raw(" ".to_string()),
            ]))
            .style(user_bg_style)
        }

        fn close_user_bubble(
            items: &mut Vec<ListItem<'static>>,
            plain_lines: &mut Vec<String>,
            open: &mut bool,
            user_bg_style: Style,
            user_border_style: Style,
        ) {
            if *open {
                items.push(user_padding_line(user_bg_style, user_border_style));
                plain_lines.push(" | ".to_string());
                *open = false;
            }
        }

        fn wrap_hard_display_width(s: &str, max_width: usize) -> Vec<String> {
            if max_width == 0 {
                return vec![String::new()];
            }
            if UnicodeWidthStr::width(s) <= max_width {
                return vec![s.to_string()];
            }

            let mut lines: Vec<String> = Vec::new();
            let mut current = String::new();
            let mut current_width = 0usize;

            for ch in s.chars() {
                let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);

                if !current.is_empty() && current_width + ch_width > max_width {
                    lines.push(std::mem::take(&mut current));
                    current_width = 0;
                }

                // Even if a single char is wider than max_width, still render it.
                current.push(ch);
                current_width += ch_width;

                if current_width >= max_width && !current.is_empty() {
                    lines.push(std::mem::take(&mut current));
                    current_width = 0;
                }
            }

            if !current.is_empty() {
                lines.push(current);
            }

            if lines.is_empty() {
                lines.push(String::new());
            }

            lines
        }

        // Top margin between messages (previously provided partly by role/timestamp line).
        items.push(blank_line());
        plain_lines.push(String::new());

        let spinner_frame = self.spinner.current().to_string();
        let mut user_bubble_open = false;

        if !message.flow_items.is_empty() {
            for flow_item in &message.flow_items {
                match flow_item {
                    FlowItem::Text {
                        content,
                        is_streaming,
                    } => {
                        if message.role == MessageRole::Assistant
                            && MarkdownRenderer::has_markdown_syntax(content)
                        {
                            close_user_bubble(
                                &mut items,
                                &mut plain_lines,
                                &mut user_bubble_open,
                                user_bg_style,
                                user_border_style,
                            );
                            let md_width = available_width.saturating_sub(2) as usize;
                            // Use cached render for completed messages, fresh render for streaming
                            let markdown_lines = if message.is_streaming {
                                self.markdown_renderer.render(content, md_width)
                            } else {
                                self.markdown_renderer.render_cached(content, md_width)
                            };

                            for md_line in markdown_lines {
                                let mut spans: Vec<Span<'static>> =
                                    vec![Span::raw("  ".to_string())];
                                spans.extend(md_line.spans);
                                let plain = spans
                                    .iter()
                                    .map(|span| span.content.as_ref())
                                    .collect::<String>();
                                items.push(ListItem::new(Line::from(spans)));
                                plain_lines.push(plain);
                            }
                        } else {
                            if message.role != MessageRole::User {
                                close_user_bubble(
                                    &mut items,
                                    &mut plain_lines,
                                    &mut user_bubble_open,
                                    user_bg_style,
                                    user_border_style,
                                );
                            }
                            for line in content.lines() {
                                if message.role == MessageRole::User {
                                    let max_text_width = available_width.saturating_sub(3) as usize;
                                    let wrapped = wrap_hard_display_width(line, max_text_width);
                                    if !user_bubble_open {
                                        items.push(user_padding_line(
                                            user_bg_style,
                                            user_border_style,
                                        ));
                                        plain_lines.push(" | ".to_string());
                                        user_bubble_open = true;
                                    }
                                    for wrapped_line in wrapped {
                                        let plain = format!(" | {}", wrapped_line);
                                        items.push(
                                            ListItem::new(Line::from(vec![
                                                Span::raw(" ".to_string()),
                                                Span::styled(
                                                    "\u{258f}".to_string(),
                                                    user_border_style,
                                                ), // ▏
                                                Span::raw(" ".to_string()),
                                                Span::raw(wrapped_line),
                                            ]))
                                            .style(user_bg_style),
                                        );
                                        plain_lines.push(plain);
                                    }
                                } else {
                                    let max_text_width = available_width.saturating_sub(2) as usize;
                                    for wrapped_line in
                                        wrap_hard_display_width(line, max_text_width)
                                    {
                                        let plain = format!("  {}", wrapped_line);
                                        items.push(ListItem::new(Line::from(vec![
                                            Span::raw("  ".to_string()),
                                            Span::raw(wrapped_line),
                                        ])));
                                        plain_lines.push(plain);
                                    }
                                }
                            }
                        }

                        if *is_streaming {
                            if message.role == MessageRole::User {
                                if !user_bubble_open {
                                    items.push(user_padding_line(user_bg_style, user_border_style));
                                    plain_lines.push(" | ".to_string());
                                    user_bubble_open = true;
                                }
                                items.push(
                                    ListItem::new(Line::from(vec![
                                        Span::raw(" ".to_string()),
                                        Span::styled("\u{258f}".to_string(), user_border_style), // ▏
                                        Span::raw(" ".to_string()),
                                        Span::styled(
                                            "\u{2588}".to_string(),
                                            self.theme.style(StyleKind::Primary),
                                        ),
                                    ]))
                                    .style(user_bg_style),
                                );
                                plain_lines.push(" | _".to_string());
                            } else {
                                items.push(ListItem::new(Line::from(vec![
                                    Span::raw("  ".to_string()),
                                    Span::styled(
                                        "\u{2588}".to_string(),
                                        self.theme.style(StyleKind::Primary),
                                    ),
                                ])));
                                plain_lines.push("  _".to_string());
                            }
                        }
                    }

                    FlowItem::Thinking { content } => {
                        let thinking_block_id =
                            format!("{}::thinking:{}", message.id, thinking_block_index);
                        thinking_block_index = thinking_block_index.saturating_add(1);

                        close_user_bubble(
                            &mut items,
                            &mut plain_lines,
                            &mut user_bubble_open,
                            user_bg_style,
                            user_border_style,
                        );
                        // Render thinking block with distinct style.
                        let trimmed = content.trim_end();
                        let clean_content = trimmed.trim_end_matches("<thinking_end>").trim_end();

                        // `/thinking` toggles between fully-collapsed and
                        // fully-expanded. Manual per-block expands are only
                        // meaningful in collapsed (Hide) mode; in Show mode
                        // every block is expanded regardless of overrides, so
                        // manually-expanded blocks survive a full toggle
                        // round-trip instead of being inverted by XOR.
                        let collapsed = match self.presentation.thinking {
                            crate::config::ThinkingMode::Show => false,
                            crate::config::ThinkingMode::Hide => self
                                .thinking_disclosures
                                .is_collapsed(&thinking_block_id, true),
                        };
                        // In Show mode the header is non-interactive: hide the
                        // caret so users don't expect to click-collapse an
                        // already fully-expanded block.
                        let caret =
                            if self.presentation.thinking == crate::config::ThinkingMode::Show {
                                ""
                            } else if collapsed {
                                "\u{25b8}"
                            } else {
                                "\u{25be}"
                            };

                        let header_y = items.len().min(u16::MAX as usize) as u16;
                        thinking_regions.push((thinking_block_id.clone(), header_y, header_y));
                        let left_label = if caret.is_empty() {
                            "Thinking".to_string()
                        } else {
                            format!("{} Thinking", caret)
                        };
                        if collapsed {
                            let hint = "click to expand";
                            let indent = "  ";
                            let gap = (available_width as usize)
                                .saturating_sub(indent.width() + left_label.width() + hint.width());
                            let spacer = " ".repeat(gap.max(1));
                            let plain = format!("{}{}{}{}", indent, left_label, spacer, hint);
                            items.push(ListItem::new(Line::from(vec![
                                Span::raw(indent.to_string()),
                                Span::styled(
                                    left_label,
                                    self.theme
                                        .style(StyleKind::Muted)
                                        .add_modifier(Modifier::ITALIC),
                                ),
                                Span::raw(spacer),
                                Span::styled(hint.to_string(), self.theme.style(StyleKind::Muted)),
                            ])));
                            plain_lines.push(plain);
                        } else {
                            let plain = format!("  {}", left_label);
                            items.push(ListItem::new(Line::from(vec![
                                Span::raw("  ".to_string()),
                                Span::styled(
                                    left_label,
                                    self.theme
                                        .style(StyleKind::Muted)
                                        .add_modifier(Modifier::ITALIC),
                                ),
                            ])));
                            plain_lines.push(plain);
                        }

                        let content_lines: Vec<&str> = clean_content.lines().collect();
                        let line_count = content_lines.len();

                        if collapsed {
                            // Collapsed: header only (no extra summary lines)
                        } else if line_count == 0 {
                            items.push(ListItem::new(Line::from(vec![
                                Span::raw("    ".to_string()),
                                Span::styled(
                                    "(empty)".to_string(),
                                    self.theme.style(StyleKind::Muted),
                                ),
                            ])));
                            plain_lines.push("    (empty)".to_string());
                        } else {
                            let thinking_max_width = available_width.saturating_sub(4) as usize; // 4 = indent "    "
                            for line in content_lines {
                                let wrapped = wrap_hard_display_width(line, thinking_max_width);
                                for wl in wrapped {
                                    let plain = format!("    {}", wl);
                                    items.push(ListItem::new(Line::from(vec![
                                        Span::raw("    ".to_string()),
                                        Span::styled(wl, self.theme.style(StyleKind::Muted)),
                                    ])));
                                    plain_lines.push(plain);
                                }
                            }
                        }

                        // Extra spacing so thinking doesn't visually stick to following text/tools.
                        items.push(blank_line());
                        plain_lines.push(String::new());
                    }

                    FlowItem::UserSteering {
                        content,
                        is_pending,
                        ..
                    } => {
                        close_user_bubble(
                            &mut items,
                            &mut plain_lines,
                            &mut user_bubble_open,
                            user_bg_style,
                            user_border_style,
                        );
                        let label = if *is_pending {
                            "You steered (pending)"
                        } else {
                            "You steered"
                        };
                        let prefix = format!("  {label}: ");
                        let content_width = available_width
                            .saturating_sub(prefix.width().min(u16::MAX as usize) as u16)
                            as usize;
                        let mut first_line = true;
                        for line in content.lines() {
                            for wrapped in wrap_hard_display_width(line, content_width.max(1)) {
                                let line_prefix = if first_line {
                                    first_line = false;
                                    prefix.clone()
                                } else {
                                    "  ".to_string()
                                };
                                plain_lines.push(format!("{line_prefix}{wrapped}"));
                                items.push(ListItem::new(Line::from(vec![
                                    Span::styled(line_prefix, self.theme.style(StyleKind::Primary)),
                                    Span::raw(wrapped),
                                ])));
                            }
                        }
                    }

                    FlowItem::Tool { tool_state } => {
                        close_user_bubble(
                            &mut items,
                            &mut plain_lines,
                            &mut user_bubble_open,
                            user_bg_style,
                            user_border_style,
                        );
                        let expanded = !self
                            .tool_disclosures
                            .is_collapsed(&tool_state.tool_id, !self.presentation.tool_details);
                        let focused = self.focused_block_tool.as_ref() == Some(&tool_state.tool_id);
                        let tool_render = crate::ui::tool_cards::render_tool_card(
                            tool_state,
                            &self.theme,
                            expanded,
                            focused,
                            &spinner_frame,
                            available_width,
                        );
                        let y_start = items.len().min(u16::MAX as usize) as u16;
                        items.extend(tool_render.items);
                        plain_lines.extend(tool_render.plain_lines);
                        let y_end = items.len().saturating_sub(1).min(u16::MAX as usize) as u16;
                        tool_regions.push((tool_state.tool_id.clone(), y_start, y_end));
                    }
                }
            }
        } else {
            // Empty flow_items — shouldn't happen normally, but handle gracefully
            items.push(ListItem::new(Line::from(vec![
                Span::raw("  ".to_string()),
                Span::styled("(empty)".to_string(), self.theme.style(StyleKind::Muted)),
            ])));
            plain_lines.push("  (empty)".to_string());
        }

        if message.role == MessageRole::User && self.presentation.timestamps && user_bubble_open {
            if let Some(timestamp) =
                crate::ui::message_time::format_message_timestamp(message.timestamp)
            {
                let plain = format!(" | {timestamp}");
                items.push(
                    ListItem::new(Line::from(vec![
                        Span::raw(" ".to_string()),
                        Span::styled("\u{258f}".to_string(), user_border_style),
                        Span::raw(" ".to_string()),
                        Span::styled(timestamp, self.theme.style(StyleKind::Muted)),
                    ]))
                    .style(user_bg_style),
                );
                plain_lines.push(plain);
            }
        }

        close_user_bubble(
            &mut items,
            &mut plain_lines,
            &mut user_bubble_open,
            user_bg_style,
            user_border_style,
        );

        // Bottom margin between messages (helps tool -> thinking transitions).
        items.push(blank_line());
        plain_lines.push(String::new());

        MessageRenderResult {
            items,
            tool_regions,
            thinking_regions,
            plain_lines,
        }
    }

    /// Render status bar (between Conversation and Input)
    fn render_status_bar(&mut self, frame: &mut Frame, area: Rect, chat_state: &ChatState) {
        if chat_state.is_processing {
            // Show thinking spinner when processing
            self.spinner.tick();
            let loading_text = format!(" {} Thinking...", self.spinner.current());
            let stats_text = context_status_text(chat_state.last_primary_model_usage.as_ref())
                .map(|status| format!("{status} "))
                .unwrap_or_default();

            let padding_len =
                (area.width as usize).saturating_sub(loading_text.len() + stats_text.len());

            let loading_span = Span::styled(loading_text, self.theme.style(StyleKind::Primary));
            let stats_span = Span::styled(stats_text, self.theme.style(StyleKind::Muted));

            let line = Line::from(vec![
                loading_span,
                Span::raw(" ".repeat(padding_len)),
                stats_span,
            ]);

            let paragraph = Paragraph::new(line);
            frame.render_widget(paragraph, area);
        } else {
            let status_text = if let Some(status) = &self.status {
                format!(" {}", status)
            } else {
                format!(" {}", default_chat_status_text(chat_state))
            };

            let paragraph = Paragraph::new(status_text)
                .style(self.theme.style(StyleKind::Muted))
                .alignment(Alignment::Left)
                .wrap(Wrap { trim: true });

            frame.render_widget(paragraph, area);
        }
    }

    fn render_input(&mut self, frame: &mut Frame, area: Rect, chat_state: &ChatState) {
        use super::text_input::TextInputStyle;

        let shell_mode = self.is_shell_mode();
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(self.theme.style(StyleKind::Primary))
            .title(if shell_mode { " SHELL " } else { " Input " });

        let inner = block.inner(area);

        // Render the block border
        frame.render_widget(block, area);

        let style = TextInputStyle {
            first_line_prefix: if shell_mode { "! " } else { "> " },
            continuation_prefix: "  ",
            placeholder: if shell_mode {
                "Enter shell command...".to_string()
            } else {
                "Enter message...".to_string()
            },
            text_style: ratatui::style::Style::default(),
            placeholder_style: self.theme.style(StyleKind::Muted),
        };

        self.text_input
            .render(frame, inner, &style, !chat_state.is_processing);
    }

    fn render_command_menu(&mut self, frame: &mut Frame, area: Rect) {
        self.command_menu.render(frame, area, &self.theme);
    }

    fn render_model_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.model_selector.render(frame, area, &self.theme);
    }

    fn render_agent_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.agent_selector.render(frame, area, &self.theme);
    }

    fn render_session_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.session_selector.render(frame, area, &self.theme);
    }

    fn render_fork_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.fork_selector.render(frame, area, &self.theme);
    }

    fn render_timeline_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.timeline_selector.render(frame, area, &self.theme);
    }

    fn render_skill_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.skill_selector.render(frame, area, &self.theme);
    }

    fn render_subagent_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.subagent_selector.render(frame, area, &self.theme);
    }

    fn render_mcp_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.mcp_selector.render(frame, area, &self.theme);
    }

    fn render_mcp_add_dialog(&mut self, frame: &mut Frame, area: Rect) {
        self.mcp_add_dialog.render(frame, area, &self.theme);
    }

    fn render_provider_selector(&mut self, frame: &mut Frame, area: Rect) {
        self.provider_selector.render(frame, area, &self.theme);
    }

    fn render_model_config_form(&mut self, frame: &mut Frame, area: Rect) {
        self.model_config_form.render(frame, area, &self.theme);
    }

    fn render_shortcuts(&self, frame: &mut Frame, area: Rect, chat_state: &ChatState) {
        let muted = self.theme.style(StyleKind::Muted);

        // Build left side content
        let mode_text = if self.browse_mode {
            " Browse "
        } else {
            " Chat "
        };

        // Build left text for width calculation
        let left_text = format!("{} | Model: {}", mode_text, chat_state.current_model_name);

        // Build left line with proper styling
        let left_spans = vec![
            Span::styled(mode_text, self.theme.style(StyleKind::Primary)),
            Span::styled(" | ", muted),
            Span::styled(format!("Model: {}", chat_state.current_model_name), muted),
        ];

        // Build right side shortcuts with proper styling
        let (full_right_spans, full_right_text) =
            build_shortcut_display(&self.shortcut_hints, muted);

        // Render lines based on available width
        let available_width = area.width as usize;
        let left_line = Line::from(left_spans);
        let full_right_line = Line::from(full_right_spans);

        // Calculate widths using unicode_width
        let left_width = UnicodeWidthStr::width(left_text.as_str());
        let right_width = UnicodeWidthStr::width(full_right_text.as_str());

        let mut lines = Vec::new();

        if left_width + right_width + 2 <= available_width {
            // Both fit on one line: left-align left, right-align right
            let gap = available_width.saturating_sub(left_width + right_width);
            let mut combined_spans = Vec::new();
            combined_spans.extend(left_line.spans);
            combined_spans.push(Span::raw(" ".repeat(gap)));
            combined_spans.extend(full_right_line.spans);
            lines.push(Line::from(combined_spans));
        } else {
            // Need multiple lines: render left and right separately
            let (right_spans, _) =
                build_shortcut_display_for_width(&self.shortcut_hints, muted, available_width);
            lines.push(left_line);
            lines.push(Line::from(right_spans));
        }

        let paragraph = Paragraph::new(lines);
        frame.render_widget(paragraph, area);
    }

    /// Calculate the required height for the shortcuts area
    fn calculate_shortcuts_height(
        available_width: u16,
        chat_state: &ChatState,
        browse_mode: bool,
        shortcut_hints: &[(String, &'static str)],
    ) -> u16 {
        let mode_text = if browse_mode { " Browse " } else { " Chat " };
        let left_text = format!("{} | Model: {}", mode_text, chat_state.current_model_name);

        let (_, right_text) = build_shortcut_display(shortcut_hints, Style::default());

        let left_width = UnicodeWidthStr::width(left_text.as_str());
        let right_width = UnicodeWidthStr::width(right_text.as_str());

        // If both fit on one line (with at least 2 spaces gap), height is 1
        if left_width + right_width + 2 <= available_width as usize {
            1
        } else {
            // Otherwise, need 2 lines
            2
        }
    }

    fn calculate_status_height(
        available_width: u16,
        chat_state: &ChatState,
        status: Option<&str>,
    ) -> u16 {
        if chat_state.is_processing {
            return 1;
        }
        if available_width == 0 {
            return 1;
        }

        let status_text = if let Some(status_text) = status {
            format!(" {}", status_text)
        } else {
            format!(" {}", default_chat_status_text(chat_state))
        };

        let width = available_width as usize;
        let mut lines = 0usize;
        for raw_line in status_text.lines() {
            let line_width = UnicodeWidthStr::width(raw_line);
            lines += ((line_width + width.saturating_sub(1)) / width).max(1);
        }
        if lines == 0 {
            lines = 1;
        }

        lines as u16
    }
}

#[cfg(test)]
mod shortcut_contract_tests {
    use super::*;
    use crate::actions::{ActionState, ResolvedKeymap};
    use crate::config::ShortcutsConfig;
    use ratatui::style::Color;

    #[test]
    fn chat_shortcuts_keep_visible_order_and_muted_style() {
        let muted = Style::default().fg(Color::DarkGray);

        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());
        let shortcuts = keymap.compact_hints(ActionState::chat(false, false));
        let (spans, text) = build_shortcut_display(&shortcuts, muted);

        assert_eq!(
            text,
            "[Tab]Switch Agent [Alt+↵]Newline [Ctrl+P]Commands [↑↓]History [Ctrl+E]Browse [Ctrl+C]Quit"
        );
        assert_eq!(
            spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<Vec<_>>(),
            [
                "[Tab]",
                "Switch Agent",
                " ",
                "[Alt+↵]",
                "Newline",
                " ",
                "[Ctrl+P]",
                "Commands",
                " ",
                "[↑↓]",
                "History",
                " ",
                "[Ctrl+E]",
                "Browse",
                " ",
                "[Ctrl+C]",
                "Quit",
            ]
        );
        assert!(spans.iter().all(|span| span.style == muted));
    }

    #[test]
    fn shortcut_registry_contract_footer_uses_resolved_keymap() {
        let shortcuts = ResolvedKeymap::new(&ShortcutsConfig::default())
            .compact_hints(ActionState::chat(false, false));
        let (_, text) = build_shortcut_display(&shortcuts, Style::default());
        assert!(text.contains("[Ctrl+P]Commands"));
    }

    #[test]
    fn processing_footer_shows_interrupt_without_quit() {
        let shortcuts = ResolvedKeymap::new(&ShortcutsConfig::default())
            .compact_hints(ActionState::chat(true, false));
        let (_, text) = build_shortcut_display(&shortcuts, Style::default());

        assert!(text.contains("[Esc]Interrupt"));
        assert!(!text.contains("Quit"));
        assert!(!text.contains("Switch Agent"));
    }

    #[test]
    fn narrow_footer_keeps_the_recovery_hint_visible() {
        let idle = ResolvedKeymap::new(&ShortcutsConfig::default())
            .compact_hints(ActionState::chat(false, false));
        let (_, idle_text) = build_shortcut_display_for_width(&idle, Style::default(), 80);
        assert!(idle_text.contains("[Ctrl+C]Quit"), "{idle_text}");
        assert!(UnicodeWidthStr::width(idle_text.as_str()) <= 80);

        let processing = ResolvedKeymap::new(&ShortcutsConfig::default())
            .compact_hints(ActionState::chat(true, false));
        let (_, processing_text) =
            build_shortcut_display_for_width(&processing, Style::default(), 80);
        assert!(
            processing_text.contains("[Esc]Interrupt"),
            "{processing_text}"
        );
        assert!(UnicodeWidthStr::width(processing_text.as_str()) <= 80);
    }

    #[test]
    fn opencode_hidden_thinking_default_is_stable_while_streaming() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        let message = ChatMessage {
            id: "assistant-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            role: MessageRole::Assistant,
            timestamp: std::time::SystemTime::now(),
            flow_items: vec![FlowItem::Thinking {
                content: "private streaming reasoning".to_string(),
            }],
            is_streaming: true,
            version: 1,
        };

        let rendered = view.render_message(&message, 80);
        let plain = rendered.plain_lines.join("\n");

        assert!(plain.contains("Thinking"), "{plain}");
        assert!(plain.contains("click to expand"), "{plain}");
        assert!(!plain.contains("private streaming reasoning"), "{plain}");
    }

    #[test]
    fn thinking_toggle_keeps_manual_expand_across_round_trip() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        // Two thinking blocks in one message: block 0 will be manually
        // expanded, block 1 stays collapsed by default.
        let message = ChatMessage {
            id: "assistant-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            role: MessageRole::Assistant,
            timestamp: std::time::SystemTime::now(),
            flow_items: vec![
                FlowItem::Thinking {
                    content: "reasoning-alpha".to_string(),
                },
                FlowItem::Thinking {
                    content: "reasoning-beta".to_string(),
                },
            ],
            is_streaming: false,
            version: 1,
        };

        // Default Hide: both collapsed (header only).
        let plain = view.render_message(&message, 80).plain_lines.join("\n");
        assert!(plain.contains("click to expand"), "{plain}");
        assert!(!plain.contains("reasoning-alpha"), "{plain}");
        assert!(!plain.contains("reasoning-beta"), "{plain}");

        // Manually expand block 0; block 1 stays collapsed.
        view.toggle_thinking_block_for_test("assistant-1", 0);
        let plain = view.render_message(&message, 80).plain_lines.join("\n");
        assert!(plain.contains("reasoning-alpha"), "{plain}");
        assert!(!plain.contains("reasoning-beta"), "{plain}");

        // `/thinking` → fully expanded: both blocks visible (spec 1).
        view.toggle_thinking();
        let plain = view.render_message(&message, 80).plain_lines.join("\n");
        assert!(plain.contains("reasoning-alpha"), "{plain}");
        assert!(plain.contains("reasoning-beta"), "{plain}");

        // `/thinking` back → Hide default: manual expand persists for block 0
        // while block 1 collapses again (spec 2).
        view.toggle_thinking();
        let plain = view.render_message(&message, 80).plain_lines.join("\n");
        assert!(plain.contains("reasoning-alpha"), "{plain}");
        assert!(!plain.contains("reasoning-beta"), "{plain}");
    }

    #[test]
    fn timestamps_render_inside_user_messages_only_when_enabled() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        let mut config = crate::config::UiConfig::default();
        config.timestamps = true;
        view.apply_presentation_config(&config);
        let timestamp = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(86_400);
        let message = ChatMessage {
            id: "user-1".to_string(),
            turn_id: Some("turn-1".to_string()),
            role: MessageRole::User,
            timestamp,
            flow_items: vec![FlowItem::Text {
                content: "hello".to_string(),
                is_streaming: false,
            }],
            is_streaming: false,
            version: 0,
        };
        let expected = chrono::DateTime::<chrono::Local>::from(timestamp)
            .format("%Y-%m-%d %H:%M")
            .to_string();

        let shown = view.render_message(&message, 80).plain_lines.join("\n");
        assert!(shown.contains(&expected), "{shown}");

        config.timestamps = false;
        view.apply_presentation_config(&config);
        let hidden = view.render_message(&message, 80).plain_lines.join("\n");
        assert!(!hidden.contains(&expected), "{hidden}");
    }
}

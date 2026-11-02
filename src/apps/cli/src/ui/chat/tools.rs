impl ChatView {
    // ============ Tool card expand/collapse ============

    /// Toggle expand/collapse on the currently focused block tool
    pub(crate) fn toggle_focused_tool_expand(&mut self, chat_state: &ChatState) {
        // If no tool is focused, auto-focus the last block tool
        if self.focused_block_tool.is_none() {
            self.focus_last_block_tool(chat_state);
        }

        if let Some(ref tool_id) = self.focused_block_tool {
            let tool_id = tool_id.clone();
            self.tool_disclosures.toggle(&tool_id);
            self.invalidate_render_cache();
        }
    }

    /// Focus the next block tool (Ctrl+I)
    pub(crate) fn cycle_block_tool_focus_next(&mut self, chat_state: &ChatState) {
        let block_tool_ids = self.collect_block_tool_ids(chat_state);
        if block_tool_ids.is_empty() {
            self.focused_block_tool = None;
            self.invalidate_render_cache();
            return;
        }

        let current_idx = self
            .focused_block_tool
            .as_ref()
            .and_then(|id| block_tool_ids.iter().position(|tid| tid == id));

        let next_idx = match current_idx {
            Some(idx) => (idx + 1) % block_tool_ids.len(),
            None => block_tool_ids.len() - 1, // Start from the last one
        };

        self.focused_block_tool = Some(block_tool_ids[next_idx].clone());
        self.invalidate_render_cache();
    }

    /// Focus the previous block tool (Ctrl+U)
    pub(crate) fn cycle_block_tool_focus_prev(&mut self, chat_state: &ChatState) {
        let block_tool_ids = self.collect_block_tool_ids(chat_state);
        if block_tool_ids.is_empty() {
            self.focused_block_tool = None;
            self.invalidate_render_cache();
            return;
        }

        let current_idx = self
            .focused_block_tool
            .as_ref()
            .and_then(|id| block_tool_ids.iter().position(|tid| tid == id));

        let prev_idx = match current_idx {
            Some(idx) => {
                if idx == 0 {
                    block_tool_ids.len() - 1
                } else {
                    idx - 1
                }
            }
            None => block_tool_ids.len() - 1, // Start from the last one
        };

        self.focused_block_tool = Some(block_tool_ids[prev_idx].clone());
        self.invalidate_render_cache();
    }

    /// Focus the last block tool in the conversation
    fn focus_last_block_tool(&mut self, chat_state: &ChatState) {
        let block_tool_ids = self.collect_block_tool_ids(chat_state);
        self.focused_block_tool = block_tool_ids.last().cloned();
    }

    /// Collect all tool IDs that are currently rendered as block tools
    fn collect_block_tool_ids(&self, chat_state: &ChatState) -> Vec<String> {
        let mut ids = Vec::new();
        for msg in &chat_state.messages {
            for item in &msg.flow_items {
                if let FlowItem::Tool { tool_state } = item {
                    // A tool is "block" if it has a result or is running
                    // (matching the logic in tool_cards::tool_display_mode)
                    let is_block = match tool_state.tool_name.as_str() {
                        "Bash" | "bash_tool" | "run_terminal_cmd" => {
                            tool_state.result.is_some()
                                || matches!(
                                    tool_state.status,
                                    crate::chat_state::ToolDisplayStatus::Running
                                        | crate::chat_state::ToolDisplayStatus::Streaming
                                )
                        }
                        "Edit" | "Write" | "Delete" | "search_replace" | "write_file"
                        | "write_file_tool" => tool_state.result.is_some(),
                        "Task" | "AgentSpawn" => {
                            tool_state.result.is_some()
                                || matches!(
                                    tool_state.status,
                                    crate::chat_state::ToolDisplayStatus::Running
                                        | crate::chat_state::ToolDisplayStatus::Streaming
                                )
                        }
                        "TodoWrite" | "AskUserQuestion" | "CreatePlan" => true,
                        _ => false,
                    };
                    if is_block {
                        ids.push(tool_state.tool_id.clone());
                    }
                }
            }
        }
        ids
    }
}

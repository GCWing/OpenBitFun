impl ChatView {
    pub(crate) fn show_message_queue(&mut self) {
        self.message_queue.show();
        self.popup_stack.push(PopupType::MessageQueue);
    }
    pub(crate) fn message_queue_generation(&self) -> u64 {
        self.message_queue.generation
    }
    pub(crate) fn message_queue_can_auto_refresh(&self) -> bool {
        self.message_queue.can_auto_refresh()
    }
    pub(crate) fn message_queue_loading(&mut self) {
        self.message_queue.loading();
    }
    pub(crate) fn message_queue_visible(&self) -> bool {
        self.message_queue.visible
    }
    pub(crate) fn hide_message_queue(&mut self) {
        self.message_queue.visible = false;
        self.message_queue.generation = self.message_queue.generation.wrapping_add(1);
    }
    pub(crate) fn reshow_message_queue(&mut self) {
        self.message_queue.visible = true;
    }
    pub(crate) fn update_message_queue(
        &mut self,
        result: Result<openbitfun_runtime_ports::DialogQueueSnapshot, String>,
    ) {
        self.message_queue.update(result);
    }
    pub(crate) fn message_queue_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> super::message_queue::QueueAction {
        self.message_queue.handle_key(key)
    }

    pub(crate) fn show_prompt_command_shell_review(
        &mut self,
        plan: openbitfun_product_domains::external_sources::PromptCommandShellReviewPlan,
    ) {
        self.prompt_command_shell_review =
            Some(crate::ui::prompt_command_shell_review::PromptCommandShellReviewPrompt::new(plan));
    }

    pub(crate) fn prompt_command_shell_review_visible(&self) -> bool {
        self.prompt_command_shell_review.is_some()
    }

    pub(crate) fn prompt_command_shell_review_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> crate::ui::prompt_command_shell_review::PromptCommandShellReviewAction {
        self.prompt_command_shell_review.as_mut().map_or(
            crate::ui::prompt_command_shell_review::PromptCommandShellReviewAction::None,
            |prompt| prompt.handle_key_event(key),
        )
    }

    pub(crate) fn hide_prompt_command_shell_review(&mut self) {
        self.prompt_command_shell_review = None;
    }

    pub(crate) fn show_export_dialog(&mut self, filename: String) {
        self.export_dialog.show(filename);
        self.popup_stack.push(PopupType::ExportDialog);
    }

    pub(crate) fn export_dialog_visible(&self) -> bool {
        self.export_dialog.is_visible()
    }

    pub(crate) fn hide_export_dialog(&mut self) {
        self.export_dialog.hide();
    }

    pub(crate) fn export_dialog_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> crate::ui::export_dialog::ExportDialogAction {
        self.export_dialog.handle_key_event(key)
    }

    pub(crate) fn export_dialog_handle_paste(&mut self, text: &str) {
        self.export_dialog.insert_text(text);
    }

    pub(crate) fn export_dialog_confirm_overwrite(&mut self, target: String) {
        self.export_dialog.request_overwrite_confirmation(target);
    }

    pub(crate) fn export_dialog_set_error(&mut self, error: String) {
        self.export_dialog.set_error(error);
    }

    pub(crate) fn show_workspace_diff(
        &mut self,
        snapshot: openbitfun_agent_runtime::sdk::WorkspaceDiffSnapshot,
    ) {
        self.workspace_diff.show(snapshot);
        self.popup_stack.push(PopupType::WorkspaceDiff);
    }

    pub(crate) fn workspace_diff_visible(&self) -> bool {
        self.workspace_diff.is_visible()
    }

    pub(crate) fn hide_workspace_diff(&mut self) {
        self.workspace_diff.hide();
    }

    pub(crate) fn reshow_workspace_diff(&mut self) {
        self.workspace_diff.reshow();
    }

    pub(crate) fn workspace_diff_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> super::workspace_diff::WorkspaceDiffAction {
        self.workspace_diff.handle_key_event(key)
    }

    // ============ Info popup methods ============

    pub(crate) fn show_info_popup(&mut self, message: String) {
        self.info_popup = Some(message);
        self.info_popup_scroll = 0;
        self.info_popup_max_scroll = 0;
        self.popup_stack.push(PopupType::InfoPopup);
    }

    pub(crate) fn info_popup_visible(&self) -> bool {
        self.info_popup.is_some()
    }

    pub(crate) fn dismiss_info_popup(&mut self) {
        self.info_popup = None;
        self.info_popup_scroll = 0;
        self.info_popup_max_scroll = 0;
    }

    pub(crate) fn info_popup_scroll_up(&mut self, amount: u16) {
        self.info_popup_scroll = self.info_popup_scroll.saturating_sub(amount);
    }

    pub(crate) fn info_popup_scroll_down(&mut self, amount: u16) {
        self.info_popup_scroll = self
            .info_popup_scroll
            .saturating_add(amount)
            .min(self.info_popup_max_scroll);
    }

    pub(crate) fn info_popup_scroll_to_start(&mut self) {
        self.info_popup_scroll = 0;
    }

    pub(crate) fn info_popup_scroll_to_end(&mut self) {
        self.info_popup_scroll = self.info_popup_max_scroll;
    }

    // ============ Command palette methods ============

    pub(crate) fn show_command_palette(&mut self, action_state: crate::actions::ActionState) {
        self.command_palette.show(action_state);
        self.popup_stack.push(PopupType::CommandPalette);
    }

    pub(crate) fn hide_command_palette(&mut self) {
        self.command_palette.hide();
    }

    pub(crate) fn reshow_command_palette(&mut self) {
        self.command_palette.reshow();
    }

    pub(crate) fn command_palette_visible(&self) -> bool {
        self.command_palette.is_visible()
    }

    pub(crate) fn command_palette_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> PaletteAction {
        self.command_palette.handle_key_event(key)
    }

    pub(crate) fn command_palette_handle_mouse(
        &mut self,
        mouse: &crossterm::event::MouseEvent,
    ) -> PaletteAction {
        self.command_palette.handle_mouse_event(mouse)
    }

    pub(crate) fn command_palette_captures_mouse(
        &self,
        mouse: &crossterm::event::MouseEvent,
    ) -> bool {
        self.command_palette.captures_mouse(mouse)
    }

    // ============ Model selector methods ============

    pub(crate) fn show_model_selector(
        &mut self,
        models: Vec<ModelItem>,
        current_model_id: Option<String>,
        allow_edit: bool,
        current_session_selection: bool,
    ) {
        self.model_selector.show(
            models,
            current_model_id,
            allow_edit,
            current_session_selection,
        );
        self.popup_stack.push(PopupType::ModelSelector);
    }

    pub(crate) fn hide_model_selector(&mut self) {
        self.model_selector.hide();
    }

    pub(crate) fn reshow_model_selector(&mut self) {
        self.model_selector.reshow();
    }

    pub(crate) fn model_selector_visible(&self) -> bool {
        self.model_selector.is_visible()
    }

    pub(crate) fn model_selector_up(&mut self) {
        self.model_selector.move_up();
    }

    pub(crate) fn model_selector_down(&mut self) {
        self.model_selector.move_down();
    }

    pub(crate) fn model_selector_confirm(&self) -> Option<ModelItem> {
        self.model_selector.confirm_selection()
    }

    pub(crate) fn model_selector_allows_edit(&self) -> bool {
        self.model_selector.allows_edit()
    }

    // ============ Theme selector methods ============

    pub(crate) fn show_theme_selector(
        &mut self,
        themes: Vec<ThemeItem>,
        current_theme_id: Option<String>,
    ) {
        self.theme_selector.show(themes, current_theme_id);
        self.popup_stack.push(PopupType::ThemeSelector);
    }

    pub(crate) fn hide_theme_selector(&mut self) {
        self.theme_selector.hide();
    }

    pub(crate) fn reshow_theme_selector(&mut self) {
        self.theme_selector.reshow();
    }

    pub(crate) fn theme_selector_visible(&self) -> bool {
        self.theme_selector.is_visible()
    }

    pub(crate) fn theme_selector_up(&mut self) {
        self.theme_selector.move_up();
    }

    pub(crate) fn theme_selector_down(&mut self) {
        self.theme_selector.move_down();
    }

    pub(crate) fn theme_selector_confirm(&self) -> Option<ThemeItem> {
        self.theme_selector.confirm_selection()
    }

    pub(crate) fn theme_selector_selected(&self) -> Option<ThemeItem> {
        self.theme_selector.selected_item().cloned()
    }

    // ============ Agent selector methods ============

    pub(crate) fn show_agent_selector(
        &mut self,
        agents: Vec<AgentItem>,
        current_agent_id: Option<String>,
        include_external_sources: bool,
        allow_mode_switch: bool,
    ) {
        self.agent_selector.show(
            agents,
            current_agent_id,
            include_external_sources,
            allow_mode_switch,
        );
        self.popup_stack.push(PopupType::AgentSelector);
    }

    pub(crate) fn show_agent_modes_only(
        &mut self,
        agents: Vec<AgentItem>,
        current_agent_id: Option<String>,
        allow_mode_switch: bool,
    ) {
        self.agent_selector
            .show_modes_only(agents, current_agent_id, allow_mode_switch);
        self.popup_stack.push(PopupType::AgentSelector);
    }

    pub(crate) fn hide_agent_selector(&mut self) {
        self.agent_selector.hide();
    }

    pub(crate) fn reshow_agent_selector(&mut self) {
        self.agent_selector.reshow();
    }

    pub(crate) fn agent_selector_visible(&self) -> bool {
        self.agent_selector.is_visible()
    }

    pub(crate) fn agent_selector_up(&mut self) {
        self.agent_selector.move_up();
    }

    pub(crate) fn agent_selector_down(&mut self) {
        self.agent_selector.move_down();
    }

    pub(crate) fn agent_selector_confirm(&self) -> Option<AgentSelectorAction> {
        self.agent_selector.confirm_selection()
    }

    pub(crate) fn set_agent_mode_switch_allowed(&mut self, allowed: bool) {
        self.agent_selector.set_mode_switch_allowed(allowed);
    }

    // ============ Skill selector methods ============

    pub(crate) fn show_skill_menu(&mut self) {
        self.skill_selector.show_menu();
        self.popup_stack.push(PopupType::SkillSelector);
    }

    pub(crate) fn show_skill_list(&mut self, skills: Vec<SkillItem>) {
        self.skill_selector.show_list(skills);
        self.popup_stack.push(PopupType::SkillSelector);
    }

    pub(crate) fn show_skill_config(&mut self, skills: Vec<SkillItem>) {
        self.skill_selector.show_config(skills);
        self.popup_stack.push(PopupType::SkillSelector);
    }

    pub(crate) fn hide_skill_selector(&mut self) {
        self.skill_selector.hide();
    }

    pub(crate) fn reshow_skill_selector(&mut self) {
        self.skill_selector.reshow();
    }

    pub(crate) fn skill_selector_visible(&self) -> bool {
        self.skill_selector.is_visible()
    }

    pub(crate) fn skill_selector_up(&mut self) {
        self.skill_selector.move_up();
    }

    pub(crate) fn skill_selector_down(&mut self) {
        self.skill_selector.move_down();
    }

    pub(crate) fn skill_selector_confirm(&self) -> Option<SkillSelectorAction> {
        self.skill_selector.confirm_selection()
    }

    // ============ Subagent selector methods ============

    pub(crate) fn show_subagent_menu(&mut self) {
        self.agent_selector.hide();
        self.subagent_selector.show_menu();
        self.popup_stack.push(PopupType::SubagentSelector);
    }

    pub(crate) fn show_subagent_list(&mut self, subagents: Vec<SubagentItem>) {
        self.subagent_selector.show_list(subagents);
        self.popup_stack.push(PopupType::SubagentSelector);
    }

    pub(crate) fn show_subagent_config(&mut self, subagents: Vec<SubagentItem>) {
        self.subagent_selector.show_config(subagents);
        self.popup_stack.push(PopupType::SubagentSelector);
    }

    pub(crate) fn hide_subagent_selector(&mut self) {
        self.subagent_selector.hide();
    }

    pub(crate) fn reshow_subagent_selector(&mut self) {
        self.subagent_selector.reshow();
    }

    pub(crate) fn subagent_selector_visible(&self) -> bool {
        self.subagent_selector.is_visible()
    }

    pub(crate) fn subagent_selector_up(&mut self) {
        self.subagent_selector.move_up();
    }

    pub(crate) fn subagent_selector_down(&mut self) {
        self.subagent_selector.move_down();
    }

    pub(crate) fn subagent_selector_confirm(&self) -> Option<SubagentSelectorAction> {
        self.subagent_selector.confirm_selection()
    }

    // ============ MCP selector methods ============

    pub(crate) fn show_mcp_selector(&mut self, items: Vec<McpItem>) {
        self.mcp_selector.show(items);
        self.popup_stack.push(PopupType::McpSelector);
    }

    pub(crate) fn hide_mcp_selector(&mut self) {
        self.mcp_selector.hide();
    }

    pub(crate) fn reshow_mcp_selector(&mut self) {
        self.mcp_selector.reshow();
    }

    pub(crate) fn mcp_selector_visible(&self) -> bool {
        self.mcp_selector.is_visible()
    }

    pub(crate) fn mcp_selector_up(&mut self) {
        self.mcp_selector.move_up();
    }

    pub(crate) fn mcp_selector_down(&mut self) {
        self.mcp_selector.move_down();
    }

    pub(crate) fn mcp_selector_confirm(&self) -> Option<McpItem> {
        self.mcp_selector.confirm_selection()
    }

    pub(crate) fn mcp_selector_set_loading(&mut self, id: Option<String>) {
        self.mcp_selector.loading_id = id;
    }

    pub(crate) fn mcp_selector_update_items(&mut self, items: Vec<McpItem>) {
        self.mcp_selector.update_items(items);
    }

    /// Take the pending MCP toggle (set by mouse click)
    pub(crate) fn take_pending_mcp_toggle(&mut self) -> Option<McpItem> {
        self.pending_mcp_toggle.take()
    }

    pub(crate) fn mcp_selector_start_confirm_delete(&mut self, server_id: String) {
        self.mcp_selector.start_confirm_delete(server_id);
    }

    pub(crate) fn mcp_selector_cancel_confirm_delete(&mut self) {
        self.mcp_selector.cancel_confirm_delete();
    }

    pub(crate) fn mcp_selector_is_confirm_delete(&self, server_id: &str) -> bool {
        self.mcp_selector.is_confirm_delete(server_id)
    }

    pub(crate) fn mcp_selector_start_confirm_external(&mut self, server_id: String) {
        self.mcp_selector.start_confirm_external(server_id);
    }

    pub(crate) fn mcp_selector_is_confirm_external(&self, server_id: &str) -> bool {
        self.mcp_selector.is_confirm_external(server_id)
    }

    pub(crate) fn mcp_selector_cancel_confirm_external(&mut self) {
        self.mcp_selector.cancel_confirm_external();
    }

    // ============ MCP add dialog methods ============

    pub(crate) fn show_mcp_add_dialog(&mut self) {
        self.mcp_add_dialog.show();
        self.popup_stack.push(PopupType::McpAddDialog);
    }

    pub(crate) fn mcp_add_dialog_visible(&self) -> bool {
        self.mcp_add_dialog.is_visible()
    }

    pub(crate) fn mcp_add_dialog_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> McpAddAction {
        self.mcp_add_dialog.handle_key_event(key)
    }

    pub(crate) fn mcp_add_dialog_handle_paste(&mut self, text: &str) {
        self.mcp_add_dialog.insert_text(text);
    }

    pub(crate) fn hide_mcp_add_dialog(&mut self) {
        self.mcp_add_dialog.hide();
    }

    pub(crate) fn reshow_mcp_add_dialog(&mut self) {
        self.mcp_add_dialog.show();
    }

    // ============ Session selector methods ============

    pub(crate) fn show_session_selector(
        &mut self,
        sessions: Vec<SessionItem>,
        current_session_id: Option<String>,
        can_delete: bool,
    ) {
        self.session_selector
            .show(sessions, current_session_id, can_delete);
        self.popup_stack.push(PopupType::SessionSelector);
    }

    pub(crate) fn session_selector_visible(&self) -> bool {
        self.session_selector.is_visible()
    }

    pub(crate) fn hide_session_selector(&mut self) {
        self.session_selector.hide();
    }

    pub(crate) fn reshow_session_selector(&mut self) {
        self.session_selector.reshow();
    }

    pub(crate) fn session_selector_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> SessionAction {
        self.session_selector.handle_key_event(key)
    }

    pub(crate) fn session_selector_remove_item(&mut self, session_id: &str) {
        self.session_selector.remove_item(session_id);
    }

    // ============ Subagent Session lineage selector methods ============

    pub(crate) fn show_session_lineage_selector(
        &mut self,
        snapshot: &openbitfun_agent_runtime::sdk::AgentSessionLineageSnapshot,
    ) {
        self.session_lineage_selector.show(snapshot);
        self.popup_stack.push(PopupType::SessionLineageSelector);
    }

    pub(crate) fn session_lineage_selector_visible(&self) -> bool {
        self.session_lineage_selector.is_visible()
    }

    pub(crate) fn hide_session_lineage_selector(&mut self) {
        self.session_lineage_selector.hide();
    }

    pub(crate) fn reshow_session_lineage_selector(&mut self) {
        self.session_lineage_selector.reshow();
    }

    pub(crate) fn session_lineage_selector_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> SessionLineageAction {
        self.session_lineage_selector.handle_key_event(key)
    }

    pub(crate) fn set_lineage_inspection(&mut self, label: Option<String>) {
        self.lineage_inspection_label = label;
    }

    // ============ Fork selector methods ============

    pub(crate) fn show_fork_selector(&mut self, points: Vec<crate::chat_state::SessionForkPoint>) {
        self.clear_committed_message_anchor();
        self.fork_selector.show(points);
        self.popup_stack.push(PopupType::ForkSelector);
    }

    pub(crate) fn fork_selector_visible(&self) -> bool {
        self.fork_selector.is_visible()
    }

    pub(crate) fn hide_fork_selector(&mut self) {
        self.fork_selector.hide();
    }

    pub(crate) fn reshow_fork_selector(&mut self) {
        self.fork_selector.reshow();
    }

    pub(crate) fn fork_selector_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> ForkAction {
        self.fork_selector.handle_key_event(key)
    }

    // ============ Timeline selector methods ============

    pub(crate) fn show_timeline_selector(
        &mut self,
        points: Vec<crate::chat_state::SessionTimelinePoint>,
    ) {
        self.clear_committed_message_anchor();
        self.timeline_selector.show(points);
        self.popup_stack.push(PopupType::TimelineSelector);
    }

    pub(crate) fn timeline_selector_visible(&self) -> bool {
        self.timeline_selector.is_visible()
    }

    pub(crate) fn hide_timeline_selector(&mut self) {
        self.timeline_selector.hide();
    }

    pub(crate) fn reshow_timeline_selector(&mut self) {
        self.timeline_selector.reshow();
    }

    pub(crate) fn timeline_selector_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> TimelineAction {
        self.timeline_selector.handle_key_event(key)
    }

    // ============ Prompt stash selector methods ============

    pub(crate) fn show_prompt_stash_selector(
        &mut self,
        entries: Vec<crate::prompt_stash::PromptStashEntry>,
    ) {
        self.prompt_stash_selector.show(entries);
        self.popup_stack.push(PopupType::PromptStashSelector);
    }

    pub(crate) fn prompt_stash_selector_visible(&self) -> bool {
        self.prompt_stash_selector.is_visible()
    }

    pub(crate) fn hide_prompt_stash_selector(&mut self) {
        self.prompt_stash_selector.hide();
    }

    pub(crate) fn reshow_prompt_stash_selector(&mut self) {
        self.prompt_stash_selector.reshow();
    }

    pub(crate) fn prompt_stash_selector_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> crate::ui::prompt_stash_selector::PromptStashAction {
        self.prompt_stash_selector.handle_key_event(key)
    }

    // ============ Provider selector methods (add model step 1) ============

    pub(crate) fn show_provider_selector(
        &mut self,
        provider_catalog: openbitfun_core_types::ProviderCatalog,
    ) {
        self.provider_selector.show(provider_catalog);
        self.popup_stack.push(PopupType::ProviderSelector);
    }

    pub(crate) fn provider_selector_visible(&self) -> bool {
        self.provider_selector.is_visible()
    }

    pub(crate) fn hide_provider_selector(&mut self) {
        self.provider_selector.hide();
    }

    pub(crate) fn reshow_provider_selector(&mut self) {
        self.provider_selector.reshow();
    }

    pub(crate) fn provider_selector_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> Option<ProviderSelection> {
        self.provider_selector.handle_key_event(key)
    }

    pub(crate) fn provider_selector_handle_mouse(
        &mut self,
        mouse: &crossterm::event::MouseEvent,
    ) -> Option<ProviderSelection> {
        self.provider_selector.handle_mouse_event(mouse)
    }

    pub(crate) fn provider_selector_captures_mouse(
        &self,
        mouse: &crossterm::event::MouseEvent,
    ) -> bool {
        self.provider_selector.captures_mouse(mouse)
    }

    // ============ Model config form methods (add model step 2) ============

    pub(crate) fn show_model_config_form_custom(&mut self) {
        self.model_config_form.show_custom();
        self.popup_stack.push(PopupType::ModelConfigForm);
    }

    pub(crate) fn show_model_config_form_from_provider(
        &mut self,
        provider_name: &str,
        base_url: &str,
        format: &str,
        default_model: &str,
    ) {
        self.model_config_form
            .show_from_provider(provider_name, base_url, format, default_model);
        self.popup_stack.push(PopupType::ModelConfigForm);
    }

    pub(crate) fn show_model_config_form_for_edit(
        &mut self,
        model_id: &str,
        result: &super::model_config_form::ModelFormResult,
    ) {
        self.model_config_form.show_for_edit(model_id, result);
        self.popup_stack.push(PopupType::ModelConfigForm);
    }

    pub(crate) fn model_config_form_visible(&self) -> bool {
        self.model_config_form.is_visible()
    }

    pub(crate) fn hide_model_config_form(&mut self) {
        self.model_config_form.hide();
    }

    pub(crate) fn reshow_model_config_form(&mut self) {
        self.model_config_form.reshow();
    }

    pub(crate) fn model_config_form_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> ModelFormAction {
        self.model_config_form.handle_key_event(key)
    }

    // ============ Account login form ============

    pub(crate) fn show_login_form(&mut self) {
        self.login_form.show();
        self.popup_stack.push(PopupType::LoginForm);
    }

    pub(crate) fn login_form_visible(&self) -> bool {
        self.login_form.is_visible()
    }

    pub(crate) fn hide_login_form(&mut self) {
        self.login_form.hide();
    }

    pub(crate) fn reshow_login_form(&mut self) {
        self.login_form.show();
    }

    pub(crate) fn login_form_handle_key(
        &mut self,
        key: crossterm::event::KeyEvent,
    ) -> LoginFormAction {
        self.login_form.handle_key_event(key)
    }

    pub(crate) fn login_form_set_authorization(
        &mut self,
        authorization: openbitfun_product_domains::account::GitHubAuthStart,
    ) {
        self.login_form.set_authorization(authorization);
    }
    pub(crate) fn login_form_set_status(&mut self, status: &str) {
        self.login_form.set_status(status);
    }
    pub(crate) fn login_form_set_error(&mut self, message: impl Into<String>) {
        self.login_form.set_error(message);
    }

    pub(crate) fn login_form_insert_paste(&mut self, text: &str) {
        self.login_form.insert_paste(text);
    }

    pub(crate) fn show_account_panel(
        &mut self,
        info: openbitfun_product_domains::account::AccountInfo,
        devices: Vec<openbitfun_product_domains::account::AccountDevice>,
    ) {
        self.login_form.show_account(info, devices);
        self.popup_stack.push(PopupType::LoginForm);
    }
}

#[cfg(test)]
mod tests {
    use super::ChatView;
    use crate::chat_state::ChatState;
    use crate::ui::agent_selector::AgentItem;
    use crate::ui::theme::Theme;
    use ratatui::{backend::TestBackend, Terminal};

    #[test]
    fn opening_subagent_management_hides_the_parent_agent_selector() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        view.show_agent_selector(
            vec![AgentItem {
                id: "Standard".to_string(),
                route_key: None,
                description: "General purpose".to_string(),
            }],
            Some("Standard".to_string()),
            true,
            true,
        );

        view.show_subagent_menu();

        assert!(!view.agent_selector_visible());
        assert!(view.subagent_selector_visible());
    }

    #[test]
    fn pending_mode_update_keeps_an_open_selector_disabled() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        view.show_agent_modes_only(
            vec![AgentItem {
                id: "Standard".to_string(),
                route_key: None,
                description: "General purpose".to_string(),
            }],
            Some("Standard".to_string()),
            true,
        );

        view.set_agent_mode_switch_allowed(false);

        let state = ChatState::new(
            "session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/current".to_string()),
        );
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).expect("test terminal");
        terminal
            .draw(|frame| view.render(frame, &state))
            .expect("render disabled mode selector");
        let buffer = terminal.backend().buffer();
        let rendered = (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(rendered.contains("Please wait"), "{rendered:?}");
    }
}

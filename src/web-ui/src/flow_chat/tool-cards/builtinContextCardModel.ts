import { runtimeToolRecord, runtimeToolText } from './runtimeToolCardModel';
import {
  builtinBasename, builtinRecords, builtinState, builtinText,
  type BuiltinCardContext, type BuiltinCardField, type BuiltinCardRecord,
} from './builtinToolCardModel';

/** Read-only context and persisted goal facts. All counts are from this invocation. */
export function buildBuiltinContextCard(context: BuiltinCardContext): boolean {
  const { model, input, data, done, t, number, field, section, outcome, list, link } = context;
  switch (model.name) {
    case 'get_goal': case 'create_goal': case 'update_goal': {
      model.family = 'goal';
      const goal = runtimeToolRecord(data.goal);
      model.summary = builtinText(goal.objective, input.objective) ?? t('toolCards.builtin.currentGoal');
      section('objective', goal.objective ?? input.objective);
      const state = builtinState(goal.status, t);
      field('state', state);
      field('tokenBudget', goal.tokenBudget ?? goal.token_budget ?? input.token_budget);
      field('tokensUsed', goal.tokensUsed ?? goal.tokens_used);
      field('tokensRemaining', data.remainingTokens ?? data.remaining_tokens);
      const seconds = goal.timeUsedSeconds ?? goal.time_used_seconds;
      if (typeof seconds === 'number' && Number.isFinite(seconds)) field('elapsed', t('toolCards.builtin.seconds', { value: number(seconds) }));
      section('completionReport', data.completionBudgetReport ?? data.completion_budget_report);
      if (done && state) model.outcome = { label: state, tone: goal.status === 'complete' ? 'success'
        : ['blocked', 'usageLimited', 'budgetLimited', 'paused'].includes(String(goal.status)) ? 'warning' : 'neutral' };
      if (done && (data.goal === null || model.rawResult && typeof model.rawResult === 'object'
        && !Array.isArray(model.rawResult) && Object.keys(data).length === 0)) model.emptyContent = t('toolCards.builtin.noGoal');
      return true;
    }
    case 'AgentList': case 'AgentDelete': {
      model.family = 'agent-roster';
      model.recordsLabel = t('toolCards.builtin.fields.agents');
      const deleting = model.name === 'AgentDelete';
      if (deleting) {
        const ids = data.agent_ids ?? input.agent_ids;
        const targets = [...new Set((Array.isArray(ids) ? ids : typeof ids === 'string' ? [ids] : [])
          .filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(Boolean))];
        if (targets.length) model.summary = t('toolCards.builtin.selectedAgents', { value: number(targets.length) });
        model.records = targets.map(id => ({ key: id, title: id, agentId: id }));
        model.notice = t('toolCards.builtin.deleteAgentScope');
        field('deletedAgents', data.deleted_agents);
        if (done && data.status === 'deleted') {
          outcome('deleted', 'neutral');
          model.resultSummary = typeof data.deleted_agents === 'number' ? t('toolCards.builtin.deletedAgents', { value: number(data.deleted_agents) }) : undefined;
        }
      } else {
        const agents = builtinRecords(data.agents);
        list(agents?.map((agent, index) => ({
          key: `${builtinText(agent.agent_id) ?? 'agent'}:${index}`, title: builtinText(agent.name, agent.agent_id) ?? t('toolCards.builtin.unknown'),
          agentId: builtinText(agent.agent_id), state: builtinState(agent.status, t),
        })));
        model.summary = t('toolCards.builtin.directChildren');
        if (done && agents) model.resultSummary = t('toolCards.builtin.agentCounts', {
          total: number(agents.length), running: number(agents.filter(agent => ['running', 'active'].includes(String(agent.status))).length),
        });
      }
      return true;
    }
    case 'SessionHistory': {
      model.family = 'session-history';
      const transcript = runtimeToolRecord(data.transcript);
      const range = runtimeToolRecord(transcript.index_range ?? transcript.indexRange);
      const path = builtinText(transcript.transcript_path, transcript.transcriptPath);
      model.summary = builtinText(input.session_id);
      field('session', input.session_id);
      field('workspace', data.workspace);
      field('path', path);
      field('turns', Array.isArray(input.turns) && input.turns.length ? input.turns.join(', ') : t('toolCards.builtin.allTurns'));
      field('index', [builtinText(range.start_line, range.startLine), builtinText(range.end_line, range.endLine)].filter(Boolean).join('–'));
      field('includeTools', input.tools ?? false);
      field('includeToolInputs', input.tools === true && input.tool_inputs === true);
      field('includeThinking', input.thinking ?? false);
      if (done && path) { outcome('exported'); link('file', path, 'openTranscript'); }
      return true;
    }
    case 'analyze_image': {
      model.family = 'image-analysis';
      model.sourcePath = builtinText(data.path, input.path);
      model.summary = builtinBasename(model.sourcePath);
      field('path', model.sourcePath);
      field('model', data.model_name ?? data.model);
      field('dimensions', data.width && data.height ? `${data.width} × ${data.height}` : undefined);
      section('question', input.prompt);
      section('analysis', data.analysis ?? data.summary);
      section('imageCoordinates', data.coordinate_note);
      section('imageResize', data.resize_note);
      link('file', model.sourcePath, 'openImage');
      return true;
    }
    case 'GetTime': {
      model.family = 'time';
      model.summary = builtinText(data.local_time);
      field('localTime', data.local_time);
      field('utc', data.utc_time);
      field('timezone', data.timezone_offset);
      const day = typeof data.weekday_number_from_monday === 'number' ? data.weekday_number_from_monday : undefined;
      field('weekday', day && day >= 1 && day <= 7 ? t(`toolCards.builtin.weekdays.${day}`) : data.weekday);
      field('timestampSeconds', builtinText(data.unix_timestamp_seconds, data.timestamp));
      field('timestampMillis', builtinText(data.unix_timestamp_millis));
      return true;
    }
    case 'ListMCPResources': case 'ReadMCPResource': case 'ListMCPPrompts': case 'GetMCPPrompt': {
      model.family = 'mcp-resource';
      const server = builtinText(data.server_id, input.server_id);
      const subject = builtinText(data.name, input.name, data.uri, input.uri);
      model.summary = [server, subject].filter(Boolean).join(' · ');
      field('server', server);
      field('uri', data.uri ?? input.uri);
      field('template', data.name ?? input.name);
      if (model.name === 'ListMCPResources' || model.name === 'ListMCPPrompts') {
        const rows = builtinRecords(model.name === 'ListMCPResources' ? data.resources : data.prompts);
        model.recordsLabel = t(model.name === 'ListMCPResources' ? 'toolCards.builtin.fields.resources' : 'toolCards.builtin.fields.templates');
        list(rows?.map((row, index) => {
          const fields: BuiltinCardField[] = [];
          field('uri', row.uri, fields);
          field('mimeType', row.mimeType ?? row.mime_type, fields);
          const args = builtinRecords(row.arguments);
          if (args) field('requiredArguments', args.filter(arg => arg.required === true).map(arg => builtinText(arg.name)).filter(Boolean).join(', '), fields);
          return { key: `${builtinText(row.uri, row.name) ?? 'resource'}:${index}`,
            title: builtinText(row.title, row.name, row.uri) ?? t('toolCards.builtin.unknown'),
            description: builtinText(row.description), fields };
        }));
      } else if (model.name === 'ReadMCPResource') {
        const contents = builtinRecords(data.contents);
        model.recordsLabel = t('toolCards.builtin.fields.resources');
        list(contents?.map((entry, index) => {
          const fields: BuiltinCardField[] = [];
          field('mimeType', entry.mimeType ?? entry.mime_type, fields);
          if (entry.text) section('content', entry.text);
          return { key: `${builtinText(entry.uri) ?? 'content'}:${index}`, title: builtinText(entry.uri, data.uri) ?? t('toolCards.builtin.unknown'), fields };
        }));
      } else {
        section('description', data.description);
        section('prompt', data.prompt_text);
        if (!runtimeToolText(data.prompt_text)) for (const message of builtinRecords(data.messages) ?? []) {
          section('prompt', runtimeToolRecord(message.content).text);
        }
        if (done && (data.prompt_text || Array.isArray(data.messages))) outcome('loaded');
      }
      return true;
    }
    case 'Playbook': {
      model.family = 'playbook';
      // The run operation resolves an instruction template. It does not execute its steps.
      model.action = t(input.action === 'list' ? 'toolCards.builtin.listPlaybooks' : 'toolCards.builtin.readPlaybook');
      model.summary = builtinText(data.name, input.name);
      model.ordered = input.action === 'run';
      model.recordsLabel = t(model.ordered ? 'toolCards.builtin.fields.steps' : 'toolCards.builtin.fields.playbooks');
      const rows = builtinRecords(model.ordered ? data.steps : data.playbooks);
      list(rows?.map((row, index): BuiltinCardRecord => {
        const fields: BuiltinCardField[] = [];
        field('stepCount', row.step_count, fields);
        const params = builtinRecords(row.parameters);
        if (params) field('requiredArguments', params.filter(param => param.required === true).map(param => builtinText(param.name)).filter(Boolean).join(', '), fields);
        return { key: `${index}`, title: builtinText(row.name, row.description) ?? [row.domain, row.action].filter(Boolean).join('.'),
          description: row.name ? builtinText(row.description) : [row.domain, row.action].filter(Boolean).join('.'), fields };
      }));
      if (model.ordered && rows) model.notice = t('toolCards.builtin.playbookInstructions');
      return true;
    }
    default: return false;
  }
}

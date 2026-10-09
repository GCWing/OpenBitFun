import { runtimeToolRecord } from './runtimeToolCardModel';
import {
  builtinBasename, builtinRecords, builtinState, builtinText,
  type BuiltinCardContext, type BuiltinCardField, type BuiltinCardLink, type BuiltinCardRecord,
} from './builtinToolCardModel';

export function buildBuiltinWorkflowCard(context: BuiltinCardContext): void {
  const { model, input, data, done, t, field, section, outcome, operation, list, link } = context;
  switch (model.name) {
    case 'Worktree': {
      model.family = 'worktree';
      const action = input.operation;
      operation(action);
      const tree = runtimeToolRecord(data.worktree);
      const path = builtinText(data.path, tree.path, tree.rootPath, tree.root_path);
      const session = builtinText(data.session_id);
      model.summary = builtinText(data.session_name, tree.branch, input.branch, input.session_name, path, input.worktree_id, data.project_workspace_path);
      field('path', path);
      field('baseRef', input.base_ref);
      field('branch', tree.branch ?? input.branch);
      field('copyLocalChanges', input.copy_local_changes);
      field('session', data.session_name ?? session);
      field('worktree', data.worktree_id ?? tree.worktreeId ?? tree.id ?? input.worktree_id);
      link('copy-path', path, 'copyPath');
      model.recordsLabel = t('toolCards.builtin.fields.worktrees');
      list(builtinRecords(data.worktrees)?.map((row, index) => {
        const fields: BuiltinCardField[] = [];
        const links: BuiltinCardLink[] = [];
        const rowPath = builtinText(row.path, row.rootPath, row.root_path);
        if (rowPath) fields.push({ label: t('toolCards.builtin.fields.path'), value: rowPath,
          links: [{ kind: 'copy-path', value: rowPath, label: t('toolCards.builtin.links.copyPath') }] });
        field('branch', row.branch, fields);
        field('baseRef', row.baseRef ?? row.base_ref, fields);
        field('lifecycle', builtinState(row.lifecycle, t), fields);
        field('dirty', row.dirty, fields);
        field('locked', row.locked, fields);
        field('missing', row.missing, fields);
        field('unpublishedCommits', row.hasUnpublishedCommits, fields);
        field('associatedSessions', row.associatedSessionCount, fields);
        field('runningSessions', row.runningSessionCount, fields);
        for (const session of builtinRecords(row.sessions) ?? []) {
          const value = builtinText(session.sessionId);
          if (value) fields.push({ label: t('toolCards.builtin.fields.session'), value: builtinText(session.sessionName) ?? value,
            links: [{ kind: 'session', value, label: t('toolCards.builtin.links.openSession') }] });
        }
        return { key: `${builtinText(row.id, row.worktreeId) ?? 'tree'}:${index}`,
          title: builtinText(row.branch, row.name, row.path, row.id) ?? t('toolCards.builtin.unknown'), fields, links };
      }));
      if (done && action !== 'remove') link('session', session, 'openSession');
      if (done && action === 'remove' && data.success === true) outcome('removed');
      return;
    }
    case 'PortForward': {
      model.family = 'port-forward';
      const action = input.operation;
      operation(action);
      const forward = runtimeToolRecord(data.forward);
      const target = builtinText(data.target, input.target);
      const remoteHost = builtinText(forward.remoteHost, forward.remote_host, input.remote_host);
      const remotePort = builtinText(forward.remotePort, forward.remote_port, input.remote_port);
      const from = [target, remoteHost && remoteHost !== '127.0.0.1' ? remoteHost : undefined, remotePort].filter(Boolean).join(':');
      // Only the recorded result supplies a local endpoint. Requested ports can be replaced by the host.
      const to = builtinText(data.local_address);
      model.summary = to ? `${from} → ${to}` : target ?? builtinText(input.forward_id);
      if (from && to) model.connection = { from, to };
      field('target', target);
      field('remoteEndpoint', from);
      field('localEndpoint', to);
      field('requestedPort', forward.requestedLocalPort ?? forward.requested_local_port);
      field('forwardId', forward.id ?? data.forward_id ?? input.forward_id);
      const bindHost = builtinText(forward.localHost, forward.local_host);
      if (bindHost || typeof input.expose_on_lan === 'boolean') field('accessScope',
        bindHost ? ['0.0.0.0', '::'].includes(bindHost) ? t('toolCards.builtin.lan') : t('toolCards.builtin.loopback')
          : input.expose_on_lan ? t('toolCards.builtin.lan') : t('toolCards.builtin.loopback'));
      if (data.local_port_moved === true) model.notice = t('toolCards.builtin.portMoved');
      section('connectionError', forward.lastError ?? forward.last_error);
      const rows = builtinRecords(data.targets ?? data.listening_ports ?? data.forwards);
      list(rows?.map((row, index) => {
        const fields: BuiltinCardField[] = [];
        field('localEndpoint', row.localPort !== undefined ? `${row.localHost}:${row.localPort}` : undefined, fields);
        field('remoteEndpoint', row.remotePort !== undefined ? `${row.remoteHost}:${row.remotePort}` : undefined, fields);
        field('bindAddress', row.bindAddress ?? row.bind_address, fields);
        field('process', row.process, fields);
        field('connected', row.connected, fields);
        return { key: `${builtinText(row.id, row.port) ?? 'port'}:${index}`,
          title: builtinText(row.label, row.name, row.target, row.host, row.port, row.id) ?? t('toolCards.builtin.unknown'), fields };
      }));
      if (done && action === 'start' && to) { outcome('forwardStarted'); link('url', data.local_url, 'openAddress'); }
      if (done && action === 'stop' && data.operation === 'stop') outcome('stopped');
      return;
    }
    case 'ReviewPlatform': {
      model.family = 'review-platform';
      operation(input.action);
      const result = runtimeToolRecord(data.result);
      const pr = runtimeToolRecord(data.pullRequest ?? result.pullRequest ?? result.pull_request ?? result);
      const snapshot = runtimeToolRecord(data.snapshot);
      const id = builtinText(pr.number, pr.id, input.pull_request_id);
      model.summary = [id ? `#${id}` : undefined, builtinText(pr.title, input.title, data.repositoryPath, input.repository_path)].filter(Boolean).join(' · ');
      field('repository', data.repositoryPath ?? input.repository_path);
      field('remote', data.remoteId ?? input.remote_id);
      field('state', builtinState(pr.state ?? pr.status, t));
      field('sourceBranch', pr.sourceBranch ?? input.source_branch);
      field('targetBranch', pr.targetBranch ?? input.target_branch);
      field('reviewEvent', input.event);
      field('resolved', input.resolved);
      field('total', data.count ?? runtimeToolRecord(snapshot.pagination).total ?? snapshot.totalCount ?? snapshot.total);
      field('changedFiles', pr.changedFileCountKnown !== false ? pr.changedFiles : undefined);
      const checks = runtimeToolRecord(pr.checks);
      field('checksPassed', checks.passed);
      field('checksFailed', checks.failed);
      field('checksPending', checks.pending);
      section('body', data.body ?? input.body);
      section('results', result.message);
      section('ciLog', data.log, 'code');
      if (data.truncated === true) model.notice = t('toolCards.builtin.truncated');
      const rows = builtinRecords(input.action === 'list_remotes' ? snapshot.remotes ?? data.remotes
        : snapshot.pullRequests ?? snapshot.items ?? data.pullRequests ?? data.candidates ?? data.items);
      model.recordsLabel = t('toolCards.builtin.fields.results');
      list(rows?.map((row, index): BuiltinCardRecord => {
        const links: BuiltinCardLink[] = [];
        link('url', row.webUrl ?? row.web_url ?? row.url, 'openReview', links);
        const fields: BuiltinCardField[] = [];
        field('sourceBranch', row.sourceBranch, fields);
        field('targetBranch', row.targetBranch, fields);
        field('author', row.author, fields);
        field('resolved', row.resolved, fields);
        const title = builtinText(row.title, row.name, row.path, row.shortHash, row.filePath, row.id) ?? t('toolCards.builtin.unknown');
        return { key: `${builtinText(row.id) ?? 'review'}:${index}`, title, description: builtinText(row.body),
          state: builtinState(row.state ?? row.status, t), fields, links };
      }));
      const ci = builtinRecords(data.ci);
      if (ci?.length) section('checks', ci.map(check => [builtinText(check.name), builtinState(check.status ?? check.conclusion, t)].filter(Boolean).join(' · ')).join('\n'));
      if (data.status === 'needs_auth') { outcome('signIn', 'warning'); model.notice = t('toolCards.builtin.reviewAuth'); }
      else if (data.status === 'needs_remote_selection') { outcome('selectRemote', 'warning'); model.notice = t('toolCards.builtin.selectRemote'); }
      else if (done) link('url', pr.webUrl ?? pr.web_url ?? pr.url ?? result.webUrl ?? result.url, 'openReview');
      link('review', data.repositoryPath ?? input.repository_path, 'openReviewPanel');
      return;
    }
    case 'FrontendWorkbench': {
      model.family = 'frontend-workbench';
      operation(input.action);
      model.summary = builtinText(data.activeRevision, data.draftId, data.revisionId, input.command_id, input.draft_id);
      field('draft', data.draftId ?? input.draft_id);
      field('path', data.draftPath);
      field('baseRevision', data.baseRevision);
      field('activeRevision', data.activeRevision);
      field('previousRevision', data.previousRevision);
      field('pendingRevision', runtimeToolRecord(data.pending).revisionId);
      field('command', input.command_id);
      section('reason', data.reason);
      const label = builtinState(data.status, t);
      if (done && label) model.outcome = { label, tone: data.status === 'confirmed' ? 'success'
        : ['rolled_back', 'awaiting_confirmation', 'awaiting_candidate_ready', 'loading_candidate'].includes(String(data.status)) ? 'warning' : 'neutral' };
      if (input.action === 'apply' && !done || ['awaiting_confirmation', 'loading_candidate'].includes(String(data.status))) {
        model.notice = t('toolCards.builtin.hostConfirmation');
      }
      const files = runtimeToolRecord(data.files);
      for (const key of ['css', 'javascript', 'apiReference']) {
        const value = builtinText(files[key]);
        if (value) model.records.push({ key: `file:${key}`, title: builtinBasename(value) ?? value,
          fields: [{ label: t('toolCards.builtin.fields.path'), value }],
          links: [{ kind: 'file', value,
            label: t(key === 'apiReference' ? 'toolCards.builtin.links.openReference' : 'toolCards.builtin.links.openSource') }] });
      }
      const capabilities = runtimeToolRecord(data.capabilities);
      const lastOutcome = runtimeToolRecord(data.lastOutcome);
      field('lastOutcome', builtinState(lastOutcome.status, t));
      if (!data.reason) section('reason', lastOutcome.reason);
      const commands = builtinRecords(data.commands ?? capabilities.commands);
      if (commands) list([...model.records, ...commands.map((row, index) => ({ key: `command:${index}`,
        title: builtinText(row.title, row.name, row.id, row.commandId) ?? t('toolCards.builtin.unknown'),
        description: builtinText(row.description) }))]);
      return;
    }
    case 'FinalizeMiniApp': {
      model.family = 'miniapp-finalize';
      const id = builtinText(data.app_id, input.app_id);
      model.summary = builtinText(data.name, id);
      field('app', id);
      field('version', data.version);
      field('theme', input.theme);
      field('contentChanged', data.changed);
      field('sourceRevision', data.source_revision);
      if (done && typeof data.changed === 'boolean') {
        outcome(data.changed ? 'updated' : 'unchanged', data.changed ? 'success' : 'neutral');
        model.notice = t('toolCards.builtin.runtimeNotified');
        link('miniapp', id, 'openApp');
      }
      return;
    }
    case 'PublishMiniApp': case 'PublishAppearance': {
      model.family = 'marketplace-publish';
      model.summary = builtinText(data.name, input.app_name, data.slug, input.slug, input.app_id, builtinBasename(builtinText(input.package_path)));
      field('release', data.release_number);
      field('submission', data.submission_id);
      field('slug', data.slug ?? input.slug);
      field('package', data.package_id ?? input.package_path);
      field('license', input.license_spdx ?? input.license ?? input.custom_license_url);
      field('minimumVersion', input.min_openbitfun_version);
      section('changelog', input.changelog);
      if (data.status === 'sign_in_required') {
        outcome('signIn', 'warning');
        model.notice = t('toolCards.builtin.signInNotice');
        link('url', data.authorization_url, 'authorize', model.links, 'primary');
      } else if (data.status === 'submitted' || data.status === 'pending_review') {
        outcome(data.status === 'submitted' ? 'submitted' : 'pendingReview', 'neutral');
        model.notice = t('toolCards.builtin.reviewPending');
        link('market', model.name === 'PublishAppearance' ? 'appearance' : 'miniapps', 'openSubmissions');
      }
      return;
    }
  }
}

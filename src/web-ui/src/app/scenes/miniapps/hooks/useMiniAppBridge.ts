/**
 * useMiniAppBridge — handles postMessage JSON-RPC from the MiniApp iframe:
 * worker.call → JS Worker, dialog.open/save/message → Tauri dialog,
 * ai.* → Host AI client, agent.* → Host agent bridge (hidden subagent runs),
 * deck.renderPage → hidden host WebView slide rasterization (export),
 * chat.* → floating session bubble composer claims and session focus,
 * private loopx.* → the host-owned persistent LoopX controller (verified builtin only;
 * this namespace is not injected into ordinary or marketplace MiniApps),
 * clipboard.* → Host navigator.clipboard.
 * Also handles openbitfun/request-appearance and pushes Appearance changes to the iframe.
 */
import { useLayoutEffect, useRef, useEffect, useState, RefObject } from 'react';
import { miniAppAPI } from '@/infrastructure/api/service-api/MiniAppAPI';
import { loopxAPI } from '@/infrastructure/api/service-api/LoopxAPI';
import { open as dialogOpen, save as dialogSave, message as dialogMessage } from '@tauri-apps/plugin-dialog';
import type { MiniApp } from '@/infrastructure/api/service-api/MiniAppAPI';
import { useCurrentWorkspace } from '@/infrastructure/contexts/WorkspaceContext';
import { useAppearance } from '@/infrastructure/appearance';
import { buildMiniAppAppearancePayload } from '../utils/buildMiniAppAppearancePayload';
import { api } from '@/infrastructure/api/service-api/ApiClient';
import { useI18n } from '@/infrastructure/i18n';
import type { MiniAppRunScope } from '../customization/miniAppCustomizationTypes';
import { systemAPI } from '@/infrastructure/api/service-api/SystemAPI';
import { workspaceAPI } from '@/infrastructure/api';
import {
  useMiniAppStore,
  MINIAPP_COMPOSER_MESSAGE_EVENT,
  MINIAPP_COMPOSER_DRAFT_EVENT,
  normalizeMiniAppBubbleCustomization,
  type MiniAppComposerMessageDetail,
} from '../miniAppStore';
import {
  completeMiniAppComposerMessage,
  rejectPendingMiniAppComposerMessages,
} from '../miniAppComposerMessages';
import { useSceneStore } from '@/app/stores/sceneStore';
import { shouldOpenMiniAppAgentRunInMainScene } from './miniAppAgentVisibility';
import { flowChatStore } from '@/flow_chat/store/FlowChatStore';
import { openMainSession } from '@/flow_chat/services/sessionActivation';
import { createLogger } from '@/shared/utils/logger';
import { logElapsed, measureAsyncAndLog, nowMs } from '@/shared/utils/timing';
import { isPeerDeviceModeActive } from '@/infrastructure/peer-device/peerModeFlag';
import {
  isLoopxBridgeMethod,
  LOOPX_BUILTIN_APP_ID,
  parseLoopxBridgeCall,
} from './loopxBridgeProtocol';

interface JSONRPC {
  jsonrpc?: string;
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface MiniAppDiagnosticMessage {
  type?: string;
  scope?: string;
  phase?: string;
  action?: string;
  requestId?: string;
}

interface AiStreamPayload {
  appId: string;
  streamId: string;
  type: 'chunk' | 'done' | 'error';
  data: Record<string, unknown>;
}

/** Distinguishes runners of the same app (installed app vs. draft preview). */
let composerTokenSeq = 0;
const log = createLogger('useMiniAppBridge');

/**
 * Module-level registry of MiniApp-owned agent session ids, keyed by runner
 * scope. Installed apps and draft previews intentionally share an app id, but
 * must never share Agent ownership.
 *
 * A hidden agent turn runs in the host while this hook owns its event routing.
 * When the hook REMOUNTS mid-turn (tab switch, iframe reload), a per-hook
 * `useRef` would reset to empty and silently drop the turn's remaining
 * `agentic://*` events — most importantly `dialog-turn-completed`. The MiniApp
 * then never learns the turn finished, so its own stall watchdog later cancels
 * an already-completed turn. Keeping the set at module scope makes it survive
 * remounts for the lifetime of the webview.
 */
const agentSessionIdsByRunner = new Map<string, Set<string>>();

function agentSessionRegistryKey(scope: MiniAppRunScope): string {
  return scope.kind === 'draft'
    ? `draft:${scope.appId}:${scope.draftId}`
    : `active:${scope.appId}`;
}

function agentSessionIdsFor(registryKey: string): Set<string> {
  let set = agentSessionIdsByRunner.get(registryKey);
  if (!set) {
    set = new Set<string>();
    agentSessionIdsByRunner.set(registryKey, set);
  }
  return set;
}

export function useMiniAppBridge(
  iframeRef: RefObject<HTMLIFrameElement>,
  app: MiniApp,
  runScope: MiniAppRunScope,
  strictRuntime = false,
) {
  const [bridgeReady, setBridgeReady] = useState(false);
  const { workspace, workspacePath } = useCurrentWorkspace();
  const peerModeActive = isPeerDeviceModeActive();
  const remoteWorkspaceActive = workspace?.workspaceKind === 'remote';
  const { current: currentAppearance } = useAppearance();
  const { currentLanguage } = useI18n('scenes/miniapp');
  const appearanceRef = useRef(currentAppearance);
  appearanceRef.current = currentAppearance;
  const workspacePathRef = useRef(workspacePath);
  workspacePathRef.current = workspacePath;
  const localeRef = useRef(currentLanguage);
  localeRef.current = currentLanguage;

  const runScopeRef = useRef<MiniAppRunScope>(runScope);
  runScopeRef.current = runScope;
  const loadedAppIdRef = useRef(app.id);
  loadedAppIdRef.current = app.id;
  // Whether this app opts out of the JS Worker. When true, framework primitive
  // calls (fs.*/shell.*/os.*/net.*) are routed to the host directly via
  // `miniapp_host_call`, so the app does not require Bun/Node at runtime.
  // `storage.*` and any custom user RPC method still go through `worker.call`,
  // but for `node.enabled = false` apps `storage.*` is served by the manager
  // (no worker), and any non-namespaced custom call will fail with a clear error.
  const nodeDisabledRef = useRef(app.permissions?.node?.enabled === false);
  const systemNotificationsAllowedRef = useRef(app.permissions?.notifications?.system === true);
  const agentEnabledRef = useRef(app.permissions?.agent?.enabled === true);
  const aiEnabledRef = useRef(app.permissions?.ai?.enabled === true);
  const strictRuntimeRef = useRef(strictRuntime);
  const hostPermissionsRef = useRef(app.permissions?.host);
  const loopxAccessCheckRef = useRef<{
    key: string;
    check: Promise<void>;
  }>();
  useLayoutEffect(() => {
    nodeDisabledRef.current = app.permissions?.node?.enabled === false;
    systemNotificationsAllowedRef.current = app.permissions?.notifications?.system === true;
    agentEnabledRef.current = app.permissions?.agent?.enabled === true;
    aiEnabledRef.current = app.permissions?.ai?.enabled === true;
    strictRuntimeRef.current = strictRuntime;
    hostPermissionsRef.current = app.permissions?.host;
  }, [
    app.id,
    app.permissions?.node?.enabled,
    app.permissions?.notifications?.system,
    app.permissions?.agent?.enabled,
    app.permissions?.ai?.enabled,
    app.permissions?.host,
    strictRuntime,
  ]);

  // Hidden agent sessions started by this iframe; used to filter the global
  // agentic:// event stream before forwarding events into the iframe. Backed by
  // a module-level map (see agentSessionIdsFor) so a mid-turn remount does not
  // reset the set and drop the turn's completion event.
  const sessionRegistryKey = agentSessionRegistryKey(runScope);
  const sessionRegistryKeyRef = useRef(sessionRegistryKey);
  const agentSessionIdsRef = useRef<Set<string>>(agentSessionIdsFor(sessionRegistryKey));
  if (sessionRegistryKeyRef.current !== sessionRegistryKey) {
    sessionRegistryKeyRef.current = sessionRegistryKey;
    agentSessionIdsRef.current = agentSessionIdsFor(sessionRegistryKey);
  }

  // This runner's identity for bubble composer claims.
  const composerTokenRef = useRef<string>('');
  if (!composerTokenRef.current) {
    composerTokenSeq += 1;
    composerTokenRef.current = `${app.id}#${composerTokenSeq}`;
  }
  useLayoutEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const rawMessage = event.data as MiniAppDiagnosticMessage & JSONRPC & { method?: string };
      if (rawMessage?.type === 'bitfun:diagnostic' && rawMessage.scope === 'loopx-install') {
        log.info('LoopX install MiniApp phase', {
          action: String(rawMessage.action || 'install_loopx').slice(0, 64),
          phase: String(rawMessage.phase || 'unknown').slice(0, 64),
          requestId: String(rawMessage.requestId || 'unassigned').slice(0, 128),
        });
        return;
      }
      const msg = rawMessage;
      if (!msg?.method) return;

      const { id, method, params = {} } = msg;
      const installAction = method === 'loopx.action'
        && params.action === 'install_loopx'
        ? String(params.action)
        : null;
      const installTrace = installAction
        ? {
            action: installAction,
            requestId: String(params.clientRequestId || id).slice(0, 128),
            receivedAt: nowMs(),
          }
        : null;
      if (installTrace) {
        log.info('LoopX install bridge request received', {
          action: installTrace.action,
          requestId: installTrace.requestId,
        });
      }
      const scope = runScopeRef.current;
      const appId = scope.appId;
      const reply = (result: unknown) =>
        iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id, result }, '*');
      const replyError = (message: string) =>
        iframeRef.current?.contentWindow?.postMessage(
          { jsonrpc: '2.0', id, error: { code: -32000, message } },
          '*',
        );

      if (method === 'openbitfun/request-appearance') {
        const payload = buildMiniAppAppearancePayload(appearanceRef.current);
        if (payload && iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage(
            { type: 'openbitfun:event', event: 'appearanceChange', payload },
            '*',
          );
        }
        return;
      }

      if (method === 'openbitfun/request-locale') {
        // Reply with the current locale id (e.g. "zh-CN" / "en-US"). The MiniApp
        // can use this both as the initial value and to look up its own i18n bundle.
        reply({ locale: localeRef.current });
        if (iframeRef.current?.contentWindow) {
          iframeRef.current.contentWindow.postMessage(
            { type: 'openbitfun:event', event: 'localeChange', payload: { locale: localeRef.current } },
            '*',
          );
        }
        return;
      }

      try {
        if (isLoopxBridgeMethod(method)) {
          if (
            loadedAppIdRef.current !== LOOPX_BUILTIN_APP_ID
            || appId !== loadedAppIdRef.current
          ) {
            replyError(
              `The LoopX controller bridge is restricted to '${LOOPX_BUILTIN_APP_ID}'.`,
            );
            return;
          }
          if (scope.kind !== 'active') {
            replyError('The LoopX controller bridge is unavailable in MiniApp draft previews.');
            return;
          }
          if (strictRuntimeRef.current) {
            replyError('The LoopX controller bridge is unavailable to strict MiniApp runtimes.');
            return;
          }

          const accessKey = `${appId}:${scope.kind}:${strictRuntimeRef.current}`;
          if (loopxAccessCheckRef.current?.key !== accessKey) {
            loopxAccessCheckRef.current = {
              key: accessKey,
              check: miniAppAPI.getCustomizationMetadata(appId)
                .then((metadata) => {
                  if (!metadata) return;
                  if (metadata.local_override) {
                    throw new Error(
                      'The LoopX controller bridge is disabled because this builtin MiniApp has a local override.',
                    );
                  }
                  if (
                    metadata.origin.kind !== 'builtin'
                    || (
                      metadata.origin.builtin_id !== undefined
                      && metadata.origin.builtin_id !== LOOPX_BUILTIN_APP_ID
                    )
                  ) {
                    throw new Error(
                      'The LoopX controller bridge requires verified builtin customization metadata.',
                    );
                  }
                })
                .catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  throw new Error(`Unable to verify access to the LoopX controller bridge: ${message}`);
                }),
            };
          }
          await loopxAccessCheckRef.current.check;
          if (installTrace) {
            logElapsed(log, 'LoopX install access check completed', installTrace.receivedAt, {
              level: 'info',
              data: { requestId: installTrace.requestId },
            });
          }

          const call = parseLoopxBridgeCall(method, params);
          if (call.kind === 'attach') {
            reply(await loopxAPI.attach(appId, call.request));
            return;
          }
          if (call.kind === 'listModels') {
            reply(await loopxAPI.listModels(appId));
            return;
          }
          if (call.kind === 'resolveIntake') {
            reply(await loopxAPI.resolveIntake(appId, call.request));
            return;
          }
          if (call.kind === 'createTask') {
            reply(await loopxAPI.createTask(appId, call.request));
            return;
          }
          if (call.kind === 'action') {
            if (installTrace) {
              const measured = await measureAsyncAndLog(
                log,
                'LoopX install Tauri action completed',
                () => loopxAPI.action(appId, call.request),
                {
                  level: 'info',
                  data: {
                    action: installTrace.action,
                    requestId: installTrace.requestId,
                  },
                },
              );
              reply(measured.value);
            } else {
              reply(await loopxAPI.action(appId, call.request));
            }
            return;
          }
          if (call.kind === 'eventsSince') {
            reply(await loopxAPI.eventsSince(appId, call.request));
            return;
          }
          reply(await loopxAPI.turnOutputSince(appId, call.request));
          return;
        }

        if (method === 'worker.call') {
          const innerMethod = (params.method as string) ?? '';
          const innerParams = (params.params as Record<string, unknown>) ?? {};
          const ns = innerMethod.split('.')[0];
          const isHostPrimitive = ns === 'fs' || ns === 'shell' || ns === 'os' || ns === 'net';
          const isStorage = ns === 'storage';

          if (strictRuntimeRef.current && ns === 'os' && hostPermissionsRef.current?.system_info !== true) {
            replyError(`MiniApp '${appId}' does not have host.system_info permission.`);
            return;
          }
          if (strictRuntimeRef.current && ns === 'shell') {
            const args = innerParams.args;
            if (!Array.isArray(args) || args.length === 0 || args.some((item) => typeof item !== 'string')) {
              replyError('Marketplace MiniApps must call shell.exec with a non-empty string args array.');
              return;
            }
            if (typeof innerParams.command === 'string' && innerParams.command.trim()) {
              replyError('Marketplace MiniApps cannot execute shell command strings.');
              return;
            }
          }

          // For node-disabled apps, framework primitives go to the host directly
          // (no Bun/Node Worker required). Storage is served by the manager.
          // For node-enabled apps, keep the legacy path so user `worker.js` exports
          // (including overrides of fs/shell) continue to work.
          if (nodeDisabledRef.current) {
            if (isHostPrimitive) {
              const result = scope.kind === 'draft'
                ? await miniAppAPI.draftHostCall(
                  appId,
                  scope.draftId,
                  innerMethod,
                  innerParams,
                  workspacePathRef.current || undefined,
                )
                : await miniAppAPI.hostCall(
                  appId,
                  innerMethod,
                  innerParams,
                  workspacePathRef.current || undefined,
                );
              reply(result);
              return;
            }
            if (isStorage) {
              const subName = innerMethod.split('.')[1];
              const key = String(innerParams.key ?? '');
              if (subName === 'get') {
                const value = scope.kind === 'draft'
                  ? await miniAppAPI.getDraftStorage(appId, scope.draftId, key)
                  : await api.invoke('get_miniapp_storage', { appId, key });
                reply(value ?? null);
                return;
              }
              if (subName === 'set') {
                if (scope.kind === 'draft') {
                  await miniAppAPI.setDraftStorage(appId, scope.draftId, key, innerParams.value ?? null);
                } else {
                  await api.invoke('set_miniapp_storage', {
                    appId,
                    key,
                    value: innerParams.value ?? null,
                  });
                }
                reply(null);
                return;
              }
              replyError(`Unknown storage method: ${innerMethod}`);
              return;
            }
            // Custom user RPC for an app without a worker — fail loudly so the dev
            // sees what's wrong instead of getting a generic worker-pool error.
            replyError(
              `MiniApp '${appId}' has node.enabled=false; cannot call custom worker method '${innerMethod}'. ` +
                `Either set node.enabled=true and ship a worker.js, or use a host primitive (fs.*/shell.*/os.*/net.*).`,
            );
            return;
          }

          const result = scope.kind === 'draft'
            ? await miniAppAPI.draftWorkerCall(
              appId,
              scope.draftId,
              innerMethod,
              innerParams,
              workspacePathRef.current || undefined,
            )
            : await miniAppAPI.workerCall(
              appId,
              innerMethod,
              innerParams,
              workspacePathRef.current || undefined,
            );
          reply(result);
          return;
        }
        if (method === 'dialog.open') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.dialog !== true) {
            replyError(`MiniApp '${appId}' does not have host.dialog permission.`);
            return;
          }
          reply(await dialogOpen(params as unknown as Parameters<typeof dialogOpen>[0]));
          return;
        }
        if (method === 'dialog.save') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.dialog !== true) {
            replyError(`MiniApp '${appId}' does not have host.dialog permission.`);
            return;
          }
          reply(await dialogSave(params as unknown as Parameters<typeof dialogSave>[0]));
          return;
        }
        if (method === 'dialog.message') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.dialog !== true) {
            replyError(`MiniApp '${appId}' does not have host.dialog permission.`);
            return;
          }
          reply(await dialogMessage(params as unknown as Parameters<typeof dialogMessage>[0]));
          return;
        }

        // ── AI commands ──────────────────────────────────────────────────────
        if (method === 'ai.complete') {
          if (strictRuntimeRef.current && !aiEnabledRef.current) {
            replyError(`MiniApp '${appId}' does not have AI permission.`);
            return;
          }
          const result = await miniAppAPI.aiComplete(appId, (params.prompt as string) ?? '', {
            systemPrompt: params.systemPrompt as string | undefined,
            model: params.model as string | undefined,
            maxTokens: params.maxTokens as number | undefined,
            temperature: params.temperature as number | undefined,
          });
          reply(result);
          return;
        }
        if (method === 'ai.chat') {
          if (strictRuntimeRef.current && !aiEnabledRef.current) {
            replyError(`MiniApp '${appId}' does not have AI permission.`);
            return;
          }
          const result = await miniAppAPI.aiChat(
            appId,
            (params.messages as { role: 'user' | 'assistant'; content: string }[]) ?? [],
            (params.streamId as string) ?? '',
            {
              systemPrompt: params.systemPrompt as string | undefined,
              model: params.model as string | undefined,
              maxTokens: params.maxTokens as number | undefined,
              temperature: params.temperature as number | undefined,
            },
          );
          reply(result);
          return;
        }
        if (method === 'ai.cancel') {
          await miniAppAPI.aiCancel(appId, (params.streamId as string) ?? '');
          reply(null);
          return;
        }
        if (method === 'ai.getModels') {
          if (strictRuntimeRef.current && !aiEnabledRef.current) {
            replyError(`MiniApp '${appId}' does not have AI permission.`);
            return;
          }
          const models = await miniAppAPI.aiListModels(appId);
          reply(models);
          return;
        }

        // ── Agent bridge commands ────────────────────────────────────────────
        if (method.startsWith('agent.')) {
          if (!agentEnabledRef.current) {
            replyError(`MiniApp '${appId}' does not have agent permission (permissions.agent.enabled).`);
            return;
          }
          if (method === 'agent.ensureSession') {
            const result = await miniAppAPI.agentEnsureSession(appId, {
              sessionId: params.sessionId as string | undefined,
              sessionName: params.sessionName as string | undefined,
              appDataWorkspace: String(params.appDataWorkspace ?? ''),
              enableTools: params.enableTools as boolean | undefined,
              model: typeof params.model === 'string' ? params.model : undefined,
            });
            agentSessionIdsRef.current.add(result.sessionId);
            const sessionWasRegistered = flowChatStore
              .getState()
              .sessions
              .has(result.sessionId);
            if (!sessionWasRegistered) {
              flowChatStore.addExternalSession(
                result.sessionId,
                typeof params.sessionName === 'string' && params.sessionName.trim()
                  ? params.sessionName.trim()
                  : `MiniApp: ${appId}`,
                'Standard',
                result.workspacePath,
                {
                  sessionKind: 'miniapp',
                  isTransient: true,
                  agentBackedTransient: true,
                },
              );
              if (!result.created) {
                try {
                  await flowChatStore.loadSessionHistory(
                    result.sessionId,
                    result.workspacePath,
                    undefined,
                    undefined,
                    undefined,
                    { includeInternal: true },
                  );
                } catch (error) {
                  // The binding is still valid even if UI history hydration
                  // fails; keep the bubble on the exact topic session.
                  log.warn('Failed to hydrate restored MiniApp agent session', {
                    appId,
                    sessionId: result.sessionId,
                    error,
                  });
                }
              }
            }
            reply(result);
            return;
          }
          if (method === 'agent.run') {
            if (params.contextFiles !== undefined && !Array.isArray(params.contextFiles)) {
              replyError('agent.run: contextFiles must be an array when provided.');
              return;
            }
            const requestedSessionId =
              typeof params.sessionId === 'string' ? params.sessionId : '';
            if (
              strictRuntimeRef.current
              && (
                !requestedSessionId
                || !agentSessionIdsRef.current.has(requestedSessionId)
              )
            ) {
              replyError(
                'Marketplace MiniApps must call agent.ensureSession first so the host can expose a visible session.',
              );
              return;
            }
            if (shouldOpenMiniAppAgentRunInMainScene(
              strictRuntimeRef.current,
              useMiniAppStore.getState().composerClaims[appId],
              composerTokenRef.current,
              requestedSessionId,
              useSceneStore.getState().activeTabId === `miniapp:${appId}`,
            )) {
              await openMainSession(requestedSessionId);
            }
            const result = await miniAppAPI.agentRun(
              appId,
              (params.prompt as string) ?? '',
              workspacePathRef.current || undefined,
              {
                runId: params.runId as string | undefined,
                sessionName: params.sessionName as string | undefined,
                displayText:
                  typeof params.displayText === 'string' ? params.displayText : undefined,
                enableTools: params.enableTools as boolean | undefined,
                sessionId: params.sessionId as string | undefined,
                appDataWorkspace: params.appDataWorkspace as string | undefined,
                model: typeof params.model === 'string' ? params.model : undefined,
                contextFiles: params.contextFiles as
                  | Array<{ name: string; content: string }>
                  | undefined,
              },
            );
            agentSessionIdsRef.current.add(result.sessionId);
            reply(result);
            return;
          }
          if (method === 'agent.cancel') {
            await miniAppAPI.agentCancel(
              appId,
              (params.sessionId as string) ?? '',
              (params.turnId as string) ?? '',
            );
            reply(null);
            return;
          }
          if (method === 'agent.turnText') {
            const result = await miniAppAPI.agentTurnText(
              appId,
              (params.sessionId as string) ?? '',
              (params.turnId as string) ?? '',
            );
            reply(result);
            return;
          }
          if (method === 'agent.cancelStaleRuns') {
            const result = await miniAppAPI.agentCancelStaleRuns(appId);
            reply(result);
            return;
          }
          replyError(`Unknown agent method: ${method}`);
          return;
        }

        // ── Floating bubble chat commands ────────────────────────────────────
        // Gated on agent permission: the composer claim exists so agentic
        // MiniApps can reuse the bubble as their input surface, and
        // focusSession only ever exposes sessions the MiniApp itself started.
        if (method.startsWith('chat.')) {
          if (!agentEnabledRef.current) {
            replyError(`MiniApp '${appId}' does not have agent permission (permissions.agent.enabled).`);
            return;
          }
          if (strictRuntimeRef.current && hostPermissionsRef.current?.chat_composer !== true) {
            replyError(`MiniApp '${appId}' does not have host.chat_composer permission.`);
            return;
          }
          if (method === 'chat.claimComposer') {
            const customization = normalizeMiniAppBubbleCustomization(params);
            useMiniAppStore.getState().claimComposer(appId, {
              token: composerTokenRef.current,
              // Keep the flat placeholder for older bubble consumers while the
              // richer host-rendered presentation lives under customization.
              placeholder: customization?.composer?.placeholder,
              customization,
            });
            reply(null);
            return;
          }
          if (method === 'chat.releaseComposer') {
            rejectPendingMiniAppComposerMessages(
              composerTokenRef.current,
              'MiniApp released the floating chat composer before the message completed',
            );
            useMiniAppStore.getState().releaseComposer(appId, composerTokenRef.current);
            reply(null);
            return;
          }
          if (method === 'chat.clearSession') {
            useMiniAppStore.getState().clearComposerSession(appId, composerTokenRef.current);
            reply(null);
            return;
          }
          if (method === 'chat.setComposerDraft') {
            // Only the runner that currently holds the composer may pop the
            // bubble open — a background runner must not steal focus.
            const claim = useMiniAppStore.getState().composerClaims[appId];
            if (claim?.token !== composerTokenRef.current) {
              replyError('chat.setComposerDraft: this MiniApp does not hold the bubble composer.');
              return;
            }
            window.dispatchEvent(
              new CustomEvent(MINIAPP_COMPOSER_DRAFT_EVENT, {
                detail: {
                  token: composerTokenRef.current,
                  text: String(params.text ?? ''),
                  sessionId: claim.sessionId,
                },
              }),
            );
            reply(null);
            return;
          }
          if (method === 'chat.focusSession') {
            const sessionId = String(params.sessionId ?? '');
            if (!sessionId || !agentSessionIdsRef.current.has(sessionId)) {
              replyError(
                'chat.focusSession: unknown session. Only sessions this MiniApp started via agent.run can be focused.',
              );
              return;
            }
            const claim = useMiniAppStore.getState().composerClaims[appId];
            if (claim?.token !== composerTokenRef.current) {
              replyError('chat.focusSession: this MiniApp does not hold the bubble composer.');
              return;
            }
            // Bind the validated session to this runner's composer claim.
            // FloatingMiniChat owns the temporary global-store switch while its
            // panel is open, then restores the user's normal session on close.
            useMiniAppStore.getState().setComposerSession(
              appId,
              composerTokenRef.current,
              sessionId,
            );
            reply(null);
            return;
          }
          if (method === 'chat.completeUserMessage') {
            const requestId = String(params.requestId ?? '').trim();
            if (!requestId) {
              replyError('chat.completeUserMessage: requestId is required.');
              return;
            }
            const completed = completeMiniAppComposerMessage(
              composerTokenRef.current,
              requestId,
              typeof params.error === 'string' ? params.error : undefined,
            );
            reply({ completed });
            return;
          }
          replyError(`Unknown chat method: ${method}`);
          return;
        }

        // ── Deck export commands ─────────────────────────────────────────────
        if (method === 'deck.renderPage') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.deck_render !== true) {
            replyError(`MiniApp '${appId}' does not have host.deck_render permission.`);
            return;
          }
          const result = await miniAppAPI.renderSlidePage(appId, {
            html: String(params.html ?? ''),
            format: String(params.format ?? 'png'),
            width: params.width as number | undefined,
            height: params.height as number | undefined,
          });
          reply(result);
          return;
        }

        // ── Clipboard commands ───────────────────────────────────────────────
        if (method === 'clipboard.writeText') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.clipboard_write !== true) {
            replyError(`MiniApp '${appId}' does not have host.clipboard_write permission.`);
            return;
          }
          await navigator.clipboard.writeText((params.text as string) ?? '');
          reply(null);
          return;
        }
        if (method === 'clipboard.readText') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.clipboard_read !== true) {
            replyError(`MiniApp '${appId}' does not have host.clipboard_read permission.`);
            return;
          }
          const text = await navigator.clipboard.readText();
          reply(text);
          return;
        }

        if (method === 'system.openExternal') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.open_external !== true) {
            replyError(`MiniApp '${appId}' does not have host.open_external permission.`);
            return;
          }
          const url = String(params.url ?? '');
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            replyError('Invalid URL.');
            return;
          }
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            replyError('Only http(s) URLs can be opened.');
            return;
          }
          await systemAPI.openExternal(parsed.toString());
          reply(null);
          return;
        }

        if (method === 'system.revealInFolder') {
          if (strictRuntimeRef.current && hostPermissionsRef.current?.reveal_in_folder !== true) {
            replyError(`MiniApp '${appId}' does not have host.reveal_in_folder permission.`);
            return;
          }
          // When `path` is omitted, open the system Downloads folder.
          let targetPath = String(params.path ?? '');
          if (!targetPath) {
            const { downloadDir } = await import('@tauri-apps/api/path');
            targetPath = await downloadDir();
          }
          if (!targetPath) {
            replyError('Could not determine the folder to open.');
            return;
          }
          await workspaceAPI.revealInExplorer(targetPath);
          reply(null);
          return;
        }

        if (method === 'notifications.system') {
          if (!systemNotificationsAllowedRef.current) {
            replyError(`MiniApp '${appId}' does not have notifications.system permission.`);
            return;
          }
          await systemAPI.sendSystemNotification(
            String(params.title ?? ''),
            params.body == null ? undefined : String(params.body),
          );
          reply(null);
          return;
        }

        replyError(`Unknown method: ${method}`);
      } catch (error) {
        if (installTrace) {
          log.error('LoopX install bridge request failed', {
            action: installTrace.action,
            requestId: installTrace.requestId,
            error,
          });
        }
        replyError(typeof error === 'string' ? error : String(error));
      }
    };
    window.addEventListener('message', handler);
    setBridgeReady(true);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, [iframeRef]);

  useEffect(() => {
    const payload = buildMiniAppAppearancePayload(currentAppearance);
    if (!payload || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'openbitfun:event', event: 'appearanceChange', payload },
      '*',
    );
  }, [currentAppearance, iframeRef]);

  // Push locale changes to the iframe so MiniApps can re-render their UI strings
  // without reloading. MiniApps subscribe via `app.on('localeChange', fn)`.
  useEffect(() => {
    if (!bridgeReady) return;
    if (!iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: 'openbitfun:event', event: 'localeChange', payload: { locale: currentLanguage } },
      '*',
    );
  }, [bridgeReady, currentLanguage, iframeRef]);

  // Forward submissions from the shared floating ChatInput into the iframe as
  // `chat:userMessage` (consumed via app.chat.onUserMessage). The MiniApp gets
  // the standard composer's display text and contexts as well as normalized
  // model text; it never owns a parallel input implementation.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<MiniAppComposerMessageDetail>).detail;
      // Match on the claim token, not the app ID: the installed app and its
      // draft preview share an ID, and both listen here.
      if (!detail || detail.token !== composerTokenRef.current) return;
      if (typeof detail.text !== 'string') return;
      const payload = {
        text: detail.text,
        ...(detail.displayText !== undefined ? { displayText: detail.displayText } : {}),
        ...(detail.contexts !== undefined ? { contexts: detail.contexts } : {}),
        ...(detail.composerPresentation !== undefined
          ? { composerPresentation: detail.composerPresentation }
          : {}),
        ...(detail.sessionId !== undefined ? { sessionId: detail.sessionId } : {}),
        ...(detail.workspacePath !== undefined ? { workspacePath: detail.workspacePath } : {}),
        ...(detail.requestId !== undefined ? { requestId: detail.requestId } : {}),
        ...(detail.source !== undefined ? { source: detail.source } : {}),
      };
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'openbitfun:event', event: 'chat:userMessage', payload },
        '*',
      );
    };
    window.addEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, handler);
    return () => {
      window.removeEventListener(MINIAPP_COMPOSER_MESSAGE_EVENT, handler);
    };
  }, [iframeRef]);

  // A composer claim may not outlive the iframe.
  useEffect(() => {
    const currentAppId = app.id;
    const token = composerTokenRef.current;
    return () => {
      rejectPendingMiniAppComposerMessages(
        token,
        'MiniApp closed before the floating chat message completed',
      );
      useMiniAppStore.getState().releaseComposer(currentAppId, token);
    };
  }, [app.id]);

  // Listen for AI stream events from Tauri and forward them to the iframe.
  useEffect(() => {
    const currentAppId = app.id;
    const unlisten = api.listen<AiStreamPayload>('miniapp://ai-stream', (payload) => {
      if (!iframeRef.current?.contentWindow) return;
      if (payload.appId !== currentAppId) return;
      iframeRef.current.contentWindow.postMessage(
        {
          type: 'openbitfun:event',
          event: 'ai:stream',
          payload: {
            streamId: payload.streamId,
            type: payload.type,
            data: payload.data,
          },
        },
        '*',
      );
    });

    return () => {
      unlisten();
    };
  }, [app.id, iframeRef]);

  // LoopX task execution belongs to the persistent host controller. This push
  // channel is only a latency optimization; the MiniApp repairs every cursor
  // gap through loopx.eventsSince and re-attaches when the stream changes.
  useEffect(() => {
    const activeScope = runScope.kind === 'active' && runScope.appId === app.id;
    if (
      app.id !== LOOPX_BUILTIN_APP_ID
      || !activeScope
      || strictRuntime
      || peerModeActive
      || remoteWorkspaceActive
    ) return;

    let disposed = false;
    let accessVerified = false;
    void miniAppAPI.getCustomizationMetadata(app.id)
      .then((metadata) => {
        if (disposed) return;
        accessVerified = !metadata || (
          !metadata.local_override
          && metadata.origin.kind === 'builtin'
          && (
            metadata.origin.builtin_id === undefined
            || metadata.origin.builtin_id === LOOPX_BUILTIN_APP_ID
          )
        );
      })
      .catch((error) => {
        log.warn('Failed to verify LoopX event bridge access', { appId: app.id, error });
      });

    const unlisten = api.listen<Record<string, unknown>>('miniapp://loopx-event', (payload) => {
      if (!accessVerified || !iframeRef.current?.contentWindow) return;
      iframeRef.current.contentWindow.postMessage(
        { type: 'bitfun:event', event: 'loopx:event', payload },
        '*',
      );
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, [
    app.id,
    app.runtime?.content_hash,
    iframeRef,
    runScope.appId,
    runScope.kind,
    runScope.kind === 'draft' ? runScope.draftId : undefined,
    peerModeActive,
    remoteWorkspaceActive,
    strictRuntime,
  ]);

  // Forward agentic:// events for MiniApp-owned hidden agent sessions into the
  // iframe as 'agent:event' (consumed via app.agent.onEvent in the SDK).
  useEffect(() => {
    if (app.permissions?.agent?.enabled !== true) return;

    const forwardedEvents = [
      'dialog-turn-started',
      'model-round-started',
      'model-round-completed',
      'text-chunk',
      'tool-event',
      'dialog-turn-completed',
      'dialog-turn-failed',
      'dialog-turn-cancelled',
      'token-usage-updated',
      'subagent-session-linked',
    ];

    const unlistenSubagentLink = api.listen<{
      sessionId?: string;
      parentSessionId?: string;
    }>('agentic://subagent-session-linked', (payload) => {
      if (!payload?.sessionId || !payload?.parentSessionId) return;
      if (!agentSessionIdsRef.current.has(payload.parentSessionId)) return;
      agentSessionIdsRef.current.add(payload.sessionId);
    });

    const unlisteners = forwardedEvents.map((eventName) =>
      api.listen<{ sessionId?: string; parentSessionId?: string; [key: string]: unknown }>(
        `agentic://${eventName}`,
        (payload) => {
          if (!iframeRef.current?.contentWindow) return;
          const eventSessionId = payload?.sessionId;
          if (!eventSessionId) return;
          const parentSessionId = payload.parentSessionId;
          const ownsSession =
            agentSessionIdsRef.current.has(eventSessionId)
            || (eventName === 'subagent-session-linked'
              && typeof parentSessionId === 'string'
              && agentSessionIdsRef.current.has(parentSessionId));
          if (!ownsSession) return;
          iframeRef.current.contentWindow.postMessage(
            {
              type: 'openbitfun:event',
              event: 'agent:event',
              payload: { sourceEvent: eventName, ...payload },
            },
            '*',
          );
          if (
            eventName === 'dialog-turn-completed'
            || eventName === 'dialog-turn-failed'
            || eventName === 'dialog-turn-cancelled'
          ) {
            agentSessionIdsRef.current.delete(eventSessionId);
            const registryKey = sessionRegistryKeyRef.current;
            if (
              agentSessionIdsRef.current.size === 0
              && agentSessionIdsByRunner.get(registryKey) === agentSessionIdsRef.current
            ) {
              agentSessionIdsByRunner.delete(registryKey);
            }
          }
        },
      ),
    );

    return () => {
      unlistenSubagentLink();
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [app.id, app.permissions?.agent?.enabled, iframeRef]);

  // Listen for Worker push events and forward them to the iframe.
  useEffect(() => {
    const currentAppId = app.id;
    const eventName = `miniapp://worker-event:${currentAppId}`;
    const unlisten = api.listen<{ appId: string; event: string; data: unknown }>(
      eventName,
      (payload) => {
        if (!iframeRef.current?.contentWindow) return;
        iframeRef.current.contentWindow.postMessage(
          {
            type: 'openbitfun:event',
            event: 'worker:event',
            payload: {
              event: payload.event,
              data: payload.data,
            },
          },
          '*',
        );
      },
    );

    return () => {
      unlisten();
    };
  }, [app.id, iframeRef]);

  return bridgeReady;
}

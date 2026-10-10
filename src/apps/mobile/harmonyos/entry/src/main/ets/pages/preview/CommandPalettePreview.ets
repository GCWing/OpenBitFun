import {
  RemoteCommandPaletteClient,
  RemoteCommandPaletteController,
  RemoteCommandPaletteScope,
  RemoteSkillCatalogQuery
} from '../../services/RemoteCommandPaletteController';
import { CommandCatalogProjection, RemoteModeSkillRow } from '../../services/CommandCatalogProjection';
import { CommandPalettePolicy } from '../../services/CommandPalettePolicy';
import {
  CommandPalettePresentation,
  CommandPaletteState,
  commandPaletteProbeReady
} from '../state/CommandPaletteState';
import { CommandPaletteAction, CommandPaletteRequest } from '../actions/ConversationIntent';
import { RemoteCommandCatalog, RemoteSessionUsageReport } from '../../model/RemoteModels';
import { ComposerBar, ComposerPresentation } from '../components/ComposerBar';
import { CommandChipRow } from '../components/CommandChipRow';
import { SkillPickerSheet } from '../components/SkillPickerSheet';
import { UsageReportSheet } from '../components/UsageReportSheet';
import { AdaptiveSheetOptions } from '../components/AdaptiveSheetOptions';
import { SettingsPlacementPolicy, SettingsSheetKind } from '../policy/SettingsPlacementPolicy';
import { MobileDesignTypography } from '../../generated/MobileDesignTokens';
import { INK, MUTED, PAGE_BG } from '../components/Theme';
import { RemoteI18n } from '../../i18n/RemoteI18n';

/**
 * The host rows this fixture answers a catalog read with.
 *
 * Shaped like the real `ModeSkillInfo` payload: built-in skills are the only ones
 * that carry a group key, and the custom rows stand for a user skill that reuses
 * a built-in name plus one of their own. The last row is one the host will not
 * let a user invoke, so the picker must drop it.
 */
const PREVIEW_SKILL_ROWS: RemoteModeSkillRow[] = [
  {
    key: 'plan', name: 'Plan', description: 'Break the request into an ordered plan',
    level: 'user', isBuiltin: true, groupKey: 'workflow', isShadowed: false,
    allowUserInvocation: true, selectedForRuntime: true, effectiveEnabled: true, globallyEnabled: true
  },
  {
    key: 'review', name: 'Review', description: 'Review the change for real defects',
    level: 'user', isBuiltin: true, groupKey: 'workflow', isShadowed: false,
    allowUserInvocation: true, selectedForRuntime: true, effectiveEnabled: true, globallyEnabled: true
  },
  {
    key: 'summarize', name: 'Summarize', description: 'Condense the current thread',
    level: 'user', isBuiltin: true, groupKey: 'writing', isShadowed: false,
    allowUserInvocation: true, selectedForRuntime: true, effectiveEnabled: true, globallyEnabled: true
  },
  {
    key: 'changelog', name: 'Changelog', description: 'Draft release notes from the diff',
    level: 'project', isBuiltin: false, isShadowed: false,
    allowUserInvocation: true, selectedForRuntime: true, effectiveEnabled: true, globallyEnabled: true
  },
  {
    key: 'plan.team', name: 'Plan', description: 'Plan the work the way this project does',
    level: 'user', isBuiltin: false, isShadowed: false,
    allowUserInvocation: true, selectedForRuntime: true, effectiveEnabled: true, globallyEnabled: true
  },
  {
    key: 'implicit', name: 'Implicit only', description: 'Never offered for a manual pick',
    level: 'user', isBuiltin: false, isShadowed: false,
    allowUserInvocation: false, selectedForRuntime: true, effectiveEnabled: true, globallyEnabled: true
  }
];

const PREVIEW_USAGE: RemoteSessionUsageReport = {
  schemaVersion: 1,
  sessionId: 'preview-session',
  scope: { kind: 'session', turnCount: 7, includesSubagents: false },
  coverage: { level: 'partial', missing: ['files'] },
  time: { wallTimeMs: 1_842_000, activeTurnMs: 611_000, modelMs: 402_000, toolMs: 121_000 },
  tokens: { inputTokens: 128_400, outputTokens: 22_950, totalTokens: 151_350, cachedTokens: 61_200 },
  models: [{ modelId: 'claude-sonnet-4', callCount: 14, totalTokens: 151_350 }],
  tools: [{ toolName: 'read_file', callCount: 21, errorCount: 1 }],
  compression: { compactionCount: 1, savedTokens: 48_000 },
  errors: { totalErrors: 1, toolErrors: 1, modelErrors: 0 }
};

/**
 * The host, minus the network.
 *
 * Only the four `host_invoke` verbs are answered here; a refusal throws the way
 * the bridge does when a desktop does not know a command, and the held
 * compaction never settles until the fixture is asked to let it.
 */
@ObservedV2
class CommandPalettePreviewClient implements RemoteCommandPaletteClient {
  refuseCatalog: boolean = false;
  failCompact: boolean = false;
  holdCompact: boolean = false;
  private release: () => void = () => {};

  async skillCatalog(_query: RemoteSkillCatalogQuery): Promise<RemoteCommandCatalog> {
    if (this.refuseCatalog) {
      throw new Error('Command not found: get_mode_skill_configs');
    }
    return CommandCatalogProjection.parseHostCatalog(PREVIEW_SKILL_ROWS);
  }

  async compactSession(_query: RemoteCommandPaletteScope): Promise<string> {
    if (this.holdCompact) {
      await new Promise<void>((resolve: () => void) => {
        this.release = resolve;
      });
    }
    if (this.failCompact) {
      throw new Error('The target device did not start the compaction. Try again later.');
    }
    return 'Context compacted';
  }

  /** Lets a held compaction finish, so the completion line can be seen too. */
  releaseHeld(): void {
    this.release();
  }

  async runInitAgentsMd(_query: RemoteCommandPaletteScope): Promise<string> {
    return 'AGENTS.md generated';
  }

  async sessionUsageReport(_query: RemoteCommandPaletteScope): Promise<RemoteSessionUsageReport> {
    return PREVIEW_USAGE;
  }
}

/**
 * The real command row, picker and usage sheet over a network-free host.
 *
 * The controller, its probe and the projection are production code; only the
 * verbs are answered here, so what these screenshots show is what the row does
 * with a catalog, a refusal, a running verb and a settled failure rather than
 * what a mock of the row would draw.
 */
@ComponentV2
export struct CommandPalettePreview {
  @Local draft: string = '';
  @Local showSkillPicker: boolean = false;
  @Local showUsageReport: boolean = false;
  @Local sheetPresented: boolean = false;
  @Local wide: boolean = false;
  /**
   * Bumped by every state transition.
   *
   * It is read in `build()` so the fixture re-renders on the controller's
   * callbacks, and it doubles as the state name a screenshot can be read
   * against.
   */
  @Local revision: number = 0;
  private palette: CommandPaletteState = new CommandPaletteState();
  private client: CommandPalettePreviewClient = new CommandPalettePreviewClient();
  private controller: RemoteCommandPaletteController = new RemoteCommandPaletteController(
    this.client,
    {
      onCatalogLoading: (): void => {
        this.palette.setCatalogLoading();
        this.stateChanged();
      },
      onCatalogReady: (_sessionId: string, catalog: RemoteCommandCatalog): void => {
        this.palette.setCatalogReady(catalog);
        this.stateChanged();
      },
      onCatalogFailed: (_sessionId: string, errorText: string): void => {
        this.palette.setCatalogFailed(errorText);
        this.stateChanged();
      },
      onCommandStarted: (_sessionId: string, wireAction: string): void => {
        this.palette.beginCommand(wireAction);
        this.stateChanged();
      },
      onCommandSettled: (_sessionId: string, wireAction: string, errorText: string, _message: string): void => {
        this.palette.settleCommand(wireAction, errorText);
        this.stateChanged();
      },
      onCommandNoticeExpired: (_sessionId: string, wireAction: string): void => {
        this.palette.expireNotice(wireAction);
        this.stateChanged();
      },
      onUsageLoading: (): void => {
        this.palette.setUsageLoading();
        this.stateChanged();
      },
      onUsageReady: (_sessionId: string, report: RemoteSessionUsageReport | undefined): void => {
        this.palette.setUsageReady(report);
        this.stateChanged();
      },
      onUsageFailed: (_sessionId: string, errorText: string): void => {
        this.palette.setUsageFailed(errorText);
        this.stateChanged();
      }
    }
  );

  aboutToAppear(): void {
    const variant = this.variant();
    this.client.refuseCatalog = variant === 'degraded';
    this.client.failCompact = variant === 'failed';
    this.client.holdCompact = variant === 'busy';
    this.draft = variant === 'token' ? '' : 'Check the redirect handler';
    if (variant === 'token' || variant === 'busy') {
      this.palette.setSkill('plan');
    }
    // Both sheets open before the first frame, the way the settings preview
    // opens its own: the scenario id is only known once the page is appearing.
    if (variant === 'sheet' || variant === 'degraded') {
      this.openSheet(true);
    }
    if (variant === 'usage') {
      this.openSheet(false);
    }
    // The catalog read is also the probe, so this is the same first move a
    // session entry makes: one read decides whether the row may run anything.
    void this.controller.loadCatalog('preview-session', 'agentic', false, this.canApply());
    if (variant === 'busy' || variant === 'failed') {
      void this.controller.runCommand('preview-session', CommandPalettePolicy.compactWireAction,
        this.scope, this.canApply());
    }
    if (variant === 'usage') {
      void this.controller.loadUsageReport('preview-session', this.scope, this.canApply());
    }
  }

  build() {
    this.Body()
  }

  /**
   * The fixture's one screen, in a builder rather than in `build()`.
   *
   * A sheet binds to the node it is attached to, and the root of `build()` is
   * the node a parent can re-address; the app's own sheet hosts attach theirs
   * inside a builder for the same reason.
   */
  @Builder
  private Body() {
    Column({ space: 8 }) {
      Text(`command-palette · ${this.variant()} · r${this.revision}`)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(MUTED)
        .id('command-palette-state')
      Text(this.stateLine())
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(INK)
        .maxLines(3)
        .id('command-palette-status')
      Row({ space: 6 }) {
        Button('Probe')
          .id('palette-probe')
          .onClick(() => {
            void this.controller.loadCatalog('preview-session', 'agentic', true, this.canApply());
          })
        Button('Sheet')
          .id('palette-sheet')
          .onClick(() => {
            this.dispatch(new CommandPaletteRequest(CommandPaletteAction.OpenSkills));
          })
        Button('Usage')
          .id('palette-usage')
          .onClick(() => {
            this.dispatch(new CommandPaletteRequest(CommandPaletteAction.OpenUsage));
          })
        Button('Token')
          .id('palette-token')
          .onClick(() => {
            this.dispatch(new CommandPaletteRequest(CommandPaletteAction.SelectSkill, 'plan'));
          })
        Button('Release')
          .id('palette-release')
          .onClick(() => {
            this.client.holdCompact = false;
            this.client.releaseHeld();
          })
      }
      Blank()
      CommandChipRow({
        palette: this.presentation(),
        presentation: this.wide ? ComposerPresentation.Floating : ComposerPresentation.Compact,
        onRequest: (request: CommandPaletteRequest) => {
          this.dispatch(request);
        }
      })
      ComposerBar({
        presentation: this.wide ? ComposerPresentation.Floating : ComposerPresentation.Compact,
        chatInput: this.draft,
        skillId: this.palette.skillId,
        commandRowActive: true,
        onChatInputChange: (value: string) => {
          this.draft = value;
        },
        onRemoveSkillToken: () => {
          this.dispatch(new CommandPaletteRequest(CommandPaletteAction.ClearSkill));
        }
      })
    }
    .width('100%')
    .height('100%')
    .padding({ left: 12, right: 12, top: 12 })
    .backgroundColor(PAGE_BG)
    // One node carries one sheet binding, so the picker and the report take
    // turns on it exactly as they do in the conversation pane.
    .bindSheet($$this.sheetPresented, this.ActiveSheet(), this.activeSheetOptions())
    .onAreaChange((_old: Area, area: Area) => {
      this.wide = Number(area.width) >= 600;
    })
  }

  @Builder
  private ActiveSheet() {
    if (this.showSkillPicker) {
      SkillPickerSheet({
        palette: this.presentation(),
        onSelect: (skillId: string) => {
          this.closeSheet();
          this.dispatch(new CommandPaletteRequest(CommandPaletteAction.SelectSkill, skillId));
        },
        onRefresh: () => {
          void this.controller.loadCatalog('preview-session', 'agentic', true, this.canApply());
        },
        onClose: () => {
          this.closeSheet();
        }
      })
    } else {
      UsageReportSheet({
        palette: this.presentation(),
        onRetry: () => {
          void this.controller.loadUsageReport('preview-session', this.scope, this.canApply());
        },
        onClose: () => {
          this.closeSheet();
        }
      })
    }
  }

  private activeSheetOptions(): SheetOptions {
    return AdaptiveSheetOptions.fromPlacement(SettingsPlacementPolicy.compactBottom(
      this.showSkillPicker ? SettingsSheetKind.SkillPicker : SettingsSheetKind.UsageReport), true);
  }

  private openSheet(skills: boolean): void {
    this.showSkillPicker = skills;
    this.showUsageReport = !skills;
    this.sheetPresented = true;
  }

  private closeSheet(): void {
    this.sheetPresented = false;
  }

  /**
   * The row's one funnel, mirroring the conversation's dispatch.
   *
   * Opening or closing a sheet is this page's own view state; everything else
   * goes through the same controller the conversation uses, so the probe, the
   * single-flight guard and the notices behave here exactly as they do in the
   * chat page.
   */
  private dispatch(request: CommandPaletteRequest): void {
    if (request.action === CommandPaletteAction.ToggleGoal) {
      const toggled = CommandPalettePolicy.toggleGoal(this.draft, this.palette.goalPending);
      this.draft = toggled.draft;
      this.palette.setGoalPending(toggled.pending);
      this.stateChanged();
      return;
    }
    if (request.action === CommandPaletteAction.SelectSkill) {
      this.palette.setSkill(request.skillId);
      this.stateChanged();
      return;
    }
    if (request.action === CommandPaletteAction.ClearSkill) {
      this.palette.clearSkill();
      this.stateChanged();
      return;
    }
    if (request.action === CommandPaletteAction.OpenUsage ||
      request.action === CommandPaletteAction.RetryUsage) {
      this.openSheet(false);
      void this.controller.loadUsageReport('preview-session', this.scope, this.canApply());
      return;
    }
    if (request.action === CommandPaletteAction.OpenSkills ||
      request.action === CommandPaletteAction.RefreshCatalog) {
      this.openSheet(true);
      void this.controller.loadCatalog('preview-session', 'agentic',
        request.action === CommandPaletteAction.RefreshCatalog, this.canApply());
      return;
    }
    const wireAction = request.action === CommandPaletteAction.RetryCommand ?
      request.wireAction : request.action;
    if (CommandPalettePolicy.isRunnable(wireAction)) {
      void this.controller.runCommand('preview-session', wireAction, this.scope, this.canApply());
    }
  }

  private get scope(): RemoteCommandPaletteScope {
    const value: RemoteCommandPaletteScope = { sessionId: 'preview-session' };
    value.workspacePath = '/Users/user/projects/openbitfun';
    return value;
  }

  /** Every read here is pinned to the one session this fixture stands for. */
  private canApply(): (sessionId: string) => boolean {
    return (sessionId: string): boolean => sessionId === 'preview-session';
  }

  private presentation(): CommandPalettePresentation {
    return CommandPalettePresentation.project(
      this.palette,
      commandPaletteProbeReady(this.palette.catalogStatus),
      true,
      false
    );
  }

  private stateChanged(): void {
    this.revision += 1;
  }

  /** What the fixture is showing: the probe's verdict and the row's own line. */
  private stateLine(): string {
    const probe = commandPaletteProbeReady(this.palette.catalogStatus) ? 'probe ok' : 'probe refused';
    const notice = this.palette.notice;
    const running = this.palette.runningCommand.length > 0 ?
      ` · running ${this.palette.runningCommand}` : '';
    return notice.visible ? `${probe}${running} · ${RemoteI18n.t(notice.labelKey)}` : `${probe}${running}`;
  }

  private variant(): string {
    const id = AppStorage.get<string>('scenarioId') ?? 'command-palette';
    return id.replace('command-palette', '').replace('-dark', '').replace(/^-/, '');
  }
}

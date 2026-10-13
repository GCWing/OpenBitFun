import {
  REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1,
  RemoteDefaultModels,
  RemoteModelCatalog,
  RemoteModelConfig
} from '../../model/RemoteModels';
import { CloudAccountDevice } from '../../services/CloudAccountClient';
import { DeviceModelDefaultsRequestPath } from '../state/DeviceModelDefaultsSheetState';
import { AppRootPresentationActions, emptyAppRootPresentationActions } from '../actions/AppRootPresentationActions';
import { AppSettingsSurface } from '../components/AppRootOverlaySurfaces';
import { AppShell } from '../components/AppShell';
import { PAGE_BG } from '../components/Theme';
import { AppShellState } from '../state/AppShellState';
import { RemotePageState } from '../state/RemotePageState';

/**
 * The device model pages over a fixture desktop: the production sheet, its two
 * model pages and the production controller, with the device's answers supplied
 * locally.
 *
 * Nothing here is a picture of a page. The scenario id picks a device state — how
 * many models it has, whether it can serve the page at all, whether a write is
 * still in flight — and the sheet is mounted the way the app mounts it, so every
 * state on screen is one the app can actually reach, and the interaction between
 * them (tapping a role, choosing a model, watching the read-back land) works.
 */

/** One model of the fixture desktop. */
function previewModel(
  id: string,
  name: string,
  provider: string,
  modelName: string,
  contextWindow: number,
  enabled: boolean,
  capabilities: string[]
): RemoteModelConfig {
  return {
    id,
    name,
    provider,
    base_url: '',
    model_name: modelName,
    context_window: contextWindow,
    enabled,
    capabilities
  };
}

/**
 * The fixture desktop's catalog: four roles' worth of models, so `fast` and the
 * multimodal slot can be told apart — one text-only model, one that carries both
 * capabilities, one multimodal-only model, and one disabled model that no list
 * may offer.
 */
function previewModels(): RemoteModelConfig[] {
  return [
    previewModel('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', 'anthropic',
      'claude-sonnet-4-5', 200000, true, ['text_chat']),
    previewModel('openbitfun:gpt-5-mini', 'GPT-5 mini', 'openai',
      'openbitfun:gpt-5-mini', 128000, true, ['text_chat']),
    previewModel('google/gemini-2.5-flash', 'Gemini 2.5 Flash', 'google',
      'gemini-2.5-flash', 1000000, true, ['text_chat', 'image_understanding']),
    previewModel('local:qwen3-coder', 'Qwen3 Coder', 'local',
      'qwen3-coder', 32768, true, ['text_chat']),
    previewModel('preview/vision-preview', 'Vision Preview', 'openbitfun',
      'vision-preview', 64000, true, ['image_understanding']),
    previewModel('legacy/disabled-model', 'Legacy model', 'legacy',
      'legacy-model', 8192, false, ['text_chat'])
  ];
}

/** A primary model and two empty slots: the state the page opens on. */
function previewDefaults(): RemoteDefaultModels {
  return {
    primary: 'anthropic/claude-sonnet-4.5',
    fast: null,
    image_understanding: null
  };
}

/** The model the two write-driven scenarios select for the fast slot. */
const PREVIEW_WRITE_MODEL: string = 'openbitfun:gpt-5-mini';

/**
 * The fixture desktop's request path.
 *
 * `hangWrites` is the one behaviour a static fixture cannot express any other
 * way: an answer that never arrives is what the locked page looks like, and it
 * cannot be faked by a state flag without also faking the busy lock that the
 * controller derives from the request being out.
 */
class PreviewModelDefaultsClient implements DeviceModelDefaultsRequestPath {
  hangWrites: boolean = false;
  private models: RemoteModelConfig[];
  private stored: RemoteDefaultModels;

  constructor(models: RemoteModelConfig[], stored: RemoteDefaultModels) {
    this.models = models;
    this.stored = stored;
  }

  // Declared as fields rather than methods: the pages bind the request path as a
  // property-typed shape, and ArkTS does not treat a method as one of those.
  getModelCatalog: (sessionId?: string) => Promise<RemoteModelCatalog> =
    async (): Promise<RemoteModelCatalog> => {
      return {
        version: 1,
        models: this.models.slice(),
        default_models: this.stored
      };
    };

  setModelDefaults: (
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ) => Promise<RemoteDefaultModels> = async (
    primary: string | null,
    fast: string | null,
    imageUnderstanding: string | null
  ): Promise<RemoteDefaultModels> => {
    if (this.hangWrites) {
      return new Promise<RemoteDefaultModels>((): void => {});
    }
    this.stored = {
      primary,
      fast,
      search: this.stored.search,
      image_understanding: imageUnderstanding,
      image_generation: this.stored.image_generation,
      speech_recognition: this.stored.speech_recognition
    };
    return this.stored;
  };
}

/**
 * The settings surface the production shell mounts, over the fixture's device
 * catalog. Only the two device-model requests differ from the app's own wiring.
 */
function previewActions(client: PreviewModelDefaultsClient): AppRootPresentationActions {
  const base = emptyAppRootPresentationActions();
  return {
    onWorkspaceTools: base.onWorkspaceTools,
    onNavigationBack: base.onNavigationBack,
    onConversationIntent: base.onConversationIntent,
    onCloseSidebar: base.onCloseSidebar,
    onCompactLayoutEntered: base.onCompactLayoutEntered,
    onLayoutModeChanged: base.onLayoutModeChanged,
    onRemoteHome: base.onRemoteHome,
    onSidebar: base.onSidebar,
    onSettings: {
      close: base.onSettings.close,
      accountSettled: base.onSettings.accountSettled,
      disconnect: base.onSettings.disconnect,
      clearPairing: base.onSettings.clearPairing,
      reconnect: base.onSettings.reconnect,
      openAccount: base.onSettings.openAccount,
      cloudCancelLogin: base.onSettings.cloudCancelLogin,
      cloudLogin: base.onSettings.cloudLogin,
      cloudLogout: base.onSettings.cloudLogout,
      cloudListDevices: async (): Promise<CloudAccountDevice[]> => [],
      cloudSelectDevice: base.onSettings.cloudSelectDevice,
      getPermissionMode: base.onSettings.getPermissionMode,
      setPermissionMode: base.onSettings.setPermissionMode,
      getDeviceModelCatalog: (): Promise<RemoteModelCatalog> => client.getModelCatalog(),
      setDeviceModelDefaults: (
        primary: string | null,
        fast: string | null,
        imageUnderstanding: string | null
      ): Promise<RemoteDefaultModels> => {
        return client.setModelDefaults(primary, fast, imageUnderstanding);
      },
      setLanguage: base.onSettings.setLanguage
    },
    onConnect: base.onConnect,
    onFilePreview: base.onFilePreview,
    generalStatus: base.generalStatus
  };
}

@ComponentV2
export struct DeviceModelDefaultsPreview {
  @Local shellState: AppShellState = new AppShellState();
  @Local remotePageState: RemotePageState = new RemotePageState();
  @Local actions: AppRootPresentationActions = emptyAppRootPresentationActions();
  private client: PreviewModelDefaultsClient =
    new PreviewModelDefaultsClient(previewModels(), previewDefaults());

  aboutToAppear(): void {
    const scenario = this.scenarioId();
    this.client = new PreviewModelDefaultsClient(
      scenario === 'device-model-empty' ? [] : previewModels(),
      previewDefaults()
    );
    this.client.hangWrites = scenario === 'device-model-writing';
    this.remotePageState.setAccountUserId('octocat');
    this.remotePageState.setAccountUsername('octocat');
    this.remotePageState.setControlTarget('account_device', 'account-desktop-1', 'Account desktop 1');
    this.remotePageState.setDesktopIdentity('Account desktop 1', 'account-desktop-1');
    this.remotePageState.connectionState = 'connected';
    // An older desktop is one that never advertised the command, so the page is
    // reached through the same capability check the app uses.
    this.remotePageState.setHostCapabilities(scenario === 'device-model-degraded' ?
      ['workspace_id_references_v1'] : [REMOTE_CAPABILITY_DEVICE_MODEL_DEFAULTS_V1]);
    this.actions = previewActions(this.client);
    this.shellState.showSettings = true;
    this.shellState.settingsSheet.setPage('deviceModels');
    const role = this.pickerRole(scenario);
    if (role.length > 0) {
      this.shellState.settingsSheet.openModelPick(role);
    }
    if (scenario === 'device-model-writing' || scenario === 'device-model-updated') {
      void this.driveWrite();
    }
  }

  /**
   * Runs the write the scenario is about, before the first frame.
   *
   * The sheet arms the same gate a moment later from its own parameters, so this
   * only has to happen first: a scenario that has to show a write in flight — or
   * its result — cannot wait for the page to be tapped.
   */
  private async driveWrite(): Promise<void> {
    const deviceModels = this.shellState.settingsSheet.deviceModels;
    deviceModels.bind(this.client);
    deviceModels.setGate({ supported: true, connected: true, deviceId: 'account-desktop-1' });
    await deviceModels.ensureLoaded();
    await deviceModels.selectRole('fast', PREVIEW_WRITE_MODEL);
  }

  private scenarioId(): string {
    const scenario = AppStorage.get<string>('scenarioId') ?? '';
    return scenario.endsWith('-dark') ? scenario.slice(0, scenario.length - 5) : scenario;
  }

  /** The role the picker is opened on, or an empty string for the settings page. */
  private pickerRole(scenario: string): string {
    if (scenario === 'device-model-pick-fast') {
      return 'fast';
    }
    if (scenario === 'device-model-pick-multimodal') {
      return 'image_understanding';
    }
    if (scenario === 'device-model-pick-primary') {
      return 'primary';
    }
    return '';
  }

  build() {
    AppShell({
      shellState: this.shellState,
      allowSidebar: true,
      content: () => {
        this.EmptyConversation()
      },
      settings: () => {
        this.Settings()
      },
      onCloseSidebar: () => {
        this.shellState.showSidebar = false;
      }
    })
  }

  @Builder
  private EmptyConversation() {
    Column()
      .width('100%')
      .height('100%')
      .backgroundColor(PAGE_BG)
  }

  @Builder
  private Settings() {
    AppSettingsSurface({
      shellState: this.shellState,
      remotePageState: this.remotePageState,
      actions: this.actions
    })
  }
}

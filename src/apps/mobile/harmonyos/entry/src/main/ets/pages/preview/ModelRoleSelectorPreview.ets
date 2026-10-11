import { RemoteModelCatalog, RemoteModelConfig } from '../../model/RemoteModels';
import { RemoteUiState } from '../../services/RemoteUiState';
import { ConversationUiModelCatalog, toConversationUiModelCatalog } from '../state/ConversationUiModels';
import { ComposerBar, ComposerPresentation } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';

/**
 * Drives the production composer with a model catalog fixture so the
 * primary/fast role rows, their resolved metadata, and the concrete-model role
 * badges can be inspected on a device.
 *
 * No account, host, or remote request is involved: the catalog is projected
 * through the same `toConversationUiModelCatalog` path the app uses, the
 * selection starts from the session model id the same way hydration does, and
 * the select handler records the payload it received instead of talking to a
 * host. The recorded payload is surfaced on screen so a screenshot can prove it.
 */
@ComponentV2
export struct ModelRoleSelectorPreview {
  @Local catalog: ConversationUiModelCatalog = toConversationUiModelCatalog(this.fixtureCatalog());
  @Local selectedModelId: string = RemoteUiState.selectedModelIdForCatalog(this.fixtureCatalog(), '');
  @Local received: string = '';
  @Local wide: boolean = false;
  // The model control lives in the expanded action row, and the composer only
  // expands for focus, an open selector, or a multiline draft. A two-line draft
  // reaches that state without depending on the emulator's IME.
  @Local draft: string = 'Model role selector probe\nor the fallback row';

  aboutToAppear(): void {
    // The launcher decides the posture through the scenario id, so both
    // presentations can be captured without an extra tap. Resize still toggles
    // the presentation live.
    this.wide = (AppStorage.get<string>('scenarioId') ?? '').endsWith('-wide');
  }

  private fixtureModel(id: string, name: string, provider: string, modelName: string,
    contextWindow: number, enabled: boolean): RemoteModelConfig {
    return {
      id: id,
      name: name,
      provider: provider,
      base_url: '',
      model_name: modelName,
      context_window: contextWindow,
      enabled: enabled,
      capabilities: []
    };
  }

  /** Four enabled models plus one disabled one, with distinct primary and fast targets. */
  private fixtureCatalog(): RemoteModelCatalog {
    return {
      version: 1,
      models: [
        this.fixtureModel('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5', 'anthropic',
          'claude-sonnet-4-5', 200000, true),
        this.fixtureModel('openbitfun:gpt-5-mini', 'GPT-5 mini', 'openai',
          'openbitfun:gpt-5-mini', 128000, true),
        this.fixtureModel('google/gemini-2.5-flash', 'Gemini 2.5 Flash', 'google',
          'gemini-2.5-flash', 1000000, true),
        this.fixtureModel('local:qwen3-coder', 'Qwen3 Coder', 'local', 'qwen3-coder', 32768, true),
        this.fixtureModel('legacy/disabled-model', 'Legacy model', 'legacy', 'legacy-model', 8192, false)
      ],
      default_models: {
        primary: 'anthropic/claude-sonnet-4.5',
        fast: 'openbitfun:gpt-5-mini',
        search: '',
        image_understanding: ''
      },
      session_model_id: 'fast'
    };
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('Resize').id('model-role-resize').onClick(() => { this.wide = !this.wide; })
      }
      Text(`selected=${this.selectedModelId} received=${this.received}`)
        .id('model-role-state').fontColor(INK)
      Blank()
      ComposerBar({
        presentation: this.wide ? ComposerPresentation.Floating : ComposerPresentation.Compact,
        chatInput: this.draft,
        modelCatalog: this.catalog,
        selectedModelId: this.selectedModelId,
        onChatInputChange: (value: string) => { this.draft = value; },
        onSelectModel: (modelId: string) => {
          this.received = modelId;
          this.selectedModelId = modelId;
        }
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }
}

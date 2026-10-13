import { DeviceModelDefaultsSheetState } from './DeviceModelDefaultsSheetState';

/**
 * Settings sheet navigation and editor drafts live here so a fold-driven
 * rebuild does not send the user back to the home list or wipe in-progress
 * local-model fields.
 *
 * It is also where the device model pages' controller lives. Those pages are two
 * levels of one workflow over the connected desktop — the settings page and the
 * role picker it pushes — so the controller outlives either of them and belongs
 * to the sheet state the sheet hands to both.
 */
@ObservedV2
export class SettingsSheetState {
  @Trace page: string = 'main';
  /**
   * The role the second-level picker edits. Empty while the picker is closed,
   * so a page rebuilt from the wrong level cannot open someone else's list.
   */
  @Trace pickRole: string = '';
  /** Device model role defaults for the connected desktop; reset when the sheet closes. */
  readonly deviceModels: DeviceModelDefaultsSheetState = new DeviceModelDefaultsSheetState();
  @Trace savedGeneralChatApiUrl: string = '';
  @Trace savedGeneralChatModelName: string = '';
  @Trace savedGeneralChatHasApiKey: boolean = false;
  @Trace draftApiUrl: string = '';
  @Trace draftApiKey: string = '';
  @Trace draftModelName: string = '';
  @Trace draftClearApiKey: boolean = false;
  @Trace editorDraftHydrated: boolean = false;

  setPage(page: string): void {
    if (page !== 'modelPick') {
      this.pickRole = '';
    }
    this.page = page;
  }

  /**
   * Pushes the role picker: the second level of the sheet's own page stack
   * (`main` → `deviceModels` → `modelPick`).
   */
  openModelPick(role: string): void {
    this.pickRole = role;
    this.page = 'modelPick';
  }

  /** Returns one level: the picker goes back to the settings page that pushed it. */
  backFromModelPick(): void {
    this.pickRole = '';
    this.page = 'deviceModels';
  }

  syncSaved(apiUrl: string, modelName: string, hasApiKey: boolean): void {
    this.savedGeneralChatApiUrl = apiUrl;
    this.savedGeneralChatModelName = modelName;
    this.savedGeneralChatHasApiKey = hasApiKey;
  }

  hydrateEditorDraft(apiUrl: string, modelName: string): void {
    if (this.editorDraftHydrated) {
      return;
    }
    this.draftApiUrl = apiUrl;
    this.draftModelName = modelName;
    this.draftApiKey = '';
    this.draftClearApiKey = false;
    this.editorDraftHydrated = true;
  }

  resetOnClose(): void {
    this.page = 'main';
    this.pickRole = '';
    this.deviceModels.reset();
    this.draftApiUrl = '';
    this.draftApiKey = '';
    this.draftModelName = '';
    this.draftClearApiKey = false;
    this.editorDraftHydrated = false;
  }
}

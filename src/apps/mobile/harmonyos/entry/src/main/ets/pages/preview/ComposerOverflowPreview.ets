import { ChatComposerPolicy } from '../../services/ChatComposerPolicy';
import { ComposerBar, ComposerPresentation } from '../components/ComposerBar';
import { INK, PAGE_BG } from '../components/Theme';

/**
 * One line of draft that is far wider than the collapsed field, so the field has
 * to mark what it cannot show.
 */
const OVERFLOW_DRAFT: string =
  'Keep the collapsed composer honest about what it cannot show: this draft is '
  + 'much wider than one line of the field, so the reader must see where it stops.';

/**
 * A newline puts the same production composer into its tall form, which is the
 * other half of the contract: the expanded field keeps a scrollable viewport and
 * the expanded action row carries the draft's supplemental microphone beside the
 * primary action.
 */
const MULTILINE_DRAFT: string =
  'Expanded draft, first line\nsecond line\nthird line';

/**
 * The composer's draft chrome as the phone draws it: an empty field reaches
 * dictation from the primary slot, a collapsed draft keeps its one line to
 * itself and marks the overflow with an ellipsis instead of scrolling sideways,
 * and an expanded draft gets the supplemental microphone beside Send.
 *
 * This mounts the production `ComposerBar` with the same capabilities the remote
 * chat surface uses and no host, so the pixels are the shipping pixels. The
 * `composer-overflow-state` line asks the production `ChatComposerPolicy` the
 * two questions that decide the chrome — which primary action the draft earns,
 * and whether the supplemental voice slot is wanted — so a screenshot can be read
 * without inferring the decision from the glyphs alone. `supplementalVoice`
 * reports the slot as mounted, not the bare policy answer: the collapsed field
 * gives its one line to the draft, so the slot only reaches the screen from the
 * expanded action row.
 *
 * **Next draft** cycles the three states on one install: the wide single line,
 * the empty field, and the multiline draft. **Resize** swaps the compact and
 * floating presentations without restarting the app.
 */
@ComponentV2
export struct ComposerOverflowPreview {
  @Local draftIndex: number = 0;
  @Local draft: string = OVERFLOW_DRAFT;
  @Local floating: boolean = false;

  aboutToAppear(): void {
    // The launcher picks the starting state and the posture through the scenario
    // id, so each draft can be captured without an extra tap.
    const scenarioId = AppStorage.get<string>('scenarioId') ?? '';
    this.draftIndex = this.startingDraftIndex(scenarioId);
    this.draft = this.draftFor(this.draftIndex);
    this.floating = scenarioId.endsWith('-wide');
  }

  private startingDraftIndex(scenarioId: string): number {
    if (scenarioId.startsWith('composer-overflow-empty')) {
      return 1;
    }
    return scenarioId.startsWith('composer-overflow-expanded') ? 2 : 0;
  }

  private draftFor(index: number): string {
    if (index === 1) {
      return '';
    }
    return index === 2 ? MULTILINE_DRAFT : OVERFLOW_DRAFT;
  }

  private nextDraft(): void {
    this.draftIndex = (this.draftIndex + 1) % 3;
    this.draft = this.draftFor(this.draftIndex);
  }

  /** The same expansion decision the composer makes, read from the policy. */
  private collapsed(): boolean {
    return !ChatComposerPolicy.isExpanded(this.draft, false, false);
  }

  private stateLine(): string {
    // The remote chat capabilities, an idle connection and no running turn: the
    // two draft states this fixture is about are decided by the text alone.
    const action = ChatComposerPolicy.primaryAction(
      this.draft, 0, false, false, false, true, true, 'connected', true);
    const collapsed = this.collapsed();
    // The policy owns whether a draft earns the slot; the collapsed field gives
    // its one line to the draft, so the slot only reaches the screen from the
    // expanded action row. Report what is mounted, which is what a reader can
    // check against the pixels.
    const supplementalVoice = !collapsed &&
      ChatComposerPolicy.shouldShowSupplementalVoice(this.draft, 0, false, true);
    const draft = this.draft.length === 0 ? 'empty' : `${this.draft.length} chars`;
    return `draft=${draft} collapsed=${collapsed} action=${action} ` +
      `supplementalVoice=${supplementalVoice}`;
  }

  build() {
    Column({ space: 8 }) {
      Row({ space: 8 }) {
        Button('Next draft').id('composer-overflow-draft').onClick(() => {
          this.nextDraft();
        })
        Button('Resize').id('composer-overflow-resize').onClick(() => {
          this.floating = !this.floating;
        })
      }
      Text(this.stateLine()).id('composer-overflow-state').fontColor(INK).fontSize(12)
      Blank()
      ComposerBar({
        presentation: this.floating ? ComposerPresentation.Floating : ComposerPresentation.Compact,
        chatInput: this.draft,
        onChatInputChange: (value: string) => {
          this.draft = value;
        }
      })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
  }
}

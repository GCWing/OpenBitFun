import { MobileDesignTypography, MobileDesignGeometry } from '../../generated/MobileDesignTokens';
import { RemoteI18n } from '../../i18n/RemoteI18n';
import { ConversationUiQuestionAnswer } from '../state/ConversationUiModels';
import { ACCENT, PRIMARY_ACTION, CARD, INK, LINE, MUTED, CONTENT_ON_ACTION, STATUS_DANGER, SOFT } from './Theme';

interface QuestionOption {
  label: string;
  description?: string;
}

interface QuestionInput {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface QuestionPayload {
  questions?: QuestionInput[];
}

@ComponentV2
export struct ToolConfirmationPanel {
  @Param toolId: string = '';
  @Param defaultInputText: string = '';
  @Param hasEditableInput: boolean = false;
  @Param leadingInset: number = 30;
  @Param compactActions: boolean = true;
  @Param isBusy: boolean = false;
  @Event onApproveTool: (toolId: string, updatedInput?: Object) => void =
    (_toolId: string, _updatedInput?: Object) => {};
  @Event onRejectTool: (toolId: string) => void = (_toolId: string) => {};
  @Local inputText: string = '';
  @Local inputError: string = '';

  aboutToAppear(): void {
    this.inputText = this.defaultInputText;
  }

  build() {
    Column({ space: 8 }) {
      if (this.hasEditableInput) {
        this.InputEditor()
      }
      if (this.compactActions) {
        Row({ space: MobileDesignGeometry.approvalCardGap }) {
          Blank()
          Button(RemoteI18n.t('chat.reject'))
            .fontSize(MobileDesignTypography.labelMedium.size).fontColor(INK)
            .height(MobileDesignGeometry.approvalActionHeight).padding({ left: 16, right: 16 })
            .backgroundColor(SOFT).borderRadius(MobileDesignGeometry.approvalActionRadius)
            .enabled(!this.isBusy)
            .onClick(() => this.onRejectTool(this.toolId))
          Button(RemoteI18n.t('chat.approve'))
            .fontSize(MobileDesignTypography.labelMedium.size).fontColor(CONTENT_ON_ACTION)
            .height(MobileDesignGeometry.approvalActionHeight).padding({ left: 16, right: 16 })
            .backgroundColor(PRIMARY_ACTION).borderRadius(MobileDesignGeometry.approvalActionRadius)
            .enabled(!this.isBusy).onClick(() => this.approve())
        }.width('100%')
      } else {
      Row({ space: 8 }) {
        Text(RemoteI18n.t('chat.approve'))
          .fontSize(MobileDesignTypography.labelMedium.size)
          .fontColor(CONTENT_ON_ACTION)
          .textAlign(TextAlign.Center)
          .height(32)
          .layoutWeight(1)
          .backgroundColor(ACCENT)
          .borderRadius(16)
          .enabled(!this.isBusy)
          .onClick(() => this.approve())
        Text(RemoteI18n.t('chat.reject'))
          .fontSize(MobileDesignTypography.labelMedium.size)
          .fontColor(INK)
          .textAlign(TextAlign.Center)
          .height(32)
          .layoutWeight(1)
          .backgroundColor(SOFT)
          .borderRadius(16)
          .border({ width: 1, color: LINE })
          .enabled(!this.isBusy)
          .onClick(() => this.onRejectTool(this.toolId))
      }
      .width('100%')
      }
    }
    .width('100%')
    .padding({ left: this.leadingInset })
  }

  @Builder
  private InputEditor() {
    Column({ space: 6 }) {
      Row() {
        Text(RemoteI18n.t('chat.toolInput')).fontSize(MobileDesignTypography.labelSmall.size).fontColor(MUTED)
        Blank()
        Text(RemoteI18n.t('chat.reset'))
          .fontSize(MobileDesignTypography.labelSmall.size)
          .fontColor(MUTED)
          .onClick(() => {
            this.inputText = this.defaultInputText;
            this.inputError = '';
          })
      }
      .width('100%')
      TextArea({ placeholder: RemoteI18n.t('chat.editJsonInput'), text: this.inputText })
        .height(96)
        .fontSize(MobileDesignTypography.labelSmall.size)
        .fontColor(INK)
        .lineHeight(MobileDesignTypography.labelSmall.lineHeight)
        .backgroundColor(SOFT)
        .borderRadius(14)
        .padding(10)
        .border({ width: 1, color: this.inputError.length > 0 ? STATUS_DANGER : LINE })
        .defaultFocus(false)
        .enabled(!this.isBusy)
        .onChange((value: string) => {
          this.inputText = value;
          this.inputError = '';
        })
      if (this.inputError.length > 0) {
        Text(this.inputError).fontSize(MobileDesignTypography.labelSmall.size).fontColor(STATUS_DANGER)
      }
    }
    .width('100%')
  }

  private approve(): void {
    if (this.toolId.length === 0 || this.isBusy) {
      return;
    }
    if (!this.hasEditableInput) {
      this.onApproveTool(this.toolId);
      return;
    }
    const rawInput = this.inputText.trim();
    if (rawInput.length === 0) {
      this.inputError = RemoteI18n.t('chat.jsonObjectRequired');
      return;
    }
    try {
      const parsed = JSON.parse(rawInput) as Object;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.inputError = RemoteI18n.t('chat.jsonObjectRequired');
        return;
      }
      this.inputError = '';
      this.onApproveTool(this.toolId, parsed);
    } catch (_err) {
      this.inputError = RemoteI18n.t('chat.jsonInvalid');
    }
  }
}

@ComponentV2
export struct ToolQuestionAnswerPanel {
  @Param toolId: string = '';
  @Param questionsJson: string = '';
  @Param isBusy: boolean = false;
  @Event onAnswerQuestion: (toolId: string, answers: ConversationUiQuestionAnswer) => void =
    (_toolId: string, _answers: ConversationUiQuestionAnswer) => {};
  @Local questions: QuestionInput[] = [];
  @Local selectedAnswers: Map<number, string[]> = new Map<number, string[]>();
  @Local customAnswers: Map<number, string> = new Map<number, string>();

  aboutToAppear(): void {
    this.questions = this.parseQuestions(this.questionsJson);
  }

  @Monitor('questionsJson')
  onQuestionsChanged(): void {
    this.questions = this.parseQuestions(this.questionsJson);
    this.selectedAnswers = new Map<number, string[]>();
    this.customAnswers = new Map<number, string>();
  }

  build() {
    Column({ space: 8 }) {
      ForEach(this.questions, (question: QuestionInput, index: number) => {
        this.Question(question, index);
      }, (question: QuestionInput, index: number) => `${index}:${question.header}:${question.question}`)
      Row() {
        Text(RemoteI18n.t('chat.submitAnswer'))
          .fontSize(MobileDesignTypography.labelMedium.size)
          .fontColor(this.canSubmit() ? CONTENT_ON_ACTION : MUTED)
          .textAlign(TextAlign.Center)
          .height(32)
          .layoutWeight(1)
          .backgroundColor(this.canSubmit() ? ACCENT : SOFT)
          .opacity(this.isBusy ? 0.5 : 1)
          .borderRadius(16)
          .onClick(() => this.submit())
      }
      .width('100%')
    }
    .width('100%')
    .padding({ left: 30 })
  }

  @Builder
  private Question(question: QuestionInput, index: number) {
    Column({ space: 6 }) {
      Text(question.header.length > 0 ? `${question.header}  ${question.question}` : question.question)
        .fontSize(MobileDesignTypography.bodyMedium.size)
        .lineHeight(MobileDesignTypography.bodyMedium.lineHeight)
        .fontColor(INK)
        .width('100%')
      ForEach(question.options, (option: QuestionOption) => {
        this.OptionRow(option, index, question.multiSelect === true)
      }, (option: QuestionOption) => option.label)
      if (this.isOtherSelected(index)) {
        TextArea({ placeholder: RemoteI18n.t('chat.answerPlaceholder'), text: this.customAnswers.get(index) || '' })
          .height(64).fontSize(MobileDesignTypography.labelSmall.size).backgroundColor(CARD).borderRadius(10).padding(10)
          .border({ width: 1, color: LINE }).defaultFocus(false).enabled(!this.isBusy)
          .onChange((value: string) => {
            const next = new Map<number, string>(this.customAnswers);
            next.set(index, value);
            this.customAnswers = next;
          })
      }
    }
    .width('100%')
  }

  // The label is the thing being chosen, so it wraps rather than truncates: an
  // option the user cannot read in full is one they cannot pick with any
  // confidence. That rules out a fixed row height and a side-by-side
  // description, which on a phone leaves the label a sliver of the row.
  @Builder
  private OptionRow(option: QuestionOption, index: number, multiSelect: boolean) {
    Row({ space: 8 }) {
      SymbolGlyph(this.isSelected(index, option.label) ?
        $r('sys.symbol.checkmark_circle_fill') : $r('sys.symbol.circle'))
        .fontSize(18)
        .fontColor([this.isSelected(index, option.label) ? INK : MUTED])
        .width(20)
      Column({ space: 3 }) {
        Text(option.label)
          .fontSize(MobileDesignTypography.bodyMedium.size)
          .lineHeight(MobileDesignTypography.bodyMedium.lineHeight)
          .fontColor(INK)
          .width('100%')
        if (option.description && option.description.length > 0) {
          Text(option.description)
            .fontSize(MobileDesignTypography.bodySmall.size)
            .lineHeight(MobileDesignTypography.bodySmall.lineHeight)
            .fontColor(MUTED)
            .maxLines(3)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding({ left: 10, right: 10, top: 9, bottom: 9 })
    .backgroundColor(this.isSelected(index, option.label) ? SOFT : CARD).borderRadius(10)
    .onClick(() => this.toggleOption(index, option.label, multiSelect))
  }

  private canSubmit(): boolean {
    if (this.isBusy || this.toolId.length === 0 || this.questions.length === 0) {
      return false;
    }
    return this.questions.every((_question: QuestionInput, index: number) => {
      const selected = this.selectedAnswers.get(index) || [];
      if (selected.length === 0) return false;
      return !this.isOtherSelected(index) || (this.customAnswers.get(index) || '').trim().length > 0;
    });
  }

  private isSelected(index: number, label: string): boolean {
    return (this.selectedAnswers.get(index) || []).indexOf(label) >= 0;
  }

  private isOtherSelected(index: number): boolean {
    return this.isSelected(index, RemoteI18n.t('common.other'));
  }

  private toggleOption(index: number, label: string, multiSelect: boolean): void {
    if (this.isBusy) return;
    const current = (this.selectedAnswers.get(index) || []).slice();
    if (multiSelect) {
      const position = current.indexOf(label);
      if (position >= 0) current.splice(position, 1);
      else current.push(label);
    } else {
      current.splice(0, current.length, label);
    }
    const next = new Map<number, string[]>(this.selectedAnswers);
    next.set(index, current);
    this.selectedAnswers = next;
  }

  private submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    const answers: ConversationUiQuestionAnswer = {};
    this.questions.forEach((question: QuestionInput, index: number) => {
      const selected = (this.selectedAnswers.get(index) || []).map((value: string) => {
        return value === RemoteI18n.t('common.other') ? (this.customAnswers.get(index) || '').trim() : value;
      });
      const value: string | string[] = question.multiSelect === true ? selected : selected[0];
      (answers as Record<string, Object>)[`${index}`] = value as Object;
    });
    this.onAnswerQuestion(this.toolId, answers);
  }

  private parseQuestions(value: string): QuestionInput[] {
    try {
      const payload = JSON.parse(value) as QuestionPayload;
      return (payload.questions || []).map((question: QuestionInput) => this.normalizeQuestion(question))
        .filter((question: QuestionInput) => question.question.length > 0);
    } catch (_err) {
      return [];
    }
  }

  private normalizeQuestion(question: QuestionInput): QuestionInput {
    const normalized: QuestionInput = {
      question: question.question || '',
      header: question.header || '',
      options: (question.options || []).slice(),
      multiSelect: question.multiSelect === true
    };
    const otherLabel = RemoteI18n.t('common.other');
    if (!normalized.options.some((option: QuestionOption) => option.label.trim().toLowerCase() === 'other' ||
      option.label === otherLabel)) {
      normalized.options.push({ label: otherLabel, description: '' });
    }
    return normalized;
  }
}

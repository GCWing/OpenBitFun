import { BusinessError, pasteboard } from '@kit.BasicServicesKit';
import { ObservableChatTimelineItem } from '../../model/ChatTimelineModels';
import { ChatMessage } from '../../model/RemoteModels';
import { ClipboardService } from '../../services/ClipboardService';
import { DeviceApiLevelService } from '../../services/DeviceApiLevelService';
import { MarkdownHtmlSerializer } from '../../services/MarkdownHtmlSerializer';
import { ConversationIntent, ConversationIntentType, MessageCopyScope } from '../actions/ConversationIntent';
import { ComposerPresentation } from '../components/ComposerBar';
import { ConversationView } from '../components/ConversationView';
import { ConversationViewOptions } from '../components/ConversationViewContract';
import { INK, LINE, MUTED, PAGE_BG, SOFT } from '../components/Theme';
import { WideLayoutGeometry } from '../layout/WideLayoutGeometry';
import { AdaptiveLayoutInput } from '../policy/AdaptiveLayoutInput';
import { ConversationLayoutPolicy } from '../policy/ConversationLayoutPolicy';
import { SelectionCapabilityPolicy } from '../policy/SelectionCapabilityPolicy';
import {
  SettingsPlacement,
  SettingsPlacementPolicy,
  SettingsSheetKind
} from '../policy/SettingsPlacementPolicy';
import { ChatSurface } from '../state/ChatSurface';
import { REMOTE_CHAT_COMPOSER_CAPABILITIES } from '../state/ChatComposerCapabilities';
import { ConversationViewState } from '../state/ConversationViewState';

/**
 * A message short enough to stay on the ordinary selectable bubble.
 */
const SHORT_USER_TEXT: string = '这段代码为什么会有内存泄漏？';

/**
 * A message long enough to be cut by the line rule: eleven lines against the
 * frozen eight.
 */
const LONG_USER_TEXT: string = [
  '请按下面的清单完整处理这次改动：',
  '1. 在会话时间线里定位用户消息的渲染路径；',
  '2. 为长消息加截断预览，并在行尾追加可点开的入口；',
  '3. 面板内要能长按选择并复制，手柄可以调整范围；',
  '4. 截断态气泡不给手柄，长按弹出轻量菜单；',
  '5. 复制成功后给出状态提示，不要静默失败；',
  '6. 浅色与深色主题都要检查对比度；',
  '7. 竖屏与平板横屏两种布局都要走一遍；',
  '8. 流式输出期间允许选中态被重置，但不能崩溃；',
  '9. 交付前补单测并跑一遍架构检查；',
  '10. 最后把设备证据截图归档。'
].join('\n');

/**
 * A single-line message long enough to be cut by the character rule: the
 * preview stops at 360 characters even though the message has one line. It has
 * to stay above that count with the preview still measurably shorter, which is
 * what makes the character branch distinguishable from the line branch in one
 * transcript.
 */
const LONG_SINGLE_LINE_TEXT: string = [
  '下面这一整段是一条没有换行的长提示，用来验证按字符截断的分支：',
  '它必须在预览里停在第三百六十个字符处并追加省略号，',
  '同时行尾仍然要有可以点开的入口，点开之后面板里要显示完整的这一段内容，',
  '面板内长按要能出现系统选择菜单与手柄，选择范围可以拖到整段文字之外，',
  '复制全文时写入剪贴板的必须是完整文本而不是这段预览，',
  '所以完整文本长度一定要明显大于预览长度，这样设备的回读报文才能把两者区分开，',
  '这一条同样要覆盖手柄拖动的边界：从一个字符切到整段，再从整段缩回一个词，',
  '手柄在长文里滑过折行位置时不能丢焦点，也不能把选中高亮留在已经离开的段落上，',
  '如果预览行的最后一个字符正好落在气泡右边缘，追加的省略号与入口仍然必须完整可见，',
  '浅色主题下入口用信息色加下划线，深色主题下同一个色板要保持可读而不刺眼，',
  '这条提示后面还要继续补充一些内容，让完整文本长度明显大于三百六十个字符的预览长度，',
  '否则回读到的长度数字不足以区分“复制全文”写的是整条消息还是这段预览，',
  '所以这里再补两句：第一句确认字符截断以后仍然可以继续长按选择，',
  '第二句确认这条消息在平板横屏与竖屏两种布局下都不会把入口挤出气泡，',
  '最后还要确认这一条消息在深色主题下同样可读、截断标记与链接颜色不互相干扰。'
].join('');

/**
 * An answer carrying every block the renderer draws, in one message: the
 * cross-block selection has to be able to run paragraph -> list -> code, and
 * the table and the code block are the two children that own a horizontal
 * `Scroll`, which is the interaction the container has to survive.
 */
const ASSISTANT_MARKDOWN: string = [
  '## 选择与复制验证',
  '',
  '第一段正文：**加粗**、*斜体*、`行内代码`、~~删除线~~，以及一个 [OpenBitFun 文档](https://example.com/docs) 链接。',
  '',
  '- 列表项 A：拖动手柄时选择应能越过这一项',
  '- 列表项 B：块间拼接应保留换行',
  '- [x] 已完成的复选项',
  '- [ ] 未完成的复选项',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '',
  '> 引用块：引用段落也参与连续选择。',
  '',
  '```ts',
  "const message = 'a code block line long enough to overflow the pane horizontally';",
  'console.log(message);',
  '```',
  '',
  '| 列 A | 列 B | 列 C |',
  '| --- | --- | --- |',
  '| 单元格一 | 单元格二 | 单元格三 |',
  '| 更长的单元格内容 | 更长的单元格内容 | 更长的单元格内容 |',
  '',
  '---',
  '',
  '结尾段落：用于确认分隔线之后仍可继续选择。'
].join('\n');

const ASSISTANT_SHORT_MARKDOWN: string =
  '收到，我按清单逐条处理，先给出结论：截断与全文面板都需要自己的选择表面。';

function message(id: string, role: string, text: string): ChatMessage {
  return { id, role, text, status: 'completed', timestamp: '0' };
}

function row(id: string, role: string, text: string): ObservableChatTimelineItem {
  return new ObservableChatTimelineItem({
    id,
    type: role === 'user' ? 'user_message' : 'assistant_message',
    message: message(id, role, text),
    isStreaming: false,
    isFinalizing: false
  });
}

function transcript(): ObservableChatTimelineItem[] {
  return [
    row('short-user', 'user', SHORT_USER_TEXT),
    row('markdown-answer', 'assistant', ASSISTANT_MARKDOWN),
    row('long-user', 'user', LONG_USER_TEXT),
    row('advice-answer', 'assistant', ASSISTANT_SHORT_MARKDOWN),
    row('long-line-user', 'user', LONG_SINGLE_LINE_TEXT)
  ];
}

/**
 * The copy and selection surface, over one transcript that carries every shape
 * the feature distinguishes: a short user message, an answer with all of the
 * markdown blocks, a line-cut user message, and a character-cut user message.
 *
 * A device check needs more than the pixels: whether the long press reached the
 * system selection menu, what the truncated bubble opened, and which clipboard
 * flavors a copy wrote are all invisible in a screenshot of the surface itself.
 * The strip above the conversation therefore states what the last intent asked
 * for and what the pasteboard actually holds afterwards, read back through the
 * same pasteboard the copy wrote to. The last requested copy scope and the
 * recorded mime types together are what proves the rich write really produced a
 * second flavor rather than a plain text that merely looks right.
 *
 * The scenario id picks the mount, and nothing else, because the mount is the
 * question: `copy-selection` renders the pane the way the wide detail leaf does,
 * `copy-selection-nav` pushes it through a `Navigation` the way the compact
 * route does, and `copy-selection-wide` forces the floating composer. The
 * placement and the composer presentation follow the real window width, so the
 * same fixture covers a phone and a tablet without a second scenario.
 */
@ComponentV2
export struct CopySelectionPreview {
  @Local state: ConversationViewState = new ConversationViewState();
  @Local placement: SettingsPlacement =
    SettingsPlacementPolicy.compactBottom(SettingsSheetKind.UserMessageFullText);
  @Local apiLevel: number = 0;
  @Local crossBlock: boolean = false;
  @Local lastIntent: string = '(none)';
  @Local clipboardReport: string = '(not read)';
  @Local viewportWidth: number = 0;
  private readonly clipboard: ClipboardService = new ClipboardService();
  private readonly navigationStack: NavPathStack = new NavPathStack();
  private routed: boolean = false;

  aboutToAppear(): void {
    this.state.surface = ChatSurface.Remote;
    this.state.connectionState = 'connected';
    this.state.activeSession = {
      sessionId: 'copy-selection-preview',
      title: 'Copy and selection',
      workspacePath: '/workspace',
      agentType: 'code'
    };
    this.state.desktopName = 'Studio';
    this.state.composerCapabilities = REMOTE_CHAT_COMPOSER_CAPABILITIES;
    this.state.timelineItems = transcript();
    this.state.timelineRevision = 1;
    this.apiLevel = DeviceApiLevelService.sdkApiVersion();
    this.crossBlock = SelectionCapabilityPolicy.supportsCrossBlockSelection(this.apiLevel);
    if (this.scenarioId() === 'copy-selection-nav' && !this.routed) {
      // Pushed rather than mounted as the navigation bar's own content: the
      // compact shell opens a conversation as a destination on its stack.
      this.routed = true;
      this.navigationStack.pushPath({ name: 'copy-selection' });
    }
  }

  private scenarioId(): string {
    return AppStorage.get<string>('scenarioId') ?? 'copy-selection';
  }

  private isWideViewport(): boolean {
    return this.viewportWidth >= ConversationLayoutPolicy.MD_MIN_WIDTH;
  }

  /**
   * The placement the app root would resolve for this window. The fixture has
   * no creases to offer and is not asked to reproduce a foldable, so the input
   * carries the measured viewport and nothing else.
   */
  private refreshGeometry(width: number, height: number): void {
    this.viewportWidth = width;
    this.placement = SettingsPlacementPolicy.resolve(
      new AdaptiveLayoutInput(width, height, 0, false, false, false, this.isWideViewport(), [], []),
      SettingsSheetKind.UserMessageFullText
    );
  }

  private options(): ConversationViewOptions {
    const options = new ConversationViewOptions();
    options.showSidebarButton = true;
    options.showBackButton = false;
    options.composerPresentation =
      this.isWideViewport() ? ComposerPresentation.Floating : ComposerPresentation.Compact;
    options.fullTextSheetPlacement = this.placement;
    return options;
  }

  private async handleIntent(intent: ConversationIntent): Promise<void> {
    if (intent.type === ConversationIntentType.CopyMessage) {
      await this.copyWithScope(intent.value, intent.copyScope);
      return;
    }
    if (intent.type === ConversationIntentType.OpenFilePreview) {
      // The link span sits inside the selection container; recording the intent
      // is what proves the tap still reached it.
      this.lastIntent = `open-link ${intent.value}`;
      return;
    }
    if (intent.type === ConversationIntentType.ChatInputChanged) {
      this.state.chatInput = intent.value;
      return;
    }
    this.lastIntent = `intent ${intent.type}`;
  }

  /**
   * The production clipboard write for one scope. The controller does this on a
   * paired host; the preview drives the same services directly so the pasteboard
   * really holds what a copy wrote.
   */
  private async copyWithScope(text: string, scope: MessageCopyScope): Promise<void> {
    try {
      if (scope === MessageCopyScope.Rich) {
        await this.clipboard.copyRich(text, MarkdownHtmlSerializer.toHtml(text));
      } else {
        await this.clipboard.writeText(text);
      }
      this.lastIntent = `copy ${scope} len=${text.length}`;
    } catch (err) {
      this.lastIntent = `copy ${scope} failed ${JSON.stringify(err)}`;
      return;
    }
    await this.readClipboard();
  }

  /**
   * What the pasteboard holds now: the mime types of every record with its
   * length, and the primary record's first characters. A rich copy that only
   * stated its scope would not be evidence that the html record was written, so
   * the readback is what turns one tap into a payload report.
   *
   * The text is read per record rather than through `PasteData.getPrimaryText()`:
   * measured on device, that accessor returns nothing here, so the primary record
   * is the first record exactly as the write ordered it.
   *
   * Measured on the emulator, this readback is not evidence of the payload: the
   * platform hands a plain app an empty `PasteData` (no records, no text) even
   * while the copy is in the clipboard, and a package without the pasteboard read
   * permission cannot go further. The strip therefore reports what the app is
   * given, and the authoritative payload read stays
   * `hidumper -s PasteboardService -a "--data"`, which states the record count
   * and the mime types the copy wrote.
   */
  private async readClipboard(): Promise<void> {
    try {
      const data = await pasteboard.getSystemPasteboard().getData();
      const count = data.getRecordCount();
      const types: string[] = [];
      let primaryText: string = '';
      for (let index = 0; index < count; index += 1) {
        const record = data.getRecord(index);
        const text = String(record.toPlainText());
        if (index === 0) {
          primaryText = text;
        }
        types.push(`${record.mimeType}(${text.length})`);
      }
      const head = primaryText.substring(0, 40).replace(/\n/g, ' ');
      this.clipboardReport = `records=${types.join(',')} plainLen=${primaryText.length} head="${head}"`;
    } catch (err) {
      const failure = err as BusinessError;
      this.clipboardReport = `read refused code=${failure?.code} message=${failure?.message}`;
    }
  }

  build() {
    Column() {
      this.Diagnostics()
      // The pane takes what is left, not the window's full height: the chat page
      // puts its own overlay at the bottom of whatever box it is given, so a pane
      // measured at the window's height draws its composer below the screen.
      Column() {
        if (this.scenarioId() === 'copy-selection-nav') {
          this.NavigationLayout()
        } else {
          this.Conversation()
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PAGE_BG)
    .onAreaChange((_oldArea: Area, newArea: Area) => {
      this.refreshGeometry(
        WideLayoutGeometry.areaLength(newArea.width),
        WideLayoutGeometry.areaLength(newArea.height)
      );
    })
  }

  /**
   * The compact route's own shape: a `Navigation` whose stack holds the
   * conversation as a pushed destination. This exists because a sheet bound
   * inside that subtree is the one placement the app has never used.
   */
  @Builder
  private NavigationLayout() {
    Navigation(this.navigationStack) {
      Column()
        .width('100%')
        .height('100%')
    }
      .width('100%')
      .height('100%')
      .hideTitleBar(true)
      .mode(NavigationMode.Stack)
      .navBarWidth('100%')
      .minContentWidth(0)
      .navDestination(this.Destination)
  }

  @Builder
  private Destination(name: string) {
    NavDestination() {
      this.Conversation()
    }
      .hideTitleBar(true)
      .backgroundColor(PAGE_BG)
  }

  @Builder
  private Conversation() {
    ConversationView({
      state: this.state,
      options: this.options(),
      onIntent: (intent: ConversationIntent): void => {
        void this.handleIntent(intent);
      }
    })
  }

  /**
   * The report strip. It lives above the pane rather than inside it so that
   * nothing it draws can be mistaken for the surface under test.
   */
  @Builder
  private Diagnostics() {
    Column({ space: 2 }) {
      Text(`scenario=${this.scenarioId()} api=${this.apiLevel} crossBlock=${this.crossBlock} ` +
        `sheet=${this.placement.mode} w=${Math.round(this.viewportWidth)}`)
        .id('copy-selection-scenario')
        .fontSize(10)
        .fontColor(MUTED)
        .width('100%')
      Text(`intent=${this.lastIntent}`)
        .id('copy-selection-intent')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(2)
      Text(`clip=${this.clipboardReport}`)
        .id('copy-selection-clipboard')
        .fontSize(10)
        .fontColor(INK)
        .width('100%')
        .maxLines(3)
    }
    .width('100%')
    // The shell is immersive, so the strip starts at the window's top edge and
    // has to clear the status bar itself; without the inset the clock draws over
    // the report it is there to be read against.
    .padding({ left: 12, right: 12, top: 48, bottom: 6 })
    .backgroundColor(SOFT)
    .border({ width: { bottom: 0.5 }, color: LINE })
  }
}

import { LayersPlusIcon } from "@openbitfun/ui";
import { toolsForComponent } from '@openbitfun/flow-chat-presentation/registry';
import { semanticToolCardPreviews } from './SemanticToolCardPreview';
import { createScenarioClock, execScenarios, execSnapshot, type ExecToolName } from '@openbitfun/flow-chat-presentation/scenarios';
import { ScenarioCommand, FlowGroupPreview, ThinkingPreview, ExplorePreview, ContextLoadPreview, RuntimeStatusPreview } from './FlowChatScenarios';
import {
  Fragment,
  useState,
  type ReactNode,
} from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowUp,
  BookOpen,
  CalendarClock,
  Circle,
  Code2,
  Cpu,
  FileEdit,
  FileText,
  FolderOpen,
  FolderSearch,
  GitBranch,
  GitCompare,
  Globe,
  Hourglass,
  Image as ImageIcon,
  Info,
  Layers,
  ListEnd,
  ListTodo,
  MessageSquare,
  Mic,
  Monitor,
  MousePointer,
  Plus,
  Pencil,
  Rocket,
  Search,
  SearchCheck,
  Shield,
  SquareTerminal,
  Terminal,
  Trash2,
  User,
  type LucideIcon,
} from "lucide-react";
import { IconButton } from "@openbitfun/ui";
import {
  AgentControlToolCard,
  AgentWaitToolCard,
  AmbientToolCard,
  AmbientToolCardHeader,
  AskUser,
  ChatComposer,
  ChatComposerActionButton,
  ChatComposerQueue,
  ChatComposerQueueAttachmentBadge,
  ChatComposerQueueHeader,
  ChatComposerQueueItem,
  ChatComposerQueueItemActions,
  ChatComposerQueueItemContent,
  ChatComposerQueueList,
  ChatComposerQueueTitle,
  ContextCompressionToolCard,
  ControlHubToolCard,
  ListModelsToolCard,
  CronToolCard,
  DefaultToolCard,
  DirectoryListToolCard,
  FileDiffToolCard,
  FileOperationToolCard,
  FlowChatMetricDetails,
  FlowChatTurnMetrics,
  GetToolSpecToolCard,
  GitToolCard,
  GlobSearchToolCard,
  GrepSearchToolCard,
  PageDeployToolCard,
  PagePublishToolCard,
  ProminentToolCard,
  ProminentToolCardSummary,
  ReadFileToolCard,
  ReviewSummaryToolCard,
  RunCodeToolCard,
  SessionControlToolCard,
  SessionMessageToolCard,
  SkillToolCard,
  TerminalControlToolCard,
  TodoToolCard,
  ToolCardChangeSummary,
  ToolCardActions,
  ToolCardCopyButton,
  ToolRelationRow,
  ViewImageToolCard,
  WebFetchToolCard,
  WebSearchToolCard,
  type FileOperationKind,
  type FlowChatToolStatus,
  type AskUserAnswers,
  type AskUserState,
} from "@openbitfun/ui/flow-chat";
import { componentRegistry } from "@openbitfun/ui/registry";
import { useI18n } from "../i18n";
import { usePresentationFormatNumber, usePresentationTranslate } from "./flowChatTranslation";
import "./FlowChatPreviewRegistry.css";

type RegisteredComponent = (typeof componentRegistry)[number];

export type FlowChatComponentMeta = Extract<
  RegisteredComponent,
  { readonly category: "flow-chat" }
>;
export type FlowChatComponentName = FlowChatComponentMeta["name"];
export type FlowChatPreviewAttention = "adaptive" | "ambient" | "prominent";
export type FlowChatPreviewSection = "framework" | "tool-card";
export type FlowChatPreviewState = FlowChatComponentMeta["states"][number];

export interface FlowChatToolSpecimen {
  tool: string;
}

interface FlowChatPreviewRenderOptions {
  interactive: boolean;
  specimen?: FlowChatToolSpecimen;
  state: FlowChatPreviewState;
}

type Translate = ReturnType<typeof useI18n>["t"];

export interface FlowChatPreviewDefinition {
  attention: FlowChatPreviewAttention;
  codeSample: (t: Translate) => string;
  icon: LucideIcon;
  render: (options: FlowChatPreviewRenderOptions) => ReactNode;
  section: FlowChatPreviewSection;
  specimens: readonly FlowChatToolSpecimen[];
}

type FlowChatPreviewDefinitionMap = {
  readonly [Name in FlowChatComponentName]: FlowChatPreviewDefinition;
};

type PreviewProps = FlowChatPreviewRenderOptions;

function TurnMetricsPreview({ state, interactive }: PreviewProps) {
  const t = usePresentationTranslate();
  const formatNumber = usePresentationFormatNumber();
  const unknown = state === "unknown";
  const tokenValue = formatNumber(24800);
  const rateValue = t("modelRound.metrics.rateValue", { value: formatNumber(42) });
  const tokenRows = [
    { label: t("modelRound.metrics.total"), value: tokenValue },
    { label: t("modelRound.metrics.input"), value: formatNumber(22400) },
    { label: t("modelRound.metrics.output"), value: formatNumber(2400) },
    ...(!unknown ? [{ label: t("modelRound.metrics.cache"), value: `${formatNumber(62.5)}%` }] : []),
  ];
  const rateRows = [{ label: t("modelRound.metrics.averageRate"), value: rateValue }];

  return <FlowChatTurnMetrics
    label={t("modelRound.metrics.label")}
    tokenValue={tokenValue}
    tokenDescription={tokenRows.map(row => `${row.label}: ${row.value}`).join(" · ")}
    tokenDetails={<FlowChatMetricDetails rows={tokenRows} />}
    cacheHitRate={unknown ? null : 0.625}
    rateValue={unknown ? null : rateValue}
    rateDescription={rateRows.map(row => `${row.label}: ${row.value}`).join(" · ")}
    rateDetails={<FlowChatMetricDetails rows={rateRows} note={t("modelRound.metrics.rateBasis")} />}
    speedLevel={unknown ? null : 3}
    focusable={interactive}
  />;
}

function RelationPreview({ state, interactive }: PreviewProps) {
  const t = usePresentationTranslate();
  const result = state === 'error' ? t('toolCards.default.failed') : state === 'loading'
    ? t('toolCards.interaction.sendingMessage') : t('toolCards.interaction.messageSent');
  return <ToolRelationRow status={resolveStatus(state)} result={result}
    interaction={{ operation: 'send', source: { kind: 'session', label: t('toolCards.interaction.currentSession') },
      target: { kind: 'agent', label: 'Maintainer' } }}
    details={interactive ? result : undefined} resultLabel={t('toolCards.interaction.inspectMessage')} />;
}

function ChatComposerPreview({ interactive, state }: PreviewProps) {
  const [value, setValue] = useState(state === "expanded" ? "Review the attached project notes and explain how the implementation should behave across narrow and wide windows." : "");
  const expanded = state === "expanded";
  const queued = state === "queued";

  return (
    <div className="flow-chat-composer-preview">
      <ChatComposer
        busy={state === "busy"}
        contextBar={state === "default" ? undefined : (
          <div className="flow-chat-composer-preview__context">
            <span><Monitor aria-hidden="true" />This computer</span>
            <span>OpenBitFun</span>
            <span><GitBranch aria-hidden="true" />1.0.0-explore</span>
            <span><Circle aria-hidden="true" />worktree</span>
            <span className="flow-chat-composer-preview__permission">
              <Shield aria-hidden="true" />Ask
            </span>
          </div>
        )}
        disabled={state === "disabled"}
        endActions={(
          <>
            <button
              className="flow-chat-composer-preview__model"
              disabled={state === "disabled"}
              type="button"
            >
              <span>deepseek-v4-pro</span>
              <small>high</small>
            </button>
            <ChatComposerActionButton
              aria-label="Voice input"
              disabled={state === "disabled"}
              icon={<Mic aria-hidden="true" />}
            />
            <ChatComposerActionButton
              aria-label="Send"
              disabled={state === "disabled"}
              icon={<ArrowUp aria-hidden="true" />}
              variant="primary"
            />
          </>
        )}
        layout={expanded ? "expanded" : "compact"}
        queue={queued ? (
          <ChatComposerQueue aria-label="Wait for sending">
            <ChatComposerQueueHeader>
              <ListEnd aria-hidden="true" />
              <ChatComposerQueueTitle count={13}>
                Wait for sending
              </ChatComposerQueueTitle>
            </ChatComposerQueueHeader>
            <ChatComposerQueueList>
              <ChatComposerQueueItem>
                <ChatComposerQueueItemContent>
                  Help me turn these two photos into Studio Ghibli style. Wait, maybe…
                </ChatComposerQueueItemContent>
                <ChatComposerQueueAttachmentBadge
                  count={3}
                  label="3 image attachments"
                />
                <ChatComposerQueueItemActions>
                  <IconButton
                    aria-label="Send now"
                    icon={<ArrowUp />}
                    size="xs"
                  />
                  <IconButton
                    aria-label="Delete"
                    icon={<Trash2 />}
                    size="xs"
                  />
                  <IconButton
                    aria-label="Edit"
                    icon={<Pencil />}
                    size="xs"
                  />
                </ChatComposerQueueItemActions>
              </ChatComposerQueueItem>
            </ChatComposerQueueList>
          </ChatComposerQueue>
        ) : undefined}
        startActions={(
          <ChatComposerActionButton
            aria-label="Add context"
            disabled={state === "disabled"}
            icon={<Plus aria-hidden="true" />}
            variant="fill"
          />
        )}
      >
        <textarea
          aria-label="Message"
          disabled={state === "disabled"}
          onChange={interactive ? (event) => setValue(event.target.value) : undefined}
          placeholder="How can I help you..."
          rows={expanded ? 3 : 1}
          value={value}
        />
      </ChatComposer>
    </div>
  );
}

function resolveStatus(state: FlowChatPreviewState): FlowChatToolStatus {
  if (state === "loading") return "running";
  if (state === "error") return "error";
  if (state === "confirmation") return "pending_confirmation";
  return "completed";
}

function FrameworkPreview({
  interactive,
  kind,
  state,
}: PreviewProps & { kind: "ambient" | "prominent" }) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(state === "expanded");
  const status = resolveStatus(state);
  const previewState = state === "hover" ? "hover" : undefined;
  const toggleExpanded = interactive
    ? () => setIsExpanded((expanded) => !expanded)
    : undefined;
  const expandedContent = (
    <div className="flow-chat-tool-card-preview__details">
      <code>HTTP 200 · size=2,486 bytes</code>
      <span>{t("components.preview.flowChat.completed")}</span>
    </div>
  );

  if (kind === "ambient") {
    return (
      <div className="flow-chat-tool-card-preview" data-preview-kind="ambient">
        <AmbientToolCard
          data-openbitfun-preview-state={previewState}
          expandedContent={expandedContent}
          header={(
            <AmbientToolCardHeader
              action={t("components.preview.flowChat.readFile")}
              content="src/flow_chat/tool-cards/index.ts"
              extra={state === "error"
                ? t("components.preview.flowChat.failed")
                : "128 lines"}
              icon={<FileText aria-hidden="true" />}
            />
          )}
          isExpanded={isExpanded}
          onClick={toggleExpanded}
          status={status}
        />
      </div>
    );
  }

  const actions = interactive ? (
    <ToolCardActions>
      <IconButton
        aria-label={t("components.preview.flowChat.download")}
        icon={<ArrowDownToLine aria-hidden="true" />}
        size="sm"
        variant="quiet"
      />
      <ToolCardCopyButton
        label={t("components.preview.flowChat.copy")}
        onPress={() => undefined}
      />
    </ToolCardActions>
  ) : undefined;

  return (
    <div className="flow-chat-tool-card-preview" data-preview-kind="prominent">
      <ProminentToolCard
        data-openbitfun-preview-state={previewState}
        errorContent={t("components.preview.flowChat.commandFailed")}
        expandedContent={expandedContent}
        summary={(
          <ProminentToolCardSummary
            action={t("components.preview.flowChat.runCommand")}
            actions={actions}
            content={(
              <code className="flow-chat-tool-card-preview__command">
                {'curl -s -o /dev/null -w "HTTP %{http_code}" https://openbitfun.com'}
              </code>
            )}
            extra={(
              <ToolCardChangeSummary
                additions={6}
                aria-label={t("components.preview.flowChat.changeSummary")}
                deletions={0}
              />
            )}
            icon={<SquareTerminal aria-hidden="true" />}
          />
        )}
        isExpanded={isExpanded}
        onToggle={toggleExpanded}
        requiresConfirmation={state === "confirmation"}
        status={status}
      />
    </div>
  );
}

function ReadFilePreview({ interactive, state }: PreviewProps) {
  const { t } = useI18n();
  const status = resolveStatus(state);
  const action = state === "loading"
    ? t("components.preview.flowChat.readingFile")
    : t("components.preview.flowChat.readFile");
  const content = state === "error"
    ? t("components.preview.flowChat.readFailed")
    : "src/flow_chat/tool-cards/index.ts · 128 lines";

  return (
    <div className="flow-chat-tool-card-preview">
      <ReadFileToolCard
        accessibleLabel={t("components.preview.flowChat.readFile")}
        action={action}
        content={content}
        data-openbitfun-preview-state={state === "hover" ? "hover" : undefined}
        interactive={interactive}
        onOpen={interactive ? () => undefined : undefined}
        status={status}
      />
    </div>
  );
}

function ContextCompressionPreview({ state }: PreviewProps) {
  const { t } = useI18n();
  const status = resolveStatus(state);

  return (
    <div className="flow-chat-tool-card-preview">
      <ContextCompressionToolCard
        data-openbitfun-preview-state={state === "hover" ? "hover" : undefined}
        error={state === "error"
          ? t("components.preview.flowChat.contextError")
          : undefined}
        processingText={status !== "error"
          ? t("components.preview.flowChat.contextProcessing")
          : undefined}
        status={status}
        summary={status === "completed"
          ? t("components.preview.flowChat.contextSummary")
          : undefined}
        title={t("components.preview.flowChat.contextCompression")}
      />
    </div>
  );
}

function CommandPreview({ interactive, specimen, state }: PreviewProps) {
  const [clock] = useState(createScenarioClock);
  const toolName: ExecToolName = specimen?.tool === 'WriteStdin' || specimen?.tool === 'ExecControl' ? specimen.tool : 'ExecCommand';
  const scenario = execScenarios.find(({ id }) => id === `${toolName}-lifecycle`)!;
  const item = state === 'confirmation' ? execSnapshot(toolName, { status: 'pending_confirmation' })
    : state === 'error' ? execScenarios.find(({ id }) => id === `${toolName}-error`)!.steps[1]!.item
    : state === 'loading' ? scenario.steps[1]!.item : scenario.steps.at(-1)!.item;
  return <ScenarioCommand item={item} clock={clock} interactive={interactive}
    initialExpanded={state === 'expanded' ? true : undefined} previewState={state === 'hover' ? 'hover' : undefined} />;
}

function resolveFileOperation(tool?: string): FileOperationKind {
  if (tool === "Delete") return "delete";
  if (tool === "Write") return "write";
  return "edit";
}

function FileOperationPreview({ interactive, specimen, state }: PreviewProps) {
  const { t } = useI18n();
  const operation = resolveFileOperation(specimen?.tool);
  const [isExpanded, setIsExpanded] = useState(state === "expanded");
  const status = resolveStatus(state);
  const path = operation === "write"
    ? "src/flow_chat/tool-cards/NewCard.tsx"
    : operation === "delete"
      ? "dist/stale-preview.js"
      : "src/flow_chat/components/FlowToolCard.tsx";
  const actionLabel = operation === "write"
    ? t("components.preview.flowChat.writeFile")
    : operation === "delete"
      ? t("components.preview.flowChat.deleteFile")
      : t("components.preview.flowChat.editFile");
  const preview = operation === "delete" ? undefined : (
    <pre className="flow-chat-tool-card-preview__diff">
      <span data-change="removed">- legacyToolCard</span>
      <span data-change="added">+ {operation === "write" ? "NewCard" : "FlowChatComponentPreview"}</span>
    </pre>
  );

  return (
    <div className="flow-chat-tool-card-preview">
      <FileOperationToolCard
        actionLabel={actionLabel}
        changeSummary={operation === "delete" ? undefined : {
          additions: operation === "write" ? 86 : 12,
          deletions: operation === "write" ? 0 : 4,
          label: t("components.preview.flowChat.fileChangeSummary"),
        }}
        data-openbitfun-preview-state={state === "hover" ? "hover" : undefined}
        error={state === "error" ? {
          message: t("components.preview.flowChat.fileErrorMessage"),
          title: t("components.preview.flowChat.fileErrorTitle"),
        } : undefined}
        isExpanded={isExpanded}
        onOpenFile={interactive && operation !== "delete" ? {
          label: t("components.preview.flowChat.openFile"),
          onPress: () => undefined,
        } : undefined}
        onToggle={interactive ? () => setIsExpanded((expanded) => !expanded) : undefined}
        operation={operation}
        path={path}
        pathLabel={path}
        preview={preview}
        requiresConfirmation={state === "confirmation"}
        status={status}
        statusDetail={state === "loading"
          ? t("components.preview.flowChat.fileLoading")
          : undefined}
      />
    </div>
  );
}

type ActivityPreviewKind = "agent-wait" | "get-tool-spec" | "skill" | "terminal-control";

function ActivityPreview({
  kind,
  state,
}: PreviewProps & { kind: ActivityPreviewKind }) {
  const { t } = useI18n();
  const status = resolveStatus(state);
  const shared = {
    "data-openbitfun-preview-state": state === "hover" ? "hover" : undefined,
    status,
    summary: state === "error"
      ? t("components.preview.flowChat.failed")
      : state === "loading"
        ? t("components.preview.flowChat.running")
        : t("components.preview.flowChat.completed"),
  };

  const card = kind === "agent-wait"
    ? <AgentWaitToolCard {...shared} action="AgentWait" />
    : kind === "get-tool-spec"
      ? <GetToolSpecToolCard {...shared} action="GetToolSpec" />
      : kind === "skill"
        ? <SkillToolCard {...shared} action="Skill" />
        : <TerminalControlToolCard {...shared} action="TerminalControl" />;

  return <div className="flow-chat-tool-card-preview">{card}</div>;
}

type SearchPreviewKind = "directory" | "glob" | "grep" | "web";

function SearchPreview({
  interactive,
  kind,
  state,
}: PreviewProps & { kind: SearchPreviewKind }) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(state === "expanded");
  const status = resolveStatus(state);
  const Component = kind === "directory"
    ? DirectoryListToolCard
    : kind === "glob"
      ? GlobSearchToolCard
      : kind === "grep"
        ? GrepSearchToolCard
        : WebSearchToolCard;
  const summary = state === "loading"
    ? t("components.preview.flowChat.running")
    : state === "error"
      ? t("components.preview.flowChat.failed")
      : kind === "directory"
        ? "List src/ · 18 entries"
        : kind === "glob"
          ? "Find **/*.tsx · 42 files"
          : kind === "grep"
            ? "Search ToolCard · 27 matches"
            : "Search FlowChat component architecture · 3 results";

  return (
    <div className="flow-chat-tool-card-preview">
      <Component
        action={kind === "grep" ? "Search text:" : kind === "glob" ? "Search files:" : "Search:"}
        data-openbitfun-preview-state={state === "hover" ? "hover" : undefined}
        details={[
          { label: "Scope", value: "src/flow_chat" },
          { label: "Results", value: "3" },
        ]}
        isExpanded={isExpanded}
        onToggle={interactive ? () => setIsExpanded((value) => !value) : undefined}
        resultText={kind === "grep" ? "FlowToolCard.tsx:42\nindex.ts:88\nREADME.md:17" : undefined}
        results={kind === "grep" ? undefined : [
          {
            description: kind === "web" ? "Reusable FlowChat card anatomy and migration boundary." : undefined,
            icon: kind === "web" ? "link" : "file",
            key: "one",
            onOpen: interactive && kind === "web" ? () => undefined : undefined,
            title: kind === "web" ? "FlowChat tool cards" : "src/flow_chat/tool-cards/index.ts",
            url: kind === "web" ? "https://openbitfun.com/docs/flow-chat" : undefined,
          },
          {
            icon: kind === "directory" ? "directory" : "file",
            key: "two",
            title: kind === "directory" ? "components/" : "design-system/packages/ui/src/flow-chat.ts",
          },
        ]}
        status={status}
        summary={summary}
      />
    </div>
  );
}

function SessionPreview({
  interactive,
  kind,
  state,
}: PreviewProps & { kind: "control" | "message" }) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(state === "expanded");
  const status = resolveStatus(state);
  const common = {
    "data-openbitfun-preview-state": state === "hover" ? "hover" : undefined,
    action: kind === "control" ? "SessionControl" : "SessionMessage",
    error: state === "error" ? t("components.preview.flowChat.failed") : undefined,
    fields: [
      { label: "Session", value: "review-42" },
      { label: "Workspace", value: "OpenBitFun" },
    ],
    isExpanded,
    onToggle: interactive ? () => setIsExpanded((value) => !value) : undefined,
    status,
    summary: state === "loading"
      ? t("components.preview.flowChat.running")
      : t("components.preview.flowChat.completed"),
  };

  return (
    <div className="flow-chat-tool-card-preview">
      {kind === "control" ? (
        <SessionControlToolCard
          {...common}
          sessions={[{ agentType: "review", id: "review-42", key: "review-42", name: "UI audit" }]}
        />
      ) : (
        <SessionMessageToolCard
          {...common}
          message="Please verify the public FlowChat component contract."
          messageLabel="Message"
        />
      )}
    </div>
  );
}

const PREVIEW_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='320' viewBox='0 0 320 320'%3E%3Crect width='320' height='320' rx='32' fill='%23232a35'/%3E%3Cpath d='M60 235l64-76 42 45 31-36 63 67z' fill='%237e8ca3'/%3E%3Ccircle cx='224' cy='91' r='25' fill='%23c6cfdb'/%3E%3C/svg%3E";

type StandardAmbientPreviewKind = "cron" | "default" | "run-code" | "todo" | "view-image" | "web-fetch" | "list-models" | "control-hub";

function StandardAmbientPreview({
  interactive,
  kind,
  specimen,
  state,
}: PreviewProps & { kind: StandardAmbientPreviewKind }) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(state === "expanded");
  const status = resolveStatus(state);
  const common = {
    "data-openbitfun-preview-state": state === "hover" ? "hover" : undefined,
    isExpanded,
    onToggle: interactive ? () => setIsExpanded((value) => !value) : undefined,
    status,
  };

  let card: ReactNode;
  if (kind === "list-models") {
    card = <ListModelsToolCard {...common} action={t("runtimeCards.modelsTitle")}
      models={[]} modelsLabel={t("runtimeCards.modelsTitle")} modelIdLabel={t("runtimeCards.modelId")}
      emptyContent={state === "loading" ? undefined : t("runtimeCards.emptyModels")}
      error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
      summary={state === "loading" ? t("components.preview.flowChat.running") : t("runtimeCards.modelsTitle")} />;
  } else if (kind === "control-hub") {
    card = <ControlHubToolCard {...common} action={t("runtimeCards.controlTitle")} domain="meta" attention="ambient"
      resultLabel={t("runtimeCards.result")} fields={[{ label: t("runtimeCards.controlTitle"), value: "meta.capabilities" }]}
      requiresConfirmation={state === "confirmation"}
      error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
      summary={state === "loading" ? t("components.preview.flowChat.running") : "meta.capabilities"} />;
  } else if (kind === "run-code") {
    card = (
      <RunCodeToolCard
        {...common}
        action="RunCode"
        error={state === "error" ? t("components.preview.flowChat.commandFailed") : undefined}
        output="packages built\ncontracts verified"
        outputLabel="Output"
        program={<pre className="flow-chat-tool-card-preview__output">await verifyDesignSystem();</pre>}
        programLabel="Program"
        summary="Verify the independent FlowChat package"
      />
    );
  } else if (kind === "web-fetch") {
    card = (
      <WebFetchToolCard
        {...common}
        action="WebFetch"
        content="FlowChat components expose stable semantic props and public data contracts."
        details={["markdown", "96 chars"]}
        error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
        onOpenUrl={interactive ? () => undefined : undefined}
        openUrlLabel="Open source"
        title="FlowChat architecture"
        url="https://openbitfun.com/docs/flow-chat"
      />
    );
  } else if (kind === "default") {
    const toolName = specimen?.tool ?? "UnregisteredTool";
    card = (
      <DefaultToolCard
        {...common}
        description="Standard fallback presentation"
        displayName={toolName}
        error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
        inputLabel="Input"
        inputPreview={'{\n  "scope": "flow-chat"\n}'}
        requiresConfirmation={state === "confirmation"}
        resultLabel="Result"
        resultPreview="Contract verified"
        summary={state === "confirmation" ? "Waiting for confirmation" : "Contract verified"}
        toolName={toolName}
      />
    );
  } else if (kind === "view-image") {
    card = (
      <ViewImageToolCard
        {...common}
        alt="FlowChat preview sample"
        errorText={t("components.preview.flowChat.failed")}
        imageFailed={state === "error"}
        previewLabel="Open image preview"
        source={state === "loading" ? undefined : PREVIEW_IMAGE}
        statusText={state === "loading" ? t("components.preview.flowChat.running") : "Viewed image"}
      />
    );
  } else if (kind === "cron") {
    card = (
      <CronToolCard
        {...common}
        action="Scheduled job:"
        error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
        fields={[
          { label: "Schedule:", value: "Every 30 minutes" },
          { label: "Next run:", value: "Today 14:30" },
          { label: "Enabled:", value: "Yes" },
          { label: "Job id:", value: "job_7f3a91" },
        ]}
        message={isExpanded ? "Summarize the open pull requests and report blockers." : undefined}
        messageLabel="Payload"
        summary={state === "error"
          ? t("components.preview.flowChat.failed")
          : "Created Nightly repository review"}
      />
    );
  } else {
    card = (
      <TodoToolCard
        {...common}
        allCompleted={false}
        completedCount={1}
        items={[
          { content: "Define public component", key: "one", status: "completed" },
          { content: "Migrate FlowChat adapter", key: "two", status: "in_progress" },
          { content: "Remove legacy CSS", key: "three", status: "pending" },
        ]}
        loading={state === "loading"}
        mode="standard"
        summary="Migrate FlowChat adapter"
        title="Tasks"
        totalCount={3}
      />
    );
  }

  return <div className="flow-chat-tool-card-preview">{card}</div>;
}

type ProminentPreviewKind = "agent" | "diff" | "git" | "page-deploy" | "page-publish" | "review";

function ConcreteProminentPreview({
  interactive,
  kind,
  state,
}: PreviewProps & { kind: ProminentPreviewKind }) {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(state === "expanded");
  const status = resolveStatus(state);
  const common = {
    "data-openbitfun-preview-state": state === "hover" ? "hover" : undefined,
    isExpanded,
    onToggle: interactive ? () => setIsExpanded((value) => !value) : undefined,
    status,
  };

  let card: ReactNode;
  if (kind === "agent") {
    card = (
      <AgentControlToolCard
        status={status}
        agentName="reviewer"
        onOpenAgent={interactive ? () => undefined : undefined}
        openAgentLabel="Open agent"
        statusLabel={state === "error" ? t("components.preview.flowChat.failed")
          : state === "loading" ? t("components.preview.flowChat.running") : undefined}
        statusTone={state === "error" ? "danger" : "neutral"}
        summary="Review the shared FlowChat card boundary"
      />
    );
  } else if (kind === "diff") {
    card = (
      <FileDiffToolCard
        {...common}
        action="GetFileDiff:"
        changeSummary={{
          additions: 12,
          deletions: 4,
          label: t("components.preview.flowChat.fileChangeSummary"),
        }}
        error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
        loading={state === "loading"}
        message="Public component migration"
        path="src/flow_chat/components/FlowToolCard.tsx"
        pathLabel="FlowToolCard.tsx"
        textPreview="- legacy shell\n+ public component"
      />
    );
  } else if (kind === "git") {
    card = (
      <GitToolCard
        {...common}
        action="Git:"
        command="git diff --stat"
        error={state === "error" ? t("components.preview.flowChat.commandFailed") : undefined}
        footerItems={[{ label: "Exit", tone: "success", value: "0" }]}
        loading={state === "loading"}
        statusSummary="21 files changed"
        stdout="21 files changed, 842 insertions(+), 517 deletions(-)"
      />
    );
  } else if (kind === "review") {
    card = (
      <ReviewSummaryToolCard
        {...common}
        changedFiles={["FlowToolCard.tsx", "registry.ts"]}
        fileCountLabel="2 files"
        filesLabel="Changed files"
        kind="review"
        loading={state === "loading"}
        summary="No blocking issues found in the component boundary."
        title="Review: 0 issues"
      />
    );
  } else {
    const Component = kind === "page-deploy" ? PageDeployToolCard : PagePublishToolCard;
    card = (
      <Component
        {...common}
        action={kind === "page-deploy" ? "PageDeploy:" : "PagePublish:"}
        error={state === "error" ? t("components.preview.flowChat.failed") : undefined}
        fields={[
          { label: "Slug", value: "flow-chat-cards" },
          { label: "Version", value: "v42" },
        ]}
        loading={state === "loading"}
        subject="flow-chat-cards"
        version="v42"
      />
    );
  }

  return <div className="flow-chat-tool-card-preview">{card}</div>;
}

function concreteCodeSample(name: string) {
  return () => `import { ${name} } from "@openbitfun/ui/flow-chat";\n\n<${name} status="completed" />`;
}

function AskUserPreview({ interactive, state }: PreviewProps) {
  const { t } = useI18n();
  const formatNumber = usePresentationFormatNumber();
  const completed = state === "completed";
  const startsSelected = completed
    || state === "submitted"
    || state === "selected"
    || state === "submitting"
    || state === "disabled";
  const [answers, setAnswers] = useState<AskUserAnswers>(
    startsSelected ? { version: ["beta"] } : {},
  );
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(state === "submitted");
  const componentState: AskUserState = state === "loading"
    ? "loading"
    : state === "error"
      ? "error"
      : state === "submitting"
        ? "submitting"
        : completed
          ? "completed"
          : submitted ? "submitted" : "asking";
  const questions = [{
    customOption: {
      description: t("components.preview.flowChat.askUserOtherDescription"),
      inputLabel: t("components.preview.flowChat.askUserOtherInputLabel"),
      label: t("components.preview.flowChat.askUserOther"),
      placeholder: t("components.preview.flowChat.askUserOtherPlaceholder"),
      value: "other",
    },
    id: "version",
    label: t("components.preview.flowChat.askUserSummaryPrefix"),
    options: [
      {
        description: t("components.preview.flowChat.askUserBetaDescription"),
        label: "v0.2.19-beta.1 (Recommended)",
        value: "beta",
      },
      {
        description: t("components.preview.flowChat.askUserStableDescription"),
        label: "v0.2.18",
        value: "stable",
      },
      {
        description: t("components.preview.flowChat.askUserNightlyDescription"),
        label: t("components.preview.flowChat.askUserNightly"),
        value: "nightly",
      },
    ],
    prompt: t("components.preview.flowChat.askUserQuestion"),
    selectionMode: "single" as const,
  }];
  const selectedValue = answers.version?.[0];
  const hasAnswer = Boolean(selectedValue && (selectedValue !== "other" || customAnswers.version?.trim()));
  const statusLabel = componentState === "loading"
    ? t("components.preview.flowChat.askUserLoading")
    : componentState === "error"
      ? t("components.preview.flowChat.askUserError")
      : componentState === "submitting"
        ? t("components.preview.flowChat.askUserSubmitting")
        : t("components.preview.flowChat.askUserWaiting");

  return (
    <div className="flow-chat-tool-card-preview">
      <AskUser
        answers={answers}
        customAnswers={customAnswers}
        disabled={state === "disabled"}
        navigation={{
          backLabel: t("components.preview.flowChat.askUserBack"),
          nextLabel: t("components.preview.flowChat.askUserNext"),
          progressLabel: (current, total) => t("components.preview.flowChat.askUserProgress", {
            current: formatNumber(current), total: formatNumber(total),
          }),
          selectionLabel: (selected, total) => t("components.preview.flowChat.askUserSelection", {
            selected: formatNumber(selected), total: formatNumber(total),
          }),
        }}
        onAnswersChange={interactive ? (questionId, values) => {
          setAnswers((current) => ({ ...current, [questionId]: values }));
        } : undefined}
        onCustomAnswerChange={interactive ? (questionId, value) => {
          setCustomAnswers((current) => ({ ...current, [questionId]: value }));
        } : undefined}
        onSubmit={interactive ? () => setSubmitted(true) : undefined}
        questions={componentState === "error" ? [] : questions}
        state={componentState}
        statusLabel={completed || submitted || componentState === "asking" ? undefined : statusLabel}
        submitDisabled={!hasAnswer}
        submitLabel={completed || submitted || componentState === "loading" || componentState === "error"
          ? undefined
          : t("components.preview.flowChat.askUserSubmit")}
        submittingLabel={t("components.preview.flowChat.askUserSubmitting")}
      />
    </div>
  );
}

export const flowChatPreviewDefinitions = {
  ...semanticToolCardPreviews,
  ListModelsToolCard: {
    attention: "ambient", icon: Cpu, section: "tool-card",
    codeSample: () => '<ListModelsToolCard status={status} action={label} models={models} modelsLabel={label} modelIdLabel={idLabel} isExpanded={expanded} onToggle={toggle} />',
    render: (options) => <StandardAmbientPreview {...options} kind="list-models" />,
    specimens: toolsForComponent("ListModelsToolCard").map((tool) => ({ tool })),
  },
  ControlHubToolCard: {
    attention: "adaptive", icon: MousePointer, section: "tool-card",
    codeSample: () => '<ControlHubToolCard status={status} action={label} attention={attention} domain={domain} resultLabel={resultLabel} fields={fields} isExpanded={expanded} onToggle={toggle} />',
    render: (options) => <StandardAmbientPreview {...options} kind="control-hub" />,
    specimens: toolsForComponent("ControlHubToolCard").map((tool) => ({ tool })),
  },
  ThinkingBlock: {
    attention: "ambient", icon: Info, section: "framework", specimens: [],
    codeSample: () => '<ThinkingBlock expanded={expanded} label={label} onToggle={toggle}>{content}</ThinkingBlock>',
    render: (options) => <ThinkingPreview {...options} />,
  },
  FlowGroup: {
    attention: "ambient", icon: LayersPlusIcon, section: "framework", specimens: [],
    codeSample: () => '<FlowGroup expanded={expanded} summary={summary} onExpandedChange={setExpanded}>{items}</FlowGroup>',
    render: (options) => <FlowGroupPreview {...options} />,
  },
  ExploreGroup: {
    attention: "ambient", icon: Search, section: "framework", specimens: [],
    codeSample: () => '<ExploreGroup expanded={expanded} summary={summary} onToggle={toggle}>{items}</ExploreGroup>',
    render: (options) => <ExplorePreview {...options} />,
  },
  ContextLoadGroup: {
    attention: "ambient", icon: LayersPlusIcon, section: "framework", specimens: [],
    codeSample: () => '<ContextLoadGroup expanded={expanded} summary={summary} itemCount={count} onToggle={toggle}>{items}</ContextLoadGroup>',
    render: (options) => <ContextLoadPreview {...options} />,
  },
  FlowChatRuntimeStatus: {
    attention: "ambient", icon: Hourglass, section: "framework", specimens: [],
    codeSample: () => '<FlowChatRuntimeStatus label={hint} visible={visible} />',
    render: (options) => <RuntimeStatusPreview {...options} />,
  },
  FlowChatTurnMetrics: {
    attention: "ambient", icon: Cpu, section: "framework", specimens: [],
    codeSample: () => '<FlowChatTurnMetrics label={label} tokenValue={tokens} tokenDescription={tokenDescription} cacheHitRate={cacheHitRate} rateValue={rate} rateDescription={rateDescription} speedLevel={speedLevel} />',
    render: (options) => <TurnMetricsPreview {...options} />,
  },
  AgentControlToolCard: {
    attention: "prominent",
    codeSample: concreteCodeSample("AgentControlToolCard"),
    icon: User,
    render: (options) => <ConcreteProminentPreview {...options} kind="agent" />,
    section: "tool-card",
    specimens: toolsForComponent("AgentControlToolCard").map((tool) => ({ tool })),
  },
  AgentWaitToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("AgentWaitToolCard"),
    icon: Hourglass,
    render: (options) => <ActivityPreview {...options} kind="agent-wait" />,
    section: "tool-card",
    specimens: toolsForComponent("AgentWaitToolCard").map((tool) => ({ tool })),
  },
  ToolRelationRow: {
    attention: 'adaptive', icon: MessageSquare, section: 'framework',
    codeSample: () => '<ToolRelationRow interaction={relationship} result={outcome} status="completed" details={message} />',
    render: (options) => <RelationPreview {...options} />,
    specimens: toolsForComponent('ToolRelationRow').map((tool) => ({ tool })),
  },
  AmbientToolCard: {
    attention: "ambient",
    codeSample: (t) => `import { AmbientToolCard, AmbientToolCardHeader } from "@openbitfun/ui/flow-chat";\nimport { FileText } from "lucide-react";\n\n<AmbientToolCard\n  status="completed"\n  header={(\n    <AmbientToolCardHeader\n      icon={<FileText />}\n      action="${t("components.preview.flowChat.readFile")}"\n      content="src/flow_chat/tool-cards/index.ts"\n    />\n  )}\n/>`,
    icon: FileText,
    render: (options) => <FrameworkPreview {...options} kind="ambient" />,
    section: "framework",
    specimens: toolsForComponent("AmbientToolCard").map((tool) => ({ tool })),
  },
  AskUser: {
    attention: "prominent",
    codeSample: () => `import { AskUser } from "@openbitfun/ui/flow-chat";\n\n<AskUser\n  answers={answers}\n  customAnswers={customAnswers}\n  questions={questions}\n  state="completed"\n/>`,
    icon: MessageSquare,
    render: (options) => <AskUserPreview {...options} />,
    section: "tool-card",
    specimens: toolsForComponent("AskUser").map((tool) => ({ tool })),
  },
  ChatComposer: {
    attention: "adaptive",
    codeSample: () => `import { ChatComposer } from "@openbitfun/ui/flow-chat";\n\n<ChatComposer\n  contextBar={<WorkspaceContext />}\n  queue={pendingMessages.length ? <PendingMessageQueue items={pendingMessages} /> : undefined}\n  layout={multiline ? "expanded" : "compact"}\n  startActions={<AddMenu />}\n  endActions={<ComposerActions />}\n>\n  <RichTextEditor />\n</ChatComposer>`,
    icon: MessageSquare,
    render: (options) => <ChatComposerPreview {...options} />,
    section: "framework",
    specimens: toolsForComponent("ChatComposer").map((tool) => ({ tool })),
  },
  CommandToolCard: {
    attention: "prominent",
    codeSample: (t) => `import { CommandToolCard } from "@openbitfun/ui/flow-chat";\n\n<CommandToolCard\n  action="${t("components.preview.flowChat.runCommand")}"\n  command="pnpm run design-system:check"\n  emptyCommand="${t("components.preview.flowChat.emptyCommand")}"\n  isExpanded={isExpanded}\n  onToggle={() => setIsExpanded((value) => !value)}\n  output={<TerminalOutput />}\n  status="completed"\n/>`,
    icon: Terminal,
    render: (options) => <CommandPreview {...options} />,
    section: "tool-card",
    specimens: toolsForComponent("CommandToolCard").map((tool) => ({ tool })),
  },
  ContextCompressionToolCard: {
    attention: "prominent",
    codeSample: (t) => `import { ContextCompressionToolCard } from "@openbitfun/ui/flow-chat";\n\n<ContextCompressionToolCard\n  status="completed"\n  summary="${t("components.preview.flowChat.contextSummary")}"\n  title="${t("components.preview.flowChat.contextCompression")}"\n/>`,
    icon: Archive,
    render: (options) => <ContextCompressionPreview {...options} />,
    section: "tool-card",
    specimens: toolsForComponent("ContextCompressionToolCard").map((tool) => ({ tool })),
  },
  CronToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("CronToolCard"),
    icon: CalendarClock,
    render: (options) => <StandardAmbientPreview {...options} kind="cron" />,
    section: "tool-card",
    specimens: toolsForComponent("CronToolCard").map((tool) => ({ tool })),
  },
  DefaultToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("DefaultToolCard"),
    icon: Info,
    render: (options) => <StandardAmbientPreview {...options} kind="default" />,
    section: "tool-card",
    specimens: toolsForComponent("DefaultToolCard").map((tool) => ({ tool })),
  },
  DirectoryListToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("DirectoryListToolCard"),
    icon: FolderOpen,
    render: (options) => <SearchPreview {...options} kind="directory" />,
    section: "tool-card",
    specimens: toolsForComponent("DirectoryListToolCard").map((tool) => ({ tool })),
  },
  FileDiffToolCard: {
    attention: "prominent",
    codeSample: (t) => `import { FileDiffToolCard } from "@openbitfun/ui/flow-chat";\n\n<FileDiffToolCard\n  action="GetFileDiff:"\n  changeSummary={{\n    additions: 12,\n    deletions: 4,\n    label: "${t("components.preview.flowChat.fileChangeSummary")}",\n  }}\n  path="src/flow_chat/components/FlowToolCard.tsx"\n  pathLabel="FlowToolCard.tsx"\n  status="completed"\n/>`,
    icon: GitCompare,
    render: (options) => <ConcreteProminentPreview {...options} kind="diff" />,
    section: "tool-card",
    specimens: toolsForComponent("FileDiffToolCard").map((tool) => ({ tool })),
  },
  FileOperationToolCard: {
    attention: "adaptive",
    codeSample: (t) => `import { FileOperationToolCard } from "@openbitfun/ui/flow-chat";\n\n<FileOperationToolCard\n  actionLabel="${t("components.preview.flowChat.editFile")}"\n  isExpanded={isExpanded}\n  onToggle={() => setIsExpanded((value) => !value)}\n  operation="edit"\n  path="src/flow_chat/components/FlowToolCard.tsx"\n  pathLabel="FlowToolCard.tsx"\n  preview={<DiffPreview />}\n  status="completed"\n/>`,
    icon: FileEdit,
    render: (options) => <FileOperationPreview {...options} />,
    section: "tool-card",
    specimens: toolsForComponent("FileOperationToolCard").map((tool) => ({ tool })),
  },
  GetToolSpecToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("GetToolSpecToolCard"),
    icon: SearchCheck,
    render: (options) => <ActivityPreview {...options} kind="get-tool-spec" />,
    section: "tool-card",
    specimens: toolsForComponent("GetToolSpecToolCard").map((tool) => ({ tool })),
  },
  GitToolCard: {
    attention: "prominent",
    codeSample: concreteCodeSample("GitToolCard"),
    icon: GitBranch,
    render: (options) => <ConcreteProminentPreview {...options} kind="git" />,
    section: "tool-card",
    specimens: toolsForComponent("GitToolCard").map((tool) => ({ tool })),
  },
  GlobSearchToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("GlobSearchToolCard"),
    icon: FolderSearch,
    render: (options) => <SearchPreview {...options} kind="glob" />,
    section: "tool-card",
    specimens: toolsForComponent("GlobSearchToolCard").map((tool) => ({ tool })),
  },
  GrepSearchToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("GrepSearchToolCard"),
    icon: Search,
    render: (options) => <SearchPreview {...options} kind="grep" />,
    section: "tool-card",
    specimens: toolsForComponent("GrepSearchToolCard").map((tool) => ({ tool })),
  },
  PageDeployToolCard: {
    attention: "prominent",
    codeSample: concreteCodeSample("PageDeployToolCard"),
    icon: ArrowDownToLine,
    render: (options) => <ConcreteProminentPreview {...options} kind="page-deploy" />,
    section: "tool-card",
    specimens: toolsForComponent("PageDeployToolCard").map((tool) => ({ tool })),
  },
  PagePublishToolCard: {
    attention: "prominent",
    codeSample: concreteCodeSample("PagePublishToolCard"),
    icon: Rocket,
    render: (options) => <ConcreteProminentPreview {...options} kind="page-publish" />,
    section: "tool-card",
    specimens: toolsForComponent("PagePublishToolCard").map((tool) => ({ tool })),
  },
  ProminentToolCard: {
    attention: "prominent",
    codeSample: (t) => `import { ProminentToolCard, ProminentToolCardSummary } from "@openbitfun/ui/flow-chat";\nimport { SquareTerminal } from "lucide-react";\n\n<ProminentToolCard\n  status="completed"\n  isExpanded={isExpanded}\n  onToggle={() => setIsExpanded((value) => !value)}\n  summary={(\n    <ProminentToolCardSummary\n      icon={<SquareTerminal />}\n      action="${t("components.preview.flowChat.runCommand")}"\n      content={<code>curl https://openbitfun.com</code>}\n    />\n  )}\n  expandedContent={<CommandOutput />}\n/>`,
    icon: SquareTerminal,
    render: (options) => <FrameworkPreview {...options} kind="prominent" />,
    section: "framework",
    specimens: toolsForComponent("ProminentToolCard").map((tool) => ({ tool })),
  },
  ReadFileToolCard: {
    attention: "ambient",
    codeSample: (t) => `import { ReadFileToolCard } from "@openbitfun/ui/flow-chat";\n\n<ReadFileToolCard\n  accessibleLabel="${t("components.preview.flowChat.readFile")}"\n  action="${t("components.preview.flowChat.readFile")}"\n  content="src/flow_chat/tool-cards/index.ts · 128 lines"\n  interactive\n  onOpen={openFile}\n  status="completed"\n/>`,
    icon: FileText,
    render: (options) => <ReadFilePreview {...options} />,
    section: "tool-card",
    specimens: toolsForComponent("ReadFileToolCard").map((tool) => ({ tool })),
  },
  ReviewSummaryToolCard: {
    attention: "prominent",
    codeSample: concreteCodeSample("ReviewSummaryToolCard"),
    icon: SearchCheck,
    render: (options) => <ConcreteProminentPreview {...options} kind="review" />,
    section: "tool-card",
    specimens: toolsForComponent("ReviewSummaryToolCard").map((tool) => ({ tool })),
  },
  RunCodeToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("RunCodeToolCard"),
    icon: Code2,
    render: (options) => <StandardAmbientPreview {...options} kind="run-code" />,
    section: "tool-card",
    specimens: toolsForComponent("RunCodeToolCard").map((tool) => ({ tool })),
  },
  SessionControlToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("SessionControlToolCard"),
    icon: Layers,
    render: (options) => <SessionPreview {...options} kind="control" />,
    section: "tool-card",
    specimens: toolsForComponent("SessionControlToolCard").map((tool) => ({ tool })),
  },
  SessionMessageToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("SessionMessageToolCard"),
    icon: MessageSquare,
    render: (options) => <SessionPreview {...options} kind="message" />,
    section: "tool-card",
    specimens: toolsForComponent("SessionMessageToolCard").map((tool) => ({ tool })),
  },
  SkillToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("SkillToolCard"),
    icon: BookOpen,
    render: (options) => <ActivityPreview {...options} kind="skill" />,
    section: "tool-card",
    specimens: toolsForComponent("SkillToolCard").map((tool) => ({ tool })),
  },
  TerminalControlToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("TerminalControlToolCard"),
    icon: SquareTerminal,
    render: (options) => <ActivityPreview {...options} kind="terminal-control" />,
    section: "tool-card",
    specimens: toolsForComponent("TerminalControlToolCard").map((tool) => ({ tool })),
  },
  TodoToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("TodoToolCard"),
    icon: ListTodo,
    render: (options) => <StandardAmbientPreview {...options} kind="todo" />,
    section: "tool-card",
    specimens: toolsForComponent("TodoToolCard").map((tool) => ({ tool })),
  },
  ViewImageToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("ViewImageToolCard"),
    icon: ImageIcon,
    render: (options) => <StandardAmbientPreview {...options} kind="view-image" />,
    section: "tool-card",
    specimens: toolsForComponent("ViewImageToolCard").map((tool) => ({ tool })),
  },
  WebFetchToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("WebFetchToolCard"),
    icon: Globe,
    render: (options) => <StandardAmbientPreview {...options} kind="web-fetch" />,
    section: "tool-card",
    specimens: toolsForComponent("WebFetchToolCard").map((tool) => ({ tool })),
  },
  WebSearchToolCard: {
    attention: "ambient",
    codeSample: concreteCodeSample("WebSearchToolCard"),
    icon: Search,
    render: (options) => <SearchPreview {...options} kind="web" />,
    section: "tool-card",
    specimens: toolsForComponent("WebSearchToolCard").map((tool) => ({ tool })),
  },
} as const satisfies FlowChatPreviewDefinitionMap;

function isFlowChatComponent(
  component: RegisteredComponent,
): component is FlowChatComponentMeta {
  return component.category === "flow-chat";
}

export const flowChatPreviewRegistry = componentRegistry
  .filter(isFlowChatComponent)
  .map((component) => ({
    component,
    definition: flowChatPreviewDefinitions[component.name],
  }));

export function getFlowChatPreviewDefinition(
  componentName: string,
): FlowChatPreviewDefinition | undefined {
  if (!Object.prototype.hasOwnProperty.call(flowChatPreviewDefinitions, componentName)) {
    return undefined;
  }

  return flowChatPreviewDefinitions[componentName as FlowChatComponentName];
}

export function FlowChatComponentPreview({
  componentName,
  interactive = true,
  specimen,
  state,
}: {
  componentName: string;
  interactive?: boolean;
  specimen?: FlowChatToolSpecimen;
  state?: string;
}) {
  const entry = flowChatPreviewRegistry.find(
    ({ component }) => component.name === componentName,
  );
  const definition = getFlowChatPreviewDefinition(componentName);

  if (!entry || !definition) {
    return null;
  }

  const resolvedState = (state ?? entry.component.states[0]) as FlowChatPreviewState;

  return (
    <Fragment key={`${componentName}-${resolvedState}-${specimen?.tool ?? "component"}`}>
      {definition.render({
        interactive,
        specimen,
        state: resolvedState,
      })}
    </Fragment>
  );
}

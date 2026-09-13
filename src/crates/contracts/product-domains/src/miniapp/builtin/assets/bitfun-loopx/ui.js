'use strict';

// LoopX is owned by the BitFun host. This file only projects durable snapshots
// and cursor-addressed events into the MiniApp UI.
const app = window.app;
const byId = (id) => document.getElementById(id);
const MAX_EVENTS = 2000;
const MAX_RENDERED_OUTPUT_BLOCKS = 500;
const MAX_TURN_OUTPUT_EVENTS = 4000;
const MAX_OUTPUT_HISTORY_EVENTS = 50000;
const MAX_OUTPUT_HISTORY_CHARS = 16000000;
const LONG_OUTPUT_BLOCK_CHARS = 12000;
/// A settled run's decision text is often the only place the real reason is
/// written down, so the compact preview must stay expandable.
const SUMMARY_CONCLUSION_MAX_CHARS = 110;
const MAX_INTAKE_HISTORY = 12;
const HOST_CLOCK_TICK_MS = 5000;
const HOST_RESUME_GAP_MS = 30000;
const STALE_ACTIVE_REATTACH_MS = 30000;
const MODEL_SELECTION_STORAGE_KEY = 'loopx.modelId';
const INTAKE_HISTORY_STORAGE_KEY = 'loopx.intakeHistory';
const METADATA_HYDRATE_TIMEOUT_MS = 8000;
const AUTO_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const HIGH_RISK_SCOPES = new Set([
  'publish',
  'public_comment',
  'pull_request',
  'merge',
  'production_action',
]);
const SNAPSHOT_EVENT_KINDS = new Set([
  'task_created',
  'state_changed',
  'phase_changed',
  'approval_required',
  'settlement_recorded',
  'environment_changed',
  'operation_cancelled',
  'snapshot_invalidated',
]);

const COPY = {
  'zh-CN': {
    skipToLogs: '跳到日志',
    connecting: '正在连接宿主',
    connected: '已连接',
    connectionFailed: '连接失败',
    intakeLabel: 'GitHub Issue、Pull Request 或仓库链接',
    intakePlaceholder: '粘贴 GitHub Issue、PR、仓库或 Issues 列表链接',
    model: '模型',
    modelAuto: '自动模型',
    modelLoading: '正在加载模型…',
    modelEmpty: '未找到已启用的文本模型',
    modelLoadFailed: '模型列表加载失败',
    modelReloadTitle: '刷新模型列表',
    modelSelectionChanged: '已切换模型，请重新分析链接。',
    modelPrimaryTag: '主模型',
    resolve: '分析链接',
    resolving: '正在实时复核链接',
    resetLoopx: '重置 LoopX',
    pauseAll: '停止全部任务',
    pauseAllHint: '停止整个 LoopX 运行：正在执行的任务会被中断，仍处排队/等待的任务保持原地，新任务不再受理，直到你点「继续」。等待你审批的门禁不受影响。',
    resumeAll: '继续任务',
    resumeAllHint: '恢复整个 LoopX 运行：重新受理新任务并推进排队中的任务。',
    resettingLoopxBackground: '正在后台清理任务与工作进展；窗口可以继续使用，完成后会自动刷新。',
    destructiveAction: '危险操作',
    resetLoopxTitle: '清空并重新开始',
    resetLoopxMessage: '将停止并删除 {tasks} 个任务、{events} 条日志、全部工作进展和受管工作区。此操作不可撤销。',
    resetLoopxRetained: '模型配置、GitHub 登录、MiniApp 设置和干净的 Git 对象缓存会保留；仍在进行的工作区不会被复用。',
    resetLoopxConfirm: '清空并重新开始',
    resetLoopxApplied: 'LoopX 已清空，可以重新开始测试。',
    resetLoopxDeferred: 'LoopX 已清空；部分旧工作区仍被占用，正在后台继续清理。',
    unsupportedTitle: '当前执行位置不支持 LoopX',
    unsupportedDefault: 'LoopX 目前只支持本地 Desktop 工作区；远程工作区不会静默改在本机执行。',
    environment: '环境',
    coreEnvironment: '核心环境',
    optionalEnvironment: '增强能力',
    required: '必需',
    optional: '可选',
    retryEnvironment: '重新检查环境',
    installLoopx: '安装兼容版本',
    loopxInstallStarted: '正在从官方 GitHub 源仓库下载并校验 LoopX {version}…',
    loopxInstallQueued: '安装已在后台开始，可以继续使用当前窗口。',
    loopxInstallComplete: 'LoopX {version} 已安装，环境检查已更新。',
    loopxInstallFailed: 'LoopX 安装失败：{message}',
    loopxRepairTitle: 'LoopX 版本需要修复',
    loopxRepairDetail: '当前 {current}，此功能需要 {version}。安装到 BitFun 管理目录，不会修改系统版本。',
    loopxInstallingTitle: '正在准备 LoopX {version}',
    loopxInstallingDetail: '仅下载运行所需源码并校验版本，完成后会自动重新检查环境。',
    tasks: '任务',
    taskCountLabel: '共 {value} 个任务',
    collapseTasks: '收起任务栏',
    resizeTasks: '调整任务栏宽度',
    resizeIssueColumns: '调整详情和时间线宽度',
    expandTasks: '展开任务栏',
    noTasks: '暂无任务',
    emptyNoTask: '暂无任务',
    emptyNoTaskHint: '在上方粘贴 GitHub Issue 或 Pull Request 链接创建修复任务；运行过程会实时展示在这里。',
    followBanner: '自动跟随：{item} · {state}',
    followBannerHint: '正在展示运行中的任务；点击左侧任务可固定查看该 Issue',
    backToFollow: '恢复自动跟随',
    timelineTitle: '运行时间线',
    timelineLiveScope: '实时 · {item}',
    timelineIdleScope: '已固定 · {item}',
    worktreeQuiet: '正在准备 Worktree：{item}。首次克隆可能需要几分钟；Git 静默时不会产生子进程输出。',
    noLogs: '暂无运行事件',
    noLiveOutput: '暂无实时模型输出',
    awaitingFirstOutput: '模型已启动，正在等待首段输出…',
    preparingElapsed: '已等待 {duration}',
    reviewDecision: '去处理',
    summaryTitle: '最新进展',
    summaryEmpty: 'Agent 完成本轮回合后，结论会保存在这里。',
    factsWorkspace: '工作区',
    factsTurn: '回合',
    factsReceipt: '结算回执',
    factsModel: '模型',
    factsArtifacts: '产出物',
    techDetailsTitle: '技术详情',
    factsArtifactNone: '本轮暂无文件变更',
    errorTitle: '错误',
    gateKindPublish: '发布审批',
    gateKindComment: '发布评论审批',
    gatePublishCommentTitle: '发布维护者评论到 {item}',
    gatePublishCommentSummary: '将向 {item} 发布一条公开评论，这是对外写入，不会修改代码或创建 PR。',
    gatePublishCommentApproveEffect: '在 {item} 公开发布这条评论；不会修改代码，也不会创建 PR。',
    gatePublishCommentRejectEffect: '不发布评论；草稿、调查结果和工作区都会保留。',
    gatePublishCommentRecommendation: '建议先核对评论要点；批准后评论会立即公开。',
    gatePublishCommentApprove: '批准发布',
    gateCommentPointsTitle: '评论要点',
    gateCommentDraftTitle: '草稿位置',
    gateCommentDraftHint: '完整正文保存在任务工作区草稿文件中。',
    approvalAppliedComment: '已批准：将向 {item} 发布维护者评论。',
    approvalAppliedPublish: '已批准：将推送分支并创建 Pull Request。',
    approvalAppliedGeneric: '已批准：任务将继续执行「{title}」。',
    approvalRejectedNotice: '已拒绝：该操作不会执行，草稿、进度和工作区都会保留。',
    gateKindDecision: '决策请求',
    outputUnavailable: '实时输出暂不可用',
    outputThinking: '思考',
    outputThinkingSummary: '思考过程 · {value} 字（点击展开）',
    outputToolSummary: '工具详情（点击展开）',
    decisionCardTitle: '需要你的决策',
    decisionCardTitleExternal: '等待外部操作',
    decisionCardTitleRecovery: '工作段被中断，需要恢复',
    decisionCardTitlePlanExhausted: '修复计划已执行完毕，等待收尾方式',
    decisionResume: '恢复重试',
    decisionContinueAfterOwnerAction: '我已完成，继续任务',
    decisionCardRecheck: '重新检查 PR 状态',
    decisionCardRecheckGeneric: '重新检查外部状态',
    decisionCardRecheckRecent: '最近已检查（{time}），外部状态未变化',
    decisionCardRecheckCooldown: '刚检查过，稍候几秒可再次检查',
    decisionCardExternalActionLabel: '需要在 BitFun 之外完成的操作：',
    decisionCardExternalSummary: '在 GitHub 完成 {prs} 的合并或审核后，点下方「重新检查 PR 状态」继续任务。',
    decisionCardExternalSummaryGeneric: '任务正在等待一个发生在 BitFun 之外的操作；完成后点下方「重新检查外部状态」继续任务。',
    approvalContextTitle: '本次决策的背景',
    decisionCardGateHint: '请在上方审批面板中批准或拒绝该请求。',
    decisionCardRecoveryHint: '本段工作已结束，但结算未能确认持久进展；可恢复重试一次，结论详情见下方最新进展。',
    decisionCardPlanExhaustedHint: '流程的待办已全部执行完，但没有留下可继续的待办、待批门禁或收尾声明，宿主不会伪造收尾。已产生的提交、未提交改动与证据均保留在任务工作区。你可以：从任务分支手动推送并开 PR / 在 issue 上评论说明；或等 goal 出现新待办（例如上游 PR 合并、新的监控结论）后再点“恢复重试”。',
    summaryVerdictNeedsFix: '需要修复',
    summaryVerdictAlreadyFixedUpstream: '上游已修复',
    summaryVerdictWontFix: '无需修复',
    summaryVerdictNeedsInfo: '信息不足',
    summaryReproductionReproduced: '已复现',
    summaryReproductionNotReproduced: '未复现（未执行复现环节）',
    summaryReproductionNotApplicable: '不适用',
    summaryReproductionE2e: '已复现（端到端）',
    summaryReproductionModule: '已复现（模块/测试级）',
    summaryReproductionScoped: '已复现（范围见证据）',
    summaryReproductionEvidenceLabel: '复现证据',
    summaryE2eVerificationHint: '端到端验证仍待完成：请在真实运行环境按 Issue 描述步骤确认修复生效。',
    summaryReproductionInProgress: '复现中',     summaryReproductionPending: '待复现',     summaryReproductionActiveHint: '复现环节正在进行，当前不是最终结论。',
    summaryWontFixReasonDuplicateOf: '重复议题',
    summaryWontFixReasonByDesign: '设计如此，无需改动',
    summaryWontFixReasonInvalid: '无需处理（无可执行请求）',
    summaryWontFixReasonEvaluationPending: '评估中，暂不处理',
    state_completed_needs_fix: '已处理，待发布',
    summaryShowFullConclusion: '展开完整结论',
    summaryBackground: '背景',
    summarySectionCompleted: '已完成',
    summarySectionArtifacts: '证据与产物',
    summarySectionCurrentAction: '当前动作',
    summaryAgentEnglish: '英文原文',
    summaryActualFindings: '实际发现',
    summaryWhyNoFix: '为什么不用自动修复',
    taskLabelsMore: '+{value}',
    summaryMissingInfo: '判断所需信息',
    summaryCompletedTitlePlain: '处理结果',
    summaryCompletedNoFollowup: '处理已完成，系统不再自动跟进；如需继续，请使用「重新尝试」提交新任务。',
    issueDescriptionEmpty: '（该 Issue 没有正文描述）',
    summarySegmentEvidence: '调查取证',
    summarySegmentRouteDecision: '方案决策',
    summarySegmentImplementation: '实现修复',
    summarySegmentValidation: '验证',
    summarySegmentDelivery: '交付',
    summaryCompletedTitle: '本段完成',
    summaryDecisionTitle: '已定方案',
    summaryRejectedTitle: '已否决的其他方案',
    summaryNextStep: '下一步',
    summaryBlockers: '阻塞',
    summaryConclusion: '结论',
    summaryProcessDetails: '查看过程详情',
    summaryTechReceipts: '技术回执（原始文本）',
    localPathRefHint: '本地文件，无法在应用内打开：{path}',
    summaryPendingGate: '等待你在上方审批面板中处理',
    recoveryReasonHostRestart: '中断原因：应用异常关闭导致执行中断',
    recoveryReasonExecutionFailure: '中断原因：执行过程失败',
    recoveryReasonPlanExhausted: '中断原因：计划用尽——无待办、无待批门禁、无终局声明',
    recoveryReasonSettlementUnverified: '中断原因：结算未能确认持久进展，详情见下方技术回执',
    recoveryReasonSettlementNoProgress: '中断原因：本段收尾写回未被 LoopX 接受，未形成结算认可的持久进展',
    recoveryReasonSettlementReceiptMissing: '中断原因：本段写入已验证，但配额花费回执缺失，结算未完成',
    recoveryReasonRepositoryPaused: '中断原因：同仓库其他任务失败后暂停队列',
    recoveryReasonManualRestore: '中断原因：手动恢复的归档任务',
    outputTool: '工具',
    outputModel: '模型',
    outputText: '输出',
    outputChunks: '{value} 段',
    sourceScheduler: '任务调度',
    sourceLoopx: 'LoopX 引擎',
    sourceAgent: 'Agent',
    sourceGit: 'Git',
    sourceGithub: 'GitHub',
    sourceSystem: '系统',
    toolExecCommand: '执行命令',
    toolRead: '读取文件',
    toolGrep: '搜索内容',
    toolLs: '浏览目录',
    toolWebFetch: '访问网页',
    toolWebSearch: '搜索网页',
    toolWrite: '写入文件',
    toolEdit: '修改文件',
    toolQueued: '工具已排队：{tool}',
    toolWaiting: '工具等待中：{tool}',
    toolStarted: '正在运行：{tool}',
    toolConfirmation: '工具等待确认：{tool}',
    toolConfirmed: '已确认工具：{tool}',
    toolRejected: '已拒绝工具：{tool}',
    toolCompleted: '工具完成：{tool}',
    toolFailed: '工具失败：{tool}',
    toolCancelled: '工具已取消：{tool}',
    toolStateQueued: '排队',
    toolStateWaiting: '等待',
    toolStateStarted: '运行中',
    toolStateConfirmation: '等待确认',
    toolStateConfirmed: '已确认',
    toolStateRejected: '已拒绝',
    toolStateCompleted: '已完成',
    toolStateFailed: '失败',
    toolStateCancelled: '已取消',
    newEvents: '滚动到最新输出',
    confirmTask: '确认任务',
    repository: '仓库',
    workspace: '工作区',
    workspace_existing_worktree: '使用现有 Worktree',
    workspace_new_worktree: '将创建独立 Worktree',
    workspace_clone_required: '将克隆并创建 Worktree',
    workspace_unavailable: '工作区不可用',
    imageCapability: '图片能力',
    supported: '支持',
    unsupported: '不支持',
    items: 'Issue / PR',
    permissions: '本次权限',
    explicitGrant: '逐项授权',
    cancel: '取消',
    close: '关闭',
    createTasks: '创建所选任务',
    newAttempt: '新尝试',
    terminalExists: '已有终态任务',
    confirmNewAttempt: '确认新尝试',
    decisionRequired: '需要你的决定',
    systemNotificationTitle: 'BitFun LoopX 需要你的决定 · {label}',
    afterApprove: '批准后',
    afterReject: '拒绝后',
    approvalNote: '审批备注',
    approvalNoteToggle: '添加备注',
    approvalNotePlaceholder: '补充批准或拒绝的原因（可选）',
    reject: '拒绝',
    approve: '批准',
    pause: '暂停',
    resume: '恢复',
    resumeRepository: '恢复仓库任务（{value}）',
    resumeTargetMissing: '恢复目标已失效，请刷新任务列表后重试',
    resumingRepository: '正在恢复异常任务…',
    repositorySerial: '同仓库串行执行',
    batchAction: '批量操作',
    resumeRepositoryTitle: '恢复此仓库的异常任务',
    confirmContinue: '确认继续',
    resumeRepositoryMessage: '将恢复 {repository} 中 {value} 个已暂停、中止或失败的任务。同一时间只运行 1 个，其余任务进入队列。',
    resumeRepositoryApplied: '已将 {value} 个仓库任务加入队列。',
    repositoryPausedByModel: '模型请求失败，仓库队列已暂停',
    archive: '归档并清理工作区',
    restore: '还原',
    updated: '更新于 {duration}前',
    taskUpdated: '任务更新于 {duration}前',
    openInGithub: '在 GitHub 中打开',
    openExternalFailed: '无法打开外部链接，请手动复制地址到浏览器。',
    currentWork: '当前',
    outcomeUpdated: '进展更新于 {duration}前',
    stagePending: '待开始',
    stageActive: '进行中',
    stageComplete: '已完成',
    stageBlocked: '已阻塞',
    progressSummaryLine: '修复分五步：准备工作区 → 分析与方案 → 实施修改 → 结果核验 → 结算收束。当前：{stage}。',
    progressPreparing: '正在准备独立 Worktree',
    progressQueued: '等待同仓库前序 Issue',
    progressAnalyzing: '正在分析原因并形成可执行方案',
    progressImplementing: '已进入代码修改阶段',
    progressValidating: '正在核验本轮产出',
    progressSettling: '正在保存本轮进展',
    progressWaiting: '等待你的决定',
    progressRecovery: '本轮执行已中断',
    progressCompleted: '修复流程已完成',
    progressResolvedUpstream: '上游已处理该问题',
    progressResolvedUpstreamDetail: '已确认当前上游代码移除了原始故障路径，不需要再提交额外修复。',
    progressIdle: '等待任务推进',
    issueDescription: 'Issue 描述',
    loadingIssueDescription: '正在加载 Issue 描述…',
    issueDescriptionUnavailable: '暂时无法加载 Issue 描述。',
    issueDescriptionExcerptNote: '以上是截断后的纯文本摘要，不是 GitHub 原文（Markdown 已被移除）。',
    issueDescriptionOpenOnGithub: '在 GitHub 查看完整描述',
    publishApprovalTitle: '是否发布修复并创建 Pull Request？',
    publishApprovalSummary: '修复已在分支 {branch} 的提交 {commit} 中准备完成，目标仓库为 {repository}。现在需要你决定是否发布。',
    publishApprovalSummaryGeneric: '修复和发布材料已经准备完成，目标仓库为 {repository}。现在需要你决定是否发布为 Pull Request。',
    publishApprovalApproveEffect: '推送修复分支并创建 Pull Request。批准不会自动合并代码，合并由你决定。',
    publishApprovalRejectEffect: '不推送分支，也不创建 Pull Request；本地分支、提交和验证结果会保留，任务停在当前步骤。',
    publishApprovalRecommendationReady: '建议批准：当前修改已有验证结果，批准后仍可在 Pull Request 中继续评审，并不会自动合并。',
    publishApprovalRecommendationReview: '建议先确认修改和验证结果；批准只会发布 Pull Request，不会自动合并。',
    publishApprovalApprove: '批准并创建 PR',
    publishApprovalReject: '暂不发布',
    state_queued_repo_wait_with: '等待 {item} 完成后才能开始',
    externalActionTitlePr: '创建 Pull Request 到 {item}',
    externalActionPushDetail: '将推送分支 {branch}（提交 {commit}）并创建 Pull Request，不会自动合并。',
    externalActionPushDetailNoCommit: '将推送分支 {branch} 并创建 Pull Request，不会自动合并。',
    externalActionPushDetailUnknown: '将把已准备好的修复分支推送到 {repository} 并创建 Pull Request，不会自动合并。',
    externalActionApprovePr: '推送分支并创建 Pull Request（不会自动合并）。',
    externalActionRejectPr: '不推送、不创建 Pull Request；本地分支、提交与验证结果保留。',
    externalActionTitlePush: '推送分支或提交到远端',
    externalActionPushSummary: '将把本地提交推送到远端仓库（不创建 Pull Request）。',
    externalActionApprovePush: '执行 git 推送。',
    externalActionRejectPush: '不推送；本地提交与工作区保留。',
    externalActionTitleValidate: '运行外部验证（构建 / 安装 / 真实运行）',
    externalActionSummaryValidate: '将执行构建、安装或真实运行验证，不会改动仓库内容。',
    externalActionApproveValidate: '执行验证命令并汇报结果。',
    externalActionRejectValidate: '不执行验证；任务保持等待。',
    externalActionTitle: '需要批准的对外操作',
    externalActionSummaryDetail: '请求执行：{detail}',
    externalActionSummaryFallback: 'Agent 请求执行一个需要你批准的对外操作。',
    externalActionApproveFallback: '执行该操作，完成后汇报结果。',
    externalActionRejectFallback: '不执行该操作；现有修改、证据与工作区保留。',
    approvalAppliedGenericDetail: '已批准：{detail}',
    summarySupportingEvidence: '支撑证据',
    summaryArtifactSupports: '对应结论：{value}',
    artifactKindSource: '来源问题',
    artifactKindRepro: '复现与验证证据',
    artifactKindValidation: '验证证据',
    artifactKindImplementation: '相关实现与改动范围',
    artifactKindDocs: '模块约束与架构依据',
    artifactKindReview: '发布与评审准备',
    artifactKindFile: '相关文件',
    gateRawDetails: '技术原文（仅在需要核对时展开）',
    gateGrantAuthorityScopes: '需要的权限：{scopes}。',
    gateGatedReadTitle: '允许读取 Issue 正文与维护者评论？',
    gateGatedReadSummary: 'Agent 目前只能看到这条 Issue 的元数据（标题、标签、状态）。要判断它是否值得修复、是否已经有人处理过，需要进一步读取正文和评论内容。这些内容仅用于本任务的分析，不会原样写入公开状态。',
    gateGatedReadApproveEffect: 'Agent 将读取该 Issue 的正文与维护者评论，继续「是否已有人修复」的证据评估，然后汇报结论或继续修复。',
    gateGatedReadRejectEffect: 'Agent 不会读取任何正文内容，任务保持等待。你也可以在备注中直接粘贴关键信息后再批准。',
    gateGatedReadApprove: '允许读取',
    gateGatedReadReject: '暂不读取',
    gateClarifyTitle: '维护者反馈存在歧义，需要你澄清方向',
    gateClarifySummary: '维护者对该修复提出的修改要求存在多种理解方式，Agent 无法确定预期行为，需要你给出明确方向。原始反馈见下方。',
    gateClarifyApproveEffect: '批准后请在备注中写清预期的行为或取舍，Agent 会按你的说明继续修改。',
    gateReuseMergeTitle: '是否合并已有 PR 作为本 Issue 的解决方案？',
    gateReuseMergeSummaryWithPr: 'Agent 评估认为已有 {pr}（{title}）可直接解决当前 Issue，验证证据齐全，无需重复实现；合并前请确认 PR 归属与合并权限。',
    gateReuseMergeSummary: 'Agent 评估认为已有 PR 可直接解决当前 Issue，验证证据齐全，无需重复实现；合并前请确认 PR 归属与合并权限。',
    gateReuseMergeApproveEffect: '批准后不会为当前 Issue 提交新补丁或新 PR；将复用 {pr} 作为解决方案并执行合并，之后继续跟进该 PR 的合并/关闭状态，直到本任务收尾。',
    gateReuseMergeRejectEffect: '本轮不合并 {pr}，任务不再进入后续步骤；已完成的评估、工作区与证据全部保留。可在备注说明理由，或要求 Agent 改为独立补丁方案重新评估。',
    gateReuseMergeRecommendation: '建议：确认 PR 内容与合并时机符合预期后再批准；合并是对上游仓库的对外动作。',
    gateReuseMergeApprove: '批准合并',
    gateReuseMergeReject: '拒绝',
    gateReuseMergeFallbackPr: '已有 PR',
    gateClarifyRejectEffect: '本次不处理该反馈，任务保持等待；维护者后续补充说明后可以再次处理。',
    gateGrantAuthorityTitle: '需要授予额外写权限',
    gateGrantAuthoritySummary: '维护者的修改要求已被理解，但执行它需要的写权限当前未授权。请确认范围后决定是否授予。',
    gateGrantAuthorityApproveEffect: 'Agent 将以授予的权限应用维护者的修改要求，完成后汇报结果。',
    gateGrantAuthorityRejectEffect: '不授予权限；Agent 会把该要求记录为阻塞项并保持等待。',
    gateDraftReadyTitle: '将 Draft PR 标记为「准备评审」？',
    gateDraftReadySummary: '修复 PR 目前是草稿状态。是否标记为 ready for review 并进入评审流程由你决定。',
    gateDraftReadyApproveEffect: 'PR 将标记为 ready for review，随后按仓库政策邀请评审人。',
    gateDraftReadyRejectEffect: 'PR 保持草稿状态，继续监控；你可以稍后再批准。',
    justNow: '刚刚',
    seconds: '{value} 秒',
    minutes: '{value} 分钟',
    hours: '{value} 小时',
    days: '{value} 天',
    intakeUnavailable: '当前执行位置不支持创建任务。',
    bridgeUnavailable: '宿主没有提供受信任的 LoopX 运行接口。请更新 BitFun 后重试。',
    selectAtLeastOne: '至少选择一个仍开放的 Issue 或 PR。',
    selectAll: '全选',
    selectPermissions: '请确认全部必需权限范围后再创建任务。',
    previewExpired: '确认信息已失效，请重新分析链接。',
    taskCreated: '任务已创建。',
    tasksCreated: '已创建 {value} 个任务。',
    outcomeCount: '{message}（{value} 项）',
    selectedCandidates: '已选 {selected} / {total}',
    batchSelection: '将为已选的 {value} 个不同 Issue / PR 分别创建独立任务，工作区会逐个准备。',
    workspacePreparationFailed: '工作区准备失败',
    queuedRepoBusy: '等待同仓库当前任务完成',
    queuedBoundedWait: '回合之间等待调度（有界回合）',
    openedExisting: '已打开现有任务，没有重复创建。',
    closedNoop: '目标已关闭或合并，无需创建任务。',
    liveVerification: '目标需要再次在线复核，暂未创建任务。',
    retryRequired: '该目标已有终态任务。只有确认后才会创建新的 attempt。',
    actionApplied: '操作已应用。',
    actionAppliedResume: '已继续执行：{item}',
    actionAppliedRestore: '已还原任务：{item}',
    actionAppliedPause: '已暂停：{item}',
    actionAppliedAbort: '已中止：{item}',
    actionAppliedArchive: '已归档：{item}',
    actionAppliedRetry: '已重新尝试：{item}',
    noticeOpenLink: '打开链接',
    issuePullRequest: 'Pull Request',
    publishOutcomePr: 'Pull Request 已创建：#{number}',
    publishOutcomeComment: '已发布维护者评论：{item}',
    approvalSubmitting: '正在提交审批决定，任务会在宿主确认后继续。',
    approvalSubmittingShort: '正在提交决定…',
    actionPending: '正在提交操作',
    pausePending: '正在暂停',
    resumePending: '正在继续',
    archivePending: '正在归档',
    actionDuplicate: '该操作已经应用，无需重复执行。',
    revisionConflict: '任务状态已经变化，已刷新到最新版本。',
    actionRejected: '宿主拒绝了该操作。',
    noGate: '没有找到可回答的审批门禁，请刷新任务状态。',
    approvalNeeded: '任务正在等待远程可回答的审批。',
    activityInstallingDependencies: '正在准备项目依赖',
    activityBuildingInstaller: '正在构建 Windows 安装包',
    activityTestingUpgrade: '正在验证安装器升级链路',
    activityWaitingProcess: '正在等待外部进程返回结果',
    activitySyncingProgress: '正在同步工作进展',
    activityCheckingRepository: '正在检查仓库状态',
    activityRunningCommand: '正在执行项目命令',
    truncatedCandidates: '候选项已截断，请缩小仓库范围后重新分析。',
    imageWarning: '所选内容包含图片，但当前模型不支持图片输入。',
    modelUnavailable: '当前模型不可用，请返回并选择其他模型。',
    workspaceUnavailable: '宿主无法为该仓库准备受信任的 Worktree。',
    resolvedItem: '已处理',
    openItem: '开放',
    fromRepository: '仓库候选',
    taskNumber: '任务 {value}',
    sidecar: 'LoopX 引擎',
    nodeRuntime: 'Node.js 运行时',
    gitWorktree: 'Git / Worktree',
    agentModel: 'Agent 模型',
    pythonFallback: 'Python 备用',
    githubAuth: 'GitHub 登录',
    status_unknown: '未知',
    status_checking: '检查中',
    status_available: '可用',
    status_degraded: '已降级',
    status_unavailable: '不可用',
    status_ready: '就绪',
    status_blocked: '阻塞',
    state_preparing: '准备中',
    state_queued: '排队中',
    state_queued_repo_wait: '等待同仓库任务',
    state_queued_after_approval: '已批准，等待执行',
    action_issue_fix_confirm_reproduction: '确认复现',
    action_issue_fix_feasibility_decision: '可行性判定',
    action_issue_fix_apply_patch: '实施修复',
    action_issue_fix_validated_fix: '验证修复',
    action_issue_fix_pr_review_packet: '准备 PR 评审包',
    action_issue_fix_external_comment_packet: '准备外部评论',
    action_issue_fix_delivery: '交付与发布',
    action_issue_fix_publish: '发布 PR',
    action_issue_fix_track: 'PR 监控',
    state_running: '运行中',
    state_waiting_for_user: '待批准',
    state_waiting_for_external: '等待外部操作',
    state_retry_wait: '等待重试',
    state_cancelling: '正在停止',
    state_stopped: '已暂停',
    state_recovery_required: '待恢复',
    state_completed: '已完成',
    state_failed: '失败',
    state_archived: '已归档',
    state_resolved_upstream: '上游已修复',
    phase_unknown: '等待宿主状态',
    phase_validating_environment: '验证环境',
    phase_resolving_intake: '复核输入',
    phase_preparing_workspace: '准备独立工作区',
    phase_creating_goal: '准备任务目标',
    phase_queued: '等待调度',
    phase_inspecting_goal: '检查任务目标',
    phase_building_turn: '正在准备下一阶段',
    phase_starting_agent: '启动修复任务',
    phase_agent_running: '正在分析或修改',
    phase_validating_progress: '正在核验结果',
    phase_settling_turn: '正在保存进展',
    phase_waiting_for_approval: '等待审批',
    phase_retry_backoff: '重试退避',
    phase_cancelling: '正在取消',
    phase_recovering: '恢复并同步',
    phase_finished: '流程结束',
    monitor_phase_queued: 'PR 监控等待中',
    monitor_chip: 'PR 监控',
    monitor_waiting_detail: 'LoopX 心跳按自己的节奏检查 CI、Review 与新评论;这段等待是交付闭环的正常状态,不会消耗模型额度。',
    monitor_next_check: '下次检查',
    scope_workspace_read: '读取工作区',
    scope_workspace_write: '修改工作区',
    scope_git_local: '本地 Git 操作',
    scope_github_read: '读取 GitHub',
    scope_agent_execution: '运行 Agent',
    scope_publish: '发布变更',
    scope_public_comment: '公开评论',
    scope_pull_request: '创建 Pull Request',
    scope_merge: '合并 Pull Request',
    scope_production_action: '生产环境操作',
    scopeHighRisk: '需要单独确认的外部副作用',
    scopeStandard: '本次修复所需能力',
  },
  'en-US': {
    skipToLogs: 'Skip to logs',
    connecting: 'Connecting to host',
    connected: 'Connected',
    connectionFailed: 'Connection failed',
    intakeLabel: 'GitHub issue, pull request, or repository URL',
    intakePlaceholder: 'Paste a GitHub issue, PR, repository, or issues-list URL',
    model: 'Model',
    modelAuto: 'Automatic model',
    modelLoading: 'Loading models...',
    modelEmpty: 'No enabled text models found',
    modelLoadFailed: 'Model list failed to load',
    modelReloadTitle: 'Refresh model list',
    modelSelectionChanged: 'Model changed. Analyze the URL again.',
    modelPrimaryTag: 'Primary',
    resolve: 'Analyze URL',
    resolving: 'Verifying URL against the live source',
    resetLoopx: 'Reset LoopX',
    pauseAll: 'Stop all tasks',
    pauseAllHint: 'Stops the whole LoopX run: running agents are interrupted, queued and preparing tasks stay parked, new tasks are not accepted until you press Continue. Approval gates you already owe are not affected.',
    resumeAll: 'Continue tasks',
    resumeAllHint: 'Resumes the whole LoopX run: new tasks are accepted again and parked tasks may advance.',
    resettingLoopxBackground: 'Cleaning tasks and saved progress in the background. You can keep using this window; it refreshes when cleanup finishes.',
    destructiveAction: 'Destructive action',
    resetLoopxTitle: 'Clear and start over',
    resetLoopxMessage: 'Stop and delete {tasks} tasks, {events} log events, all saved progress, and all managed workspaces. This cannot be undone.',
    resetLoopxRetained: 'Model configuration, GitHub login, MiniApp settings, and clean Git object caches are retained. Unsettled worktrees are not reused.',
    resetLoopxConfirm: 'Clear and start over',
    resetLoopxApplied: 'LoopX was cleared. You can start a fresh test.',
    resetLoopxDeferred: 'LoopX was cleared; some old workspaces are still locked and cleanup continues in the background.',
    unsupportedTitle: 'LoopX is unavailable in this execution location',
    unsupportedDefault: 'LoopX currently supports local Desktop workspaces only. Remote workspaces will not silently run on this device instead.',
    environment: 'Environment',
    coreEnvironment: 'Core environment',
    optionalEnvironment: 'Optional capabilities',
    required: 'Required',
    optional: 'Optional',
    retryEnvironment: 'Check environment again',
    installLoopx: 'Install compatible version',
    loopxInstallStarted: 'Downloading and verifying LoopX {version} from the official GitHub source repository...',
    loopxInstallQueued: 'Installation started in the background. You can keep using this window.',
    loopxInstallComplete: 'LoopX {version} is installed and the environment check is up to date.',
    loopxInstallFailed: 'LoopX installation failed: {message}',
    loopxRepairTitle: 'LoopX needs a compatible version',
    loopxRepairDetail: 'Current: {current}. This feature requires {version}. Installation stays inside BitFun and does not change the system version.',
    loopxInstallingTitle: 'Preparing LoopX {version}',
    loopxInstallingDetail: 'Downloading only the runtime source and verifying it. The environment will be checked automatically when finished.',
    tasks: 'Tasks',
    taskCountLabel: 'Tasks: {value}',
    collapseTasks: 'Collapse task rail',
    resizeTasks: 'Resize task rail',
    resizeIssueColumns: 'Resize detail and timeline',
    expandTasks: 'Expand task rail',
    noTasks: 'No tasks yet',
    emptyNoTask: 'No tasks yet',
    emptyNoTaskHint: 'Paste a GitHub issue or pull request URL above to start a repair task; its progress streams here in real time.',
    followBanner: 'Auto-following: {item} · {state}',
    followBannerHint: 'Showing the running task; select a task on the left to pin it',
    backToFollow: 'Resume auto-follow',
    timelineTitle: 'Run timeline',
    timelineLiveScope: 'Live · {item}',
    timelineIdleScope: 'Pinned view',
    worktreeQuiet: 'Preparing worktree: {item}. The first clone can take a few minutes; Git may not emit output while it is working.',
    noLogs: 'No run events yet',
    noLiveOutput: 'No live model output yet',
    awaitingFirstOutput: 'The model has started; waiting for its first output…',
    preparingElapsed: 'Waiting for {duration}',
    reviewDecision: 'Review',
    summaryTitle: 'Latest progress',
    summaryEmpty: 'Once the Agent finishes this turn, its conclusions are saved here.',
    factsWorkspace: 'Workspace',
    factsTurn: 'Turn',
    factsReceipt: 'Settlement receipt',
    factsModel: 'Model',
    factsArtifacts: 'Artifacts',
    techDetailsTitle: 'Technical details',
    factsArtifactNone: 'No file changes in this turn yet',
    errorTitle: 'Error',
    gateKindPublish: 'Publish approval',
    gateKindComment: 'Comment approval',
    gatePublishCommentTitle: 'Publish maintainer comment to {item}',
    gatePublishCommentSummary: 'A public comment will be posted to {item}; this is an external write and will not change code or create a PR.',
    gatePublishCommentApproveEffect: 'Post this comment publicly on {item}; code and PRs are not changed.',
    gatePublishCommentRejectEffect: 'Do not post the comment; the draft, findings, and workspace are preserved.',
    gatePublishCommentRecommendation: 'Review the comment points first; approving posts it immediately.',
    gatePublishCommentApprove: 'Publish comment',
    gateCommentPointsTitle: 'Comment points',
    gateCommentDraftTitle: 'Draft file',
    gateCommentDraftHint: 'The full body is kept in the task workspace draft file.',
    approvalAppliedComment: 'Approved: a maintainer comment will be posted to {item}.',
    approvalAppliedPublish: 'Approved: the branch will be pushed and a pull request created.',
    approvalAppliedGeneric: 'Approved: the task will continue with "{title}".',
    approvalRejectedNotice: 'Rejected: the action will not run; draft, progress, and workspace are preserved.',
    gateKindDecision: 'Decision request',
    outputUnavailable: 'Live output is unavailable',
    outputThinking: 'Thinking',
    outputThinkingSummary: 'Thinking · {value} chars (click to expand)',
    outputToolSummary: 'Tool details (click to expand)',
    decisionCardTitle: 'Needs your decision',
    decisionCardTitleExternal: 'Waiting for an external action',
    decisionCardTitleRecovery: 'Work segment was interrupted and needs recovery',
    decisionCardTitlePlanExhausted: 'Fix plan completed; choose how to finish',
    decisionResume: 'Resume retry',
    decisionContinueAfterOwnerAction: 'I finished the step — continue',
    decisionCardRecheck: 'Re-check PR status',
    decisionCardRecheckGeneric: 'Re-check external status',
    decisionCardRecheckRecent: 'Last checked at {time}; external state unchanged',
    decisionCardRecheckCooldown: 'Just checked; try again in a few seconds',
    decisionCardExternalActionLabel: 'Action needed outside BitFun: ',
    decisionCardExternalSummary: 'Finish {prs} on GitHub, then use the re-check button below to continue.',
    decisionCardExternalSummaryGeneric: 'This task is waiting on an action outside BitFun. Use the re-check button below after you finish it.',
    approvalContextTitle: 'Why this decision',
    decisionCardGateHint: 'Approve or reject the request in the approval panel above.',
    decisionCardRecoveryHint: 'This segment finished but settlement could not validate durable progress. You can retry recovery once; see the summary below for the conclusion.',
    decisionCardPlanExhaustedHint: 'All plan todos are done, but the flow left no open todo, approval gate, or terminal declaration, and the host will not fabricate one. Commits, uncommitted changes, and evidence are preserved in the task worktree. You can push the task branch and open a PR / comment on the issue yourself, or wait until the goal gains a new todo or gate (for example after an upstream PR merge) and then use Resume retry.',
    summaryVerdictNeedsFix: 'Needs fix',
    summaryVerdictAlreadyFixedUpstream: 'Already fixed upstream',
    summaryVerdictWontFix: 'Won\'t fix',
    summaryVerdictNeedsInfo: 'Needs info',
    summaryReproductionReproduced: 'Reproduced',
    summaryReproductionNotReproduced: 'Not reproduced (no repro step)',
    summaryReproductionNotApplicable: 'Not applicable',
    summaryReproductionE2e: 'Reproduced (end-to-end)',
    summaryReproductionModule: 'Reproduced (module/test level)',
    summaryReproductionScoped: 'Reproduced (scope in evidence)',
    summaryReproductionEvidenceLabel: 'Reproduction evidence',
    summaryE2eVerificationHint: 'End-to-end verification is still pending: confirm the fix in a real runtime following the issue steps.',
    summaryReproductionInProgress: 'Reproduction in progress',     summaryReproductionPending: 'Awaiting reproduction',     summaryReproductionActiveHint: 'Reproduction is still in progress; this is not a final result.',
    summaryWontFixReasonDuplicateOf: 'Duplicate issue',
    summaryWontFixReasonByDesign: 'Works as designed',
    summaryWontFixReasonInvalid: 'No action needed (nothing actionable)',
    summaryWontFixReasonEvaluationPending: 'Under evaluation',
    state_completed_needs_fix: 'Handled, pending release',
    summaryShowFullConclusion: 'Show full conclusion',
    summaryBackground: 'Background',
    summarySectionCompleted: 'Completed',
    summarySectionArtifacts: 'Evidence and artifacts',
    summarySectionCurrentAction: 'Current action',
    summaryAgentEnglish: 'English original',
    summaryActualFindings: 'What was found',
    summaryWhyNoFix: 'Why this was not auto-fixed',
    taskLabelsMore: '+{value}',
    summaryMissingInfo: 'Information needed to decide',
    summaryCompletedTitlePlain: 'Outcome',
    summaryCompletedNoFollowup: 'Handling is complete; automation stops here. Use the new-attempt action if you want to continue.',
    issueDescriptionEmpty: '(This issue has no body text.)',
    summarySegmentEvidence: 'Evidence',
    summarySegmentRouteDecision: 'Route decision',
    summarySegmentImplementation: 'Implementation',
    summarySegmentValidation: 'Validation',
    summarySegmentDelivery: 'Delivery',
    summaryCompletedTitle: 'This segment',
    summaryDecisionTitle: 'Decided',
    summaryRejectedTitle: 'Rejected alternatives',
    summaryNextStep: 'Next step',
    summaryBlockers: 'Blockers',
    summaryConclusion: 'Conclusion',
    summaryProcessDetails: 'View process details',
    summaryTechReceipts: 'Technical receipts (raw text)',
    localPathRefHint: 'Local file - cannot be opened from the app: {path}',
    summaryPendingGate: 'Waiting for you in the approval panel above',
    recoveryReasonHostRestart: 'Interrupted by an abnormal app shutdown',
    recoveryReasonExecutionFailure: 'Interrupted by an execution failure',
    recoveryReasonPlanExhausted: 'Interrupted because the plan ran dry: no open todo, no approval gate, no terminal declaration',
    recoveryReasonSettlementUnverified: 'Interrupted because settlement could not validate durable progress; see the technical receipts below',
    recoveryReasonSettlementNoProgress: 'Interrupted because this segment\'s closing writeback was rejected, so no settlement-recognized durable progress was recorded',
    recoveryReasonSettlementReceiptMissing: 'Interrupted because the writeback was verified but the quota spend receipt is missing, so settlement did not complete',
    recoveryReasonRepositoryPaused: 'Interrupted because the repository queue paused after another task failed',
    recoveryReasonManualRestore: 'Interrupted because an archived task was manually restored',
    outputTool: 'Tool',
    outputModel: 'Model',
    outputText: 'Output',
    outputChunks: '{value} chunks',
    sourceScheduler: 'Task scheduler',
    sourceLoopx: 'LoopX engine',
    sourceAgent: 'Agent',
    sourceGit: 'Git',
    sourceGithub: 'GitHub',
    sourceSystem: 'System',
    toolExecCommand: 'Run command',
    toolRead: 'Read file',
    toolGrep: 'Search content',
    toolLs: 'Browse directory',
    toolWebFetch: 'Fetch web page',
    toolWebSearch: 'Search web',
    toolWrite: 'Write file',
    toolEdit: 'Edit file',
    toolQueued: 'Tool queued: {tool}',
    toolWaiting: 'Tool waiting: {tool}',
    toolStarted: 'Running: {tool}',
    toolConfirmation: 'Tool needs confirmation: {tool}',
    toolConfirmed: 'Tool confirmed: {tool}',
    toolRejected: 'Tool rejected: {tool}',
    toolCompleted: 'Tool completed: {tool}',
    toolFailed: 'Tool failed: {tool}',
    toolCancelled: 'Tool cancelled: {tool}',
    toolStateQueued: 'Queued',
    toolStateWaiting: 'Waiting',
    toolStateStarted: 'Running',
    toolStateConfirmation: 'Needs confirmation',
    toolStateConfirmed: 'Confirmed',
    toolStateRejected: 'Rejected',
    toolStateCompleted: 'Completed',
    toolStateFailed: 'Failed',
    toolStateCancelled: 'Cancelled',
    newEvents: 'Scroll to latest output',
    confirmTask: 'Confirm task',
    repository: 'Repository',
    workspace: 'Workspace',
    workspace_existing_worktree: 'Use existing worktree',
    workspace_new_worktree: 'Create an isolated worktree',
    workspace_clone_required: 'Clone and create a worktree',
    workspace_unavailable: 'Workspace unavailable',
    imageCapability: 'Image support',
    supported: 'Supported',
    unsupported: 'Unsupported',
    items: 'Issue / PR',
    permissions: 'Permissions for this run',
    explicitGrant: 'Explicit grant',
    cancel: 'Cancel',
    close: 'Close',
    createTasks: 'Create selected tasks',
    newAttempt: 'New attempt',
    terminalExists: 'A terminal task already exists',
    confirmNewAttempt: 'Confirm new attempt',
    decisionRequired: 'Your decision is required',
    systemNotificationTitle: 'BitFun LoopX needs your decision · {label}',
    afterApprove: 'If approved',
    afterReject: 'If rejected',
    approvalNote: 'Approval note',
    approvalNoteToggle: 'Add note',
    approvalNotePlaceholder: 'Optional reason for approving or rejecting',
    reject: 'Reject',
    approve: 'Approve',
    pause: 'Pause',
    resume: 'Resume',
    resumeRepository: 'Recover repository tasks ({value})',
    resumeTargetMissing: 'Resume target is stale; refresh the task list and retry',
    resumingRepository: 'Recovering failed tasks...',
    repositorySerial: 'Runs serially per repository',
    batchAction: 'Batch action',
    resumeRepositoryTitle: 'Recover repository failures',
    confirmContinue: 'Continue tasks',
    resumeRepositoryMessage: 'Recover {value} paused, interrupted, or failed tasks in {repository}. One task runs at a time; the rest remain queued.',
    resumeRepositoryApplied: 'Queued {value} repository tasks.',
    repositoryPausedByModel: 'Model request failed; repository queue paused',
    archive: 'Archive & clean workspace',
    restore: 'Restore',
    updated: 'Updated {duration} ago',
    taskUpdated: 'Task updated {duration} ago',
    openInGithub: 'Open in GitHub',
    openExternalFailed: 'Could not open the link. Copy the address into your browser instead.',
    currentWork: 'Current',
    outcomeUpdated: 'Progress updated {duration} ago',
    stagePending: 'Pending',
    stageActive: 'Active',
    stageComplete: 'Complete',
    stageBlocked: 'Blocked',
    progressSummaryLine: 'The repair runs five stages: worktree → analysis and plan → implementation → validation → settlement. Current: {stage}.',
    progressPreparing: 'Preparing an isolated worktree',
    progressQueued: 'Waiting for the previous repository issue',
    progressAnalyzing: 'Analyzing the cause and forming an actionable plan',
    progressImplementing: 'Code changes are in progress',
    progressValidating: 'Validating this outcome',
    progressSettling: 'Saving this stage of progress',
    progressWaiting: 'Waiting for your decision',
    progressRecovery: 'Execution was interrupted',
    progressCompleted: 'The repair workflow is complete',
    progressResolvedUpstream: 'Resolved upstream',
    progressResolvedUpstreamDetail: 'The current upstream code has removed the original failure path, so no additional patch is required.',
    progressIdle: 'Waiting for task progress',
    issueDescription: 'Issue description',
    loadingIssueDescription: 'Loading issue description...',
    issueDescriptionUnavailable: 'Issue description is temporarily unavailable.',
    issueDescriptionExcerptNote: 'This is a truncated plain-text excerpt, not the original GitHub body (markdown was removed).',
    issueDescriptionOpenOnGithub: 'View the full description on GitHub',
    publishApprovalTitle: 'Publish the fix and create a pull request?',
    publishApprovalSummary: 'The fix is prepared on branch {branch} at commit {commit} for {repository}. Your approval is required before publishing it.',
    publishApprovalSummaryGeneric: 'The fix and publishing materials are ready for {repository}. Your approval is required before creating the pull request.',
    publishApprovalApproveEffect: 'Push the fix branch and create a pull request. Approval does not merge code automatically; merging stays your decision.',
    publishApprovalRejectEffect: 'Do not push the branch or create a pull request. Keep the local branch, commit, and validation results, and stop at this step.',
    publishApprovalRecommendationReady: 'Recommended: approve. The change has validation results and remains reviewable in the pull request; it will not be merged automatically.',
    publishApprovalRecommendationReview: 'Review the change and validation results first. Approval publishes a pull request but does not merge it automatically.',
    publishApprovalApprove: 'Approve and create PR',
    publishApprovalReject: 'Keep local only',
    state_queued_repo_wait_with: 'Waiting for {item} to finish first',
    externalActionTitlePr: 'Create a pull request for {item}',
    externalActionPushDetail: 'Push branch {branch} (commit {commit}) and open a pull request; nothing is merged automatically.',
    externalActionPushDetailNoCommit: 'Push branch {branch} and open a pull request; nothing is merged automatically.',
    externalActionPushDetailUnknown: 'Push the prepared fix branch to {repository} and open a pull request; nothing is merged automatically.',
    externalActionApprovePr: 'Push the branch and open a pull request (no automatic merge).',
    externalActionRejectPr: 'Do not push or open a pull request; keep the local branch, commit, and validation results.',
    externalActionTitlePush: 'Push a branch or commit',
    externalActionPushSummary: 'Push the local commit to the remote repository (no pull request).',
    externalActionApprovePush: 'Run the git push.',
    externalActionRejectPush: 'Do not push; keep the local commit and workspace.',
    externalActionTitleValidate: 'Run external validation (build / install / real run)',
    externalActionSummaryValidate: 'Run a build, install, or real-run validation without changing repository content.',
    externalActionApproveValidate: 'Run the validation and report the result.',
    externalActionRejectValidate: 'Do not run the validation; the task stays waiting.',
    externalActionTitle: 'External action needs your approval',
    externalActionSummaryDetail: 'Requested action: {detail}',
    externalActionSummaryFallback: 'The agent requested an external action that needs your approval.',
    externalActionApproveFallback: 'Perform that action and report the result.',
    externalActionRejectFallback: 'Do not perform the action; existing changes, evidence, and the workspace are kept.',
    approvalAppliedGenericDetail: 'Approved: {detail}',
    summarySupportingEvidence: 'Supporting evidence',
    summaryArtifactSupports: 'Supports: {value}',
    artifactKindSource: 'Source issue',
    artifactKindRepro: 'Reproduction / verification evidence',
    artifactKindValidation: 'Validation evidence',
    artifactKindImplementation: 'Implementation and change scope',
    artifactKindDocs: 'Module constraints and design basis',
    artifactKindReview: 'Publish / review preparation',
    artifactKindFile: 'Related file',
    gateRawDetails: 'Verbatim request (technical details only)',
    gateGrantAuthorityScopes: 'Required scopes: {scopes}.',
    gateGatedReadTitle: 'Allow reading the issue body and maintainer comments?',
    gateGatedReadSummary: 'The agent can only see metadata (title, labels, state) so far. To judge whether this issue is worth fixing and whether someone already handled it, it needs to read the issue body and comments. That content is only used for this task\'s analysis and is never copied into public state.',
    gateGatedReadApproveEffect: 'The agent will read the issue body and maintainer comments, continue the prior-work evidence check, then report a conclusion or continue the fix.',
    gateGatedReadRejectEffect: 'No content will be read and the task stays waiting. You can also paste key details in the note and approve.',
    gateGatedReadApprove: 'Allow reading',
    gateGatedReadReject: 'Not now',
    gateClarifyTitle: 'Maintainer feedback is ambiguous — clarification needed',
    gateClarifySummary: 'The maintainer\'s requested change can be interpreted in multiple ways; the agent cannot determine the intended behavior and needs your direction. The original feedback is below.',
    gateClarifyApproveEffect: 'After approving, describe the intended behavior or tradeoff in the note; the agent will continue accordingly.',
    gateReuseMergeTitle: 'Merge the existing PR as this issue\'s solution?',
    gateReuseMergeSummaryWithPr: 'The agent evaluated existing {pr} ({title}) as already fixing this issue with solid verification evidence; no duplicate implementation is needed. Confirm PR ownership and merge authority before approving.',
    gateReuseMergeSummary: 'The agent evaluated an existing PR as already fixing this issue with solid verification evidence; no duplicate implementation is needed. Confirm PR ownership and merge authority before approving.',
    gateReuseMergeApproveEffect: 'No new patch or PR will be submitted for this issue; {pr} will be reused as the solution and merged. The task keeps tracking that PR\'s merge/close state until it closes out.',
    gateReuseMergeRejectEffect: 'This round will not merge {pr} and the task will not proceed; the evaluation, workspace, and evidence are preserved. Note a reason, or ask the agent for an independent patch route instead.',
    gateReuseMergeRecommendation: 'Recommendation: approve only when the PR content and merge timing match your expectations; merging is an external action on the upstream repository.',
    gateReuseMergeApprove: 'Approve merge',
    gateReuseMergeReject: 'Reject',
    gateReuseMergeFallbackPr: 'the existing PR',
    gateClarifyRejectEffect: 'The feedback will not be processed for now and the task stays waiting; it can be revisited after the maintainer clarifies.',
    gateGrantAuthorityTitle: 'Additional write authority required',
    gateGrantAuthoritySummary: 'The maintainer\'s requested change is understood, but applying it requires write authority that is not currently granted. Confirm the scope before deciding.',
    gateGrantAuthorityApproveEffect: 'The agent will apply the maintainer\'s change with the granted authority and report back when done.',
    gateGrantAuthorityRejectEffect: 'Authority will not be granted; the agent records the request as blocked and keeps waiting.',
    gateDraftReadyTitle: 'Mark the draft PR as ready for review?',
    gateDraftReadySummary: 'The fix PR is still a draft. Decide whether to mark it ready for review and start the review process.',
    gateDraftReadyApproveEffect: 'The PR will be marked ready for review and reviewers invited per repository policy.',
    gateDraftReadyRejectEffect: 'The PR stays a draft and monitoring continues; you can approve later.',
    justNow: 'just now',
    seconds: '{value}s',
    minutes: '{value}m',
    hours: '{value}h',
    days: '{value}d',
    intakeUnavailable: 'Tasks cannot be created from this execution location.',
    bridgeUnavailable: 'The host did not expose the trusted LoopX runtime interface. Update BitFun and try again.',
    selectAtLeastOne: 'Select at least one open issue or pull request.',
    selectAll: 'Select all',
    selectPermissions: 'Confirm every required permission scope before creating the task.',
    previewExpired: 'This preview is stale. Analyze the URL again.',
    taskCreated: 'Task created.',
    tasksCreated: '{value} tasks created.',
    outcomeCount: '{message} ({value} items)',
    selectedCandidates: '{selected} / {total} selected',
    batchSelection: 'Each of the {value} selected issues or pull requests will become a separate task. Workspaces are prepared one at a time.',
    workspacePreparationFailed: 'Workspace setup failed',
    queuedRepoBusy: 'Waiting for the active task in this repository',
    queuedBoundedWait: 'Between bounded turns',
    openedExisting: 'Opened the existing task without creating a duplicate.',
    closedNoop: 'The target is closed or merged; no task was created.',
    liveVerification: 'The target needs another live verification before a task can be created.',
    retryRequired: 'A terminal task exists. Confirm before creating a new attempt.',
    actionApplied: 'Action applied.',
    actionAppliedResume: 'Resumed: {item}',
    actionAppliedRestore: 'Restored: {item}',
    actionAppliedPause: 'Paused: {item}',
    actionAppliedAbort: 'Aborted: {item}',
    actionAppliedArchive: 'Archived: {item}',
    actionAppliedRetry: 'Retried: {item}',
    noticeOpenLink: 'Open link',
    issuePullRequest: 'Pull request',
    publishOutcomePr: 'Pull request created: #{number}',
    publishOutcomeComment: 'Maintainer comment published: {item}',
    approvalSubmitting: 'Submitting the decision. The task will continue after host confirmation.',
    approvalSubmittingShort: 'Submitting decision...',
    actionPending: 'Applying action',
    pausePending: 'Pausing',
    resumePending: 'Continuing',
    archivePending: 'Archiving',
    actionDuplicate: 'This action was already applied.',
    revisionConflict: 'Task state changed. The latest snapshot has been loaded.',
    actionRejected: 'The host rejected this action.',
    noGate: 'No answerable approval gate was found. Refresh the task state.',
    approvalNeeded: 'The task is waiting at an approval gate that can be answered remotely.',
    activityInstallingDependencies: 'Preparing project dependencies',
    activityBuildingInstaller: 'Building the Windows installer',
    activityTestingUpgrade: 'Validating the installer upgrade path',
    activityWaitingProcess: 'Waiting for an external process to finish',
    activitySyncingProgress: 'Synchronizing durable progress',
    activityCheckingRepository: 'Checking repository state',
    activityRunningCommand: 'Running a project command',
    truncatedCandidates: 'The candidate list was truncated. Narrow the repository scope and analyze again.',
    imageWarning: 'Selected content contains images, but the current model does not support image input.',
    modelUnavailable: 'The selected model is unavailable. Go back and choose another model.',
    workspaceUnavailable: 'The host cannot prepare a trusted worktree for this repository.',
    resolvedItem: 'Resolved',
    openItem: 'Open',
    fromRepository: 'Repository candidate',
    taskNumber: 'Task {value}',
    sidecar: 'LoopX engine',
    nodeRuntime: 'Node.js runtime',
    gitWorktree: 'Git / Worktree',
    agentModel: 'Agent model',
    pythonFallback: 'Python fallback',
    githubAuth: 'GitHub sign-in',
    status_unknown: 'Unknown',
    status_checking: 'Checking',
    status_available: 'Available',
    status_degraded: 'Degraded',
    status_unavailable: 'Unavailable',
    status_ready: 'Ready',
    status_blocked: 'Blocked',
    state_preparing: 'Preparing',
    state_queued: 'Queued',
    state_queued_repo_wait: 'Waiting for same-repo task',
    state_queued_after_approval: 'Approved, waiting to run',
    action_issue_fix_confirm_reproduction: 'Confirm reproduction',
    action_issue_fix_feasibility_decision: 'Feasibility decision',
    action_issue_fix_apply_patch: 'Apply fix',
    action_issue_fix_validated_fix: 'Validate fix',
    action_issue_fix_pr_review_packet: 'Prepare PR review packet',
    action_issue_fix_external_comment_packet: 'Prepare external comment',
    action_issue_fix_delivery: 'Delivery and publish',
    action_issue_fix_publish: 'Publish PR',
    action_issue_fix_track: 'PR monitor',
    state_running: 'Running',
    state_waiting_for_user: 'Pending approval',
    state_waiting_for_external: 'External wait',
    state_retry_wait: 'Retry wait',
    state_cancelling: 'Stopping',
    state_stopped: 'Paused',
    state_recovery_required: 'Pending recovery',
    state_completed: 'Completed',
    state_failed: 'Failed',
    state_archived: 'Archived',
    state_resolved_upstream: 'Resolved upstream',
    phase_unknown: 'Waiting for host state',
    phase_validating_environment: 'Validating environment',
    phase_resolving_intake: 'Resolving intake',
    phase_preparing_workspace: 'Preparing an isolated workspace',
    phase_creating_goal: 'Preparing the task objective',
    phase_queued: 'Waiting for scheduler',
    phase_inspecting_goal: 'Reviewing the task objective',
    phase_building_turn: 'Building turn',
    phase_starting_agent: 'Starting the repair task',
    phase_agent_running: 'Analyzing or modifying code',
    phase_validating_progress: 'Validating results',
    phase_settling_turn: 'Saving progress',
    phase_waiting_for_approval: 'Waiting for approval',
    phase_retry_backoff: 'Retry backoff',
    phase_cancelling: 'Cancelling',
    phase_recovering: 'Recovering and syncing',
    phase_finished: 'Finished',
    monitor_phase_queued: 'PR monitor waiting',
    monitor_chip: 'PR monitor',
    monitor_waiting_detail: 'The LoopX heartbeat checks CI, review, and new comments on its own cadence; waiting here is a normal part of the delivery loop and does not consume model quota.',
    monitor_next_check: 'Next check',
    scope_workspace_read: 'Read workspace',
    scope_workspace_write: 'Modify workspace',
    scope_git_local: 'Local Git operations',
    scope_github_read: 'Read GitHub',
    scope_agent_execution: 'Run agent',
    scope_publish: 'Publish changes',
    scope_public_comment: 'Post public comments',
    scope_pull_request: 'Create pull requests',
    scope_merge: 'Merge pull requests',
    scope_production_action: 'Production actions',
    scopeHighRisk: 'External side effect requiring separate confirmation',
    scopeStandard: 'Capability required for this run',
  },
};

const view = {
  root: byId('loopx-app'),
  connectionLabel: byId('connection-label'),
  intakeForm: byId('intake-form'),
  intakeInput: byId('intake-input'),
  intakeHistory: byId('intake-history'),
  modelSelect: byId('model-select'),
  resolveButton: byId('resolve-button'),
  resetLoopx: byId('reset-loopx'),
  pauseAllLoopx: byId('pause-all-loopx'),
  resumeAllLoopx: byId('resume-all-loopx'),
  notice: byId('notice'),
  unsupportedBanner: byId('unsupported-banner'),
  unsupportedReason: byId('unsupported-reason'),
  approvalAlert: byId('approval-alert'),
  approvalAlertTitle: byId('approval-alert-title'),
  approvalAlertMessage: byId('approval-alert-message'),
  approvalAlertOpen: byId('approval-alert-open'),
  approvalAlertOpenAction: byId('approval-alert-open-action'),
  environmentPanel: byId('environment-panel'),
  environmentDot: byId('environment-dot'),
  environmentStatus: byId('environment-status'),
  environmentChecked: byId('environment-checked'),
  environmentRemediation: byId('environment-remediation'),
  environmentRemediationTitle: byId('environment-remediation-title'),
  environmentRemediationDetail: byId('environment-remediation-detail'),
  environmentRemediationProgress: byId('environment-remediation-progress'),
  installLoopx: byId('install-loopx'),
  installLoopxLabel: byId('install-loopx-label'),
  coreEnvironmentList: byId('core-environment-list'),
  optionalEnvironmentList: byId('optional-environment-list'),
  retryEnvironment: byId('retry-environment'),
  taskRail: byId('task-rail'),
  railSplitter: byId('rail-splitter'),
  collapseTasks: byId('collapse-tasks'),
  taskCount: byId('task-count'),
  repositoryActions: byId('repository-actions'),
  resumeRepository: byId('resume-repository'),
  repositoryActionsMeta: byId('repository-actions-meta'),
  taskItems: byId('task-items'),
  taskEmpty: byId('task-empty'),
  issueWorkspace: byId('log-workspace'),
  followBanner: byId('follow-banner'),
  followBannerText: byId('follow-banner-text'),
  issueEmpty: byId('issue-empty'),
  issueView: byId('issue-view'),
  issueTitle: byId('issue-title'),
  issueStatePill: byId('issue-state-pill'),
  issueMetaSep1: byId('issue-meta-sep-1'),
  issueLink: byId('issue-link'),
  issueMetaSep3: byId('issue-meta-sep-3'),
  issuePrLink: byId('issue-pr-link'),
  issueMetaSep2: byId('issue-meta-sep-2'),
  issueUpdated: byId('issue-updated'),
  issueDetail: byId('issue-detail'),
  issueSplitter: byId('issue-splitter'),
  issueApprovalPanel: byId('issue-approval-panel'),
  issueApprovalRaw: byId('issue-approval-raw'),
  issueApprovalContext: byId('issue-approval-context'),
  issueApprovalContextList: byId('issue-approval-context-list'),
  issueApprovalRawText: byId('issue-approval-raw-text'),
  issueApprovalKind: byId('issue-approval-kind'),
  issueApprovalTitle: byId('issue-approval-title'),
  issueApprovalMessage: byId('issue-approval-message'),
  issueApprovalApproveEffect: byId('issue-approval-approve-effect'),
  issueApprovalRejectEffect: byId('issue-approval-reject-effect'),
  issueApprovalRecommendation: byId('issue-approval-recommendation'),
  issueApprovalNote: byId('issue-approval-note'),
  issueApprovalNoteToggle: byId('issue-approval-note-toggle'),
  issueApprovalReject: byId('issue-approval-reject'),
  issueApprovalApprove: byId('issue-approval-approve'),
  issueDecisionCard: byId('issue-decision-card'),
  issueSummaryMeta: byId('issue-summary-meta'),
  issueSummary: byId('issue-summary'),
  issueError: byId('issue-error'),
  issueDescriptionPanel: byId('issue-description-panel'),
  issueDescription: byId('issue-description'),
  issueNumber: byId('issue-number'),
  timelineScope: byId('timeline-scope'),
  taskActions: byId('task-actions'),
  logScroll: byId('log-scroll'),
  logEmpty: byId('log-empty'),
  logEmptyText: byId('log-empty-text'),
  logList: byId('log-list'),
  newEvents: byId('new-events'),
  intakeDialog: byId('intake-dialog'),
  intakeConfirmForm: byId('intake-confirm-form'),
  intakeDialogTitle: byId('intake-dialog-title'),
  previewRepository: byId('preview-repository'),
  previewWorkspace: byId('preview-workspace'),
  previewModel: byId('preview-model'),
  previewImages: byId('preview-images'),
  candidateCount: byId('candidate-count'),
  candidateSelectAll: byId('candidate-select-all'),
  candidateList: byId('candidate-list'),
  permissionList: byId('permission-list'),
  intakeWarning: byId('intake-warning'),
  createButton: byId('create-button'),
  retryDialog: byId('retry-dialog'),
  retryMessage: byId('retry-message'),
  retryCancel: byId('retry-cancel'),
  retryConfirm: byId('retry-confirm'),
  repositoryResumeDialog: byId('repository-resume-dialog'),
  repositoryResumeMessage: byId('repository-resume-message'),
  repositoryResumeCancel: byId('repository-resume-cancel'),
  repositoryResumeConfirm: byId('repository-resume-confirm'),
  resetLoopxDialog: byId('reset-loopx-dialog'),
  resetLoopxMessage: byId('reset-loopx-message'),
  resetLoopxCancel: byId('reset-loopx-cancel'),
  resetLoopxConfirm: byId('reset-loopx-confirm'),
};

const PUBLISH_ARMED_STORAGE_KEY = 'loopx.publishArmed';
const PUBLISH_SEEN_STORAGE_KEY = 'loopx.publishSeen';

function loadStoredIdSet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []);
  } catch (error) {
    return new Set();
  }
}

function storeIdSet(key, values) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values].slice(-50)));
  } catch (error) {
    // 存储失败不影响主流程：播报只是体验优化。
  }
}

const state = {
  snapshot: null,
  events: [],
  eventKeys: new Set(),
  selectedTaskId: null,
  followLogs: true,
  expandedThinking: new Set(),
  expandedTool: new Set(),
  expandedLogDetails: new Set(),
  preview: null,
  pendingCreate: null,
  pendingRetry: null,
  approvalTaskId: null,
  ownerActionChecks: new Map(),
  autoRecheckAt: new Map(),
  promptedGateIds: new Set(),
  pendingApprovalPrompt: false,
  syncing: false,
  syncRequested: false,
  pendingResumeSignal: false,
  lastClockSampleAt: Date.now(),
  lastHostSignalAt: Date.now(),
  lastReattachAt: 0,
  gapRecovery: null,
  connected: false,
  railCollapsed: false,
  issueDetailWidth: null,
  intakeHistory: [],
  outputHistory: [],
  outputKeys: new Set(),
  outputCharacters: 0,
  turnOutput: {
    taskId: null,
    turnId: null,
    streamId: null,
    cursor: 0,
    events: [],
    message: '',
    status: 'not_running',
    inFlight: false,
    timer: null,
  },
  itemMetadata: new Map(),
  metadataRequests: new Set(),
  tornDown: false,
  repositoryResumeTarget: null,
  repositoryResumePending: false,
  taskActionPending: new Map(),
  gateAppliedPresentations: new Map(),
  gateSubmittingAction: '',
  publishOutcomeArmed: loadStoredIdSet(PUBLISH_ARMED_STORAGE_KEY),
  publishOutcomeSeen: loadStoredIdSet(PUBLISH_SEEN_STORAGE_KEY),
  approvedWaitingTasks: new Set(),
  modelCatalogLoading: false,
  modelCatalogLoaded: false,
  environmentInstallPending: false,
  environmentInstallObserved: false,
  environmentInstallRequestId: null,
  resetPending: false,
};

function localeId() {
  const raw = app && typeof app.locale === 'string' ? app.locale : 'en-US';
  return raw.startsWith('zh') ? 'zh-CN' : 'en-US';
}

function text(key, values) {
  const table = COPY[localeId()] || COPY['en-US'];
  let output = table[key] || COPY['en-US'][key] || key;
  if (values) {
    Object.entries(values).forEach(([name, value]) => {
      output = output.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
    });
  }
  return output;
}

function applyLocale() {
  document.documentElement.lang = localeId();
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = text(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
    element.setAttribute('placeholder', text(element.dataset.i18nPlaceholder));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((element) => {
    const value = text(element.dataset.i18nTitle);
    element.setAttribute('title', value);
    if (element.getAttribute('aria-label')) element.setAttribute('aria-label', value);
  });
  view.intakeForm.setAttribute('aria-label', text('intakeLabel'));
  view.modelSelect.setAttribute('aria-label', text('model'));
  renderAll();
}

function normalizeTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 100000000000 ? number * 1000 : number;
}

function durationLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 8) return text('justNow');
  if (seconds < 60) return text('seconds', { value: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return text('minutes', { value: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return text('hours', { value: hours });
  return text('days', { value: Math.floor(hours / 24) });
}

function relativeLabel(value) {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) return '--';
  return durationLabel(Date.now() - timestamp);
}

function clockLabel(value) {
  const timestamp = normalizeTimestamp(value);
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function stateLabel(value) { return text(`state_${value || 'recovery_required'}`); }
function phaseLabel(value) { return text(`phase_${value || 'unknown'}`); }
function statusLabel(value) { return text(`status_${value || 'unknown'}`); }
function scopeLabel(value) { return text(`scope_${value}`); }

function isWorkspacePreparationFailure(task) {
  return Boolean(task && task.error && !task.workspacePath && !task.goalId);
}

function isResolvedUpstream(task) {
  const summary = String(task && task.lastAgentSummary || '');
  return /covered[-_ ]?upstream.{0,80}no[-_ ]?follow[-_ ]?up/is.test(summary)
    || /原始故障路径.{0,40}(?:消失|移除).{0,120}(?:不开\s*PR|无需.{0,20}修复)/is.test(summary);
}

function stripPriorityPrefix(value) {
  // 优先级标签是宿主内部字段：任何位置的 [P#] 都不能回显给用户。
  return String(value == null ? '' : value)
    .replace(/\[P\d+\]\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function taskActionKey(task) {
  const todo = task && task.currentTodo;
  return todo ? String(todo.actionKind || '') : '';
}

function taskActionLabel(task) {
  const kind = taskActionKey(task);
  if (!kind) return '';
  const known = {
    issue_fix_confirm_reproduction: 'action_issue_fix_confirm_reproduction',
    issue_fix_feasibility_decision: 'action_issue_fix_feasibility_decision',
    issue_fix_apply_patch: 'action_issue_fix_apply_patch',
    issue_fix_validated_fix: 'action_issue_fix_validated_fix',
    issue_fix_pr_review_packet: 'action_issue_fix_pr_review_packet',
    issue_fix_external_comment_packet: 'action_issue_fix_external_comment_packet',
    issue_fix_delivery: 'action_issue_fix_delivery',
    issue_fix_publish: 'action_issue_fix_publish',
  }[kind];
  if (known) return text(known);
  if (kind.startsWith('issue_fix_track_')) return text('action_issue_fix_track');
  return stripPriorityPrefix(kind.replace(/^issue_fix_/, '').replace(/_/g, ' '));
}

function sameRepositoryValue(left, right) {
  const a = left && left.repository ? left.repository : left;
  const b = right && right.repository ? right.repository : right;
  if (!a || !b) return false;
  return String(a.host || '') === String(b.host || '')
    && String(a.owner || '') === String(b.owner || '')
    && String(a.repository || '') === String(b.repository || '');
}

function taskRepositoryItem(task) {
  return task && task.identity ? task.identity.item : null;
}

function activeSameRepoTask(task) {
  if (!task || !state.snapshot || !Array.isArray(state.snapshot.tasks)) return null;
  const item = taskRepositoryItem(task);
  if (!item) return null;
  return state.snapshot.tasks.find((other) => (
    other
    && other.taskId !== task.taskId
    && sameRepositoryValue(taskRepositoryItem(other), item)
    && (other.state === 'running' || other.state === 'preparing')
  )) || null;
}

function hasActiveSameRepoTask(task) {
  return Boolean(activeSameRepoTask(task));
}

function pruneApprovedWaiting(tasks) {
  if (!state.approvedWaitingTasks || !state.approvedWaitingTasks.size) return;
  [...state.approvedWaitingTasks].forEach((taskId) => {
    const entry = Array.isArray(tasks) ? tasks.find((item) => item && item.taskId === taskId) : null;
    if (!entry || entry.state !== 'queued') state.approvedWaitingTasks.delete(taskId);
  });
}

/// 已批准但还没轮到执行。宿主批准后可能立刻清掉 gate，前端的事件窗口也会被重置，
/// 所以命中一次就记住，避免同一个任务在「排队中 / 已批准，等待执行」之间反复跳。
function approvedActionPending(task) {
  const todo = task && task.currentTodo;
  const kind = todo ? String(todo.actionKind || '') : '';
  return kind === 'issue_fix_publish_pr'
    || kind === 'issue_fix_publish_comment';
}

function isApprovedWaiting(task) {
  if (!task || task.state !== 'queued') return false;
  if (state.approvedWaitingTasks && state.approvedWaitingTasks.has(task.taskId)) return true;
  const approved = queuedAfterApproval(task) || approvedActionPending(task);
  if (approved && state.approvedWaitingTasks) state.approvedWaitingTasks.add(task.taskId);
  return approved;
}

function queuedAfterApproval(task) {
  if (!task || task.state !== 'queued' || !Array.isArray(state.events)) return false;
  let sawApproval = false;
  for (const event of state.events) {
    if (!event || event.taskId !== task.taskId) continue;
    const message = String(event.message || '');
    if (event.kind === 'approval_required') sawApproval = true;
    else if (sawApproval && /Applying the typed LoopX gate decision/i.test(message)) return true;
  }
  return false;
}

function queuedContextLabel(task) {
  if (!task || task.state !== 'queued') return '';
  const blocker = activeSameRepoTask(task);
  if (blocker) {
    return text('state_queued_repo_wait_with', {
      item: compactItemLabel(blocker.identity && blocker.identity.item) || shortId(blocker.taskId),
    });
  }
  if (isApprovedWaiting(task)) return text('state_queued_after_approval');
  return '';
}
function taskStateLabel(task) {
  if (isResolvedUpstream(task)) return stateLabel('resolved_upstream');
  return isWorkspacePreparationFailure(task) ? stateLabel('failed') : stateLabel(task && task.state);
}

/// A waiting task WITHOUT a live typed gate is parked on an owner action
/// outside this host (for example merging a PR on GitHub). It is a waiting
/// status, not an approval request: the rail and the header must not label
/// it "pending approval" while the approval panel stays hidden.
function isExternalWait(task) {
  return Boolean(task)
    && task.state === 'waiting_for_user'
    && !task.pendingGateId
    && String(task.pendingGateMessage || '').trim().length > 0;
}

function pendingActionFor(task) {
  return task && task.taskId ? state.taskActionPending.get(task.taskId) : '';
}

function taskVisualState(task) {
  const pending = pendingActionFor(task);
  if (pending === 'pause' || pending === 'abort') return 'cancelling';
  if (isResolvedUpstream(task)) return 'completed';
  return isWorkspacePreparationFailure(task)
    ? 'failed'
    : ((task && task.state) || 'recovery_required');
}

function taskStateDisplayLabel(task) {
  const pending = pendingActionFor(task);
  if (pending === 'pause' || pending === 'abort') return text('pausePending');
  if (pending === 'resume' || pending === 'restore') return text('resumePending');
  if (pending === 'archive') return text('archivePending');
  if (pending) return text('actionPending');
  if (isExternalWait(task)) return text('state_waiting_for_external');
  if (task && task.state === 'completed') {
    const completion = completionLabel(task);
    if (completion) return completion;
  }
  const queuedContext = queuedContextLabel(task);
  if (queuedContext) return queuedContext;
  return taskStateLabel(task);
}

function taskPhaseLabel(task) {
  if (isWorkspacePreparationFailure(task)) return text('workspacePreparationFailed');
  if (isExternalWait(task)) return text('state_waiting_for_external');
  return phaseLabel(task && task.phase);
}

/// The LoopX frontier-todo projection marks the PR-lifecycle monitoring
/// phase. It is display-only; the LoopX registry stays authoritative.
/// Mirrors the Rust classifier `is_loopx_monitor_action` (policy.rs): the
/// `_monitor` suffix family plus the `issue_fix_track_*` merge-readiness
/// trackers. Keep both sides in sync.
function isMonitorTodo(task) {
  const todo = task && task.currentTodo;
  if (!todo) return false;
  if (String(todo.taskClass || '') === 'continuous_monitor') return true;
  const kind = String(todo.actionKind || '');
  return /_monitor$/.test(kind) || kind.startsWith('issue_fix_track_');
}

function monitorNextCheckLabel(task) {
  const raw = task && task.currentTodo && task.currentTodo.nextDueAt;
  const value = String(raw || '').trim();
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 40);
  const pad = (part) => String(part).padStart(2, '0');
  return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function monitorWaitDetail(task) {
  const detail = text('monitor_waiting_detail');
  const due = monitorNextCheckLabel(task);
  return due ? `${detail} ${text('monitor_next_check')}: ${due}` : detail;
}

function compactItemLabel(item) {
  if (!item) return '--';
  return `${item.kind === 'pr' ? 'PR' : 'Issue'} #${item.number}`;
}

function shortId(value) {
  const raw = value == null ? '' : String(value);
  return raw.length > 14 ? raw.slice(0, 8) : raw;
}

function isPlanExhaustedMessage(message) {
  return /plan is exhausted|parks? for an owner decision|does not fabricate (?:a )?terminal|Resume after the goal gains/i.test(String(message || ''));
}

function showNotice(message, tone = 'neutral', linkUrl = '') {
  const clearNotice = () => {
    view.notice.hidden = true;
    view.notice.textContent = '';
    view.notice.dataset.tone = '';
  };
  if (!message) { clearNotice(); return; }
  const raw = stripPriorityPrefix(message);
  if (!raw) { clearNotice(); return; }
  const parked = isPlanExhaustedMessage(raw);
  view.notice.textContent = parked ? text('decisionCardPlanExhaustedHint') : raw;
  view.notice.dataset.tone = parked ? 'warning' : tone;
  view.notice.hidden = false;
  const target = String(linkUrl || '').trim();
  if (!target) return;
  // 产物类回执（已创建 PR / 已发布评论）直接给可点链接，省掉让用户去时间线里找。
  const anchor = document.createElement('a');
  anchor.className = 'notice__link';
  anchor.href = target;
  anchor.textContent = text('noticeOpenLink');
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    openExternalUrl(target);
  });
  view.notice.append(' ', anchor);
}

/// Async completions (hydrate, reattach, actions) may settle after the host
/// surface went away; every DOM render must be a no-op then.
function canRender() {
  return !state.tornDown
    && typeof document !== 'undefined'
    && Boolean(document.createDocumentFragment);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || 'Unknown error');
}

function readStoredModelSelection() {
  try {
    return window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY) || '';
  } catch (_error) {
    return '';
  }
}

function writeStoredModelSelection(value) {
  try {
    window.localStorage.setItem(MODEL_SELECTION_STORAGE_KEY, value || 'auto');
  } catch (_error) {
    // Ignore storage failures; the current select value still applies.
  }
}

function renderIntakeHistory() {
  if (!view.intakeHistory) return;
  const fragment = document.createDocumentFragment();
  state.intakeHistory.forEach((url) => {
    const option = document.createElement('option');
    option.value = url;
    fragment.append(option);
  });
  view.intakeHistory.replaceChildren(fragment);
}

async function loadIntakeHistory() {
  if (!app || !app.storage || typeof app.storage.get !== 'function') return;
  try {
    const stored = await app.storage.get(INTAKE_HISTORY_STORAGE_KEY);
    state.intakeHistory = Array.isArray(stored)
      ? stored.filter((value) => typeof value === 'string' && value.trim()).slice(0, MAX_INTAKE_HISTORY)
      : [];
    renderIntakeHistory();
  } catch (_error) {
    state.intakeHistory = [];
  }
}

async function rememberIntake(value) {
  const url = String(value || '').trim();
  if (!url) return;
  state.intakeHistory = [
    url,
    ...state.intakeHistory.filter((entry) => entry.toLowerCase() !== url.toLowerCase()),
  ].slice(0, MAX_INTAKE_HISTORY);
  renderIntakeHistory();
  if (!app || !app.storage || typeof app.storage.set !== 'function') return;
  try {
    await app.storage.set(INTAKE_HISTORY_STORAGE_KEY, state.intakeHistory);
  } catch (_error) {
    // Input history remains available for the current session.
  }
}

function currentModelSelection() {
  const stored = readStoredModelSelection();
  const selected = view.modelSelect && view.modelSelect.value ? view.modelSelect.value : '';
  if (selected && (selected !== 'auto' || !stored || stored === 'auto')) return selected;
  return stored || selected || 'auto';
}

function describeModelOption(model) {
  const displayName = String(model.name || model.modelName || model.id || '').trim();
  const modelName = String(model.modelName || '').trim();
  const provider = String(model.provider || '').trim();
  const primary = displayName || modelName || model.id;
  const details = [];
  if (modelName && modelName !== primary) details.push(modelName);
  if (provider && provider !== primary && provider !== modelName) details.push(provider);
  return details.length > 0 ? `${primary} (${details.join(' · ')})` : primary;
}

function setButtonBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('is-spinning', busy);
}

function requestId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `loopx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Surfaces one owner decision through a host system notification. The host
// owns OS-level toasts: the Agent is forbidden from raising them (see the
// host execution context), so this is the only sanctioned notification path.
async function notifyGateSystemDecision(task, gate) {
  if (!app || !app.notifications || typeof app.notifications.system !== 'function') return;
  if (app.permissions && app.permissions.notifications && app.permissions.notifications.system !== true) return;
  const item = task && task.identity && task.identity.item;
  const label = issueDisplayTitle(task) || itemLabel(item);
  try {
    await app.notifications.system(
      text('systemNotificationTitle', { label }),
      String((gate.event && gate.event.message) || '').slice(0, 140),
    );
  } catch (error) {
    console.info('[bitfun-loopx] system notification skipped', error);
  }
}

function emitInstallDiagnostic(
  phase,
  request = state.environmentInstallRequestId,
  action = 'install_loopx',
) {
  const requestIdValue = request || 'unassigned';
  console.info('[bitfun-loopx] Install interaction phase', {
    phase,
    action,
    requestId: requestIdValue,
  });
  window.parent.postMessage({
    type: 'bitfun:diagnostic',
    scope: 'loopx-install',
    phase,
    action,
    requestId: requestIdValue,
  }, '*');
}

function repositoryLabel(repository) {
  if (!repository) return '--';
  return `${repository.owner || '?'}/${repository.repository || '?'}`;
}

function itemKey(item) {
  const repository = item && item.repository ? item.repository : {};
  return `${repository.host || ''}/${repository.owner || ''}/${repository.repository || ''}/${item.kind || ''}/${item.number || 0}`;
}

function itemLabel(item) {
  if (!item) return '--';
  const prefix = item.kind === 'pr' ? 'PR' : 'Issue';
  return `${repositoryLabel(item.repository)} ${prefix} #${item.number}`;
}

function itemUrl(item) {
  if (!item || !item.repository) return '';
  const { host, owner, repository } = item.repository;
  if (!host || !owner || !repository || !item.number) return '';
  const path = item.kind === 'pr' ? 'pull' : 'issues';
  return `https://${host}/${owner}/${repository}/${path}/${item.number}`;
}

/// Turns plain narrative text into DOM nodes with clickable GitHub
/// references ("PR #6", "pull request #6", "#2", short commit shas).
/// Builds elements only — no innerHTML — so agent-authored text can never
/// inject markup. Used by the brief sections and the approval context so
/// the owner can jump straight from a narrative mention to the artifact.
function linkifiedText(value, repository) {
  const raw = String(value || '');
  const fragment = document.createDocumentFragment();
  const base = repository && repository.host && repository.owner && repository.repository
    ? `https://${repository.host}/${repository.owner}/${repository.repository}`
    : '';
  const pattern = /\b(?:PR|pull request|pull)\s*#(\d+)\b|\bpull\/(\d+)\b|\b#(\d+)\b|\bcommit\s+([0-9a-f]{7,10})\b|\b([0-9a-f]{7,10})\b/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    const [full, prA, prB, issue, shaA, shaB] = match;
    let url = '';
    let label = full;
    if (prA) {
      url = `${base}/pull/${prA}`;
      label = `PR #${prA}`;
    } else if (prB) {
      url = `${base}/pull/${prB}`;
      label = `PR #${prB}`;
    } else if (issue) {
      url = `${base}/issues/${issue}`;
      label = `#${issue}`;
    } else {
      const sha = shaA || shaB;
      // Bare hex words only link when a repository is known and they are
      // not pure digits (avoids linking ordinary numbers as commits).
      if (!base || /^\d+$/.test(sha)) {
        continue;
      }
      url = `${base}/commit/${sha}`;
      label = sha;
    }
    if (match.index > cursor) {
      fragment.append(raw.slice(cursor, match.index));
    }
    if (!url) {
      fragment.append(full);
    } else {
      fragment.append(externalAnchor(label, url));
    }
    cursor = match.index + full.length;
  }
  if (cursor < raw.length) {
    fragment.append(raw.slice(cursor));
  }
  return fragment;
}

function identityTitleOf(task) {
  const item = task && task.identity && task.identity.item;
  const refreshed = (state.itemMetadata.get(itemKey(item)) || {}).title;
  if (typeof refreshed === 'string' && refreshed.trim()) return refreshed.trim();
  const title = task && task.identity && task.identity.title;
  return typeof title === 'string' ? title.trim() : '';
}

function identityDescriptionOf(task) {
  const item = task && task.identity && task.identity.item;
  const refreshed = (state.itemMetadata.get(itemKey(item)) || {}).description;
  if (typeof refreshed === 'string' && refreshed.trim()) return refreshed.trim();
  const description = task && task.identity && task.identity.description;
  return typeof description === 'string' ? description.trim() : '';
}

function compactHumanTitle(rawTitle, fallback) {
  const cleaned = String(rawTitle || '')
    .replace(/^\s*[【[]\s*(?:bug|问题)\s*[】\]]\s*[:：\-·]?\s*/i, '')
    .replace(/^\s*\d{1,2}[./-]\d{1,2}日?\s*/, '')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 88 ? `${cleaned.slice(0, 87)}…` : cleaned;
}

function issueContext(task) {
  const item = task && task.identity && task.identity.item;
  const fallback = item ? compactItemLabel(item) : '--';
  const rawTitle = identityTitleOf(task);
  return { title: compactHumanTitle(rawTitle, fallback) };
}

function issueDisplayTitle(task) {
  return issueContext(task).title;
}

function latestTaskWaitReason(task) {
  if (!task || task.state !== 'queued') return '';
  const blocker = activeSameRepoTask(task);
  if (blocker) {
    return text('state_queued_repo_wait_with', {
      item: compactItemLabel(blocker.identity && blocker.identity.item) || shortId(blocker.taskId),
    });
  }
  if (isApprovedWaiting(task)) return text('state_queued_after_approval');
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event.taskId !== task.taskId || !event.message) continue;
    const message = stripPriorityPrefix(String(event.message));
    if (/another task for this repository/i.test(message)) return text('queuedRepoBusy');
    if (/bounded turn/i.test(message)) return text('queuedBoundedWait');
    if (!/[\u3400-\u9fff]/.test(message)) continue;
    return message;
  }
  return text('queuedRepoBusy');
}

function taskForId(taskId) {
  if (!state.snapshot || !Array.isArray(state.snapshot.tasks)) return null;
  return state.snapshot.tasks.find((task) => task.taskId === taskId) || null;
}

function selectedTask() {
  return state.selectedTaskId ? taskForId(state.selectedTaskId) : null;
}

function runningOutputTask() {
  const selected = selectedTask();
  if (selected && selected.state === 'running' && selected.phase === 'agent_running') return selected;
  const tasks = state.snapshot && Array.isArray(state.snapshot.tasks)
    ? state.snapshot.tasks
    : [];
  return tasks.find((task) => task.state === 'running' && task.phase === 'agent_running') || null;
}

/// The task whose context fills the issue workspace. An explicit selection
/// always wins; without one the view follows the currently running task, then
/// the first task in execution order (state priority, then queue order), so
/// the pane opens on the issue that will be solved first.
function displayedTask() {
  const selected = selectedTask();
  if (selected) return selected;
  return runningOutputTask() || firstActionableTask() || sortedTaskList(
    ((state.snapshot && state.snapshot.tasks) || [])
      .filter((task) => task.state !== 'archived'),
  )[0] || sortedTaskList((state.snapshot && state.snapshot.tasks) || [])[0] || null;
}

function firstActionableTask() {
  const actionableStates = [
    'waiting_for_user',
    'preparing',
    'queued',
    'retry_wait',
    'recovery_required',
    'failed',
  ];
  const actionable = ((state.snapshot && state.snapshot.tasks) || [])
    .filter((task) => !taskForId(task.taskId) || !isResolvedUpstream(taskForId(task.taskId)))
    .filter((task) => actionableStates.includes(task.state));
  if (!actionable.length) return null;
  return [...actionable].sort((left, right) =>
    taskSortPriority(left) - taskSortPriority(right)
    || Number(left.createdAt || left.updatedAt || 0)
      - Number(right.createdAt || right.updatedAt || 0))[0] || null;
}

function isFollowingRunningTask() {
  return !state.selectedTaskId && Boolean(runningOutputTask());
}

function resetTurnOutput(task) {
  state.turnOutput.taskId = task ? task.taskId : null;
  state.turnOutput.turnId = task ? (task.currentTurnId || null) : null;
  state.turnOutput.streamId = null;
  state.turnOutput.cursor = 0;
  state.turnOutput.events = [];
  state.turnOutput.message = '';
  state.turnOutput.status = task ? 'current' : 'not_running';
}

function ensureTurnOutputTarget(task) {
  const currentTurn = task && task.currentTurnId ? task.currentTurnId : null;
  if (
    state.turnOutput.taskId !== (task && task.taskId)
    || state.turnOutput.turnId !== currentTurn
  ) {
    resetTurnOutput(task);
  }
}

function clearTurnOutputTimer() {
  if (state.turnOutput.timer) {
    clearTimeout(state.turnOutput.timer);
    state.turnOutput.timer = null;
  }
}

function scheduleTurnOutputPoll(delay = 1200) {
  if (state.tornDown) return;
  clearTurnOutputTimer();
  const task = runningOutputTask();
  if (!task || !app || !app.loopx || typeof app.loopx.turnOutputSince !== 'function') return;
  state.turnOutput.timer = setTimeout(() => {
    state.turnOutput.timer = null;
    void refreshTurnOutput();
  }, delay);
}

function snapshotSupported() {
  return state.snapshot && state.snapshot.executionSupport === 'supported';
}

function validEvent(event) {
  return event
    && typeof event === 'object'
    && typeof event.streamId === 'string'
    && Number.isSafeInteger(event.cursor)
    && event.cursor >= 0;
}

function addEvent(event) {
  if (!validEvent(event)) return false;
  const key = `${event.streamId}:${event.cursor}`;
  if (state.eventKeys.has(key)) return false;
  state.eventKeys.add(key);
  state.events.push(event);
  state.events.sort((left, right) => left.cursor - right.cursor);
  while (state.events.length > MAX_EVENTS) {
    const removed = state.events.shift();
    state.eventKeys.delete(`${removed.streamId}:${removed.cursor}`);
  }
  return true;
}

function replaceStreamEvents(streamId) {
  state.events = state.events.filter((event) => event.streamId === streamId);
  state.eventKeys = new Set(state.events.map((event) => `${event.streamId}:${event.cursor}`));
}

function clearRunUiState() {
  state.events = [];
  state.eventKeys.clear();
  state.selectedTaskId = null;
  state.preview = null;
  state.pendingCreate = null;
  state.pendingRetry = null;
  state.approvalTaskId = null;
  state.promptedGateIds.clear();
  state.pendingApprovalPrompt = false;
  state.repositoryResumeTarget = null;
  state.repositoryResumePending = false;
  state.taskActionPending.clear();
  state.itemMetadata.clear();
  state.metadataRequests.clear();
  state.outputHistory = [];
  state.outputKeys.clear();
  state.outputCharacters = 0;
  clearTurnOutputTimer();
  resetTurnOutput(null);
}

async function replayEvents(streamId, afterCursor, historical = false) {
  let cursor = afterCursor;
  let pageCount = 0;
  let changed = false;
  while (pageCount < 30) {
    pageCount += 1;
    const page = await app.loopx.eventsSince({
      streamId,
      afterCursor: cursor,
      limit: 250,
    });
    if (!page || page.status === 'snapshot_required' || page.streamId !== streamId) {
      return { snapshotRequired: true, changed };
    }
    (page.events || []).forEach((event) => {
      changed = addEvent(event) || changed;
    });
    cursor = Math.max(cursor, Number(page.nextCursor || cursor));
    if (!page.hasMore) break;
  }
  if (!historical && state.snapshot) {
    state.snapshot.cursor = Math.max(Number(state.snapshot.cursor || 0), cursor);
  }
  return { snapshotRequired: false, changed };
}

async function refreshTurnOutput() {
  if (state.turnOutput.inFlight) return;
  const task = runningOutputTask();
  if (!task) {
    resetTurnOutput(null);
    renderLogs();
    return;
  }
  ensureTurnOutputTarget(task);
  if (!app || !app.loopx || typeof app.loopx.turnOutputSince !== 'function') {
    state.turnOutput.status = 'output_unavailable';
    state.turnOutput.message = text('outputUnavailable');
    renderLogs();
    return;
  }

  state.turnOutput.inFlight = true;
  try {
    const page = await app.loopx.turnOutputSince({
      taskId: task.taskId,
      ...(state.turnOutput.turnId ? { turnId: state.turnOutput.turnId } : {}),
      ...(state.turnOutput.streamId ? { streamId: state.turnOutput.streamId } : {}),
      afterCursor: state.turnOutput.cursor,
      limit: 200,
    });
    if (!page || page.taskId !== task.taskId) {
      state.turnOutput.status = 'output_unavailable';
      state.turnOutput.message = text('outputUnavailable');
      return;
    }
    if (page.turnId && page.turnId !== state.turnOutput.turnId) {
      resetTurnOutput({ ...task, currentTurnId: page.turnId });
    }
    if (page.streamId && page.streamId !== state.turnOutput.streamId) {
      state.turnOutput.streamId = page.streamId;
      state.turnOutput.cursor = 0;
      state.turnOutput.events = [];
    }
    state.turnOutput.status = page.status || 'current';
    state.turnOutput.message = page.message || '';
    (page.events || []).forEach((event) => {
      if (!Number.isSafeInteger(event.cursor)) return;
      if (state.turnOutput.events.some((existing) => existing.cursor === event.cursor)) return;
      state.turnOutput.events.push(event);
      const turnId = event.turnId || page.turnId || state.turnOutput.turnId || '';
      const outputKey = `${task.taskId}:${turnId}:${event.cursor}`;
      if (!state.outputKeys.has(outputKey)) {
        const rawText = event.text == null ? '' : String(event.text);
        state.outputKeys.add(outputKey);
        state.outputHistory.push({
          ...event,
          text: rawText,
          taskId: task.taskId,
          turnId,
        });
        state.outputCharacters += rawText.length;
      }
    });
    state.turnOutput.events.sort((left, right) => left.cursor - right.cursor);
    while (state.turnOutput.events.length > MAX_TURN_OUTPUT_EVENTS) {
      state.turnOutput.events.shift();
    }
    while (
      state.outputHistory.length > MAX_OUTPUT_HISTORY_EVENTS
      || state.outputCharacters > MAX_OUTPUT_HISTORY_CHARS
    ) {
      const removed = state.outputHistory.shift();
      state.outputKeys.delete(`${removed.taskId}:${removed.turnId || ''}:${removed.cursor}`);
      state.outputCharacters = Math.max(0, state.outputCharacters - String(removed.text || '').length);
    }
    state.turnOutput.cursor = Math.max(
      state.turnOutput.cursor,
      Number(page.nextCursor || state.turnOutput.cursor),
    );
    if (page.hasMore) scheduleTurnOutputPoll(0);
    else scheduleTurnOutputPoll(1200);
  } catch (error) {
    state.turnOutput.status = 'output_unavailable';
    state.turnOutput.message = error instanceof Error ? error.message : String(error);
    scheduleTurnOutputPoll(3000);
  } finally {
    state.turnOutput.inFlight = false;
    renderLogs();
  }
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot.streamId !== 'string') {
    throw new Error('The host returned an invalid LoopX snapshot.');
  }
  const previousStreamId = state.snapshot && state.snapshot.streamId;
  const previousSidecarStatus = state.snapshot
    && state.snapshot.environment
    && state.snapshot.environment.core
    && state.snapshot.environment.core.sidecar
    && state.snapshot.environment.core.sidecar.status;
  const streamChanged = previousStreamId && previousStreamId !== snapshot.streamId;
  state.snapshot = snapshot;
  if (streamChanged) {
    clearRunUiState();
  } else {
    replaceStreamEvents(snapshot.streamId);
  }
  if (state.selectedTaskId && !taskForId(state.selectedTaskId)) {
    state.selectedTaskId = null;
  }
  state.connected = true;
  state.lastHostSignalAt = Date.now();
  view.connectionLabel.textContent = text('connected');
  view.root.setAttribute('aria-busy', 'false');
  renderAll();
  if (state.environmentInstallObserved) {
    const sidecar = snapshot.environment
      && snapshot.environment.core
      && snapshot.environment.core.sidecar;
    if (sidecar && sidecar.status === 'available') {
      emitInstallDiagnostic('environment_available');
      state.environmentInstallObserved = false;
      state.environmentInstallRequestId = null;
      showNotice(text('loopxInstallComplete', { version: sidecar.version || '' }), 'success');
    } else if (
      previousSidecarStatus === 'checking'
      && sidecar
      && sidecar.status === 'unavailable'
    ) {
      emitInstallDiagnostic('environment_unavailable');
      state.environmentInstallObserved = false;
      state.environmentInstallRequestId = null;
      showNotice(text('loopxInstallFailed', {
        message: sidecar.detail || statusLabel('unavailable'),
      }), 'error');
    }
  }
  if (state.pendingApprovalPrompt) {
    syncApprovalAttention(true);
    if (currentApprovalAttention()) state.pendingApprovalPrompt = false;
  }
}

async function attachSnapshot(loadHistory = false, resumeDetected = false) {
  if (!app || !app.loopx) {
    showBridgeUnavailable();
    return;
  }
  if (resumeDetected) state.pendingResumeSignal = true;
  if (state.syncing) {
    state.syncRequested = true;
    return;
  }
  state.syncing = true;
  if (!view.repositoryActions.hidden) view.resumeRepository.disabled = true;
  try {
    do {
      state.syncRequested = false;
      const reportResume = state.pendingResumeSignal;
      state.pendingResumeSignal = false;
      const knownStreamId = state.snapshot && state.snapshot.streamId;
      const afterCursor = state.snapshot && state.snapshot.cursor;
      if (!state.connected) view.connectionLabel.textContent = text('connecting');
      const response = await app.loopx.attach({
        ...(knownStreamId ? { knownStreamId } : {}),
        ...(Number.isSafeInteger(afterCursor) ? { afterCursor } : {}),
        ...(reportResume ? { resumeDetected: true } : {}),
      });
      state.lastReattachAt = Date.now();
      applySnapshot(response && response.snapshot);
      void loadModelCatalog();
      const snapshot = state.snapshot;
      if (loadHistory && state.events.length === 0 && snapshot.cursor > 0) {
        const replay = await replayEvents(snapshot.streamId, 0, true);
        if (replay.changed) {
          renderLogs();
          syncApprovalAttention(true);
        }
      }
    } while (state.syncRequested);
  } catch (error) {
    state.connected = false;
    view.connectionLabel.textContent = text('connectionFailed');
    showNotice(errorMessage(error), 'error');
  } finally {
    state.syncing = false;
    const tasks = state.snapshot && Array.isArray(state.snapshot.tasks)
      ? state.snapshot.tasks
      : [];
    renderRepositoryActions(tasks);
  }
}

async function recoverEventGap(event) {
  if (state.gapRecovery) return state.gapRecovery;
  state.gapRecovery = (async () => {
    try {
      const snapshot = state.snapshot;
      if (!snapshot || event.streamId !== snapshot.streamId) {
        await attachSnapshot(false);
        return;
      }
      const replay = await replayEvents(snapshot.streamId, snapshot.cursor, false);
      if (replay.snapshotRequired) {
        await attachSnapshot(false);
        return;
      }
      if (event.cursor > state.snapshot.cursor) {
        addEvent(event);
        state.snapshot.cursor = event.cursor;
      }
      renderLogs();
    } catch (error) {
      showNotice(errorMessage(error), 'error');
      await attachSnapshot(false);
    } finally {
      state.gapRecovery = null;
    }
  })();
  return state.gapRecovery;
}

function onLoopxEvent(payload) {
  const event = payload && payload.event ? payload.event : payload;
  if (!validEvent(event)) return;
  state.lastHostSignalAt = Date.now();
  if (event.kind === 'snapshot_invalidated' && event.cursor === 0) {
    state.syncRequested = true;
    queueMicrotask(() => void attachSnapshot(false));
    return;
  }
  if (!state.snapshot || event.streamId !== state.snapshot.streamId) {
    void recoverEventGap(event);
    return;
  }
  const cursor = Number(state.snapshot.cursor || 0);
  if (event.cursor > cursor + 1) {
    void recoverEventGap(event);
    return;
  }
  const changed = addEvent(event);
  if (event.kind === 'approval_required') state.pendingApprovalPrompt = true;
  state.snapshot.cursor = Math.max(cursor, event.cursor);
  if (changed) {
    renderLogs();
    if (event.kind === 'approval_required') syncApprovalAttention(true);
  }
  if (SNAPSHOT_EVENT_KINDS.has(event.kind)) {
    state.syncRequested = true;
    queueMicrotask(() => void attachSnapshot(false));
  }
}

function showBridgeUnavailable() {
  state.connected = false;
  view.root.setAttribute('aria-busy', 'false');
  view.connectionLabel.textContent = text('connectionFailed');
  view.unsupportedReason.textContent = text('bridgeUnavailable');
  view.unsupportedBanner.hidden = false;
  view.resolveButton.disabled = true;
  view.retryEnvironment.disabled = true;
}

function renderExecutionSupport() {
  const snapshot = state.snapshot;
  const supported = snapshotSupported();
  const environmentStatus = snapshot && snapshot.environment && snapshot.environment.status;
  const environmentBusyOrBlocked = environmentStatus === 'checking' || environmentStatus === 'blocked';
  view.unsupportedBanner.hidden = !snapshot || supported;
  if (snapshot && !supported) {
    view.unsupportedReason.textContent = snapshot.unsupportedReason || text('unsupportedDefault');
  }
  view.resolveButton.disabled = !supported || environmentBusyOrBlocked || state.resetPending;
  view.retryEnvironment.disabled = !supported
    || environmentStatus === 'checking'
    || state.environmentInstallPending;
  const anyActive = Boolean(snapshot)
    && snapshot.tasks.some((task) =>
      ['preparing', 'queued', 'running'].includes(task.state)
    );
  const suspended = Boolean(snapshot && snapshot.suspended);
  view.pauseAllLoopx.hidden = !anyActive || suspended || state.resetPending;
  view.resumeAllLoopx.hidden = !suspended || state.resetPending;
  view.pauseAllLoopx.title = text('pauseAllHint');
  view.resumeAllLoopx.title = suspended ? text('resumeAllHint') : text('resumeAll');
}

function environmentFact(name, label, fact) {
  const element = document.createElement('article');
  const status = fact && fact.status ? fact.status : 'unknown';
  element.className = 'environment-fact';
  element.dataset.status = status;

  const title = document.createElement('div');
  title.className = 'environment-fact__title';
  const strong = document.createElement('strong');
  strong.textContent = label;
  const value = document.createElement('span');
  value.textContent = statusLabel(status);
  const statusActions = document.createElement('div');
  statusActions.className = 'environment-fact__status-actions';
  statusActions.append(value);
  title.append(strong, statusActions);
  element.append(title);

  const detail = document.createElement('p');
  const version = fact && fact.version ? fact.version : '';
  const description = (fact && (fact.detail || fact.remediation)) || '';
  detail.textContent = [version, description].filter(Boolean).join(' · ') || statusLabel(status);
  detail.title = detail.textContent;
  element.append(detail);
  element.dataset.fact = name;
  return element;
}

function renderEnvironmentRemediation(sidecar) {
  // A checking sidecar fact carries the install target version only for the
  // managed-source install flow; plain environment probes check without one.
  const installChecking = Boolean(
    sidecar
    && sidecar.status === 'checking'
    && sidecar.version
  );
  const installAvailable = Boolean(
    sidecar
    && sidecar.remediationAction === 'install_loopx'
  );
  const installing = state.environmentInstallPending || installChecking;
  view.environmentRemediation.hidden = !installAvailable && !installing;
  if (view.environmentRemediation.hidden) return;

  view.environmentRemediation.dataset.state = installing ? 'installing' : 'blocked';
  const detail = String(sidecar && sidecar.detail || '');
  const currentVersion = (detail.match(/got loopx\s+([^\s]+)/i) || [])[1] || statusLabel('unavailable');
  const targetVersion = (detail.match(/expected loopx\s+([^\s,]+)/i) || [])[1]
    || (sidecar && sidecar.version)
    || '';
  view.environmentRemediationTitle.textContent = text(
    installing ? 'loopxInstallingTitle' : 'loopxRepairTitle',
    { version: targetVersion },
  );
  view.environmentRemediationDetail.textContent = installing
    ? text('loopxInstallingDetail')
    : text('loopxRepairDetail', { current: currentVersion, version: targetVersion });
  view.environmentRemediationProgress.hidden = !installing;
  view.installLoopx.hidden = installing;
  view.installLoopx.disabled = installing;
  view.installLoopxLabel.textContent = text('installLoopx');
}

function renderEnvironment() {
  const environment = state.snapshot && state.snapshot.environment;
  const status = environment && environment.status ? environment.status : 'unknown';
  view.environmentDot.dataset.status = status;
  view.environmentStatus.textContent = statusLabel(status);
  view.environmentChecked.textContent = environment && environment.checkedAt
    ? text('updated', { duration: relativeLabel(environment.checkedAt) })
    : '';

  const core = environment && environment.core ? environment.core : {};
  const optional = environment && environment.optional ? environment.optional : {};
  renderEnvironmentRemediation(core.sidecar);
  view.coreEnvironmentList.replaceChildren(
    environmentFact('sidecar', text('sidecar'), core.sidecar),
    environmentFact('nodeRuntime', text('nodeRuntime'), core.node_runtime),
    environmentFact('gitWorktree', text('gitWorktree'), core.gitWorktree),
    environmentFact('agentModel', text('agentModel'), core.agentModel),
  );
  view.optionalEnvironmentList.replaceChildren(
    environmentFact('pythonFallback', text('pythonFallback'), optional.pythonFallback),
    environmentFact('githubAuth', text('githubAuth'), optional.githubAuth),
  );
}

const ERROR_TASK_STATES = new Set(['recovery_required', 'failed']);
const RECOVERABLE_TASK_STATES = new Set(['stopped', ...ERROR_TASK_STATES]);

function repositoryKey(repository) {
  return repository
    ? `${repository.host || ''}/${repository.owner || ''}/${repository.repository || ''}`
    : '';
}

function taskSortPriority(task) {
  if (isResolvedUpstream(task)) return 20;
  const priorities = {
    running: 0,
    waiting_for_user: 1,
    preparing: 2,
    cancelling: 3,
    queued: 4,
    retry_wait: 5,
    failed: 10,
    recovery_required: 11,
    stopped: 12,
  };
  return priorities[task.state] ?? 20;
}

function sortedTaskList(tasks) {
  return [...tasks].sort((left, right) =>
    taskExecutionRank(left) - taskExecutionRank(right)
    || executionTieBreak(left, right));
}

/// Rail and default-focus read in ACTUAL execution order: what is running
/// first, then the queue in creation order, then parked tasks awaiting the
/// owner, then finished work (most recent first).
function taskExecutionRank(task) {
  if (isResolvedUpstream(task)) return 40;
  // 同一条仓库泳道（运行/排队/准备/取消）共用一个档位、按创建时间排序：
  // 宿主每个有界回合结算都会把任务短暂置为 queued 再重新入队，细分档位会让
  // 任务行随每次结算上下跳动（用户多次反馈「位置变来变去」）。
  const rank = {
    running: 0,
    preparing: 0,
    cancelling: 0,
    queued: 0,
    retry_wait: 0,
    waiting_for_user: 10,
    recovery_required: 11,
    stopped: 12,
    failed: 13,
    completed: 20,
    archived: 21,
  };
  return rank[(task && task.state) || ''] ?? 30;
}

function executionTieBreak(left, right) {
  const leftRank = taskExecutionRank(left);
  const rightRank = taskExecutionRank(right);
  if (leftRank >= 20 || rightRank >= 20) {
    return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
  }
  return Number(left.createdAt || left.updatedAt || 0)
    - Number(right.createdAt || right.updatedAt || 0);
}

function progressItemLabel(task) {
  const item = task && task.identity && task.identity.item;
  return issueDisplayTitle(task) || compactItemLabel(item);
}

function recoverableTasksForRepository(tasks, repository) {
  const key = repositoryKey(repository);
  return tasks.filter((task) =>
    RECOVERABLE_TASK_STATES.has(task.state)
    && !isResolvedUpstream(task)
    && repositoryKey(task.identity && task.identity.item && task.identity.item.repository) === key);
}

function renderRepositoryActions(tasks) {
  const selected = selectedTask();
  const eligibleRepositories = new Map();
  tasks.forEach((task) => {
    if (!RECOVERABLE_TASK_STATES.has(task.state) || isResolvedUpstream(task)) return;
    const repository = task.identity && task.identity.item && task.identity.item.repository;
    const key = repositoryKey(repository);
    if (key && !eligibleRepositories.has(key)) eligibleRepositories.set(key, repository);
  });
  const selectedRepository = selected
    && selected.identity
    && selected.identity.item
    && selected.identity.item.repository;
  const repository = selectedRepository && eligibleRepositories.has(repositoryKey(selectedRepository))
    ? selectedRepository
    : ([...eligibleRepositories.values()][0] || null);
  const eligible = repository ? recoverableTasksForRepository(tasks, repository) : [];
  state.repositoryResumeTarget = repository && eligible.length > 0
    ? { repository, tasks: eligible }
    : null;
  view.repositoryActions.hidden = !state.repositoryResumeTarget;
  if (!state.repositoryResumeTarget) return;
  const modelStatus = state.snapshot
    && state.snapshot.environment
    && state.snapshot.environment.core
    && state.snapshot.environment.core.agentModel
    && state.snapshot.environment.core.agentModel.status;
  const modelBlocked = modelStatus === 'degraded' || modelStatus === 'unavailable';
  view.resumeRepository.disabled = modelBlocked || state.repositoryResumePending || state.syncing;
  view.resumeRepository.textContent = state.repositoryResumePending
    ? text('resumingRepository')
    : text('resumeRepository', { value: eligible.length });
  view.repositoryActionsMeta.textContent = modelBlocked
    ? text('repositoryPausedByModel')
    : `${repositoryLabel(repository)} · ${text('repositorySerial')}`;
}

function completionLabel(task) {
  const structured = task && task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  if (!structured) return '';
  const verdict = String(structured.issue_verdict || '');
  if (verdict === 'wont_fix') {
    const reason = String(structured.wont_fix_reason || '');
    return reason
      ? summaryEnumLabel('summaryWontFixReason', reason)
      : summaryEnumLabel('summaryVerdict', 'wont_fix');
  }
  if (verdict === 'already_fixed_upstream') return summaryEnumLabel('summaryVerdict', 'already_fixed_upstream');
  if (verdict === 'needs_info') return summaryEnumLabel('summaryVerdict', 'needs_info');
  if (verdict === 'needs_fix') return text('state_completed_needs_fix');
  return '';
}

function completionTone(task) {
  const structured = task && task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  const verdict = structured ? String(structured.issue_verdict || '') : '';
  if (verdict === 'wont_fix') {
    return String(structured.wont_fix_reason || '') === 'evaluation_pending' ? 'info' : 'muted';
  }
  if (verdict === 'needs_info') return 'info';
  if (verdict === 'already_fixed_upstream' || verdict === 'needs_fix') return 'success';
  return '';
}

function taskButton(task) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'task-item';
  button.dataset.taskId = task.taskId;

  const main = document.createElement('span');
  main.className = 'task-item__main';
  const label = document.createElement('strong');
  const meta = document.createElement('small');
  const repositoryNode = document.createElement('span');
  repositoryNode.className = 'task-item__repo';
  const itemNode = document.createElement('span');
  itemNode.className = 'task-item__item';
  const activityNode = document.createElement('span');
  activityNode.className = 'task-item__time';
  meta.append(repositoryNode, ' · ', itemNode, ' · ', activityNode);
  const labels = document.createElement('span');
  labels.className = 'task-item__labels';
  main.append(label, meta, labels);

  const compact = document.createElement('span');
  compact.className = 'task-item__compact';

  const taskState = document.createElement('span');
  taskState.className = 'task-item__state task-item__hint';

  button.append(main, compact, taskState);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    selectTask(task.taskId);
  });
  updateTaskButton(button, task);
  return button;
}

function updateTaskButton(button, task) {
  const selected = task.taskId === state.selectedTaskId;
  button.classList.toggle('is-selected', selected);
  button.setAttribute('aria-pressed', String(selected));

  const item = task.identity && task.identity.item;
  const identityTitle = issueDisplayTitle(task);
  const label = button.querySelector('.task-item__main strong');
  label.textContent = identityTitle || compactItemLabel(item);
  label.title = identityTitle || compactItemLabel(item);

  const activity = task.lastOutputAt || task.updatedAt;
  const repositoryText = repositoryLabel(item && item.repository);
  const itemText = compactItemLabel(item);
  const activityText = relativeLabel(activity);
  button.querySelector('.task-item__repo').textContent = repositoryText;
  button.querySelector('.task-item__item').textContent = itemText;
  button.querySelector('.task-item__time').textContent = activityText;
  const main = button.querySelector('.task-item__main');
  button.querySelector('.task-item__main small').title = `${repositoryText} · ${itemText} · ${activityText}`;
  if (task.state === 'queued') {
    const reason = latestTaskWaitReason(task);
    if (reason) main.title = reason;
    else main.removeAttribute('title');
  } else {
    main.removeAttribute('title');
  }

  // The host already fetches GitHub labels, but the rail never showed them, so
  // the [Bug]/[Feature] signal only existed on github.com.
  const labels = button.querySelector('.task-item__labels');
  labels.replaceChildren();
  const rawLabels = item && Array.isArray(item.labels)
    ? item.labels.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  rawLabels.slice(0, 3).forEach((value) => {
    const chip = document.createElement('span');
    chip.className = 'task-item__label';
    chip.textContent = value;
    labels.append(chip);
  });
  if (rawLabels.length > 3) {
    const more = document.createElement('span');
    more.className = 'task-item__label';
    more.textContent = text('taskLabelsMore', { value: rawLabels.length - 3 });
    labels.append(more);
  }
  labels.hidden = rawLabels.length === 0;

  const pendingAction = pendingActionFor(task);
  const visualState = taskVisualState(task);
  const externalWait = isExternalWait(task);
  button.dataset.state = visualState;
  if (externalWait) button.dataset.wait = 'external';
  else delete button.dataset.wait;
  if (pendingAction) button.dataset.pending = pendingAction;
  else delete button.dataset.pending;

  const taskState = button.querySelector('.task-item__state');
  taskState.className = 'task-item__state task-item__hint';
  taskState.dataset.status = visualState;
  if (externalWait) taskState.dataset.wait = 'external';
  else delete taskState.dataset.wait;
  if (pendingAction) taskState.classList.add('task-item__hint--pending');
  else if (visualState === 'running') taskState.classList.add('task-item__hint--running');

  const stateText = taskStateDisplayLabel(task);
  taskState.textContent = stateText;
  taskState.title = stateText;
  const tone = task.state === 'completed' ? completionTone(task) : '';
  if (tone) taskState.dataset.tone = tone;
  else delete taskState.dataset.tone;
  button.setAttribute('aria-label', `${label.textContent}, ${stateText}`);

  const compact = button.querySelector('.task-item__compact');
  compact.textContent = item && item.number ? `#${item.number}` : shortId(task.taskId);
}

/// 任务已产生的 Pull Request 链接（宿主会把 PR URL 写进 structuredSummary.artifacts）。
function taskPullRequestUrl(task) {
  const summary = task && task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : {};
  const artifacts = Array.isArray(summary.artifacts)
    ? summary.artifacts.map((entry) => String(entry).trim())
    : [];
  const standalone = artifacts.find((entry) => /^https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/.test(entry));
  if (standalone) return standalone.replace(/\/+$/, '');
  const inline = String(task && task.lastAgentSummary || '').match(/https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/i);
  if (inline) return inline[0];
  return '';
}

/// 审批通过只代表「已授权」，真正的产物（PR 链接、评论）由 agent 随后完成。
/// 产物一出现就把具体结果播报出来：已创建 PR #123 <链接>。
function publishOutcomeFor(task) {
  if (!task) return null;
  const summary = task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : {};
  // 复用/合并已有 PR 的路线不播报「已创建 PR」，避免把别人的 PR 说成这次发布的产物。
  const route = String((summary.decision && summary.decision.route) || '');
  if (/reuse|merge/i.test(route) && !/publish|push|open/i.test(route)) return null;
  const pool = [];
  ['artifacts', 'completed', 'actual_findings', 'next_step'].forEach((key) => {
    const value = summary[key];
    if (Array.isArray(value)) pool.push(...value.map((entry) => String(entry)));
    else if (typeof value === 'string') pool.push(value);
  });
  pool.push(String(task.lastAgentSummary || ''));
  const haystack = pool.join('\n');
  const todoKind = task.currentTodo ? String(task.currentTodo.actionKind || '') : '';
  const tracking = /track|monitor|publish/i.test(todoKind);
  const artifacts = Array.isArray(summary.artifacts)
    ? summary.artifacts.map((entry) => String(entry).trim())
    : [];
  // 单独的 PR 链接（一行就是一个 PR URL）是「PR 已存在」的最强信号：
  // 此时任务可能已经结算/排队（currentTodo 为空），不能只靠 todo 分类判断。
  const standalonePr = artifacts.find((entry) => /^https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+\/?$/.test(entry));
  const prUrl = standalonePr
    ? standalonePr.replace(/\/+$/, '')
    : (haystack.match(/https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/i) || [])[0];
  const number = prUrl ? (String(prUrl).match(/\/pull\/(\d+)/) || [])[1] || '' : '';
  const mentionsPrNumber = Boolean(number) && new RegExp(
    `(拉取请求|pull request|\\bPR\\b)[^\\n]{0,24}#?${number}|#?${number}[^\\n]{0,24}(拉取请求|pull request|\\bPR\\b)`,
    'i',
  ).test(haystack);
  if (prUrl && (tracking || mentionsPrNumber)) {
    return { kind: 'pr', url: prUrl, number };
  }
  const commentUrl = haystack.match(/https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+#issuecomment-\d+/i);
  const commentLanguage = /(published|posted)[^\n]{0,40}(maintainer )?comment|(发布|发表)[^\n]{0,20}评论/i.test(haystack);
  if (commentLanguage && (tracking || (state.publishOutcomeArmed || new Set()).has(task.taskId))) {
    return { kind: 'comment', url: commentUrl ? commentUrl[0] : '' };
  }
  return null;
}

function announcePublishOutcome() {
  if (!canRender() || !state.snapshot || !Array.isArray(state.snapshot.tasks)) return;
  state.snapshot.tasks.forEach((task) => {
    const outcome = publishOutcomeFor(task);
    if (!outcome) return;
    const key = `${task.taskId}:${outcome.kind}:${outcome.url || ''}`;
    if (state.publishOutcomeSeen.has(key)) return;
    state.publishOutcomeSeen.add(key);
    storeIdSet(PUBLISH_SEEN_STORAGE_KEY, state.publishOutcomeSeen);
    const item = task.identity && task.identity.item;
    showNotice(
      outcome.kind === 'pr'
        ? text('publishOutcomePr', { number: outcome.number })
        : text('publishOutcomeComment', { item: compactItemLabel(item) || '--' }),
      'success',
      outcome.url,
    );
  });
}

function renderTasks() {
  if (!canRender()) return;
  const tasks = state.snapshot && Array.isArray(state.snapshot.tasks) ? state.snapshot.tasks : [];
  pruneApprovedWaiting(tasks);
  const existing = new Map();
  [...view.taskItems.children].forEach((node) => {
    if (node.dataset && node.dataset.taskId) existing.set(node.dataset.taskId, node);
  });
  // Rebuilding every button on each snapshot replaced the node between
  // mousedown and mouseup, so a task row occasionally needed a second click
  // before it changed selection (observed live on the refresh cadence).
  const desired = sortedTaskList(tasks).map((task) => {
    const node = existing.get(task.taskId);
    if (!node) return taskButton(task);
    updateTaskButton(node, task);
    return node;
  });
  desired.forEach((node, index) => {
    const current = view.taskItems.children[index];
    if (current !== node) view.taskItems.insertBefore(node, current || null);
  });
  const keep = new Set(desired);
  [...view.taskItems.children].forEach((node) => {
    if (!keep.has(node)) node.remove();
  });
  view.taskCount.textContent = String(tasks.length);
  const countLabel = text('taskCountLabel', { value: tasks.length });
  view.taskCount.title = countLabel;
  view.taskCount.setAttribute('aria-label', countLabel);
  view.taskEmpty.hidden = tasks.length !== 0;
  renderRepositoryActions(tasks);
  syncApprovalAttention(false);
  announcePublishOutcome();
}

function latestGate(taskId) {
  const task = taskForId(taskId);
  if (task && task.pendingGateId) {
    const actionKind = task.pendingGateActionKind || '';
    return {
      gateId: task.pendingGateId,
      actionKind,
      event: {
        message: task.pendingGateMessage || text('approvalNeeded'),
        details: {
          gateId: task.pendingGateId,
          actionKind,
        },
      },
    };
  }
  // A waiting task WITHOUT a live gate id but WITH a wait message is the
  // owner-action park (the decision happens outside this host, e.g. merge
  // a PR on GitHub): never fall back to history here, or the latest
  // ANSWERED approval event would be rendered as if it were live again
  // (observed live 2026-09-11: the answered publish gate popped up over
  // the merge wait). The legacy event fallback below only serves snapshots
  // that project neither field.
  if (task && String(task.pendingGateMessage || '').trim()) {
    return null;
  }
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event.taskId !== taskId || event.kind !== 'approval_required') continue;
    const details = event.details || {};
    const gateId = details.gateId || details.gate_id || details.id;
    if (gateId) {
      return {
        event,
        gateId,
        actionKind: details.actionKind || details.action_kind || '',
      };
    }
  }
  return null;
}

function currentApprovalAttention() {
  const tasks = state.snapshot && Array.isArray(state.snapshot.tasks)
    ? sortedTaskList(state.snapshot.tasks)
    : [];
  const task = tasks.find((candidate) => candidate.state === 'waiting_for_user') || null;
  if (!task) return null;
  const gate = latestGate(task.taskId);
  // The approval alert is the interactive approve/reject surface: it only
  // applies to a live typed gate. A waiting task without one is parked on
  // an owner action outside this host (merge a PR on GitHub, answer on the
  // external surface); that is surfaced by the task rail, the decision
  // card, and the timeline event instead — never by an approve/reject popup
  // that would re-ask an already-answered question.
  if (!gate) return null;
  return { task, gate };
}

function gateRawMessage(gate) {
  return String(gate && gate.event && gate.event.message || '').trim();
}

function stripGatePriorityPrefix(message) {
  return message.replace(/^\[[Pp]\d\]\s*/, '').trim();
}

/// 未知类型的 gate：只把「要做什么」那一句摆出来，不再输出模板化废话。
function firstRequestSentence(message) {
  const value = stripPriorityPrefix(message);
  if (!value) return '';
  const sentence = value.split(/(?<=[.!?])\s+/)[0] || value;
  return sentence.length > 180 ? `${sentence.slice(0, 179)}…` : sentence;
}

function authorityScopeLabels(rawMessage) {
  const rawScopes = rawMessage.match(/\[([^\]]+)\]/)?.[1] || '';
  if (!rawScopes) return '';
  const zh = localeId() === 'zh-CN';
  const scopeNames = zh
    ? {
        write: '写入仓库',
        publish: '发布 PR / 公开内容',
        external_review_request: '邀请评审',
        merge: '合并代码',
      }
    : {
        write: 'repository write',
        publish: 'publish (PR / public content)',
        external_review_request: 'review requests',
        merge: 'merge',
      };
  const labels = rawScopes
    .split(/[，,]/)
    .map((scope) => scopeNames[scope.trim().toLowerCase()] || scope.trim())
    .filter(Boolean);
  return labels.join(zh ? '、' : ', ');
}

function approvalPresentation(task, gate) {
  const rawMessage = gateRawMessage(gate);
  const body = stripGatePriorityPrefix(rawMessage);
  const actionKind = String(gate && gate.actionKind || '').toLowerCase();

  // 复用既有 PR 的合并门：用户关心的是「不重复实现、复用哪个 PR、之后是否继续跟进」。
  const reuseMerge = actionKind.includes('merge')
    || actionKind.includes('reuse')
    || /merge\s+PR\s+#(\d+)/i.test(body)
    || /reuse[_\s-]*(?:existing[_\s-]*)?pr/i.test(body);
  if (reuseMerge) {
    const prNumber = body.match(/PR\s+#(\d+)/i)?.[1] || '';
    const pr = prNumber ? `PR #${prNumber}` : text('gateReuseMergeFallbackPr');
    const prTitle = body.match(/merge\s+PR\s+#\d+\s*\(([^)]+)\)/i)?.[1] || '';
    return {
      kind: 'reuse_merge',
      title: text('gateReuseMergeTitle'),
      summary: prTitle
        ? text('gateReuseMergeSummaryWithPr', { pr, title: prTitle })
        : text('gateReuseMergeSummary'),
      rawMessage: body,
      approveEffect: text('gateReuseMergeApproveEffect', { pr }),
      rejectEffect: text('gateReuseMergeRejectEffect', { pr }),
      recommendation: text('gateReuseMergeRecommendation'),
      approveLabel: text('gateReuseMergeApprove'),
      rejectLabel: text('gateReuseMergeReject'),
    };
  }

  const mentionsPr = /\bpull request\b|\bpr\b/i.test(body);
  const publishPullRequest = actionKind.includes('publish')
    || actionKind.includes('pull_request')
    || /\bpr bundle\b/i.test(body)
    // 「approve opening the pull request」这类措辞此前会掉进 generic：只要句子里
    // 同时出现 PR 和打开/发布/评审类动作，就按「创建 PR」处理。
    || (mentionsPr && /\b(?:publish|push|creat(?:e|ing|ion)|open(?:ing)?|review|description|read(?:y)?)\b/i.test(body));
  if (publishPullRequest) {
    const branch = body.match(/\bbranch\s+([^,\s)]+)/i)?.[1] || '';
    const commit = body.match(/\bcommit\s+([0-9a-f]{7,40})\b/i)?.[1] || '';
    const messageRepository = body.match(/\bto\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=;|[\s.,]|$)/i)?.[1] || '';
    const item = task && task.identity && task.identity.item;
    const itemText = compactItemLabel(item) || repositoryLabel(item && item.repository) || '--';
    const repository = messageRepository || repositoryLabel(item && item.repository) || '--';
    const evidence = taskProgressEvidence(task);
    const validated = evidence.validated || evidence.settled || /\b(?:validated|verified)\b|验证/.test(body);
    const summaryDetail = branch
      ? (commit
        ? text('externalActionPushDetail', { branch, commit })
        : text('externalActionPushDetailNoCommit', { branch }))
      : text('externalActionPushDetailUnknown', { repository });
    return {
      kind: 'publish',
      title: text('externalActionTitlePr', { item: itemText }),
      summary: summaryDetail,
      summaryDetail,
      rawMessage,
      approveEffect: text('externalActionApprovePr'),
      rejectEffect: text('externalActionRejectPr'),
      recommendation: text(validated ? 'publishApprovalRecommendationReady' : 'publishApprovalRecommendationReview'),
      approveLabel: text('publishApprovalApprove'),
      rejectLabel: text('publishApprovalReject'),
    };
  }

  // LoopX issue-fix 契约中的已知 gate 类型：面向人给出中文说明，
  // 原始待办文本（英文、技术性）折叠进「原始请求」而不是当作正文。
  const publishComment = /comment/i.test(body)
    && /(publish|post)/i.test(body)
    && !/\bpull request\b|\bPR\b/i.test(body);
  if (publishComment) {
    const item = task && task.identity && task.identity.item;
    const itemText = compactItemLabel(item) || repositoryLabel(item && item.repository) || '--';
    const summary = task && task.structuredSummary && typeof task.structuredSummary === 'object'
      ? task.structuredSummary
      : {};
    const points = [];
    if (Array.isArray(summary.completed)) {
      summary.completed.slice(0, 2).forEach((line) => {
        const value = stripPriorityPrefix(line);
        if (value) points.push(value);
      });
    }
    if (Array.isArray(summary.missing_info)) {
      summary.missing_info.slice(0, 2).forEach((line) => {
        const value = stripPriorityPrefix(line);
        if (value) points.push(value);
      });
    }
    const artifacts = Array.isArray(summary.artifacts)
      ? summary.artifacts.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    return {
      kind: 'publish_comment',
      title: text('gatePublishCommentTitle', { item: itemText }),
      summary: text('gatePublishCommentSummary', { item: itemText }),
      rawMessage: body,
      approveEffect: text('gatePublishCommentApproveEffect', { item: itemText }),
      rejectEffect: text('gatePublishCommentRejectEffect', { item: itemText }),
      recommendation: text('gatePublishCommentRecommendation'),
      approveLabel: text('gatePublishCommentApprove'),
      rejectLabel: text('reject'),
      commentPoints: points,
      artifacts,
    };
  }
  const gatedRead = actionKind.includes('body_or_comment_read')
    || actionKind.includes('gated_read')
    || /gated read|approve a gated read/i.test(body);
  if (gatedRead) {
    return {
      kind: 'gated_read',
      title: text('gateGatedReadTitle'),
      summary: text('gateGatedReadSummary'),
      rawMessage: body,
      approveEffect: text('gateGatedReadApproveEffect'),
      rejectEffect: text('gateGatedReadRejectEffect'),
      recommendation: '',
      approveLabel: text('gateGatedReadApprove'),
      rejectLabel: text('gateGatedReadReject'),
    };
  }

  if (actionKind.includes('clarify') || actionKind.includes('semantic_ambiguity')) {
    return {
      kind: 'clarify',
      title: text('gateClarifyTitle'),
      summary: text('gateClarifySummary'),
      rawMessage: body,
      approveEffect: text('gateClarifyApproveEffect'),
      rejectEffect: text('gateClarifyRejectEffect'),
      recommendation: '',
      approveLabel: text('approve'),
      rejectLabel: text('reject'),
    };
  }

  if (actionKind.includes('authority') || actionKind.includes('grant_')) {
    const scopes = authorityScopeLabels(body);
    return {
      kind: 'grant_authority',
      title: text('gateGrantAuthorityTitle'),
      summary: scopes
        ? `${text('gateGrantAuthoritySummary')} ${text('gateGrantAuthorityScopes', { scopes })}`
        : text('gateGrantAuthoritySummary'),
      rawMessage: body,
      approveEffect: text('gateGrantAuthorityApproveEffect'),
      rejectEffect: text('gateGrantAuthorityRejectEffect'),
      recommendation: '',
      approveLabel: text('approve'),
      rejectLabel: text('reject'),
    };
  }

  if (actionKind.includes('draft') || actionKind.includes('ready_for_review')) {
    return {
      kind: 'draft_ready',
      title: text('gateDraftReadyTitle'),
      summary: text('gateDraftReadySummary'),
      rawMessage: body,
      approveEffect: text('gateDraftReadyApproveEffect'),
      rejectEffect: text('gateDraftReadyRejectEffect'),
      recommendation: '',
      approveLabel: text('approve'),
      rejectLabel: text('reject'),
    };
  }

  if (/\b(?:push|commit)\b/i.test(body)) {
    const branch = body.match(/\bbranch\s+([^,\s)]+)/i)?.[1] || '';
    const summaryDetail = branch
      ? text('externalActionPushDetailNoCommit', { branch })
      : text('externalActionPushSummary');
    return {
      kind: 'push',
      title: text('externalActionTitlePush'),
      summary: summaryDetail,
      summaryDetail,
      rawMessage: body,
      approveEffect: text('externalActionApprovePush'),
      rejectEffect: text('externalActionRejectPush'),
      recommendation: '',
      approveLabel: text('approve'),
      rejectLabel: text('reject'),
    };
  }

  if (/\b(?:build|install|run|execute|real[- ]?run|verify|verification|validation)\b|构建|安装|真实运行|验证/.test(body)) {
    return {
      kind: 'run_validation',
      title: text('externalActionTitleValidate'),
      summary: text('externalActionSummaryValidate'),
      summaryDetail: text('externalActionSummaryValidate'),
      rawMessage: body,
      approveEffect: text('externalActionApproveValidate'),
      rejectEffect: text('externalActionRejectValidate'),
      recommendation: '',
      approveLabel: text('approve'),
      rejectLabel: text('reject'),
    };
  }

  const request = firstRequestSentence(body);
  return {
    kind: 'external_action',
    title: text('externalActionTitle'),
    summary: request
      ? text('externalActionSummaryDetail', { detail: request })
      : text('externalActionSummaryFallback'),
    summaryDetail: request,
    rawMessage: body,
    approveEffect: text('externalActionApproveFallback'),
    rejectEffect: text('externalActionRejectFallback'),
    recommendation: '',
    approveLabel: text('approve'),
    rejectLabel: text('reject'),
  };
}

function syncApprovalAttention(autoOpen = false) {
  const attention = currentApprovalAttention();
  state.approvalTaskId = attention ? attention.task.taskId : null;
  view.approvalAlert.hidden = !attention;
  if (view.taskCount) view.taskCount.classList.toggle('count-badge--attention', Boolean(attention));
  if (!attention) return;

  const { task, gate } = attention;
  const item = task.identity && task.identity.item;
  const presentation = approvalPresentation(task, gate);
  view.approvalAlertTitle.textContent = `${issueDisplayTitle(task) || itemLabel(item)} · ${text('decisionRequired')}`;
  view.approvalAlertOpen.title = presentation.summary;
  view.approvalAlertOpen.setAttribute('aria-label', `${presentation.title} ${presentation.summary}`);
  view.approvalAlertMessage.textContent = presentation.summary;

  if (
    autoOpen
    && gate
    && !state.promptedGateIds.has(gate.gateId)
  ) {
    state.promptedGateIds.add(gate.gateId);
    void notifyGateSystemDecision(task, gate);
    const selected = selectedTask();
    if (!selected || selected.state !== 'waiting_for_user') selectTask(task.taskId);
  }
}

function makeActionButton(label, action, task, tone) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = tone === 'danger'
    ? 'danger-button'
    : (tone === 'primary' ? 'primary-button' : 'text-button');
  button.dataset.action = action;
  button.textContent = label;
  button.addEventListener('click', () => {
    void performAction(action, task);
  });
  return button;
}

function makePendingActionButton(task) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button is-pending';
  button.disabled = true;
  button.textContent = taskStateDisplayLabel(task);
  return button;
}

function renderTaskActions(task) {
  view.taskActions.replaceChildren();
  if (!task || !snapshotSupported()) return;
  const fragment = document.createDocumentFragment();
  if (pendingActionFor(task)) {
    fragment.append(makePendingActionButton(task));
    view.taskActions.append(fragment);
    return;
  }
  if (isResolvedUpstream(task)) {
    return;
  }
  if (['recovery_required', 'failed', 'stopped'].includes(task.state)) {
    fragment.append(makeActionButton(text('resume'), 'resume', task));
  }
  // The owner-action park (waiting without a live typed gate) is handled by
  // the decision card, which is the single actionable surface for that
  // state; do not duplicate the re-check entry here.
  if (['stopped', 'completed', 'failed'].includes(task.state)) {
    fragment.append(makeActionButton(text('archive'), 'archive', task));
  }
  if (task.state === 'archived') {
    fragment.append(makeActionButton(text('restore'), 'restore', task));
  }
  view.taskActions.append(fragment);
}

function safeMarkdownUrl(rawUrl, baseUrl) {
  const source = String(rawUrl || '').trim();
  if (!source) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    try {
      const absolute = new URL(source);
      return absolute.protocol === 'https:' || absolute.protocol === 'http:' ? absolute.href : '';
    } catch (_error) {
      return '';
    }
  }
  if (source.startsWith('//')) return `https:` + source;
  if (!baseUrl) return '';
  if (!source.startsWith('#') && !source.startsWith('/')) return '';
  try {
    const resolved = new URL(source, baseUrl);
    return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.href : '';
  } catch (_error) {
    return '';
  }
}

/// A markdown target such as `.loopx/issue-fix/report.md` points at a file on
/// the machine that ran the task, not at a web page. Resolving it against the
/// GitHub issue URL produced a hyperlink that 404'd (observed live:
/// issue-2778-pr-packet.md), so it is rendered as a non-clickable file chip.
function isLocalPathReference(rawUrl) {
  const source = String(rawUrl || '').trim();
  if (!source) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return false;
  if (source.startsWith('//') || source.startsWith('#') || source.startsWith('/')) return false;
  return true;
}

function localPathReferenceChip(label, target) {
  const chip = document.createElement('span');
  chip.className = 'local-path-ref';
  chip.title = text('localPathRefHint', { path: String(target || '') });
  const name = document.createElement('code');
  name.textContent = label || target;
  chip.append(name);
  return chip;
}

/// MiniApp iframes cannot navigate blank-target anchors themselves in the
/// Tauri sandbox; every external link goes through the host opener so a click
/// actually leaves the webview (observed live: GitHub PR buttons looked
/// actionable but did nothing).
function openExternalUrl(url) {
  const target = String(url || '').trim();
  if (!target) return;
  const bridgeOpen = app && app.system && typeof app.system.openExternal === 'function'
    ? app.system.openExternal
    : null;
  if (bridgeOpen) {
    Promise.resolve(bridgeOpen(target)).catch(() => {
      showNotice(text('openExternalFailed'), 'error');
    });
    return;
  }
  if (typeof window.open === 'function') {
    window.open(target, '_blank', 'noopener');
    return;
  }
  showNotice(text('openExternalFailed'), 'error');
}

function externalAnchor(label, url, className = '') {
  const anchor = document.createElement('a');
  if (className) anchor.className = className;
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = label;
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    openExternalUrl(url);
  });
  return anchor;
}

function appendInlineMarkdown(parent, source, baseUrl) {
  const pattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__)/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith('[')) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = parts ? safeMarkdownUrl(parts[2], baseUrl) : '';
      if (parts && href) {
        parent.append(externalAnchor(parts[1], href));
      } else if (parts && isLocalPathReference(parts[2])) {
        parent.append(localPathReferenceChip(parts[1], parts[2]));
      } else {
        parent.append(document.createTextNode(token));
      }
    } else {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function isTableRow(line) {
  const source = String(line || '').trim();
  if (!source.includes('|')) return false;
  return /^\|?[^|]*\|/.test(source);
}

function splitTableRow(line) {
  let source = String(line || '').trim();
  if (source.startsWith('|')) source = source.slice(1);
  if (source.endsWith('|')) source = source.slice(0, -1);
  return source.split('|').map((cell) => cell.trim());
}

function isTableDelimiterRow(line) {
  const source = String(line || '').trim();
  if (!source || !source.includes('|')) return false;
  const cells = splitTableRow(source);
  if (!cells.length) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function tableColumnAlign(delimiterCell) {
  const cell = String(delimiterCell || '');
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return '';
}

function isTableStart(lines, index) {
  const header = lines[index];
  const delimiter = lines[index + 1];
  if (!isTableRow(header) || !isTableDelimiterRow(delimiter)) return false;
  return splitTableRow(header).length === splitTableRow(delimiter).length;
}

function markdownTableElement(header, align, body, baseUrl) {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  header.forEach((cell, column) => {
    const th = document.createElement('th');
    if (align[column]) th.style.textAlign = align[column];
    appendInlineMarkdown(th, cell, baseUrl);
    headerRow.append(th);
  });
  head.append(headerRow);
  table.append(head);
  if (body.length) {
    const tbody = document.createElement('tbody');
    body.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((cell, column) => {
        const td = document.createElement('td');
        if (align[column]) td.style.textAlign = align[column];
        appendInlineMarkdown(td, cell, baseUrl);
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(tbody);
  }
  return table;
}
function renderMarkdown(target, source, baseUrl) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  let code = null;
  let skipFence = false;
  let paragraph = null;
  const closeParagraph = () => { paragraph = null; };
  const closeList = () => { list = null; };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) {
      closeParagraph();
      closeList();
      if (skipFence) {
        skipFence = false;
        continue;
      }
      if (code) {
        code = null;
      } else {
        const fenceInfo = line.replace(/^```\s*/, '').trim().split(/\s+/)[0] || '';
        const pre = document.createElement('pre');
        code = document.createElement('code');
        pre.append(code);
        if (fenceInfo === 'loopx_summary_v1') {
          // LoopX receipts are machine-readable duplication of the rendered
          // summary above them; keep them out of the visible markdown.
          skipFence = true;
          continue;
        }
        fragment.append(pre);
      }
      continue;
    }
    if (skipFence) continue;
    if (code) {
      code.append(document.createTextNode(`${code.textContent ? '\n' : ''}${line}`));
      continue;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }
    if (isTableStart(lines, index)) {
      closeParagraph();
      closeList();
      const header = splitTableRow(line);
      const align = splitTableRow(lines[index + 1]).map(tableColumnAlign);
      const body = [];
      let cursor = index + 2;
      while (cursor < lines.length && isTableRow(lines[cursor])) {
        body.push(splitTableRow(lines[cursor]));
        cursor += 1;
      }
      fragment.append(markdownTableElement(header, align, body, baseUrl));
      index = cursor - 1;
      continue;
    }
    const boldHeading = line.trim().match(/^\*\*([^*]+)\*\*$/);
    if (boldHeading) {
      closeParagraph();
      closeList();
      const element = document.createElement('h4');
      element.className = 'markdown-bold-heading';
      appendInlineMarkdown(element, boldHeading[1], baseUrl);
      fragment.append(element);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const element = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInlineMarkdown(element, heading[2], baseUrl);
      fragment.append(element);
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*+] |\d+\. )(.+)$/);
    if (listItem) {
      closeParagraph();
      if (!list) {
        list = document.createElement(/^\s*\d+\./.test(line) ? 'ol' : 'ul');
        fragment.append(list);
      }
      const item = document.createElement('li');
      appendInlineMarkdown(item, listItem[1], baseUrl);
      list.append(item);
      continue;
    }
    closeList();
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeParagraph();
      const element = document.createElement('blockquote');
      appendInlineMarkdown(element, quote[1], baseUrl);
      fragment.append(element);
      continue;
    }
    if (!paragraph) {
      paragraph = document.createElement('p');
      fragment.append(paragraph);
    } else {
      paragraph.append(document.createElement('br'));
    }
    appendInlineMarkdown(paragraph, line, baseUrl);
  }
  target.replaceChildren(fragment);
}

function progressTaskEvents(task) {
  return state.events.filter((event) => (
    event.taskId === task.taskId
    && (event.generation == null || Number(event.generation) === Number(task.generation))
  ));
}

function compactArtifactPath(value) {
  const parts = String(value || '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-3).join('/');
}

function isProductArtifact(value) {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  if (!normalized) return false;
  return !normalized.startsWith('.loopx/')
    && !normalized.includes('/.loopx/')
    && !normalized.startsWith('.codex/')
    && !normalized.includes('/.codex/')
    && !normalized.startsWith('.bitfun/')
    && !normalized.includes('/.bitfun/')
    && !normalized.includes('/appdata/local/temp/');
}

function taskProgressEvidence(task) {
  const events = progressTaskEvents(task);
  const started = events.filter((event) => event.details && event.details.activity === 'started');
  const countTools = (names) => started.filter((event) => names.has(event.toolName)).length;
  const reads = countTools(new Set(['Read', 'LS']));
  const searches = countTools(new Set(['Grep']));
  const web = countTools(new Set(['WebFetch', 'WebSearch']));
  const changes = started.filter((event) => (
    ['Write', 'Edit', 'ApplyPatch'].includes(event.toolName)
    && isProductArtifact(event.details && event.details.summary)
  ));
  const commands = countTools(new Set(['ExecCommand']));
  const failures = events.filter((event) => event.details && event.details.activity === 'failed').length;
  const artifacts = [...new Set(changes
    .map((event) => compactArtifactPath(event.details && event.details.summary))
    .filter(Boolean))].slice(-3);
  const validated = events.some((event) => event.phase === 'validating_progress');
  const settled = Boolean(task.settlement && task.settlement.receiptId);
  return {
    reads,
    searches,
    web,
    analysisCount: reads + searches + web,
    changes: changes.length,
    commands,
    failures,
    artifacts,
    validated,
    settled,
  };
}

function currentProgressHeading(task, evidence) {
  if (isResolvedUpstream(task)) return text('progressResolvedUpstream');
  if (task.state === 'completed') return text('progressCompleted');
  if (isExternalWait(task)) return text('state_waiting_for_external');
  if (task.state === 'waiting_for_user') return text('progressWaiting');
  if (task.state === 'recovery_required' || task.state === 'failed') return text('progressRecovery');
  if (task.phase === 'preparing_workspace') return text('progressPreparing');
  if (task.state === 'queued' && isMonitorTodo(task)) return text('monitor_phase_queued');
  if (task.state === 'queued' || task.phase === 'queued') return text('progressQueued');
  if (task.phase === 'validating_progress') return text('progressValidating');
  if (task.phase === 'settling_turn') return text('progressSettling');
  if (task.phase === 'agent_running') {
    return text(evidence.changes > 0 ? 'progressImplementing' : 'progressAnalyzing');
  }
  return text('progressIdle');
}

function currentProgressDetail(task, events) {
  if (isResolvedUpstream(task)) return text('progressResolvedUpstreamDetail');
  if (task.state === 'queued') {
    return isMonitorTodo(task) ? monitorWaitDetail(task) : latestTaskWaitReason(task);
  }
  if (isExternalWait(task)) {
    const waitMessage = String(task.pendingGateMessage || '').trim();
    return externalWaitPresentation(waitMessage, taskPullRequestLinks(task, waitMessage));
  }
  if (task.currentTool) {
    const activity = [...events].reverse().find((event) => (
      event.toolName === task.currentTool
      && event.details
      && event.details.activity === 'started'
    ));
    const summary = activity && activity.details && activity.details.summary;
    return activitySummary(task.currentTool, summary);
  }
  if (task.state === 'recovery_required' || task.state === 'failed') {
    return task.error ? String(task.error) : taskPhaseLabel(task);
  }
  if (task.workspacePath && task.phase === 'creating_goal') {
    return compactArtifactPath(task.workspacePath);
  }
  return taskPhaseLabel(task);
}

function activitySummary(toolName, rawSummary) {
  const summary = String(rawSummary || '');
  if (toolName !== 'ExecCommand') {
    const path = compactArtifactPath(summary);
    return path ? `${toolLabel(toolName)} · ${path}` : toolLabel(toolName);
  }
  if (/yarn\s+(?:workspace\s+\S+\s+)?install|pnpm\s+install|npm\s+(?:ci|install)/i.test(summary)) {
    return text('activityInstallingDependencies');
  }
  if (/dist:win|electron-builder|package-win|makensis|nsis/i.test(summary)) {
    return text('activityBuildingInstaller');
  }
  if (/smoke-windows-installer-upgrade|installer-upgrade|overwrite-marker|repro-overwrite/i.test(summary)) {
    return text('activityTestingUpgrade');
  }
  if (/Start-Sleep|Wait-Process|Get-Process|Get-CimInstance/i.test(summary)) {
    return text('activityWaitingProcess');
  }
  if (/loopx(?:\.exe)?[^\n]*(?:refresh-state|todo|heartbeat-prompt|quota)/i.test(summary)) {
    return text('activitySyncingProgress');
  }
  if (/\bgit\b/i.test(summary)) return text('activityCheckingRepository');
  return text('activityRunningCommand');
}

function renderIssueApproval(task) {
  const gate = task && task.state === 'waiting_for_user' ? latestGate(task.taskId) : null;
  const gateJustArrived = gate && view.issueApprovalPanel.hidden;
  view.issueApprovalPanel.hidden = !gate;
  if (gateJustArrived && view.issueDetail) {
    // 新到的 owner 决策自己钉在详情列顶部：把滚动位置带回顶部，
    // 保证审批卡片完整可见（sticky 定位已保证后续滚动时不被淹没）。
    view.issueDetail.scrollTop = 0;
    // 新决策不带上一决策的备注草稿：收起备注输入，回到默认紧凑形态。
    const noteField = view.issueApprovalNote.closest('.issue-approval-note');
    if (noteField) noteField.hidden = true;
    view.issueApprovalNoteToggle.setAttribute('aria-expanded', 'false');
  }
  if (!gate) return;
  const presentation = approvalPresentation(task, gate);
  view.issueApprovalKind.textContent = presentation.kind === 'publish'
    ? text('gateKindPublish')
    : (presentation.kind === 'publish_comment' ? text('gateKindComment') : text('gateKindDecision'));
  view.issueApprovalTitle.textContent = presentation.title;
  view.issueApprovalMessage.textContent = presentation.summary;
  const rawBody = String(presentation.rawMessage || '').trim();
  const showRaw = rawBody && rawBody !== presentation.summary && presentation.kind === 'generic';
  view.issueApprovalRaw.hidden = !showRaw;
  view.issueApprovalRawText.textContent = showRaw ? rawBody : '';
  view.issueApprovalApproveEffect.textContent = presentation.approveEffect;
  view.issueApprovalRejectEffect.textContent = presentation.rejectEffect;
  view.issueApprovalRecommendation.textContent = presentation.recommendation;
  // Decision context: the owner approves faster when the latest segment's
  // narrative (who asked for what on the external surface, what the agent
  // did about it, what happens next) is quoted right at the decision point
  // instead of only inside the folded brief below (observed live
  // 2026-09-11: the owner was asked to publish the follow-up fix without
  // seeing the review comment that triggered it).
  const structured = task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  const contextItems = [];
  if (presentation.commentPoints && presentation.commentPoints.length) {
    contextItems.push(`${text('gateCommentPointsTitle')}：`);
    presentation.commentPoints.forEach((line) => contextItems.push(line));
  }
  if (presentation.artifacts && presentation.artifacts.length) {
    contextItems.push(`${text('gateCommentDraftTitle')}：${presentation.artifacts.join(' , ')}`);
    contextItems.push(text('gateCommentDraftHint'));
  }
  if (presentation.kind !== 'publish_comment' && structured && Array.isArray(structured.completed)) {
    structured.completed.slice(0, 2).forEach((item) => {
      const line = String(item || '').trim();
      if (line) contextItems.push(line);
    });
  }
  if (structured && structured.next_step) {
    const line = String(structured.next_step).trim();
    if (line) contextItems.push(line);
  }
  const repository = task.identity && task.identity.item
    && task.identity.item.repository;
  view.issueApprovalContextList.replaceChildren(
    ...contextItems.map((line) => {
      const li = document.createElement('li');
      li.append(linkifiedText(line, repository));
      return li;
    }),
  );
  view.issueApprovalContext.hidden = contextItems.length === 0;
  const pending = Boolean(pendingActionFor(task)) || Boolean(state.gateSubmittingAction);
  view.issueApprovalApprove.textContent = pending ? text('approvalSubmittingShort') : presentation.approveLabel;
  view.issueApprovalReject.textContent = presentation.rejectLabel;
  view.issueApprovalApprove.disabled = pending;
  view.issueApprovalReject.disabled = pending;
  view.issueApprovalNote.disabled = pending;
}

function renderIssueStatus(task) {
  const card = view.issueDecisionCard;
  if (!card) return;
  const waiting = Boolean(task) && task.state === 'waiting_for_user';
  const recovery = Boolean(task) && task.state === 'recovery_required';
  // A live typed approval panel is the decision surface; repeating the same
  // request in the lower decision card made the page look like two questions
  // and pushed the actual summary off-screen. Keep the card for recovery and
  // owner-action/external waits, not for typed gates already rendered above.
  const typedGate = Boolean(task && task.pendingGateId);
  const show = Boolean(task)
    && !isResolvedUpstream(task)
    && (recovery || (waiting && !typedGate));
  card.hidden = !show;
  if (!show) {
    card.replaceChildren();
    return;
  }
  card.replaceChildren();
  const planExhausted = recovery && task.recoveryReason === 'plan_exhausted';
  // Owner-action park: waiting WITHOUT a live typed gate, with the park
  // message naming the external step (merge a PR on GitHub). This is a
  // "waiting for an external event" STATUS, not a decision: there is
  // nothing to approve or reject here, so the card must not use decision
  // wording (observed live 2026-09-12: the park presented itself as
  // "needs your decision" with a continue button that no-ops until the
  // external event lands, and the owner clicked it twice with no effect).
  const waitMessage = String(task.pendingGateMessage || '').trim();
  const externalWait = waiting && !task.pendingGateId && waitMessage;
  card.dataset.mode = externalWait ? 'external' : 'decision';
  const externalLinks = externalWait ? taskPullRequestLinks(task, waitMessage) : [];
  const externalPresentation = externalWait
    ? externalWaitPresentation(waitMessage, externalLinks)
    : null;
  const heading = document.createElement('strong');
  heading.id = 'issue-decision-card-title';
  heading.textContent = text(externalWait
    ? 'decisionCardTitleExternal'
    : (waiting
      ? 'decisionCardTitle'
      : (planExhausted ? 'decisionCardTitlePlanExhausted' : 'decisionCardTitleRecovery')));
  const body = document.createElement('p');
  body.className = 'issue-decision-card__message';
  let recoveryHint;
  if (externalWait) {
    recoveryHint = externalPresentation;
  } else if (waiting) {
    // With a live typed gate the actionable surface is the approval panel
    // above; the owner-action park (no gate id, message names an external
    // step like merging a PR on GitHub) carries its own instruction in the
    // message — show that instead of pointing at a panel that is hidden.
    recoveryHint = (!task.pendingGateId && waitMessage)
      ? waitMessage
      : text('decisionCardGateHint');
  } else if (String(task.pendingGateMessage || '').trim()) {
    recoveryHint = String(task.pendingGateMessage).trim();
  } else if (planExhausted) {
    recoveryHint = text('decisionCardPlanExhaustedHint');
  } else {
    // The agent's structured "next step" is the single most owner-relevant
    // fact on a settlement-parked task (for example: "wait for PR #5 to be
    // merged or closed, then run the final settlement"). Surface it here
    // instead of boilerplate so the card alone answers "what now?". It is
    // rendered from the same `structuredSummary` source as the summary
    // section below - a projection, not a second fact.
    const structured = task.structuredSummary && typeof task.structuredSummary === 'object'
      ? task.structuredSummary
      : null;
    const nextStep = structured && structured.next_step
      ? String(structured.next_step).trim()
      : '';
    recoveryHint = nextStep || text('decisionCardRecoveryHint');
  }
  body.textContent = recoveryHint;
  card.append(heading, body);
  const decisionStructured = task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  if (
    decisionStructured
    && decisionStructured.reproduction === 'reproduced'
    && reproductionScope(decisionStructured) !== 'e2e'
  ) {
    const e2eHint = document.createElement('p');
    e2eHint.className = 'issue-decision-card__e2e-hint';
    e2eHint.textContent = text('summaryE2eVerificationHint');
    card.append(e2eHint);
  }
  if (externalWait) {
    if (externalLinks.length > 0) card.append(externalWaitLinkRow(externalLinks));
    // A recent re-check with the same park message means the external
    // state has not changed: say so instead of letting the card look
    // untouched (the silent no-op that made the owner re-click).
    const recentCheck = latestOwnerActionCheck(task.taskId, waitMessage);
    if (recentCheck) {
      const hint = document.createElement('p');
      hint.className = 'issue-decision-card__recheck-hint';
      hint.textContent = text('decisionCardRecheckRecent', { time: clockLabel(recentCheck.at) });
      card.append(hint);
    }
  }
  const reasonKey = !waiting && task.recoveryReason
    ? `recoveryReason${String(task.recoveryReason).split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`
    : null;
  if (reasonKey) {
    const reason = document.createElement('p');
    reason.className = 'issue-decision-card__message';
    const table = COPY[localeId()] || COPY['en-US'];
    const reasonText = table[reasonKey] || COPY['en-US'][reasonKey] || '';
    if (reasonText) reason.textContent = reasonText;
    else reason.hidden = true;
    card.append(reason);
  }
  const actions = document.createElement('div');
  actions.className = 'issue-decision-card__actions';
  if (recovery) {
    actions.append(makeActionButton(text('decisionResume'), 'resume', task, 'primary'));
  }
  // Owner-action park (waiting without a live typed gate): the card is the
  // attention surface. The external step (open/merge the PR) is the primary
  // action above; the in-host re-check is secondary and labelled with its
  // real semantics — it re-verifies the external state, it does not
  // "continue" anything. A live typed gate keeps approve/reject as the
  // single entry.
  if (externalWait) {
    actions.append(makeOwnerActionRecheckButton(task));
  } else if (waiting && !task.pendingGateId) {
    actions.append(makeActionButton(
      text('decisionContinueAfterOwnerAction'),
      'resume',
      task,
      'primary',
    ));
  }
  card.append(actions);
}

const OWNER_ACTION_RECHECK_COOLDOWN_MS = 8000;
const OWNER_ACTION_RECHECK_RECENT_MS = 10 * 60 * 1000;

function recordOwnerActionCheck(taskId, message) {
  state.ownerActionChecks.set(taskId, { at: Date.now(), message: String(message || '') });
}

function clearOwnerActionCheck(taskId) {
  state.ownerActionChecks.delete(taskId);
}

function ownerActionCheckCoolingDown(taskId) {
  const check = state.ownerActionChecks.get(taskId);
  return Boolean(check) && Date.now() - check.at < OWNER_ACTION_RECHECK_COOLDOWN_MS;
}

function latestOwnerActionCheck(taskId, currentMessage) {
  const check = state.ownerActionChecks.get(taskId);
  if (!check) return null;
  if (check.message !== String(currentMessage || '')) return null;
  if (Date.now() - check.at >= OWNER_ACTION_RECHECK_RECENT_MS) return null;
  return check;
}

function taskPullRequestLinks(task, message = '') {
  const structured = task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  const artifacts = structured && Array.isArray(structured.artifacts)
    ? structured.artifacts
    : [];
  const seen = new Set();
  const links = [];
  artifacts.forEach((raw) => {
    const url = String(raw || '').trim();
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match || seen.has(url)) return;
    seen.add(url);
    links.push({ url, number: match[3], label: `PR #${match[3]}` });
  });
  // The park prose names the actionable PR; keep that one first when the
  // message mentions several (or a stale artifact), so the primary link and
  // the instruction cannot point at different pull requests.
  const mentionOrder = new Map();
  String(message || '').replace(
    /\b(?:PR|pull request|pull)\s*#(\d+)\b|\bpull\/(\d+)\b/gi,
    (_match, first, second) => {
      const number = String(first || second || '');
      if (number && !mentionOrder.has(number)) mentionOrder.set(number, mentionOrder.size);
      return '';
    },
  );
  links.sort((left, right) =>
    (mentionOrder.get(left.number) ?? Number.MAX_SAFE_INTEGER)
    - (mentionOrder.get(right.number) ?? Number.MAX_SAFE_INTEGER));
  return links.slice(0, 2);
}

/// The host parks an owner action behind a fixed English envelope:
/// "LoopX is waiting for an owner action outside this host: <todo text>.
/// Finish that action on the surface it names; ...". The todo text is the
/// only actionable part; the envelope is host boilerplate. Extract it so
/// the card can answer "what do I have to do?" instead of showing the
/// generic "action outside BitFun" sentence (observed live 2026-09-12:
/// the parked screen hid the only actionable text and the owner could not act).
function ownerActionSummary(message) {
  const raw = String(message || '').trim();
  const envelope = raw.match(/outside (?:this|the) host\s*[:：]\s*([\s\S]+)$/i);
  if (!envelope) return '';
  return envelope[1]
    .replace(/\s*(?:Finish that action on the surface it names|Finish the pending owner decision|The task continues when the goal gains new work|Resume after acting)[\s\S]*$/i, '')
    .replace(/[.。]$/, '')
    .trim();
}

function externalWaitPresentation(message, links) {
  const raw = String(message || '').trim();
  const hasCjk = /[\u3400-\u9fff]/.test(raw);
  const boilerplate = /outside this host|surface it names|Resume after acting|waiting for an owner action|say what still needs to change/i.test(raw);
  if (hasCjk && !boilerplate) return raw;

  // The park envelope carries the authoritative owner-action text. Surface
  // it (with a localized label) instead of the generic sentence that only
  // said "something outside BitFun" and left the owner unable to act.
  const ownerAction = ownerActionSummary(raw);
  if (ownerAction) return text('decisionCardExternalActionLabel') + ownerAction;
  if (links.length > 0) {
    const joiner = localeId() === 'zh-CN' ? '、' : ', ';
    return text('decisionCardExternalSummary', { prs: links.map((link) => link.label).join(joiner) });
  }
  return text('decisionCardExternalSummaryGeneric');
}

function externalWaitLinkRow(links) {
  const row = document.createElement('div');
  row.className = 'issue-decision-card__links';
  links.forEach((link) => {
    const anchor = externalAnchor(link.label, link.url, 'issue-decision-card__link');
    anchor.title = text('openInGithub');
    row.append(anchor);
  });
  return row;
}

function runOwnerActionRecheck(task) {
  recordOwnerActionCheck(task.taskId, String(task.pendingGateMessage || '').trim());
  return performAction('resume', task).then((applied) => {
    if (!applied) clearOwnerActionCheck(task.taskId);
    return applied;
  });
}

function makeOwnerActionRecheckButton(task, className = 'text-button') {
  const coolingDown = ownerActionCheckCoolingDown(task.taskId);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  // PR-named parks get the PR-specific label; every other owner action
  // (manual verification, publish decision, ...) gets the generic one, so
  // the button never promises a PR check the park cannot perform (observed
  // live 2026-09-12: the parked task had no pull request at all).
  const links = taskPullRequestLinks(task, task.pendingGateMessage);
  button.textContent = links.length > 0
    ? text('decisionCardRecheck')
    : text('decisionCardRecheckGeneric');
  button.disabled = Boolean(pendingActionFor(task)) || coolingDown;
  if (coolingDown) button.title = text('decisionCardRecheckCooldown');
  button.addEventListener('click', () => {
    void runOwnerActionRecheck(task);
  });
  return button;
}

/// Owner-action parks can go stale while the user is away (PR closed or
/// merged on GitHub). Re-check once shortly after the task is shown, with
/// a floor between attempts so a still-open PR does not loop.
function maybeAutoRecheckExternalWait(task) {
  if (!task || !isExternalWait(task) || pendingActionFor(task)) return;
  if (!canRender() || state.syncing) return;
  const now = Date.now();
  const last = state.autoRecheckAt.get(task.taskId) || 0;
  if (now - last < AUTO_RECHECK_INTERVAL_MS) return;
  state.autoRecheckAt.set(task.taskId, now);
  void runOwnerActionRecheck(task);
}

function summaryEnumLabel(prefix, value) {
  const key = `${prefix}${String(value || '').split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
  const table = COPY[localeId()] || COPY['en-US'];
  return table[key] || fallbackCopy(key);
}

function fallbackCopy(key) {
  return COPY['en-US'][key] || '';
}

function stripSummaryBlock(raw) {
  return String(raw || '')
    .replace(/```loopx_summary_v1[\s\S]*?```/g, '')
    .trim();
}

function compactSummaryText(value, max = 110) {
  const source = String(value || '').trim();
  if (source.length <= max) return source;
  return `${source.slice(0, max - 1)}…`;
}

/// The owner asked for the middle of the story: what the issue wanted, what
/// was actually found, and why nothing was changed. The card used to jump from
/// a verdict badge straight to a conclusion, which read as missing background.
function appendBriefSentence(container, titleKey, value, repository) {
  const source = String(value || '').trim();
  if (!source) return;
  const heading = document.createElement('h3');
  heading.append(document.createTextNode(text(titleKey)));
  if (!/[\u3400-\u9fff]/.test(source)) {
    const tag = document.createElement('span');
    tag.className = 'summary-lang-hint';
    tag.textContent = text('summaryAgentEnglish');
    heading.append(' ', tag);
  }
  const body = document.createElement('p');
  body.append(linkifiedText(source, repository));
  container.append(heading, body);
}

function appendBriefList(container, titleKey, items, repository) {
  const values = Array.isArray(items)
    ? items.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!values.length) return;
  const heading = document.createElement('h3');
  heading.append(document.createTextNode(text(titleKey)));
  if (!values.some((item) => /[\u3400-\u9fff]/.test(item))) {
    const tag = document.createElement('span');
    tag.className = 'summary-lang-hint';
    tag.textContent = text('summaryAgentEnglish');
    heading.append(' ', tag);
  }
  const list = document.createElement('ul');
  values.forEach((item) => {
    const entry = document.createElement('li');
    entry.append(linkifiedText(item, repository));
    list.append(entry);
  });
  container.append(heading, list);
}

function reproductionActiveKey(summary, task) {
  const s = summary && typeof summary === 'object' ? summary : {};
  if (s.reproduction !== 'not_reproduced' || !task) return '';
  const state = String(task.state || '');
  const phase = String(task.phase || '');
  const todoKind = task.currentTodo ? String(task.currentTodo.actionKind || '') : '';
  const paused = state === 'waiting_for_user'
    || state === 'recovery_required'
    || state === 'completed';
  if (!paused && todoKind === 'issue_fix_confirm_reproduction') {
    return 'summaryReproductionInProgress';
  }
  if (!paused && state === 'running' && phase === 'agent_running') {
    return 'summaryReproductionInProgress';
  }
  if (!paused && (state === 'queued' || state === 'preparing')) {
    return 'summaryReproductionPending';
  }
  return '';
}
function reproductionScope(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const evidence = [
    s.reproduction_evidence,
    s.actual_findings,
    s.background,
    s.decision && s.decision.reason,
  ].filter(Boolean).join(' ');
  if (!evidence) return 'unknown';
  const mentionsE2e = /(端到端|end[- ]?to[- ]?end|\be2e\b|真实环境|真实订阅)/i.test(evidence);
  const deniesE2e = /(无法|未能|没有|未做|未执行|未覆盖|不能|only|仅)[^。；\n]{0,24}(端到端|end[- ]?to[- ]?end|\be2e\b)/i.test(evidence);
  if (mentionsE2e && !deniesE2e) return 'e2e';
  if (/(回归测试|cargo test|单元测试|模块|请求构造|fixture|focused test|test surface)/i.test(evidence)) return 'module';
  return 'unknown';
}
function renderStructuredBrief(container, s, task) {
/// 每条证据/产物都要回答「它支持什么结论」，而不是抛一串路径让用户自己猜。
function classifyArtifact(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'file';
  const lower = raw.toLowerCase();
  if (/^https?:\/\//.test(lower) && /github\.com\/[^/]+\/[^/]+\/(issues|pull)\//.test(lower)) return 'source_issue';
  if (/(pr[-_]?review[-_]?packet|review[-_]?packet|publish|release)/.test(lower)) return 'review';
  if (/(evidence|repro)/.test(lower)) return 'repro';
  if (/(\.test\.|\.spec\.|vitest|cargo test|pytest|\btests?\b)/.test(lower)) return 'validation';
  if (/(^|\/)agents\.md$|(^|\/)docs?\//.test(lower) || /\.md$/.test(lower)) return 'docs';
  if (/\.(rs|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|vue|svelte|css|scss|json|toml|ya?ml)$/.test(lower)) return 'implementation';
  return 'file';
}

const ARTIFACT_KIND_LABEL_KEY = {
  source_issue: 'artifactKindSource',
  repro: 'artifactKindRepro',
  validation: 'artifactKindValidation',
  implementation: 'artifactKindImplementation',
  docs: 'artifactKindDocs',
  review: 'artifactKindReview',
  file: 'artifactKindFile',
};

function artifactSupportText(artifact, summary) {
  const value = String(artifact || '').trim();
  if (!value) return '';
  const pool = [
    summary.actual_findings,
    summary.background,
    summary.decision && summary.decision.reason,
    summary.completed,
  ].flat().filter(Boolean).map((entry) => String(entry));
  const mentioned = pool.find((entry) => entry.includes(value));
  if (!mentioned) return '';
  const sentence = stripPriorityPrefix(mentioned).split(/(?<=[。；;.!?])\s*/)[0];
  return sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence;
}

function renderSupportingEvidence(container, artifacts, summary, repository) {
  const values = Array.isArray(artifacts)
    ? artifacts.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (!values.length) return;
  const heading = document.createElement('h3');
  heading.append(document.createTextNode(text('summarySupportingEvidence')));
  const list = document.createElement('ul');
  list.className = 'summary-support';
  values.forEach((value) => {
    const entry = document.createElement('li');
    const kind = document.createElement('span');
    kind.className = 'summary-support__kind';
    kind.textContent = text(ARTIFACT_KIND_LABEL_KEY[classifyArtifact(value)] || 'artifactKindFile');
    const body = document.createElement('span');
    body.className = 'summary-support__body';
    // 路径/URL 列表不是「英文原文」叙述，不打语言标签。
    body.append(linkifiedText(value, repository));
    const support = artifactSupportText(value, summary || {});
    if (support) {
      const note = document.createElement('span');
      note.className = 'summary-support__note';
      note.textContent = text('summaryArtifactSupports', { value: support });
      body.append(note);
    }
    entry.append(kind, body);
    list.append(entry);
  });
  container.append(heading, list);
}

  const narrativeRepository = task && task.identity && task.identity.item
    ? task.identity.item.repository
    : null;
  container.replaceChildren();
  const badges = document.createElement('div');
  badges.className = 'summary-badges';
  const verdict = document.createElement('span');
  verdict.className = 'summary-badge';
  const verdictTone = ({
    needs_fix: 'warning',
    already_fixed_upstream: 'success',
    wont_fix: s.wont_fix_reason === 'evaluation_pending' ? 'info' : 'muted',
    needs_info: 'info',
  })[s.issue_verdict] || 'muted';
  verdict.dataset.tone = verdictTone;
  verdict.textContent = summaryEnumLabel('summaryVerdict', s.issue_verdict) || s.issue_verdict;
  badges.append(verdict);
  if (s.issue_verdict === 'already_fixed_upstream' && s.fixed_by) {
    badges.append(externalAnchor(s.fixed_by, s.fixed_by, 'summary-badge summary-badge--link'));
  }
  if (s.issue_verdict === 'wont_fix' && s.wont_fix_reason) {
    const reason = document.createElement('span');
    reason.className = 'summary-badge';
    reason.textContent = summaryEnumLabel('summaryWontFixReason', s.wont_fix_reason) || s.wont_fix_reason;
    badges.append(reason);
  }
  const reproScope = reproductionScope(s);
  const reproductionEvidence = String(s.reproduction_evidence || '').trim();
  const activeReproductionKey = reproductionActiveKey(s, task);
  if (s.reproduction && s.reproduction !== 'not_applicable') {
    const reproduction = document.createElement('span');
    reproduction.className = 'summary-badge';
    reproduction.dataset.tone = (activeReproductionKey || s.reproduction === 'reproduced') ? 'info' : 'muted';
    reproduction.dataset.active = activeReproductionKey ? 'true' : 'false';
    const labelKey = activeReproductionKey
      || (s.reproduction === 'reproduced'
        ? ({
          e2e: 'summaryReproductionE2e',
          module: 'summaryReproductionModule',
        }[reproScope] || 'summaryReproductionScoped')
        : (s.reproduction === 'not_reproduced'
          ? 'summaryReproductionNotReproduced'
          : 'summaryReproductionNotApplicable'));
    reproduction.textContent = text(labelKey)
      || summaryEnumLabel('summaryReproduction', s.reproduction)
      || s.reproduction;
    if (activeReproductionKey) {
      reproduction.title = text('summaryReproductionActiveHint');
    } else if (reproductionEvidence) {
      reproduction.title = `${text('summaryReproductionEvidenceLabel')}: ${reproductionEvidence}`;
    }
    badges.append(reproduction);
  }
  container.append(badges);
  const stateLabelText = taskStateDisplayLabel(task);
  const statePhaseText = taskPhaseLabel(task);
  const stateActionText = taskActionLabel(task);
  const stateLineText = [stateLabelText, statePhaseText, stateActionText].filter(Boolean).join(' · ');
  if (stateLineText) {
    const stateLine = document.createElement('p');
    stateLine.className = 'summary-inline-note summary-state-line';
    stateLine.textContent = stateLineText;
    container.append(stateLine);
  }
  if (reproductionEvidence) {
    const evidence = document.createElement('p');
    evidence.className = 'summary-inline-note summary-reproduction-evidence';
    evidence.append(document.createTextNode(`${text('summaryReproductionEvidenceLabel')}：`));
    evidence.append(linkifiedText(reproductionEvidence, narrativeRepository));
    container.append(evidence);
  }
  if (s.reproduction === 'reproduced' && reproScope !== 'e2e') {
    const e2eHint = document.createElement('p');
    e2eHint.className = 'summary-inline-note summary-e2e-hint';
    e2eHint.textContent = text('summaryE2eVerificationHint');
    container.append(e2eHint);
  }

  if (s.issue_verdict === 'needs_info' && Array.isArray(s.missing_info) && s.missing_info.length) {
    const reason = document.createElement('p');
    reason.className = 'summary-inline-note';
    reason.textContent = `${text('summaryMissingInfo')}：${s.missing_info.join('；')}`;
    container.append(reason);
  }

  if (task && task.state === 'waiting_for_user' && task.pendingGateId) {
    const pending = document.createElement('p');
    pending.className = 'summary-inline-note';
    pending.textContent = text('summaryPendingGate');
    container.append(pending);
  }

  const decision = s.decision && typeof s.decision === 'object' ? s.decision : null;
  const decisionRoute = decision && typeof decision.route === 'string'
    ? decision.route.trim()
    : '';
  const decisionReason = decision && typeof decision.reason === 'string'
    ? decision.reason.trim()
    : '';
  const decisionText = decisionRoute
    ? (decisionReason ? `${decisionRoute}（${decisionReason}）` : decisionRoute)
    : '';
  const conclusionSource = decisionText
    || (task && task.state === 'completed' ? text('summaryCompletedNoFollowup') : '');
  appendBriefSentence(container, 'summaryConclusion', conclusionSource, narrativeRepository);
  // 「结论 + 支撑证据」是一个整体：证据紧跟结论，且每条都带中文类型说明。
  renderSupportingEvidence(container, s.artifacts, s, narrativeRepository);
  appendBriefSentence(container, 'summaryBackground', s.background, narrativeRepository);
  appendBriefSentence(container, 'summaryActualFindings', s.actual_findings, narrativeRepository);
  appendBriefSentence(container, 'summaryWhyNoFix', s.why_no_fix, narrativeRepository);
  appendBriefList(container, 'summarySectionCompleted', s.completed, narrativeRepository);

  if (task && task.state === 'completed' && decisionRoute) {
    const note = document.createElement('p');
    note.className = 'summary-inline-note';
    note.textContent = text('summaryCompletedNoFollowup');
    container.append(note);
  }

  if (task && task.state !== 'completed' && s.next_step) {
    appendBriefSentence(container, 'summaryNextStep', s.next_step, narrativeRepository);
  }

  if (
    Array.isArray(s.blockers)
    && s.blockers.length
    && !(task && task.state === 'completed')
  ) {
    appendBriefList(container, 'summaryBlockers', s.blockers, narrativeRepository);
  }
}

function renderIssueBrief(task) {
  // The raw agent report ends with a `loopx_summary_v1` fence; the
  // structured brief (or the prose above it) already carries that content.
  const summary = stripSummaryBlock(task.lastAgentSummary || '');
  const structured = task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  if (structured) {
    renderStructuredBrief(view.issueSummary, structured, task);
  } else if (summary) {
    renderMarkdown(view.issueSummary, summary, itemUrl(task.identity && task.identity.item));
  } else {
    view.issueSummary.replaceChildren();
    view.issueSummary.append(text('summaryEmpty'));
  }
  const showSummaryMeta = Boolean(task.lastAgentSummaryAt) && task.state !== 'completed';
  view.issueSummaryMeta.textContent = showSummaryMeta
    ? text('outcomeUpdated', { duration: relativeLabel(task.lastAgentSummaryAt) })
    : '';
  view.issueSummaryMeta.title = showSummaryMeta ? clockLabel(task.lastAgentSummaryAt) : '';

  const error = String(task.error || '').trim();
  view.issueError.hidden = !error;
  view.issueError.textContent = error ? `${text('errorTitle')}：${error}` : '';
}

function renderFollowBanner(task) {
  const following = isFollowingRunningTask();
  view.followBanner.hidden = !following || !task;
  if (!following || !task) return;
  const item = task.identity && task.identity.item;
  view.followBannerText.textContent = text('followBanner', {
    item: compactItemLabel(item),
    state: taskStateDisplayLabel(task),
  });
  view.followBanner.title = text('followBannerHint');
}

function renderIssueView() {
  if (!canRender()) return;
  const task = displayedTask();
  view.issueView.hidden = !task;
  view.issueEmpty.hidden = Boolean(task);
  renderFollowBanner(task);
  if (!task) {
    renderTaskActions(null);
    return;
  }

  const visualState = taskVisualState(task);
  const item = task.identity && task.identity.item;
  const url = itemUrl(item);
  const itemLabelText = itemLabel(item);
  view.issueTitle.textContent = issueDisplayTitle(task) || itemLabelText;
  view.issueStatePill.hidden = false;
  view.issueStatePill.dataset.state = visualState;
  if (isExternalWait(task)) view.issueStatePill.dataset.wait = 'external';
  else delete view.issueStatePill.dataset.wait;
  view.issueStatePill.textContent = taskStateDisplayLabel(task);
  view.issueLink.hidden = !url;
  view.issueLink.textContent = itemLabelText;
  if (url) {
    view.issueLink.href = url;
    view.issueLink.setAttribute('aria-label', `${text('openInGithub')}: ${itemLabelText}`);
  } else {
    view.issueLink.removeAttribute('href');
    view.issueLink.removeAttribute('aria-label');
  }
  // 已产生 PR 时，头部常驻一个入口：不用去翻时间线找链接。
  const pullRequestUrl = taskPullRequestUrl(task);
  const pullRequestNumber = pullRequestUrl ? (pullRequestUrl.match(/\/pull\/(\d+)/) || [])[1] || '' : '';
  view.issuePrLink.hidden = !pullRequestUrl;
  if (pullRequestUrl) {
    view.issuePrLink.textContent = pullRequestNumber ? `PR #${pullRequestNumber}` : text('issuePullRequest');
    view.issuePrLink.href = pullRequestUrl;
    view.issuePrLink.title = pullRequestUrl;
    view.issuePrLink.setAttribute('aria-label', `${text('issuePullRequest')}: ${pullRequestUrl}`);
  } else {
    view.issuePrLink.textContent = '';
    view.issuePrLink.removeAttribute('href');
    view.issuePrLink.removeAttribute('title');
    view.issuePrLink.removeAttribute('aria-label');
  }
  view.issueUpdated.textContent = task.updatedAt
    ? text('taskUpdated', { duration: relativeLabel(task.updatedAt) })
    : '';
  view.issueUpdated.title = task.updatedAt ? clockLabel(task.updatedAt) : '';
  // The header meta already carries repo + item number; do not repeat the
  // same fact inside the description summary (single source of truth).
  view.issueNumber.textContent = '';
  view.issueNumber.hidden = true;
  const statePillVisible = !view.issueStatePill.hidden;
  const issueLinkVisible = !view.issueLink.hidden;
  const prLinkVisible = !view.issuePrLink.hidden;
  const updatedVisible = Boolean(view.issueUpdated.textContent);
  view.issueMetaSep1.hidden = !(statePillVisible && (issueLinkVisible || prLinkVisible || updatedVisible));
  view.issueMetaSep3.hidden = !(issueLinkVisible && prLinkVisible);
  view.issueMetaSep2.hidden = !(prLinkVisible && updatedVisible);
  renderIssueApproval(task);
  renderIssueStatus(task);
  renderIssueBrief(task);

  const description = identityDescriptionOf(task);
  const metadataKey = itemKey(item);
  const metadataResolved = state.itemMetadata.has(metadataKey);
  const metadataUnavailable = (state.itemMetadata.get(metadataKey) || {}).unavailable === true;
  const loadingDescription = !metadataResolved;
  // Keep the panel for "loading"/"unavailable" states (the reader learns why
  // the body is missing), but do not render an empty section that only adds
  // a repeating "Issue #2" label once the source confirmed there is no body.
  view.issueDescriptionPanel.hidden = metadataResolved && !metadataUnavailable && !description;
  // Distinguish "not resolved yet" (loading), "resolution failed"
  // (unavailable), and "resolved but the issue simply has no body" (empty
  // placeholder). A successfully hydrated empty body used to fall through to
  // the loading placeholder forever.
  const descriptionText = description
    || (metadataUnavailable
      ? text('issueDescriptionUnavailable')
      : (loadingDescription ? text('loadingIssueDescription') : text('issueDescriptionEmpty')));
  renderMarkdown(view.issueDescription, descriptionText, url);
  // The host projects a bounded plain-text excerpt, not the original body:
  // markdown is stripped and long text is cut with an ellipsis. Saying so stops
  // the reader from reading it as a broken renderer.
  if (description && /…$/.test(String(description).trim())) {
    const note = document.createElement('p');
    note.className = 'issue-description__note';
    note.textContent = text('issueDescriptionExcerptNote');
    if (url) {
      note.append(' ', externalAnchor(text('issueDescriptionOpenOnGithub'), url));
    }
    view.issueDescription.append(note);
  }
  renderTaskActions(task);
  if (isExternalWait(task)) {
    window.setTimeout(() => maybeAutoRecheckExternalWait(taskForId(task.taskId)), 0);
  }
}

function eventSourceLabel(source) {
  const keys = {
    controller: 'sourceScheduler',
    sidecar: 'sourceLoopx',
    agent: 'sourceAgent',
    git: 'sourceGit',
    github: 'sourceGithub',
    system: 'sourceSystem',
  };
  return keys[source] ? text(keys[source]) : (source || text('sourceScheduler'));
}

function toolLabel(toolName) {
  const keys = {
    ExecCommand: 'toolExecCommand',
    Read: 'toolRead',
    Grep: 'toolGrep',
    LS: 'toolLs',
    WebFetch: 'toolWebFetch',
    WebSearch: 'toolWebSearch',
    Write: 'toolWrite',
    Edit: 'toolEdit',
  };
  return keys[toolName] ? text(keys[toolName]) : (toolName || text('outputTool'));
}

function toolStateLabel(stateValue) {
  const key = {
    queued: 'toolStateQueued',
    waiting: 'toolStateWaiting',
    started: 'toolStateStarted',
    confirmation: 'toolStateConfirmation',
    confirmed: 'toolStateConfirmed',
    rejected: 'toolStateRejected',
    completed: 'toolStateCompleted',
    failed: 'toolStateFailed',
    cancelled: 'toolStateCancelled',
  }[stateValue];
  return key ? text(key) : stateValue;
}

function eventMessage(event, includeSummary = true) {
  const activity = event.details && event.details.activity;
  const key = {
    queued: 'toolQueued',
    waiting: 'toolWaiting',
    started: 'toolStarted',
    confirmation: 'toolConfirmation',
    confirmed: 'toolConfirmed',
    rejected: 'toolRejected',
    completed: 'toolCompleted',
    failed: 'toolFailed',
    cancelled: 'toolCancelled',
  }[activity];
  if (key) {
    const label = text(key, { tool: toolLabel(event.toolName || event.details.toolName) });
    // Completed/failed projections carry a redacted input summary (command,
    // file path, pattern) — the raw text belongs behind an expander, not
    // inline, so only append it when a caller explicitly asks for it.
    const summary = event.details && event.details.summary;
    return includeSummary && summary ? `${label} · ${summary}` : label;
  }
  return event.message || event.kind || 'event';
}

function compactToolSummary(toolName, raw) {
  const value = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (toolName !== 'ExecCommand') return compactArtifactPath(value);
  let compact = value
    .replace(/\$env:[A-Za-z0-9_]+=[^;]*;\s*/g, '')
    .replace(/cd\s+"[^"]*";\s*/gi, '')
    .replace(/&?\s*"[A-Za-z]:\\[^"]*?loopx\.exe"\s*/gi, 'loopx.exe ')
    .replace(/--format\s+json\s+--registry\s+"[^"]*"/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length > 120) compact = `${compact.slice(0, 117)}…`;
  return compact;
}


function outputKindLabel(kind) {
  if (kind === 'thinking') return text('outputThinking');
  if (kind === 'tool') return text('outputTool');
  if (kind === 'model_round_started' || kind === 'model_round_completed') return text('outputModel');
  return text('outputText');
}

function appendOutputText(existing, next) {
  const value = next == null ? '' : String(next);
  if (!value) return existing;
  return existing ? `${existing}${value}` : value;
}

function outputEventFallbackText(event) {
  if (event.text) return event.text;
  if (event.toolState) return event.toolState;
  if (event.kind === 'model_round_started') return 'Model round started';
  if (event.kind === 'model_round_completed') return 'Model round completed';
  return event.kind || text('outputText');
}

function canMergeOutputEvent(event) {
  return event.kind === 'thinking' || event.kind === 'text';
}

function compactTurnOutputBlocks(rawEvents) {
  // Drop empty chunks and stray marker chunks (for example a thinking chunk
  // whose entire text is the word "thinking") before grouping.
  const events = rawEvents.filter((event) => {
    if (event.kind !== 'thinking' && event.kind !== 'text') return true;
    const value = String(event.text == null ? '' : event.text).trim();
    if (!value) return false;
    return !(event.kind === 'thinking' && value.toLowerCase() === 'thinking');
  });
  const blocks = [];
  events.forEach((event) => {
    const kind = event.kind || 'text';
    const roundId = event.roundId || '';
    const toolName = event.toolName || '';
    const last = blocks[blocks.length - 1];
    const sameToolRun = kind === 'tool'
      && last
      && last.kind === 'tool'
      && last.toolName === toolName
      && last.roundId === roundId
      && last.taskId === event.taskId
      && last.turnId === event.turnId;
    if (
      (canMergeOutputEvent(event)
        && last
        && last.kind === kind
        && last.roundId === roundId
        && last.taskId === event.taskId
        && last.turnId === event.turnId
        && !last.isEnd)
      || sameToolRun
    ) {
      last.endCursor = event.cursor;
      if (kind === 'tool') {
        // Later tool lifecycle events supersede earlier ones: the completed
        // summary describes the same invocation better than the started one.
        if (event.text) last.text = event.text;
        last.toolState = event.toolState || last.toolState;
      } else {
        last.text = appendOutputText(last.text, event.text);
      }
      last.isEnd = Boolean(last.isEnd || event.isEnd);
      last.eventCount += 1;
      return;
    }
    blocks.push({
      startCursor: event.cursor,
      endCursor: event.cursor,
      taskId: event.taskId || '',
      turnId: event.turnId || '',
      kind,
      roundId,
      toolName,
      toolState: event.toolState || '',
      text: outputEventFallbackText(event),
      isEnd: Boolean(event.isEnd),
      eventCount: 1,
    });
  });
  // Fold trivial fragments (sentence tails like a lone period) into the
  // preceding text block of the same turn so they do not become rows.
  const merged = [];
  blocks.forEach((block) => {
    const previous = merged[merged.length - 1];
    if (
      previous
      && block.kind === 'text'
      && previous.kind === 'text'
      && previous.taskId === block.taskId
      && previous.turnId === block.turnId
      && (block.text || '').trim().length <= 3
    ) {
      previous.endCursor = block.endCursor;
      previous.text = appendOutputText(previous.text, block.text);
      previous.isEnd = Boolean(previous.isEnd || block.isEnd);
      previous.eventCount += block.eventCount;
      return;
    }
    merged.push(block);
  });
  return merged;
}

function cursorRangeLabel(block) {
  return block.startCursor === block.endCursor
    ? `#${block.startCursor}`
    : `#${block.startCursor}-${block.endCursor}`;
}

function outputBlockDomKey(block) {
  return `${block.taskId}:${block.turnId}:${block.kind}:${block.startCursor}`;
}

function outputBlockDomVersion(block) {
  return `${block.endCursor}:${block.eventCount}:${block.toolState}:${String(block.text || '').length}`;
}

/// Event-stream icons. Dense glyph fonts rendered inconsistently across
/// platforms, so each row leads with a small stroke icon that says what kind
/// of event it is.
const OUTPUT_ICON_PATHS = {
  // deepseek-harness 0 0 16 16
  thinking: {
    box: '0 0 16 16',
    paths: [
      { d: 'M8.00192 6.64454C8.75026 6.64454 9.35732 7.25169 9.35739 8.00001C9.35739 8.74838 8.7503 9.35548 8.00192 9.35548C7.25367 9.35533 6.64743 8.74829 6.64743 8.00001C6.6475 7.25178 7.25371 6.64468 8.00192 6.64454Z', rule: '' },
      { d: 'M9.97165 1.29981C11.5853 0.718916 13.271 0.642197 14.3144 1.68555C15.3577 2.72902 15.2811 4.41466 14.7002 6.02833C14.4707 6.66561 14.1504 7.32937 13.75 8.00001C14.1504 8.67062 14.4707 9.33444 14.7002 9.97169C15.2811 11.5854 15.3578 13.271 14.3144 14.3145C13.271 15.3579 11.5854 15.2811 9.97165 14.7002C9.3344 14.4708 8.67059 14.1505 7.99997 13.75C7.32933 14.1505 6.66558 14.4708 6.02829 14.7002C4.41461 15.2811 2.72899 15.3578 1.68552 14.3145C0.642155 13.271 0.71887 11.5854 1.29977 9.97169C1.52915 9.33454 1.84865 8.67049 2.24899 8.00001C1.84866 7.32953 1.52915 6.66544 1.29977 6.02833C0.718852 4.41459 0.64207 2.729 1.68552 1.68555C2.72897 0.642112 4.41456 0.718887 6.02829 1.29981C6.66541 1.52918 7.32949 1.8487 7.99997 2.24903C8.67045 1.84869 9.33451 1.52919 9.97165 1.29981ZM12.9404 9.2129C12.4391 9.893 11.8616 10.5681 11.2148 11.2149C10.568 11.8616 9.89296 12.4391 9.21286 12.9404C9.62532 13.1579 10.0271 13.338 10.4121 13.4766C11.9146 14.0174 12.9172 13.8738 13.3955 13.3955C13.8737 12.9173 14.0174 11.9146 13.4765 10.4121C13.3379 10.0271 13.1578 9.62535 12.9404 9.2129ZM3.05856 9.2129C2.84121 9.62523 2.66197 10.0272 2.52341 10.4121C1.98252 11.9146 2.12627 12.9172 2.60446 13.3955C3.08278 13.8737 4.08544 14.0174 5.58786 13.4766C5.97264 13.338 6.37389 13.1577 6.7861 12.9404C6.10624 12.4393 5.43168 11.8614 4.78513 11.2149C4.13823 10.5679 3.55992 9.89313 3.05856 9.2129ZM7.99899 3.792C7.23179 4.31419 6.45306 4.95512 5.70407 5.70411C4.95509 6.45309 4.31415 7.23184 3.79196 7.99903C4.3143 8.76666 4.95471 9.54653 5.70407 10.2959C6.45309 11.0449 7.23271 11.6848 7.99997 12.207C8.76725 11.6848 9.54683 11.0449 10.2959 10.2959C11.0449 9.54686 11.6848 8.76729 12.207 8.00001C11.6848 7.23275 11.0449 6.45312 10.2959 5.70411C9.5465 4.95475 8.76662 4.31434 7.99899 3.792ZM5.58786 2.52344C4.08533 1.98255 3.08272 2.12625 2.60446 2.6045C2.12621 3.08275 1.98252 4.08536 2.52341 5.5879C2.66189 5.97253 2.8414 6.37409 3.05856 6.78614C3.55983 6.10611 4.1384 5.43189 4.78513 4.78516C5.43186 4.13843 6.10606 3.55987 6.7861 3.0586C6.37405 2.84144 5.97249 2.66192 5.58786 2.52344ZM13.3955 2.6045C12.9172 2.12631 11.9146 1.98257 10.4121 2.52344C10.0272 2.66201 9.62519 2.84125 9.21286 3.0586C9.8931 3.55996 10.5679 4.13827 11.2148 4.78516C11.8614 5.43172 12.4392 6.10627 12.9404 6.78614C13.1577 6.37393 13.338 5.97267 13.4765 5.5879C14.0174 4.08549 13.8736 3.08281 13.3955 2.6045Z', rule: 'evenodd' },
    ],
  },
  // deepseek-harness 0 0 16 16
  ExecCommand: {
    box: '0 0 16 16',
    paths: [
      { d: 'M12.3368 1.53569L11.931 4.43172H14.8086V5.79673H11.7404L11.1962 9.67859H14.2839V11.0436H11.0056L10.4994 14.6529L9.14873 14.4643L9.62731 11.0436H5.75876L5.25252 14.6529L3.90186 14.4643L4.38043 11.0436H1.69141V9.67859H4.57104L5.11417 5.79673H2.21609V4.43172H5.30581L5.73724 1.34713L7.08995 1.53569L6.68414 4.43172H10.5527L10.9841 1.34713L12.3368 1.53569ZM5.94937 9.67859H9.81791L10.361 5.79673H6.49353L5.94937 9.67859Z', rule: 'evenodd' },
    ],
  },
  // deepseek-harness 0 0 16 16
  Read: {
    box: '0 0 16 16',
    paths: [
      { d: 'M11.2426 4.80473V6.10551H4.75819V4.80473H11.2426Z', rule: '' },
      { d: 'M9.40858 7.84478V9.14557H4.75819V7.84478H9.40858Z', rule: '' },
      { d: 'M9.23438 0.546389C10.1941 0.546389 10.9683 0.544914 11.5859 0.611819C12.2161 0.680096 12.7634 0.825745 13.2393 1.17139C13.5172 1.3733 13.7619 1.61812 13.9639 1.896C14.3096 2.37183 14.4551 2.91922 14.5234 3.54932C14.5903 4.16686 14.5889 4.94133 14.5889 5.90088V10.0981C14.5889 11.0576 14.5903 11.8321 14.5234 12.4497C14.4552 13.0798 14.3094 13.6272 13.9639 14.103C13.7619 14.381 13.5172 14.6257 13.2393 14.8276C12.7633 15.1734 12.2163 15.3189 11.5859 15.3872C10.9683 15.4541 10.1942 15.4536 9.23438 15.4536H6.76563C5.80591 15.4536 5.03168 15.4541 4.41407 15.3872C3.78385 15.3189 3.23665 15.1734 2.76074 14.8276C2.48291 14.6257 2.23802 14.3809 2.03614 14.103C1.69066 13.6272 1.54483 13.0798 1.47657 12.4497C1.40973 11.8321 1.41114 11.0576 1.41114 10.0981V5.90088C1.41113 4.94132 1.40966 4.16686 1.47657 3.54932C1.54488 2.91921 1.69042 2.37184 2.03614 1.896C2.2381 1.61807 2.4828 1.37333 2.76074 1.17139C3.23665 0.825682 3.78386 0.680109 4.41407 0.611819C5.03168 0.544905 5.80591 0.546389 6.76563 0.546389H9.23438ZM6.76563 1.896C5.77586 1.896 5.0876 1.89738 4.55957 1.95459C4.0443 2.01043 3.76214 2.11349 3.55469 2.26416C3.39135 2.38284 3.24761 2.52662 3.12891 2.68994C2.97821 2.89736 2.8752 3.17967 2.81934 3.69483C2.76214 4.22279 2.76075 4.91131 2.76074 5.90088V10.0981C2.76074 11.0876 2.76221 11.7762 2.81934 12.3042C2.87516 12.8194 2.97829 13.1026 3.12891 13.3101C3.24754 13.4733 3.39147 13.6172 3.55469 13.7358C3.76213 13.8865 4.04438 13.9896 4.55957 14.0454C5.0876 14.1026 5.77586 14.103 6.76563 14.103H9.23438C10.2242 14.103 10.9124 14.1026 11.4404 14.0454C11.9556 13.9896 12.2379 13.8865 12.4453 13.7358C12.6086 13.6172 12.7525 13.4733 12.8711 13.3101C13.0217 13.1026 13.1248 12.8195 13.1807 12.3042C13.2378 11.7762 13.2393 11.0876 13.2393 10.0981V5.90088C13.2393 4.91131 13.2379 4.22279 13.1807 3.69483C13.1248 3.17969 13.0218 2.89736 12.8711 2.68994C12.7524 2.52667 12.6086 2.38281 12.4453 2.26416C12.2379 2.11355 11.9556 2.01041 11.4404 1.95459C10.9124 1.8974 10.2241 1.896 9.23438 1.896H6.76563Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  Write: {
    box: '0 0 16 16',
    paths: [
      { d: 'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  Edit: {
    box: '0 0 16 16',
    paths: [
      { d: 'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  Grep: {
    box: '0 0 16 16',
    paths: [
      { d: 'M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z', rule: '' },
      { d: 'M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  WebSearch: {
    box: '0 0 16 16',
    paths: [
      { d: 'M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z', rule: '' },
      { d: 'M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  LS: {
    box: '0 0 16 16',
    paths: [
      { d: 'M5.19629 1.57104C5.81144 1.5711 6.38623 1.8786 6.72754 2.39038L7.19922 3.09839C7.28454 3.22635 7.42824 3.30344 7.58203 3.30347H12.1699C13.5039 3.30348 14.5859 4.38548 14.5859 5.71948V6.62671C15.2694 7.02689 15.6605 7.85012 15.4385 8.68726L14.3848 12.658C14.1037 13.7164 13.1449 14.4527 12.0498 14.4529H2.91699C1.51651 14.4529 0.451662 13.2814 0.501954 11.9519V3.98706C0.501954 2.65305 1.58396 1.57104 2.91797 1.57104H5.19629ZM3.7793 7.75562C3.30994 7.75562 2.89883 8.07153 2.77832 8.52515L1.91602 11.7722C1.74167 12.4291 2.23734 13.073 2.91699 13.073H12.0498C12.5191 13.0728 12.9304 12.757 13.0508 12.3035L14.1045 8.33374C14.1819 8.04202 13.9619 7.756 13.6602 7.75562H3.7793ZM2.91797 2.9519C2.34625 2.9519 1.88281 3.41534 1.88281 3.98706V7.2937C2.33068 6.7269 3.02249 6.37476 3.7793 6.37476H13.2051V5.71948C13.2051 5.14777 12.7416 4.68434 12.1699 4.68433H7.58203C6.96675 4.6843 6.39209 4.37595 6.05078 3.86401L5.5791 3.15601C5.49379 3.02821 5.34995 2.95196 5.19629 2.9519H2.91797Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 14 14
  WebFetch: {
    box: '0 0 14 14',
    paths: [
      { d: 'M7.00018 0.353516C10.6708 0.353535 13.6468 3.32958 13.6469 7.00018C13.6468 10.6708 10.6708 13.6468 7.00018 13.6469C3.32957 13.6468 0.353535 10.6708 0.353516 7.00018C0.353535 3.32957 3.32957 0.353531 7.00018 0.353516ZM5.44643 7.59661C5.49463 8.97506 5.70762 10.191 6.02136 11.0793C6.20141 11.5891 6.40328 11.9585 6.59898 12.1889C6.79501 12.4196 6.93213 12.454 7.00018 12.454C7.06822 12.454 7.20533 12.4197 7.40138 12.1889C7.59708 11.9585 7.79895 11.589 7.979 11.0793C8.29274 10.191 8.50574 8.97506 8.55394 7.59661H5.44643ZM1.57861 7.59661C1.80785 9.70467 3.2386 11.4509 5.1715 12.1388C5.07135 11.9317 4.97972 11.7098 4.89746 11.477C4.53084 10.4391 4.30224 9.0828 4.25357 7.59661H1.57861ZM9.74679 7.59661C9.69813 9.0828 9.46952 10.4391 9.1029 11.477C9.0206 11.7099 8.92818 11.9316 8.82797 12.1388C10.7613 11.4511 12.1925 9.70496 12.4218 7.59661H9.74679ZM5.1706 1.8616C3.23814 2.54963 1.80876 4.29604 1.5795 6.40376H4.25357C4.30224 4.91756 4.53083 3.56129 4.89746 2.5234C4.97968 2.29066 5.07051 2.0686 5.1706 1.8616ZM7.00018 1.54637C6.93213 1.54638 6.79503 1.5807 6.59898 1.81145C6.40332 2.04177 6.20139 2.41058 6.02136 2.92012C5.70754 3.80851 5.49461 5.02499 5.44643 6.40376H8.55394C8.50575 5.025 8.29282 3.80851 7.979 2.92012C7.79898 2.41059 7.59705 2.04177 7.40138 1.81145C7.20531 1.58067 7.06823 1.54637 7.00018 1.54637ZM8.82887 1.8616C8.92902 2.0687 9.02064 2.29053 9.1029 2.5234C9.46953 3.56129 9.69812 4.91756 9.74679 6.40376H12.4209C12.1916 4.29575 10.7618 2.54943 8.82887 1.8616Z', rule: 'evenodd' },
    ],
  },
  // deepseek-harness 0 0 16 16
  model_round_started: {
    box: '0 0 16 16',
    paths: [
      { d: 'M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z', rule: '' },
      { d: 'M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z', rule: '' },
      { d: 'M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  model_round_completed: {
    box: '0 0 16 16',
    paths: [
      { d: 'M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z', rule: '' },
      { d: 'M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z', rule: '' },
      { d: 'M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z', rule: '' },
    ],
  },
  // deepseek-harness 0 0 16 16
  default: {
    box: '0 0 16 16',
    paths: [
      { d: 'M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z', rule: '' },
      { d: 'M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z', rule: '' },
      { d: 'M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z', rule: '' },
    ],
  },
};

function outputIconElement(entry) {
  // 图标数据来自 deepseek-harness 的图标集（fill 型路径），不再是手绘的描边字形。
  const spec = entry && entry.paths ? entry : OUTPUT_ICON_PATHS.default;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', spec.box || '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  spec.paths.forEach((item) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', item.d);
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke', 'none');
    if (item.rule) path.setAttribute('fill-rule', item.rule);
    svg.append(path);
  });
  return svg;
}

function outputBlockIcon(block) {
  const icon = document.createElement('span');
  icon.className = 'log-icon';
  icon.dataset.icon = block.kind === 'tool' ? 'tool' : block.kind;
  icon.setAttribute('aria-hidden', 'true');
  const key = block.kind === 'tool'
    ? (block.toolName || 'default')
    : (block.kind || 'default');
  icon.append(outputIconElement(OUTPUT_ICON_PATHS[key] || OUTPUT_ICON_PATHS.default));
  return icon;
}

function disclosureChevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('disclosure-chevron');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 4l4 4-4 4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.7');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function outputBlockPreview(block) {
  const source = String(block.text || '').replace(/\s+/g, ' ').trim();
  if (!source) return outputKindLabel(block.kind);
  return source.length > 160 ? `${source.slice(0, 159)}…` : source;
}

function outputBlockIssueNode(block, className) {
  const task = taskForId(block.taskId);
  const item = task && task.identity && task.identity.item;
  const issueUrl = itemUrl(item);
  const issueLabel = item ? compactItemLabel(item) : text('taskNumber', { value: shortId(block.taskId) });
  const issue = issueUrl
    ? externalAnchor(issueLabel, issueUrl, className)
    : document.createElement('span');
  if (!issueUrl) {
    issue.className = className;
    issue.textContent = issueLabel;
  } else {
    issue.title = issueDisplayTitle(task) || itemLabel(item);
  }
  return issue;
}

function outputBlockMetaNodes(block) {
  const nodes = [];
  if (block.roundId) {
    const round = document.createElement('span');
    round.className = 'output-block__meta';
    round.textContent = shortId(block.roundId);
    round.title = block.roundId;
    nodes.push(round);
  }
  if (block.toolState) {
    const status = document.createElement('span');
    status.className = 'output-block__meta';
    status.textContent = toolStateLabel(block.toolState);
    nodes.push(status);
  }
  if (block.eventCount > 1) {
    const chunks = document.createElement('span');
    chunks.className = 'output-block__meta';
    chunks.textContent = text('outputChunks', { value: block.eventCount });
    nodes.push(chunks);
  }
  return nodes;
}

function outputBlockHeader(block) {
  const header = document.createElement('div');
  header.className = 'output-block__header';
  const level = document.createElement('span');
  level.className = 'event-level';
  level.dataset.level = block.toolState === 'failed' ? 'error' : 'info';
  level.textContent = outputKindLabel(block.kind);
  const source = document.createElement('span');
  source.className = 'output-block__source';
  source.textContent = block.toolName ? toolLabel(block.toolName) : eventSourceLabel('agent');
  const cursor = document.createElement('span');
  cursor.className = 'output-block__cursor';
  cursor.textContent = cursorRangeLabel(block);
  header.append(outputBlockIssueNode(block, 'output-block__issue'), level, source, cursor);
  outputBlockMetaNodes(block).forEach((node) => header.append(node));
  return header;
}

/// Streamed assistant text used to stay raw until the block ended, so a run in
/// progress displayed literal `##`, `**` and fence markers (observed live).
/// Re-rendering per chunk is safe now that the row is patched in place rather
/// than rebuilt.
function outputBlockMarkdownEnabled(block) {
  return block.kind === 'text';
}

function outputBlockMessage(block) {
  const message = document.createElement('div');
  message.className = 'output-block__message';
  patchOutputBlockMessage(message, block);
  return message;
}

function patchOutputBlockMessage(message, block) {
  const blockText = String(block.text || '');
  const source = blockText || outputKindLabel(block.kind);
  if (outputBlockMarkdownEnabled(block)) {
    if (!message.classList.contains('markdown-body')) {
      message.className = 'output-block__message output-block__markdown markdown-body';
      message.replaceChildren();
      delete message.dataset.renderedText;
    }
    if (message.dataset.renderedText !== source) {
      message.dataset.renderedText = source;
      renderMarkdown(message, source, itemUrl((taskForId(block.taskId) || {}).identity?.item));
    }
  } else {
    if (message.classList.contains('markdown-body')) {
      message.className = 'output-block__message';
      message.replaceChildren();
      delete message.dataset.renderedText;
    }
    if (message.textContent !== source) message.textContent = source;
  }
  if (blockText.length > LONG_OUTPUT_BLOCK_CHARS) message.classList.add('output-block__message--long');
  else message.classList.remove('output-block__message--long');
}

/// Thinking and tool blocks are developer telemetry: one line by default,
/// expanding to the raw payload. That keeps a long stream scannable, which is
/// what the harness-style event list the owner asked for requires.
function outputBlockDisclosure(block) {
  const details = document.createElement('details');
  details.className = 'output-block__disclosure';
  const store = block.kind === 'thinking' ? state.expandedThinking : state.expandedTool;
  const blockKey = outputBlockDomKey(block);
  const head = document.createElement('summary');
  head.className = 'output-block__disclosure-head';
  const kind = document.createElement('span');
  kind.className = 'output-block__source';
  kind.textContent = block.toolName ? toolLabel(block.toolName) : outputKindLabel(block.kind);
  const preview = document.createElement('span');
  preview.className = 'output-block__preview';
  preview.textContent = outputBlockPreview(block);
  const cursor = document.createElement('span');
  cursor.className = 'output-block__cursor';
  cursor.textContent = cursorRangeLabel(block);
  head.append(outputBlockIcon(block), kind, preview, cursor);
  outputBlockMetaNodes(block).forEach((node) => head.append(node));
  head.append(disclosureChevron());
  const body = document.createElement('div');
  body.className = 'output-block__disclosure-body';
  body.append(outputBlockIssueNode(block, 'output-block__issue'), outputBlockMessage(block));
  details.append(head, body);
  if (store.has(blockKey)) details.open = true;
  details.addEventListener('toggle', () => {
    if (details.open) {
      store.add(blockKey);
      pauseFollowForReading();
      const anchor = captureLogAnchor();
      requestAnimationFrame(() => restoreLogAnchor(anchor));
    } else {
      store.delete(blockKey);
    }
  });
  return details;
}

function turnOutputBlockRow(block) {
  const row = document.createElement('li');
  row.className = 'log-row turn-output-row';
  row.dataset.kind = block.kind;
  row.dataset.level = block.toolState === 'failed' ? 'error' : 'info';
  row.dataset.cursor = String(block.endCursor);
  row.dataset.taskId = block.taskId;
  row.dataset.blockKey = outputBlockDomKey(block);
  row.dataset.blockVersion = outputBlockDomVersion(block);
  if (block.kind === 'thinking' || block.kind === 'tool') {
    row.append(outputBlockDisclosure(block));
  } else {
    row.append(outputBlockHeader(block), outputBlockMessage(block));
  }
  return row;
}

/// Streaming regrows a block on every chunk. Rebuilding the <li> each time
/// dropped the pointer's :hover state and shifted the scroll position under
/// the reader (both observed live), so an existing row is patched in place and
/// the row element itself is never replaced.
function updateTurnOutputBlockRow(row, block) {
  const version = outputBlockDomVersion(block);
  if (row.dataset.blockVersion === version) return;
  row.dataset.blockVersion = version;
  row.dataset.level = block.toolState === 'failed' ? 'error' : 'info';
  row.dataset.cursor = String(block.endCursor);

  const disclosure = row.querySelector('.output-block__disclosure');
  if (disclosure) {
    const head = disclosure.querySelector('.output-block__disclosure-head');
    if (head) {
      const preview = head.querySelector('.output-block__preview');
      const previewText = outputBlockPreview(block);
      if (preview && preview.textContent !== previewText) preview.textContent = previewText;
      const kind = head.querySelector('.output-block__source');
      const kindText = block.toolName ? toolLabel(block.toolName) : outputKindLabel(block.kind);
      if (kind && kind.textContent !== kindText) kind.textContent = kindText;
      const cursor = head.querySelector('.output-block__cursor');
      const cursorText = cursorRangeLabel(block);
      if (cursor && cursor.textContent !== cursorText) cursor.textContent = cursorText;
    }
    const message = disclosure.querySelector('.output-block__message');
    if (message) patchOutputBlockMessage(message, block);
    return;
  }

  const header = row.querySelector('.output-block__header');
  if (header) header.replaceWith(outputBlockHeader(block));
  const message = row.querySelector('.output-block__message');
  if (message) patchOutputBlockMessage(message, block);
  else row.append(outputBlockMessage(block));
}
function timelineMilestoneRow(event) {
  const row = document.createElement('li');
  row.className = 'log-row log-row--milestone';
  row.dataset.level = event.level || 'info';
  row.dataset.important = String(Boolean(event.important));
  row.dataset.eventKey = String(event.cursor);

  const time = document.createElement('time');
  time.className = 'log-time';
  time.dateTime = new Date(normalizeTimestamp(event.occurredAt)).toISOString();
  time.textContent = clockLabel(event.occurredAt);

  const source = document.createElement('span');
  source.className = 'log-source';
  source.textContent = eventSourceLabel(event.source);

  const content = document.createElement('div');
  content.className = 'milestone-row__message';
  const eventDetails = event.details && typeof event.details === 'object' ? event.details : null;
  const toolName = event.toolName || (eventDetails && eventDetails.toolName) || '';
  const activity = eventDetails && eventDetails.activity;
  const rawSummary = eventDetails && eventDetails.summary;
  if (toolName && activity) {
    content.classList.add('milestone-row__message--tool');
    const label = document.createElement('span');
    label.className = 'milestone-row__tool-label';
    label.textContent = eventMessage(event, false);
    content.append(label);
    const compact = compactToolSummary(toolName, rawSummary);
    if (compact) {
      const preview = document.createElement('span');
      preview.className = 'milestone-row__tool-preview';
      preview.textContent = compact;
      preview.title = String(rawSummary || '');
      content.append(preview);
    }
    if (rawSummary) {
      const details = document.createElement('details');
      details.className = 'log-tool-details';
      const detailsKey = `e:${event.cursor}`;
      if (state.expandedLogDetails.has(detailsKey)) details.open = true;
      details.addEventListener('toggle', () => handleLogDetailsToggle(details, detailsKey));
      const detailsSummary = document.createElement('summary');
      detailsSummary.textContent = text('outputToolSummary');
      const pre = document.createElement('pre');
      pre.textContent = String(rawSummary);
      details.append(detailsSummary, pre);
      content.append(details);
    }
  } else {
    content.textContent = eventMessage(event);
  }

  row.append(time, source, content);
  return row;
}

function taskStageCardRunning(task) {
  if (!task || isExternalWait(task)) return false;
  return ['queued', 'preparing', 'running', 'cancelling'].includes(task.state)
    || task.phase === 'preparing_workspace';
}

function ensureStageCardTicker() {
  if (state.stageCardTicker) return;
  state.stageCardTicker = window.setInterval(() => {
    document.querySelectorAll('.timeline-stage-card__elapsed[data-since]').forEach((node) => {
      const since = Number(node.dataset.since || 0);
      if (!Number.isFinite(since) || since <= 0) return;
      node.textContent = text('preparingElapsed', {
        duration: durationLabel(Date.now() - since),
      });
    });
  }, 1000);
}

function timelineStageCard(task) {
  const item = task && task.identity && task.identity.item;
  const card = document.createElement('div');
  card.className = 'timeline-stage-card';
  if (!task) {
    const message = document.createElement('p');
    message.textContent = text('noLogs');
    card.append(message);
    return card;
  }
  const running = taskStageCardRunning(task);
  if (running) {
    card.dataset.running = 'true';
    const spinner = document.createElement('span');
    spinner.className = 'timeline-stage-card__spinner';
    spinner.setAttribute('aria-hidden', 'true');
    card.append(spinner);
  }
  const heading = document.createElement('strong');
  heading.textContent = task && task.state === 'queued' && isMonitorTodo(task)
    ? text('monitor_phase_queued')
    : taskPhaseLabel(task);
  card.append(heading);
  const detail = document.createElement('p');
  const taskEvents = progressTaskEvents(task);
  if (task.state === 'queued') {
    detail.textContent = isMonitorTodo(task) ? monitorWaitDetail(task) : latestTaskWaitReason(task);
  } else if (task.phase === 'preparing_workspace') {
    const since = task.updatedAt ? normalizeTimestamp(task.updatedAt) : 0;
    if (since) {
      const elapsed = document.createElement('span');
      elapsed.className = 'timeline-stage-card__elapsed';
      elapsed.dataset.since = String(since);
      elapsed.textContent = text('preparingElapsed', {
        duration: durationLabel(Date.now() - since),
      });
      detail.append(
        elapsed,
        document.createTextNode(` · ${text('worktreeQuiet', { item: compactItemLabel(item) })}`),
      );
      if (running) ensureStageCardTicker();
    } else {
      detail.textContent = text('worktreeQuiet', { item: compactItemLabel(item) });
    }
  } else if (task.state === 'running' && task.phase === 'agent_running') {
    detail.textContent = text('awaitingFirstOutput');
  } else if (isExternalWait(task)) {
    const waitMessage = String(task.pendingGateMessage || '').trim();
    detail.textContent = externalWaitPresentation(
      waitMessage,
      taskPullRequestLinks(task, waitMessage),
    );
  } else if (task.state === 'waiting_for_user') {
    detail.textContent = text('decisionCardGateHint');
  } else {
    detail.textContent = currentProgressDetail(task, taskEvents);
  }
  card.append(detail);
  return card;
}
/// The reader's place in the stream must survive re-renders. The scroller is
/// position:relative, so a row's offsetTop is stable in its coordinate space:
/// remember the first visible row plus its offset, then put it back after the
/// list has been reordered. Without this, new output shoved the row being read
/// off screen even though follow-mode was already off.
function pauseFollowForReading() {
  state.followLogs = false;
  if (view && view.newEvents) view.newEvents.hidden = false;
}

function logRowAnchorKey(node) {
  if (!node || !node.dataset) return '';
  return node.dataset.blockKey || node.dataset.toolRunKey || node.dataset.eventKey || '';
}

function findLogRowByAnchorKey(key) {
  if (!key || !view || !view.logList) return null;
  return [...view.logList.children].find((row) => logRowAnchorKey(row) === key) || null;
}

function handleLogDetailsToggle(details, key) {
  if (details.open) {
    state.expandedLogDetails.add(key);
    pauseFollowForReading();
    const anchor = captureLogAnchor();
    requestAnimationFrame(() => restoreLogAnchor(anchor));
  } else {
    state.expandedLogDetails.delete(key);
  }
}

function captureLogAnchor() {
  const scroller = view.logScroll;
  if (!scroller) return null;
  const scrollTop = scroller.scrollTop;
  const node = [...view.logList.children]
    .find((row) => row.offsetTop + row.offsetHeight > scrollTop);
  if (!node) return null;
  return { node, key: logRowAnchorKey(node), offset: node.offsetTop - scrollTop };
}

function restoreLogAnchor(anchor) {
  if (!anchor) return;
  const node = anchor.node && anchor.node.isConnected
    ? anchor.node
    : findLogRowByAnchorKey(anchor.key);
  if (!node) return;
  const scroller = view.logScroll;
  if (!scroller) return;
  const next = node.offsetTop - anchor.offset;
  if (Math.abs(scroller.scrollTop - next) > 1) scroller.scrollTop = next;
}

function timelineToolRunGroupKey(event) {
  const details = event.details && typeof event.details === 'object' ? event.details : null;
  if (!details || !details.toolName || !details.activity) return '';
  const toolId = details.toolId
    ? String(details.toolId)
    : `${details.toolName}:${details.summary || ''}`;
  const generation = event.generation == null ? '' : String(event.generation);
  return `${event.taskId || ''}:${generation}:${toolId}`;
}

function compactTimelineToolRuns(events) {
  const rows = [];
  const groups = new Map();
  events.forEach((event) => {
    const groupKey = timelineToolRunGroupKey(event);
    if (!groupKey) {
      rows.push({ key: `e:${event.cursor}`, kind: 'milestone', event });
      return;
    }
    const details = event.details;
    const terminal = ['completed', 'failed', 'cancelled', 'rejected'].includes(details.activity);
    let group = groups.get(groupKey);
    if (group && group.terminal) group = null;
    if (!group) {
      group = {
        key: `t:${groupKey}:${event.cursor}`,
        kind: 'toolRun',
        groupKey,
        first: event,
        latest: event,
        events: [],
        terminal: false,
      };
      groups.set(groupKey, group);
      rows.push(group);
    }
    group.events.push(event);
    group.latest = event;
    group.terminal = terminal;
  });
  return rows;
}

function toolRunDetailText(group) {
  return group.events
    .map((event) => {
      const details = event.details && typeof event.details === 'object' ? event.details : {};
      const state = details.activity ? toolStateLabel(details.activity) : '';
      const summary = String(details.summary || '').trim();
      const duration = details.durationMs ? `${details.durationMs} ms` : '';
      return [state, summary, duration].filter(Boolean).join(' · ');
    })
    .filter(Boolean)
    .join('\n');
}

function timelineToolRunRow(group) {
  const row = document.createElement('li');
  row.className = 'log-row log-row--milestone log-row--tool-run';
  row.dataset.toolRunKey = group.key;
  row.dataset.level = group.latest.level || 'info';
  row.dataset.important = String(Boolean(group.latest.important));

  const time = document.createElement('time');
  time.className = 'log-time';
  const source = document.createElement('span');
  source.className = 'log-source';

  const content = document.createElement('div');
  content.className = 'milestone-row__message milestone-row__message--tool';
  const icon = outputBlockIcon({
    kind: 'tool',
    toolName: (group.latest.details && group.latest.details.toolName) || '',
  });
  const label = document.createElement('span');
  label.className = 'milestone-row__tool-label';
  const stateChip = document.createElement('span');
  stateChip.className = 'milestone-row__tool-state';
  const preview = document.createElement('span');
  preview.className = 'milestone-row__tool-preview';
  const details = document.createElement('details');
  details.className = 'log-tool-details';
  const detailsKey = `t:${group.key}`;
  if (state.expandedLogDetails.has(detailsKey)) details.open = true;
  details.addEventListener('toggle', () => handleLogDetailsToggle(details, detailsKey));
  const summary = document.createElement('summary');
  summary.textContent = text('outputToolSummary');
  const pre = document.createElement('pre');
  details.append(summary, pre);
  content.append(icon, label, stateChip, preview, details);

  row.append(time, source, content);
  updateTimelineToolRunRow(row, group);
  return row;
}

function updateTimelineToolRunRow(row, group) {
  const event = group.latest;
  const details = event.details && typeof event.details === 'object' ? event.details : {};
  const toolName = String(details.toolName || '');
  const time = row.querySelector('time');
  if (time) {
    time.dateTime = new Date(normalizeTimestamp(group.first.occurredAt)).toISOString();
    time.textContent = clockLabel(group.first.occurredAt);
  }
  const source = row.querySelector('.log-source');
  if (source) source.textContent = eventSourceLabel(event.source);
  const label = row.querySelector('.milestone-row__tool-label');
  if (label) label.textContent = toolLabel(toolName);
  const stateChip = row.querySelector('.milestone-row__tool-state');
  if (stateChip) {
    stateChip.textContent = toolStateLabel(details.activity);
    stateChip.dataset.state = details.activity || '';
  }
  const preview = row.querySelector('.milestone-row__tool-preview');
  if (preview) {
    const compact = compactToolSummary(toolName, details.summary);
    preview.textContent = compact || '';
    preview.title = String(details.summary || '');
    preview.hidden = !compact;
  }
  const pre = row.querySelector('.log-tool-details pre');
  if (pre) pre.textContent = toolRunDetailText(group);
}
function renderTimeline() {
  if (!canRender()) return;
  const running = runningOutputTask();
  if (running) ensureTurnOutputTarget(running);
  const task = displayedTask();

  view.timelineScope.textContent = task
    ? text(state.selectedTaskId ? 'timelineIdleScope' : 'timelineLiveScope', {
      item: compactItemLabel(task.identity && task.identity.item),
    })
    : '';

  // Model-output blocks are keyed per turn; each block group is anchored to
  // its turn so the merged timeline stays in chronological order. Durable
  // milestone events (scheduler/engine heartbeats) are intentionally not
  // rendered: the issue summary and decision card cover that information.
  const taskBlocks = task
    ? compactTurnOutputBlocks(state.outputHistory.filter((event) => event.taskId === task.taskId))
    : [];
  const visibleBlocks = taskBlocks.slice(-MAX_RENDERED_OUTPUT_BLOCKS);
  const blockGroups = [];
  visibleBlocks.forEach((block) => {
    const last = blockGroups[blockGroups.length - 1];
    if (last && last.turnId === block.turnId) last.blocks.push(block);
    else blockGroups.push({ turnId: block.turnId, blocks: [block] });
  });

  const rows = [];
  if (visibleBlocks.length === 0) {
    // No live output captured for this task: fall back to the durable
    // tool-activity log so the timeline is not blank for older turns.
    const toolEvents = task
      ? state.events.filter((event) => (
        event.taskId === task.taskId
        && event.kind === 'log'
        && (event.generation == null || Number(event.generation) === Number(task.generation))
      ))
      : [];
    compactTimelineToolRuns(toolEvents).forEach((row) => rows.push(row));
  } else {
    blockGroups.forEach((group) => {
      group.blocks.forEach((block) => rows.push({ key: `b:${outputBlockDomKey(block)}`, kind: 'block', block }));
    });
  }
  const visibleRows = rows.slice(-MAX_RENDERED_OUTPUT_BLOCKS);

  const existingBlocks = new Map(
    [...view.logList.children]
      .filter((node) => node.dataset && node.dataset.blockKey)
      .map((node) => [node.dataset.blockKey, node]),
  );
  const existingEvents = new Map(
    [...view.logList.children]
      .filter((node) => node.dataset && node.dataset.eventKey)
      .map((node) => [node.dataset.eventKey, node]),
  );
  const existingToolRuns = new Map(
    [...view.logList.children]
      .filter((node) => node.dataset && node.dataset.toolRunKey)
      .map((node) => [node.dataset.toolRunKey, node]),
  );
  const desired = visibleRows.map((row) => {
    if (row.kind === 'block') {
      const node = existingBlocks.get(row.key);
      if (!node) return turnOutputBlockRow(row.block);
      updateTurnOutputBlockRow(node, row.block);
      return node;
    }
    if (row.kind === 'toolRun') {
      const node = existingToolRuns.get(row.key);
      if (!node) return timelineToolRunRow(row);
      updateTimelineToolRunRow(node, row);
      return node;
    }
    const node = existingEvents.get(row.key);
    return node || timelineMilestoneRow(row.event);
  });
  const logAnchor = state.followLogs ? null : captureLogAnchor();
  desired.forEach((node, index) => {
    const current = view.logList.children[index];
    if (current !== node) view.logList.insertBefore(node, current || null);
  });
  const desiredNodes = new Set(desired);
  [...view.logList.children].forEach((node) => {
    if (!desiredNodes.has(node)) node.remove();
  });

  const hasRows = visibleRows.length !== 0;
  view.logEmpty.hidden = hasRows;
  if (!hasRows) {
    view.logEmptyText.textContent = state.turnOutput.message || text('noLiveOutput');
    const stageCard = timelineStageCard(task);
    view.logEmpty.querySelector('svg').hidden = Boolean(task);
    const previousCard = view.logEmpty.querySelector('.timeline-stage-card');
    if (previousCard) previousCard.remove();
    if (task) view.logEmpty.append(stageCard);
  }
  if (state.followLogs) {
    requestAnimationFrame(() => {
      view.logScroll.scrollTop = view.logScroll.scrollHeight;
      view.newEvents.hidden = true;
    });
  } else {
    restoreLogAnchor(logAnchor);
    if (visibleRows.length) view.newEvents.hidden = false;
  }
  if (running && !state.turnOutput.inFlight && !state.turnOutput.timer) {
    scheduleTurnOutputPoll(state.turnOutput.events.length ? 1200 : 0);
  }
}

function renderLogs() {
  renderTimeline();
}

function renderAll() {
  if (!canRender()) return;
  renderExecutionSupport();
  renderEnvironment();
  renderTasks();
  renderIssueView();
  renderLogs();
}

async function hydrateTaskMetadata(taskId) {
  const task = taskForId(taskId);
  const item = task && task.identity && task.identity.item;
  if (!item) return;
  const metadataKey = itemKey(item);
  if (state.metadataRequests.has(metadataKey) || state.itemMetadata.has(metadataKey)) return;
  state.metadataRequests.add(metadataKey);
  renderIssueView();
  try {
    const response = await Promise.race([
      app.loopx.resolveIntake({
        input: itemUrl(item),
        modelId: task.modelId || 'auto',
      }),
      new Promise((_resolve, reject) => {
        window.setTimeout(
          () => reject(new Error('metadata timeout')),
          METADATA_HYDRATE_TIMEOUT_MS,
        );
      }),
    ]);
    const candidates = response && response.preview && Array.isArray(response.preview.candidates)
      ? response.preview.candidates
      : [];
    const candidate = candidates.find((entry) => itemKey(entry.key) === metadataKey);
    state.itemMetadata.set(metadataKey, {
      title: candidate && candidate.title ? candidate.title : '',
      description: candidate && candidate.description ? candidate.description : '',
      unavailable: !candidate,
    });
  } catch (_error) {
    state.itemMetadata.set(metadataKey, { unavailable: true });
  } finally {
    state.metadataRequests.delete(metadataKey);
    renderTasks();
    renderIssueView();
  }
}

function selectTask(taskId) {
  const changed = state.selectedTaskId !== (taskId || null);
  state.selectedTaskId = taskId || null;
  if (changed) view.issueApprovalNote.value = '';
  renderTasks();
  // A panel render exception must never block switching to another task:
  // keep the selection authoritative and surface the panel error on console.
  try {
    renderIssueView();
  } catch (error) {
    console.error('renderIssueView failed:', error);
  }
  try {
    renderTimeline();
  } catch (error) {
    console.error('renderTimeline failed:', error);
  }
  if (taskId) void hydrateTaskMetadata(taskId);
}

function unselectTask() {
  selectTask(null);
}

function focusTaskLogs(taskId) {
  state.followLogs = true;
  selectTask(taskId || null);
  if (!taskId) return;
  window.requestAnimationFrame(() => {
    view.issueWorkspace.focus({ preventScroll: true });
    view.logScroll.scrollTop = view.logScroll.scrollHeight;
  });
}

function factValue(value, fallback = '--') {
  return value == null || value === '' ? fallback : String(value);
}

function renderPreview(preview) {
  state.preview = preview;
  const repository = preview.repository || {};
  view.intakeDialogTitle.textContent = repositoryLabel(repository);
  view.previewRepository.textContent = repositoryLabel(repository);
  view.previewWorkspace.textContent = preview.workspace && preview.workspace.path
    ? preview.workspace.path
    : text(`workspace_${(preview.workspace && preview.workspace.disposition) || 'unavailable'}`);
  view.previewModel.textContent = factValue(preview.model && preview.model.modelId, view.modelSelect.value);
  view.previewImages.textContent = preview.model && preview.model.supportsImages
    ? text('supported')
    : text('unsupported');

  const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
  const candidateFragment = document.createDocumentFragment();
  candidates.forEach((candidate) => {
    const label = document.createElement('label');
    label.className = 'candidate-item';
    label.dataset.state = candidate.state || 'unknown';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'candidate';
    input.value = itemKey(candidate.key);
    const resolved = candidate.state === 'closed' || candidate.state === 'merged';
    input.disabled = resolved;
    input.checked = !resolved && candidate.defaultSelected === true;
    input.addEventListener('change', updateCreateButton);

    const copy = document.createElement('span');
    copy.className = 'candidate-copy';
    const title = document.createElement('strong');
    title.textContent = candidate.title || itemLabel(candidate.key);
    const meta = document.createElement('small');
    meta.textContent = candidate.fromRepository
      ? `${itemLabel(candidate.key)} · ${text('fromRepository')}`
      : itemLabel(candidate.key);
    copy.append(title, meta);

    const itemState = document.createElement('span');
    itemState.className = 'candidate-state';
    itemState.textContent = resolved ? text('resolvedItem') : text('openItem');
    label.append(input, copy, itemState);
    candidateFragment.append(label);
  });
  view.candidateList.replaceChildren(candidateFragment);

  const scopes = Array.isArray(preview.permissionScopes) ? preview.permissionScopes : [];
  const permissionFragment = document.createDocumentFragment();
  scopes.forEach((scope) => {
    const highRisk = HIGH_RISK_SCOPES.has(scope);
    const label = document.createElement('label');
    label.className = 'permission-item';
    label.dataset.risk = highRisk ? 'high' : 'standard';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'permission';
    input.value = scope;
    input.checked = !highRisk;
    input.addEventListener('change', updateCreateButton);
    const copy = document.createElement('span');
    copy.className = 'permission-copy';
    const title = document.createElement('strong');
    title.textContent = scopeLabel(scope);
    const detail = document.createElement('small');
    detail.textContent = highRisk ? text('scopeHighRisk') : text('scopeStandard');
    copy.append(title, detail);
    const risk = document.createElement('span');
    risk.className = 'candidate-state';
    risk.textContent = highRisk ? '!' : '';
    label.append(input, copy, risk);
    permissionFragment.append(label);
  });
  view.permissionList.replaceChildren(permissionFragment);

  updateCreateButton();
}

function renderIntakeWarnings() {
  const preview = state.preview;
  if (!preview) return;
  const candidates = Array.isArray(preview.candidates) ? preview.candidates : [];
  const selectedCount = selectedPreviewItems().length;
  const warnings = [];
  if (selectedCount > 1) warnings.push(text('batchSelection', { value: selectedCount }));
  if (preview.truncated) warnings.push(text('truncatedCandidates'));
  if (
    candidates.some((candidate) => candidate.hasImages)
    && preview.model
    && !preview.model.supportsImages
  ) warnings.push(text('imageWarning'));
  if (preview.model && preview.model.available === false) {
    warnings.push(preview.model.detail || text('modelUnavailable'));
  }
  if (preview.workspace && preview.workspace.disposition === 'unavailable') {
    warnings.push(preview.workspace.detail || text('workspaceUnavailable'));
  }
  if (!allRequiredPermissionScopesSelected()) warnings.push(text('selectPermissions'));
  view.intakeWarning.hidden = warnings.length === 0;
  view.intakeWarning.textContent = warnings.join(' ');
}

function selectedPreviewItems() {
  if (!state.preview) return [];
  const selectedKeys = new Set(
    [...view.candidateList.querySelectorAll('input[name="candidate"]:checked')]
      .map((input) => input.value),
  );
  return (state.preview.candidates || [])
    .filter((candidate) => selectedKeys.has(itemKey(candidate.key)))
    .map((candidate) => candidate.key);
}

function selectedPermissionScopes() {
  return [...view.permissionList.querySelectorAll('input[name="permission"]:checked')]
    .map((input) => input.value);
}

function allRequiredPermissionScopesSelected() {
  const required = state.preview && Array.isArray(state.preview.permissionScopes)
    ? state.preview.permissionScopes
    : [];
  const selected = new Set(selectedPermissionScopes());
  return required.length > 0 && required.every((scope) => selected.has(scope));
}

function syncSelectAll() {
  const selectAll = view.candidateSelectAll;
  if (!selectAll) return;
  const enabled = [...view.candidateList.querySelectorAll('input[name="candidate"]:not(:disabled)')];
  const checked = [...view.candidateList.querySelectorAll('input[name="candidate"]:checked')];
  selectAll.checked = enabled.length > 0 && checked.length === enabled.length;
  selectAll.indeterminate = checked.length > 0 && checked.length < enabled.length;
}

function updateCreateButton() {
  const itemCount = selectedPreviewItems().length;
  const candidateCount = state.preview && Array.isArray(state.preview.candidates)
    ? state.preview.candidates.length
    : 0;
  const previewReady = Boolean(state.preview)
    && (!state.preview.model || state.preview.model.available !== false)
    && (!state.preview.workspace || state.preview.workspace.disposition !== 'unavailable');
  view.createButton.disabled = itemCount === 0 || !previewReady || !allRequiredPermissionScopesSelected();
  view.createButton.textContent = itemCount > 1
    ? `${text('createTasks')} (${itemCount})`
    : text('createTasks');
  view.candidateCount.textContent = text('selectedCandidates', {
    selected: itemCount,
    total: candidateCount,
  });
  syncSelectAll();
  renderIntakeWarnings();
}

async function loadModelCatalog() {
  const select = view.modelSelect;
  if (!select || select.tagName !== 'SELECT') return;
  if (!app || !app.loopx || typeof app.loopx.listModels !== 'function') return;
  if (state.modelCatalogLoading) return;
  if (state.modelCatalogLoaded && select.options.length > 1) return;
  state.modelCatalogLoading = true;
  select.dataset.loading = 'true';
  const loadingAutoOption = [...select.options].find((option) => option.value === 'auto');
  if (!state.modelCatalogLoaded && loadingAutoOption) {
    loadingAutoOption.textContent = text('modelLoading');
  }
  try {
    const models = await app.loopx.listModels();
    const current = currentModelSelection();
    select.replaceChildren();
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = text('modelAuto');
    auto.selected = current === 'auto';
    select.appendChild(auto);
    let selectedExists = current === 'auto';
    const availableModels = Array.isArray(models) ? models : [];
    let renderedModelCount = 0;
    for (const model of availableModels) {
      if (!model || !model.id) continue;
      const option = document.createElement('option');
      option.value = model.id;
      const tag = model.isDefault === true ? ` · ${text('modelPrimaryTag')}` : '';
      option.textContent = `${describeModelOption(model)}${tag}`;
      option.selected = current === model.id;
      selectedExists = selectedExists || option.selected;
      select.appendChild(option);
      renderedModelCount += 1;
    }
    if (select.options.length === 1) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = text('modelEmpty');
      empty.disabled = true;
      empty.dataset.status = 'empty';
      select.appendChild(empty);
    }
    if (!selectedExists) select.value = 'auto';
    state.modelCatalogLoaded = renderedModelCount > 0;
    select.title = text('modelReloadTitle');
  } catch (error) {
    const current = currentModelSelection();
    [...select.options].forEach((option) => {
      if (option.dataset.status) option.remove();
    });
    if (select.options.length === 0) {
      const auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = text('modelAuto');
      select.appendChild(auto);
    } else {
      const auto = [...select.options].find((option) => option.value === 'auto');
      if (auto) auto.textContent = text('modelAuto');
    }
    if (![...select.options].some((option) => option.dataset.status === 'load-failed')) {
      const failed = document.createElement('option');
      failed.value = '';
      failed.textContent = text('modelLoadFailed');
      failed.disabled = true;
      failed.dataset.status = 'load-failed';
      select.appendChild(failed);
    }
    select.value = current === 'auto' ? 'auto' : select.value;
    select.title = errorMessage(error);
    state.modelCatalogLoaded = false;
  } finally {
    state.modelCatalogLoading = false;
    delete select.dataset.loading;
  }
}

async function resolveIntake() {
  const input = view.intakeInput.value.trim();
  if (!input) {
    view.intakeInput.focus();
    return;
  }
  if (!snapshotSupported()) {
    showNotice(text('intakeUnavailable'), 'error');
    return;
  }
  setButtonBusy(view.resolveButton, true);
  showNotice(text('resolving'));
  try {
    const response = await app.loopx.resolveIntake({
      input,
      modelId: view.modelSelect.value,
    });
    if (!response || !response.preview) throw new Error(text('previewExpired'));
    await rememberIntake(input);
    renderPreview(response.preview);
    showNotice('');
    view.intakeDialog.showModal();
  } catch (error) {
    showNotice(errorMessage(error), 'error');
  } finally {
    setButtonBusy(view.resolveButton, false);
  }
}

function outcomeMessage(outcome) {
  if (outcome && outcome.message) return outcome.message;
  const kind = outcome && outcome.kind;
  if (kind === 'created') return text('taskCreated');
  if (kind === 'opened_existing') return text('openedExisting');
  if (kind === 'closed_noop') return text('closedNoop');
  if (kind === 'needs_live_verification') return text('liveVerification');
  if (kind === 'retry_confirmation_required') return text('retryRequired');
  return kind || text('taskCreated');
}

function summarizeOutcomes(outcomes) {
  const createdCount = outcomes.filter((outcome) => outcome.kind === 'created').length;
  const messages = [];
  if (createdCount === 1) messages.push(text('taskCreated'));
  if (createdCount > 1) messages.push(text('tasksCreated', { value: createdCount }));

  const grouped = new Map();
  outcomes
    .filter((outcome) => outcome.kind !== 'created')
    .forEach((outcome) => {
      const message = outcomeMessage(outcome);
      grouped.set(message, (grouped.get(message) || 0) + 1);
    });
  grouped.forEach((count, message) => {
    messages.push(count === 1 ? message : text('outcomeCount', { message, value: count }));
  });
  return messages;
}

async function createTasks(retryTerminal) {
  if (!state.preview) {
    showNotice(text('previewExpired'), 'error');
    return;
  }
  const selectedItems = selectedPreviewItems();
  if (!selectedItems.length) {
    view.intakeWarning.hidden = false;
    view.intakeWarning.textContent = text('selectAtLeastOne');
    return;
  }
  const grantedScopes = selectedPermissionScopes();
  if (!allRequiredPermissionScopesSelected()) {
    view.intakeWarning.hidden = false;
    view.intakeWarning.textContent = text('selectPermissions');
    return;
  }
  const createRequest = {
    clientRequestId: requestId(),
    previewFingerprint: state.preview.fingerprint,
    selectedItems,
    modelId: state.preview.model && state.preview.model.modelId
      ? state.preview.model.modelId
      : view.modelSelect.value,
    grantedScopes,
    retryTerminal: Boolean(retryTerminal),
  };
  state.pendingCreate = createRequest;
  view.createButton.disabled = true;
  view.retryConfirm.disabled = true;
  try {
    const response = await app.loopx.createTask(createRequest);
    const outcomes = response && Array.isArray(response.outcomes) ? response.outcomes : [];
    const retryOutcomes = outcomes.filter((outcome) => outcome.kind === 'retry_confirmation_required');
    if (!retryTerminal && retryOutcomes.length) {
      state.pendingRetry = {
        preview: state.preview,
        itemKeys: new Set(retryOutcomes.map((outcome) => itemKey(outcome.item))),
        scopes: grantedScopes,
      };
      view.retryMessage.textContent = retryOutcomes.map(outcomeMessage).join(' ');
      view.intakeDialog.close();
      view.retryDialog.showModal();
      return;
    }
    const messages = summarizeOutcomes(outcomes);
    const hasError = outcomes.some((outcome) => outcome.kind === 'needs_live_verification');
    showNotice(messages.join(' '), hasError ? 'error' : 'neutral');
    view.intakeDialog.close();
    view.retryDialog.close();
    state.preview = null;
    state.pendingRetry = null;
    await attachSnapshot(false);
    const outcomeTaskIds = outcomes
      .filter((outcome) => outcome.taskId && ['created', 'opened_existing'].includes(outcome.kind))
      .map((outcome) => outcome.taskId);
    const focusedTaskId = sortedTaskList(
      ((state.snapshot && state.snapshot.tasks) || [])
        .filter((task) => outcomeTaskIds.includes(task.taskId)),
    )[0]?.taskId || outcomeTaskIds[0];
    focusTaskLogs(focusedTaskId || null);
  } catch (error) {
    showNotice(errorMessage(error), 'error');
  } finally {
    state.pendingCreate = null;
    view.retryConfirm.disabled = false;
    updateCreateButton();
  }
}

async function confirmRetry() {
  const pending = state.pendingRetry;
  if (!pending || !state.preview) {
    view.retryDialog.close();
    showNotice(text('previewExpired'), 'error');
    return;
  }
  view.candidateList.querySelectorAll('input[name="candidate"]').forEach((input) => {
    input.checked = pending.itemKeys.has(input.value);
  });
  await createTasks(true);
}

function openResetLoopxDialog() {
  const tasks = state.snapshot && Array.isArray(state.snapshot.tasks)
    ? state.snapshot.tasks.length
    : 0;
  view.resetLoopxMessage.textContent = text('resetLoopxMessage', {
    tasks,
    events: state.events.length,
  });
  view.resetLoopxDialog.showModal();
}

async function suiteAction(action) {
  if (!state.snapshot || state.suitePending) return;
  state.suitePending = true;
  const button = action.startsWith('pause') ? view.pauseAllLoopx : view.resumeAllLoopx;
  setButtonBusy(button, true);
  view.root.setAttribute('aria-busy', 'true');
  try {
    const response = await app.loopx.action({
      action,
      clientRequestId: requestId(),
      expectedRevision: Number((state.snapshot && state.snapshot.revision) || 0),
    });
    showNotice(
      response && response.message ? response.message : text(action.startsWith('pause') ? 'pauseAll' : 'resumeAll'),
      'success'
    );
  } catch (error) {
    showNotice(errorMessage(error), 'error');
  } finally {
    setButtonBusy(button, false);
    view.root.setAttribute('aria-busy', 'false');
    state.suitePending = false;
    await attachSnapshot(false);
  }
}

async function resetLoopx() {
  if (!state.snapshot || state.resetPending) return;
  state.resetPending = true;
  setButtonBusy(view.resetLoopx, true);
  view.resetLoopxConfirm.disabled = true;
  view.resetLoopxDialog.close();
  view.root.setAttribute('aria-busy', 'true');
  showNotice(text('resettingLoopxBackground'));
  renderExecutionSupport();
  try {
    const clientRequestId = requestId();
    await attachSnapshot(false);
    view.root.setAttribute('aria-busy', 'true');
    let request = {
      action: 'reset_all',
      clientRequestId,
      expectedRevision: Number((state.snapshot && state.snapshot.revision) || 0),
    };
    let response = await app.loopx.action(request);
    for (let attempt = 0; attempt < 2 && response && response.status === 'revision_conflict'; attempt += 1) {
      await attachSnapshot(false);
      const nextRevision = Number(response.currentRevision || (state.snapshot && state.snapshot.revision) || 0);
      if (!Number.isSafeInteger(nextRevision) || nextRevision === request.expectedRevision) break;
      request = { ...request, expectedRevision: nextRevision };
      response = await app.loopx.action(request);
    }
    if (response && response.status === 'revision_conflict') {
      showNotice(response.message || text('revisionConflict'), 'error');
    } else if (response && response.status === 'rejected') {
      showNotice(response.message || text('actionRejected'), 'error');
    } else {
      clearRunUiState();
      const deferredCleanup = Boolean(
        response
        && response.message
        && response.message.includes('cleanup is still running'),
      );
      showNotice(text(deferredCleanup ? 'resetLoopxDeferred' : 'resetLoopxApplied'), deferredCleanup ? 'warning' : 'success');
    }
    await attachSnapshot(false);
  } catch (error) {
    showNotice(errorMessage(error), 'error');
    await attachSnapshot(false);
  } finally {
    state.resetPending = false;
    setButtonBusy(view.resetLoopx, false);
    view.resetLoopxConfirm.disabled = false;
    view.root.setAttribute('aria-busy', 'false');
    renderExecutionSupport();
  }
}

function openRepositoryResumeDialog() {
  const target = state.repositoryResumeTarget;
  if (!target || !target.tasks.length) {
    showNotice(text('resumeTargetMissing'), 'error');
    return;
  }
  const table = COPY[localeId()] || COPY['en-US'];
  const fallback = COPY['en-US'];
  const reasons = [];
  target.tasks.forEach((task) => {
    if (!task.recoveryReason) return;
    const key = `recoveryReason${String(task.recoveryReason).split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}`;
    const label = table[key] || fallback[key];
    if (label && !reasons.includes(label)) reasons.push(label);
  });
  view.repositoryResumeMessage.textContent = text('resumeRepositoryMessage', {
    repository: repositoryLabel(target.repository),
    value: target.tasks.length,
  });
  if (reasons.length) {
    const reasonLine = document.createElement('small');
    reasonLine.className = 'dialog-reasons';
    const separator = localeId().startsWith('zh') ? '；' : '; ';
    reasonLine.textContent = reasons.join(separator);
    view.repositoryResumeMessage.append(document.createElement('br'), reasonLine);
  }
  view.repositoryResumeDialog.showModal();
}

async function resumeRepository() {
  const target = state.repositoryResumeTarget;
  if (!target || !target.tasks.length || !state.snapshot) {
    showNotice(text('resumeTargetMissing'), 'error');
    view.repositoryResumeDialog.close();
    return;
  }
  const count = target.tasks.length;
  state.repositoryResumePending = true;
  renderRepositoryActions(state.snapshot.tasks || []);
  view.repositoryResumeConfirm.disabled = true;
  try {
    const response = await app.loopx.action({
      action: 'resume_repository',
      repository: target.repository,
      clientRequestId: requestId(),
      expectedRevision: Number(state.snapshot.revision || 0),
    });
    if (response && response.status === 'revision_conflict') {
      showNotice(response.message || text('revisionConflict'), 'error');
    } else if (response && response.status === 'rejected') {
      showNotice(response.message || text('actionRejected'), 'error');
    } else {
      showNotice(text('resumeRepositoryApplied', { value: count }), 'success');
    }
    view.repositoryResumeDialog.close();
    await attachSnapshot(false);
  } catch (error) {
    showNotice(errorMessage(error), 'error');
    await attachSnapshot(false);
  } finally {
    state.repositoryResumePending = false;
    view.repositoryResumeConfirm.disabled = false;
    const tasks = state.snapshot && Array.isArray(state.snapshot.tasks)
      ? state.snapshot.tasks
      : [];
    renderRepositoryActions(tasks);
  }
}

function mergeActionTask(response) {
  if (!response || !response.task || !state.snapshot) return;
  const index = state.snapshot.tasks.findIndex((item) => item.taskId === response.task.taskId);
  if (index >= 0) state.snapshot.tasks.splice(index, 1, response.task);
  else state.snapshot.tasks.push(response.task);
  state.snapshot.revision = Math.max(
    Number(state.snapshot.revision || 0),
    Number(response.currentRevision || 0),
    Number(response.task.revision || 0),
  );
}

function latestActionRevision(response, fallback) {
  const taskRevision = Number(response && response.task && response.task.revision);
  if (Number.isSafeInteger(taskRevision)) return taskRevision;
  const currentRevision = Number(response && response.currentRevision);
  return Number.isSafeInteger(currentRevision) ? currentRevision : fallback;
}

async function sendActionRequest(request) {
  const response = await app.loopx.action(request);
  mergeActionTask(response);
  return response;
}

function gateAppliedPresentation(extra) {
  if (!extra) return null;
  if (extra.presentation) return extra.presentation;
  const gateId = extra.gateId;
  if (gateId && state.gateAppliedPresentations && state.gateAppliedPresentations.has(gateId)) {
    return state.gateAppliedPresentations.get(gateId);
  }
  return null;
}

const ACTION_APPLIED_TEXT_KEY = {
  resume: 'actionAppliedResume',
  restore: 'actionAppliedRestore',
  pause: 'actionAppliedPause',
  abort: 'actionAppliedAbort',
  archive: 'actionAppliedArchive',
  retry_environment: 'actionAppliedRetry',
};

function actionAppliedNotice(action, task, extra, response) {
  // 提交前先把审批说明缓存下来：宿主在批准瞬间就会清掉 pendingGateId，
  // 之后再查 latestGate() 已经查不到，旧代码因此回退成英文原文或「操作已应用。」。
  const presentation = gateAppliedPresentation(extra);
  if (action === 'approve' && task && presentation) {
    if (presentation.kind === 'publish_comment') {
      const item = task.identity && task.identity.item;
      return text('approvalAppliedComment', { item: compactItemLabel(item) || '--' });
    }
    if (presentation.summaryDetail) {
      return text('approvalAppliedGenericDetail', { detail: presentation.summaryDetail });
    }
    if (presentation.kind === 'publish') return text('approvalAppliedPublish');
    return text('approvalAppliedGeneric', { title: presentation.title });
  }
  if (action === 'reject' && task) return text('approvalRejectedNotice');
  const actionKey = ACTION_APPLIED_TEXT_KEY[action];
  if (actionKey) {
    const item = task && task.identity && task.identity.item;
    const label = compactItemLabel(item) || (task ? issueDisplayTitle(task) : '') || '--';
    return text(actionKey, { item: label });
  }
  const raw = stripPriorityPrefix(response && response.message);
  // 宿主回执是英文内部句子（Approval applied; ... [P1] ...）时不再回显，
  // 只接受已经本地化（含中文）的宿主文案。
  if (raw && /[\u3400-\u9fff]/.test(raw)) return raw;
  return text('actionApplied');
}
async function performAction(action, task, extra = {}) {
  if (!snapshotSupported()) {
    showNotice(text('intakeUnavailable'), 'error');
    return false;
  }
  const expectedRevision = task
    ? Number(task.revision || 0)
    : Number((state.snapshot && state.snapshot.revision) || 0);
  const request = {
    action,
    clientRequestId: extra.clientRequestId || requestId(),
    expectedRevision,
    ...(task ? { taskId: task.taskId } : {}),
    ...(extra.gateId ? { gateId: extra.gateId } : {}),
    ...(extra.note ? { note: extra.note } : {}),
  };
  if (task && task.taskId) {
    state.taskActionPending.set(task.taskId, action);
    renderTasks();
    renderIssueView();
  }
  try {
    let response = await sendActionRequest(request);
    if (
      response
      && response.status === 'revision_conflict'
      && ((task && response.task && response.task.taskId === task.taskId)
        // Snapshot-level actions (repository resume, reset) carry the fresh
        // root revision in the conflict response instead of a task.
        || (!task && Number.isSafeInteger(Number(response.currentRevision))))
    ) {
      const nextRevision = latestActionRevision(response, request.expectedRevision);
      if (nextRevision !== request.expectedRevision) {
        response = await sendActionRequest({
          ...request,
          expectedRevision: nextRevision,
        });
      }
    }
    const status = response && response.status;
    if (status === 'revision_conflict') {
      showNotice(response.message || text('revisionConflict'), 'error');
      await attachSnapshot(false);
      return false;
    } else if (status === 'rejected') {
      showNotice(response.message || text('actionRejected'), 'error');
      return false;
    } else if (status === 'duplicate') {
      showNotice(
        action === 'install_loopx'
          ? text('loopxInstallQueued')
          : (response.message || text('actionDuplicate')),
      );
    } else {
      showNotice(
        action === 'install_loopx'
          ? text('loopxInstallQueued')
          : actionAppliedNotice(action, task, extra, response),
        'success',
      );
      await attachSnapshot(false);
    }
    return true;
  } catch (error) {
    showNotice(errorMessage(error), 'error');
    await attachSnapshot(false);
    return false;
  } finally {
    if (task && task.taskId && state.taskActionPending.get(task.taskId) === action) {
      state.taskActionPending.delete(task.taskId);
      renderTasks();
      renderIssueView();
    }
  }
}

function installLoopxFromGithub() {
  if (state.environmentInstallPending) return;
  state.environmentInstallRequestId = state.environmentInstallRequestId || requestId();
  emitInstallDiagnostic('click_handler_entered');
  state.environmentInstallPending = true;
  state.environmentInstallObserved = true;
  renderExecutionSupport();
  renderEnvironment();
  const installSidecar = state.snapshot
    && state.snapshot.environment
    && state.snapshot.environment.core
    && state.snapshot.environment.core.sidecar;
  const installTargetVersion = (String(installSidecar && installSidecar.detail || '')
    .match(/expected loopx\s+([^\s,]+)/i) || [])[1]
    || (installSidecar && installSidecar.version)
    || '';
  showNotice(text('loopxInstallStarted', { version: installTargetVersion }));
  emitInstallDiagnostic('ui_pending_rendered');
  window.setTimeout(() => {
    emitInstallDiagnostic('request_task_started');
    void submitLoopxInstallation();
  }, 50);
}

async function submitLoopxInstallation() {
  try {
    emitInstallDiagnostic('bridge_call_started');
    const started = await performAction('install_loopx', null, {
      clientRequestId: state.environmentInstallRequestId,
    });
    emitInstallDiagnostic(started ? 'bridge_call_completed' : 'bridge_call_rejected');
    if (started) {
      await attachSnapshot(false);
    } else {
      state.environmentInstallObserved = false;
      state.environmentInstallRequestId = null;
    }
  } finally {
    state.environmentInstallPending = false;
    renderExecutionSupport();
    renderEnvironment();
  }
}

async function answerTaskGate(task, action, note = '') {
  const gate = task && latestGate(task.taskId);
  if (!task || !gate) {
    showNotice(text('noGate'), 'error');
    clearGateSubmitting();
    return;
  }
  showNotice(text('approvalSubmitting'));
  const presentation = approvalPresentation(task, gate);
  if (presentation && state.gateAppliedPresentations) {
    state.gateAppliedPresentations.set(gate.gateId, presentation);
  }
  if (
    action === 'approve'
    && presentation
    && (presentation.kind === 'publish' || presentation.kind === 'publish_comment')
    && state.publishOutcomeArmed
  ) {
    // 授权只是开始：等 agent 真的把 PR / 评论发出来后再播报具体产物。
    state.publishOutcomeArmed.add(task.taskId);
    storeIdSet(PUBLISH_ARMED_STORAGE_KEY, state.publishOutcomeArmed);
  }
  try {
    const applied = await performAction(action, task, {
      gateId: gate.gateId,
      note: note.trim(),
      presentation,
    });
    const shown = displayedTask();
    if (applied && shown && shown.taskId === task.taskId) view.issueApprovalNote.value = '';
  } finally {
    syncApprovalAttention(false);
    clearGateSubmitting();
  }
}

function approvalAlertGate() {
  const task = state.approvalTaskId ? taskForId(state.approvalTaskId) : null;
  const gate = task ? latestGate(task.taskId) : null;
  return task && gate ? { task, gate } : null;
}

function openApprovalAlertGate() {
  const attention = approvalAlertGate();
  if (attention) selectTask(attention.task.taskId);
}

function answerSelectedTaskGate(action) {
  // 审批面板是按 displayedTask() 渲染的，而 selectedTask() 在没有手动点过
  // 左侧任务行时是 null（旧代码因此 if (!task) return 静默返回：按钮点了
  // 既不发请求也没有任何反馈）。这里改为回答「面板正在展示的那个任务」。
  const task = displayedTask() || (state.approvalTaskId ? taskForId(state.approvalTaskId) : null);
  if (!task) return;
  if (!latestGate(task.taskId)) {
    showNotice(text('noGate'), 'error');
    return;
  }
  markGateSubmitting(action);
  void answerTaskGate(task, action, view.issueApprovalNote.value);
}

function markGateSubmitting(action) {
  state.gateSubmittingAction = action || '';
  const approve = view.issueApprovalApprove;
  const reject = view.issueApprovalReject;
  if (!approve || !reject) return;
  approve.disabled = true;
  reject.disabled = true;
  view.issueApprovalNote.disabled = true;
  approve.classList.toggle('is-submitting', action === 'approve');
  reject.classList.toggle('is-submitting', action === 'reject');
  const button = action === 'approve' ? approve : reject;
  button.textContent = text('approvalSubmittingShort');
  button.setAttribute('aria-busy', 'true');
}

function clearGateSubmitting() {
  state.gateSubmittingAction = '';
  [view.issueApprovalApprove, view.issueApprovalReject].forEach((button) => {
    if (!button) return;
    button.classList.remove('is-submitting');
    button.removeAttribute('aria-busy');
  });
  try {
    renderIssueView();
  } catch (error) {
    console.error('renderIssueView failed after gate decision:', error);
  }
}

const RAIL_MIN_WIDTH = 180;
const RAIL_MAX_WIDTH = 520;
const RAIL_DEFAULT_WIDTH = 286;
const RAIL_WIDTH_STORAGE_KEY = 'loopx.railWidth';
const ISSUE_DETAIL_MIN_WIDTH = 380;
const ISSUE_DETAIL_MAX_WIDTH = 820;
const ISSUE_DETAIL_DEFAULT_WIDTH = 620;
const ISSUE_DETAIL_WIDTH_STORAGE_KEY = 'loopx.issueDetailWidth';

function setRailWidth(width) {
  const workbench = view.taskRail.parentElement;
  workbench.style.setProperty('--rail-width', `${width}px`);
  state.railWidth = width;
  // 窄轨（还没折叠到底）需要另一套排版：状态胶囊独占一行、标题两行截断。
  view.taskRail.classList.toggle('is-narrow', Number(width) < 248);
}

function setRailCollapsed(collapsed) {
  state.railCollapsed = Boolean(collapsed);
  view.taskRail.classList.toggle('is-collapsed', state.railCollapsed);
  view.taskRail.parentElement.classList.toggle('tasks-collapsed', state.railCollapsed);
  view.collapseTasks.setAttribute('aria-expanded', String(!state.railCollapsed));
  view.collapseTasks.setAttribute(
    'title',
    state.railCollapsed ? text('expandTasks') : text('collapseTasks'),
  );
}

function bindRailSplitter() {
  const splitter = view.railSplitter;
  if (!splitter) return;
  let startX = 0;
  let startWidth = 0;
  let active = false;
  const width = () => state.railWidth || RAIL_DEFAULT_WIDTH;

  const move = (event) => {
    if (!active) return;
    const next = startWidth + (event.clientX - startX);
    setRailWidth(Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, next)));
    splitter.setAttribute('aria-valuenow', String(width()));
    event.preventDefault();
  };

  const end = () => {
    if (!active) return;
    active = false;
    splitter.classList.remove('is-dragging');
    splitter.classList.remove('is-focused');
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.body.style.userSelect = '';
    splitter.setAttribute('aria-valuenow', String(width()));
    persistRailWidth();
  };

  splitter.addEventListener('pointerdown', (event) => {
    if (state.railCollapsed) {
      setRailCollapsed(false);
      setRailWidth(Math.max(RAIL_MIN_WIDTH, width()));
    }
    active = true;
    startX = event.clientX;
    startWidth = width();
    splitter.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    event.preventDefault();
  });

  splitter.addEventListener('focus', () => splitter.classList.add('is-focused'));
  splitter.addEventListener('blur', () => splitter.classList.remove('is-focused'));

  // Double-click or double-activate resets to the default width.
  splitter.addEventListener('dblclick', () => {
    if (state.railCollapsed) setRailCollapsed(false);
    setRailWidth(RAIL_DEFAULT_WIDTH);
    splitter.setAttribute('aria-valuenow', String(width()));
    persistRailWidth();
  });
  splitter.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (state.railCollapsed) setRailCollapsed(false);
    const step = event.shiftKey ? 48 : 12;
    const next = event.key === 'ArrowRight' ? width() + step : width() - step;
    setRailWidth(Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, next)));
    splitter.setAttribute('aria-valuenow', String(width()));
    persistRailWidth();
  });

  splitter.setAttribute('aria-valuemin', String(RAIL_MIN_WIDTH));
  splitter.setAttribute('aria-valuemax', String(RAIL_MAX_WIDTH));
  splitter.setAttribute('aria-valuenow', String(width()));
  splitter.setAttribute('aria-controls', 'task-rail');

  // Restore persisted width (session-only when storage is unavailable).
  try {
    const stored = window.localStorage.getItem(RAIL_WIDTH_STORAGE_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    if (Number.isFinite(parsed) && parsed >= RAIL_MIN_WIDTH && parsed <= RAIL_MAX_WIDTH) {
      setRailWidth(parsed);
    }
  } catch {
    /* storage unavailable: keep default width for this session */
  }
}

function persistRailWidth() {
  const value = String(state.railWidth || RAIL_DEFAULT_WIDTH);
  try {
    window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, value);
  } catch {
    /* storage unavailable: keep width for this session only */
  }
}

function issueDetailBounds() {
  const columns = view.issueSplitter && view.issueSplitter.parentElement;
  const total = columns ? columns.getBoundingClientRect().width : 0;
  const max = total > 0
    ? Math.min(ISSUE_DETAIL_MAX_WIDTH, Math.max(ISSUE_DETAIL_MIN_WIDTH, total - 360))
    : ISSUE_DETAIL_MAX_WIDTH;
  return {
    min: ISSUE_DETAIL_MIN_WIDTH,
    max: Math.max(ISSUE_DETAIL_MIN_WIDTH, max),
  };
}

function clampIssueDetailWidth(width) {
  const bounds = issueDetailBounds();
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function setIssueDetailWidth(width) {
  const next = clampIssueDetailWidth(width);
  view.issueView.style.setProperty('--issue-detail-width', `${next}px`);
  state.issueDetailWidth = next;
}

function persistIssueDetailWidth() {
  const value = String(state.issueDetailWidth || ISSUE_DETAIL_DEFAULT_WIDTH);
  try {
    window.localStorage.setItem(ISSUE_DETAIL_WIDTH_STORAGE_KEY, value);
  } catch {
    /* storage unavailable: keep width for this session only */
  }
}

function bindIssueSplitter() {
  const splitter = view.issueSplitter;
  if (!splitter) return;
  let startX = 0;
  let startWidth = 0;
  let active = false;
  const width = () => state.issueDetailWidth || ISSUE_DETAIL_DEFAULT_WIDTH;

  const updateAria = () => {
    const bounds = issueDetailBounds();
    splitter.setAttribute('aria-valuemin', String(bounds.min));
    splitter.setAttribute('aria-valuemax', String(bounds.max));
    splitter.setAttribute('aria-valuenow', String(width()));
  };

  const move = (event) => {
    if (!active) return;
    setIssueDetailWidth(startWidth + (event.clientX - startX));
    updateAria();
    event.preventDefault();
  };

  const end = () => {
    if (!active) return;
    active = false;
    splitter.classList.remove('is-dragging');
    splitter.classList.remove('is-focused');
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.body.style.userSelect = '';
    updateAria();
    persistIssueDetailWidth();
  };

  splitter.addEventListener('pointerdown', (event) => {
    active = true;
    startX = event.clientX;
    startWidth = width();
    splitter.classList.add('is-dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    event.preventDefault();
  });
  splitter.addEventListener('focus', () => splitter.classList.add('is-focused'));
  splitter.addEventListener('blur', () => splitter.classList.remove('is-focused'));
  splitter.addEventListener('dblclick', () => {
    setIssueDetailWidth(ISSUE_DETAIL_DEFAULT_WIDTH);
    updateAria();
    persistIssueDetailWidth();
  });
  splitter.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 48 : 12;
    const next = event.key === 'ArrowRight' ? width() + step : width() - step;
    setIssueDetailWidth(next);
    updateAria();
    persistIssueDetailWidth();
  });
  splitter.setAttribute('aria-controls', 'issue-detail issue-timeline');
  try {
    const stored = window.localStorage.getItem(ISSUE_DETAIL_WIDTH_STORAGE_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    setIssueDetailWidth(Number.isFinite(parsed) ? parsed : ISSUE_DETAIL_DEFAULT_WIDTH);
  } catch {
    setIssueDetailWidth(ISSUE_DETAIL_DEFAULT_WIDTH);
  }
  updateAria();
  window.addEventListener('resize', () => {
    setIssueDetailWidth(width());
    updateAria();
  });
}

function bindEvents() {
  bindRailSplitter();
  bindIssueSplitter();
  view.modelSelect.addEventListener('pointerdown', () => void loadModelCatalog());
  view.modelSelect.addEventListener('focus', () => void loadModelCatalog());
  view.modelSelect.addEventListener('change', () => {
    writeStoredModelSelection(view.modelSelect.value || 'auto');
    if (state.preview) {
      state.preview = null;
      if (view.intakeDialog.open) view.intakeDialog.close();
      showNotice(text('modelSelectionChanged'));
    }
  });
  view.intakeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void resolveIntake();
  });
  view.candidateSelectAll.addEventListener('change', () => {
    const checked = view.candidateSelectAll.checked;
    view.candidateList.querySelectorAll('input[name="candidate"]:not(:disabled)').forEach((input) => {
      input.checked = checked;
    });
    updateCreateButton();
  });
  view.resetLoopx.addEventListener('click', openResetLoopxDialog);
  view.pauseAllLoopx.addEventListener('click', () => { void suiteAction('pause_all'); });
  view.resumeAllLoopx.addEventListener('click', () => { void suiteAction('resume_all'); });
  view.resetLoopxCancel.addEventListener('click', () => {
    view.resetLoopxDialog.close();
  });
  view.resetLoopxConfirm.addEventListener('click', (event) => {
    event.preventDefault();
    void resetLoopx();
  });
  view.installLoopx.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.environmentInstallPending) return;
    state.environmentInstallRequestId = state.environmentInstallRequestId || requestId();
    emitInstallDiagnostic('pointer_down');
  });
  view.installLoopx.addEventListener('click', () => {
    void installLoopxFromGithub();
  });
  view.retryEnvironment.addEventListener('click', async () => {
    await performAction('retry_environment', null);
  });
  view.resumeRepository.addEventListener('click', openRepositoryResumeDialog);
  view.approvalAlertOpen.addEventListener('click', openApprovalAlertGate);
  view.approvalAlertOpenAction.addEventListener('click', openApprovalAlertGate);
  view.issueLink.addEventListener('click', (event) => {
    const href = view.issueLink.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    openExternalUrl(href);
  });
  view.issueApprovalApprove.addEventListener('click', () => answerSelectedTaskGate('approve'));
  view.issueApprovalReject.addEventListener('click', () => answerSelectedTaskGate('reject'));
  view.issueApprovalNoteToggle.addEventListener('click', () => {
    const field = view.issueApprovalNote.closest('.issue-approval-note');
    const expanded = field.hidden;
    field.hidden = !expanded;
    view.issueApprovalNoteToggle.setAttribute('aria-expanded', String(expanded));
    if (expanded) view.issueApprovalNote.focus();
  });
  view.repositoryResumeCancel.addEventListener('click', () => {
    view.repositoryResumeDialog.close();
  });
  view.repositoryResumeConfirm.addEventListener('click', (event) => {
    event.preventDefault();
    void resumeRepository();
  });
  view.collapseTasks.addEventListener('click', () => {
    setRailCollapsed(!state.railCollapsed);
  });
  view.logScroll.addEventListener('scroll', () => {
    const remaining = view.logScroll.scrollHeight - view.logScroll.scrollTop - view.logScroll.clientHeight;
    state.followLogs = remaining < 40;
    if (state.followLogs) view.newEvents.hidden = true;
  }, { passive: true });
  view.newEvents.addEventListener('click', () => {
    state.followLogs = true;
    renderLogs();
  });
  document.querySelectorAll('.dialog-close').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  view.intakeConfirmForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void createTasks(false);
  });
  view.retryCancel.addEventListener('click', () => {
    state.pendingRetry = null;
    view.retryDialog.close();
  });
  view.retryConfirm.addEventListener('click', (event) => {
    event.preventDefault();
    void confirmRetry();
  });
}

function updateLivenessClock() {
  renderIssueView();
  renderTasks();
  const resumed = sampleHostClock();
  if (resumed) {
    void attachSnapshot(false, true);
    return;
  }
  const tasks = state.snapshot && Array.isArray(state.snapshot.tasks) ? state.snapshot.tasks : [];
  const hasActiveWork = tasks.some((task) => [
    'preparing',
    'running',
    'cancelling',
    'retry_wait',
  ].includes(task.state));
  const now = Date.now();
  if (
    hasActiveWork
    && document.visibilityState === 'visible'
    && now - state.lastHostSignalAt >= STALE_ACTIVE_REATTACH_MS
    && now - state.lastReattachAt >= STALE_ACTIVE_REATTACH_MS
  ) {
    void attachSnapshot(false);
  }
}

function sampleHostClock() {
  const now = Date.now();
  const elapsed = now - state.lastClockSampleAt;
  state.lastClockSampleAt = now;
  return elapsed >= HOST_RESUME_GAP_MS;
}

function handleHostSurfaceReturn() {
  if (document.visibilityState !== 'visible') return;
  void attachSnapshot(false, sampleHostClock());
}

async function start() {
  bindEvents();
  applyLocale();
  void loadIntakeHistory();
  void loadModelCatalog();
  if (!app || !app.loopx) {
    showBridgeUnavailable();
    return;
  }
  app.loopx.onEvent(onLoopxEvent);
  if (typeof app.onLocaleChange === 'function') app.onLocaleChange(applyLocale);
  if (typeof app.onActivate === 'function') app.onActivate(handleHostSurfaceReturn);
  document.addEventListener('visibilitychange', handleHostSurfaceReturn);
  window.addEventListener('focus', handleHostSurfaceReturn);
  window.addEventListener('pageshow', handleHostSurfaceReturn);
  window.addEventListener('online', handleHostSurfaceReturn);
  window.addEventListener('beforeunload', () => {
    state.tornDown = true;
    clearTurnOutputTimer();
    document.removeEventListener('visibilitychange', handleHostSurfaceReturn);
    window.removeEventListener('focus', handleHostSurfaceReturn);
    window.removeEventListener('pageshow', handleHostSurfaceReturn);
    window.removeEventListener('online', handleHostSurfaceReturn);
    if (app.loopx && typeof app.loopx.offEvent === 'function') {
      app.loopx.offEvent(onLoopxEvent);
    }
  });
  window.setInterval(updateLivenessClock, HOST_CLOCK_TICK_MS);
  await attachSnapshot(true);
}

void start();

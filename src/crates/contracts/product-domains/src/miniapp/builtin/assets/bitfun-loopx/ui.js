'use strict';

// LoopX is owned by the BitFun host. This file only projects durable snapshots
// and cursor-addressed events into the MiniApp UI.
const app = window.app;
const byId = (id) => document.getElementById(id);
const MAX_EVENTS = 2000;
const MAX_RENDERED_OUTPUT_BLOCKS = 500;
const MAX_TURN_OUTPUT_EVENTS = 4000;
const MAX_OUTPUT_HISTORY_EVENTS = 50000;
const MAX_OUTPUT_EVENT_CHARS = 16000;
const MAX_OUTPUT_BLOCK_CHARS = 120000;
const MAX_OUTPUT_HISTORY_CHARS = 8000000;
const MAX_INTAKE_HISTORY = 12;
const HOST_CLOCK_TICK_MS = 5000;
const HOST_RESUME_GAP_MS = 30000;
const STALE_ACTIVE_REATTACH_MS = 30000;
const MODEL_SELECTION_STORAGE_KEY = 'loopx.modelId';
const INTAKE_HISTORY_STORAGE_KEY = 'loopx.intakeHistory';
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
    resettingLoopxBackground: '正在后台清理任务与工作进展；窗口可以继续使用，完成后会自动刷新。',
    destructiveAction: '危险操作',
    resetLoopxTitle: '清空并重新开始',
    resetLoopxMessage: '将停止并删除 {tasks} 个任务、{events} 条日志、全部工作进展和受管工作区。此操作不可撤销。',
    resetLoopxRetained: '模型配置、GitHub 登录、MiniApp 设置和干净的 Git 对象缓存会保留；仍在进行的工作区不会被复用。',
    resetLoopxConfirm: '清空并重新开始',
    resetLoopxApplied: 'LoopX 已清空，可以重新开始测试。',
    unsupportedTitle: '当前执行位置不支持 LoopX',
    unsupportedDefault: 'LoopX 目前只支持本地 Desktop 工作区；远程工作区不会静默改在本机执行。',
    environment: '环境',
    coreEnvironment: '核心环境',
    optionalEnvironment: '增强能力',
    required: '必需',
    optional: '可选',
    retryEnvironment: '重新检查环境',
    installLoopx: '安装兼容版本',
    loopxInstallStarted: '正在从官方 GitHub 源仓库下载并校验 LoopX v0.5.1…',
    loopxInstallQueued: '安装已在后台开始，可以继续使用当前窗口。',
    loopxInstallComplete: 'LoopX v0.5.1 已安装，环境检查已更新。',
    loopxInstallFailed: 'LoopX 安装失败：{message}',
    loopxRepairTitle: 'LoopX 版本需要修复',
    loopxRepairDetail: '当前 {current}，此功能需要 0.5.1。安装到 BitFun 管理目录，不会修改系统版本。',
    loopxInstallingTitle: '正在准备 LoopX 0.5.1',
    loopxInstallingDetail: '仅下载运行所需源码并校验版本，完成后会自动重新检查环境。',
    tasks: '任务',
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
    gateKindDecision: '决策请求',
    outputUnavailable: '实时输出暂不可用',
    outputThinking: '思考',
    outputThinkingSummary: '思考过程 · {value} 字（点击展开）',
    decisionCardTitle: '需要你的决策',
    decisionCardTitleRecovery: '工作段被中断，需要恢复',
    decisionCardTitlePlanExhausted: '修复计划已执行完毕，等待收尾方式',
    decisionResume: '恢复重试',
    decisionCardGateHint: '请在下方审批面板中批准或拒绝该请求。',
    decisionCardRecoveryHint: '本段工作已结束，但结算未能确认持久进展；可恢复重试一次，结论详情见下方最新进展。',
    decisionCardPlanExhaustedHint: '流程的待办已全部执行完，但没有留下可继续的待办、待批门禁或收尾声明，宿主不会伪造收尾。已产生的提交、未提交改动与证据均保留在任务工作区。你可以：从任务分支手动推送并开 PR / 在 issue 上评论说明；或等 goal 出现新待办（例如上游 PR 合并、新的监控结论）后再点“恢复重试”。',
    summaryVerdictNeedsFix: '🛠️ 需要修复',
    summaryVerdictAlreadyFixedUpstream: '✅ 上游已修复',
    summaryVerdictWontFix: '🚫 无需修复',
    summaryVerdictNeedsInfo: '❓ 信息不足',
    summaryReproductionReproduced: '🔁 已复现',
    summaryReproductionNotReproduced: '🔁 未复现',
    summaryReproductionNotApplicable: '🔁 不适用',
    summarySegmentEvidence: '调查取证',
    summarySegmentRouteDecision: '方案决策',
    summarySegmentImplementation: '实现修复',
    summarySegmentValidation: '验证',
    summarySegmentDelivery: '交付',
    summaryCompletedTitle: '本段完成',
    summaryDecisionTitle: '已定方案',
    summaryRejectedTitle: '已否决选项',
    summaryNextStep: '下一步',
    summaryBlockers: '阻塞',
    summaryTechReceipts: '技术回执',
    summaryPendingGate: '⏸️ 等你批准后继续（见上方审批面板）',
    recoveryReasonHostRestart: '中断原因：应用异常关闭导致执行中断',
    recoveryReasonExecutionFailure: '中断原因：执行过程失败',
    recoveryReasonPlanExhausted: '中断原因：计划用尽——无待办、无待批门禁、无终局声明',
    recoveryReasonSettlementUnverified: '中断原因：结算未能确认持久进展（写入已验证，花费回执缺失）',
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
    updated: '更新于 {duration} 前',
    openInGithub: '在 GitHub 中打开',
    currentWork: '当前',
    outcomeUpdated: '{duration}前更新',
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
    publishApprovalTitle: '是否发布修复并创建 Pull Request？',
    publishApprovalSummary: '修复已在分支 {branch} 的提交 {commit} 中准备完成，目标仓库为 {repository}。现在需要你决定是否发布。',
    publishApprovalSummaryGeneric: '修复和发布材料已经准备完成，目标仓库为 {repository}。现在需要你决定是否发布为 Pull Request。',
    publishApprovalApproveEffect: '推送修复分支并创建 Pull Request，随后进入 macOS 真机验证。批准不会自动合并代码。',
    publishApprovalRejectEffect: '不推送分支，也不创建 Pull Request；本地分支、提交和验证结果会保留，任务停在当前步骤。',
    publishApprovalRecommendationReady: '建议批准：当前修改已有验证结果，批准后仍可在 Pull Request 中继续评审，并不会自动合并。',
    publishApprovalRecommendationReview: '建议先确认修改和验证结果；批准只会发布 Pull Request，不会自动合并。',
    publishApprovalApprove: '批准并创建 PR',
    publishApprovalReject: '暂不发布',
    genericApprovalTitle: '是否继续处理这个 Issue？',
    genericApprovalSummary: 'Agent 在执行任务时请求一个决定。具体内容见下方原始请求；不确定时可以先在时间线里确认它做了什么再决定。',
    genericApprovalApproveEffect: '执行当前操作，然后继续后续处理；完成后会再次汇报结果。',
    genericApprovalRejectEffect: '本次不执行该操作，任务不会继续进入后续步骤。现有修改、调查结果和工作区都会保留。',
    genericApprovalRecommendation: '建议：确认下面的操作符合预期后再继续；不确定时可以暂不执行，并在备注中说明需要补充的信息。',
    gateRawDetails: '原始请求（来自 Agent，英文原文）',
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
    state_running: '运行中',
    state_waiting_for_user: '待批准',
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
    resettingLoopxBackground: 'Cleaning tasks and saved progress in the background. You can keep using this window; it refreshes when cleanup finishes.',
    destructiveAction: 'Destructive action',
    resetLoopxTitle: 'Clear and start over',
    resetLoopxMessage: 'Stop and delete {tasks} tasks, {events} log events, all saved progress, and all managed workspaces. This cannot be undone.',
    resetLoopxRetained: 'Model configuration, GitHub login, MiniApp settings, and clean Git object caches are retained. Unsettled worktrees are not reused.',
    resetLoopxConfirm: 'Clear and start over',
    resetLoopxApplied: 'LoopX was cleared. You can start a fresh test.',
    unsupportedTitle: 'LoopX is unavailable in this execution location',
    unsupportedDefault: 'LoopX currently supports local Desktop workspaces only. Remote workspaces will not silently run on this device instead.',
    environment: 'Environment',
    coreEnvironment: 'Core environment',
    optionalEnvironment: 'Optional capabilities',
    required: 'Required',
    optional: 'Optional',
    retryEnvironment: 'Check environment again',
    installLoopx: 'Install compatible version',
    loopxInstallStarted: 'Downloading and verifying LoopX v0.5.1 from the official GitHub source repository...',
    loopxInstallQueued: 'Installation started in the background. You can keep using this window.',
    loopxInstallComplete: 'LoopX v0.5.1 is installed and the environment check is up to date.',
    loopxInstallFailed: 'LoopX installation failed: {message}',
    loopxRepairTitle: 'LoopX needs a compatible version',
    loopxRepairDetail: 'Current: {current}. This feature requires 0.5.1. Installation stays inside BitFun and does not change the system version.',
    loopxInstallingTitle: 'Preparing LoopX 0.5.1',
    loopxInstallingDetail: 'Downloading only the runtime source and verifying it. The environment will be checked automatically when finished.',
    tasks: 'Tasks',
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
    gateKindDecision: 'Decision request',
    outputUnavailable: 'Live output is unavailable',
    outputThinking: 'Thinking',
    outputThinkingSummary: 'Thinking · {value} chars (click to expand)',
    decisionCardTitle: 'Needs your decision',
    decisionCardTitleRecovery: 'Work segment was interrupted and needs recovery',
    decisionCardTitlePlanExhausted: 'Fix plan completed; choose how to finish',
    decisionResume: 'Resume retry',
    decisionCardGateHint: 'Approve or reject the request in the approval panel below.',
    decisionCardRecoveryHint: 'This segment finished but settlement could not validate durable progress. You can retry recovery once; see the summary below for the conclusion.',
    decisionCardPlanExhaustedHint: 'All plan todos are done, but the flow left no open todo, approval gate, or terminal declaration, and the host will not fabricate one. Commits, uncommitted changes, and evidence are preserved in the task worktree. You can push the task branch and open a PR / comment on the issue yourself, or wait until the goal gains a new todo or gate (for example after an upstream PR merge) and then use Resume retry.',
    summaryVerdictNeedsFix: '🛠️ Needs fix',
    summaryVerdictAlreadyFixedUpstream: '✅ Already fixed upstream',
    summaryVerdictWontFix: '🚫 Won\'t fix',
    summaryVerdictNeedsInfo: '❓ Needs info',
    summaryReproductionReproduced: '🔁 Reproduced',
    summaryReproductionNotReproduced: '🔁 Not reproduced',
    summaryReproductionNotApplicable: '🔁 Not applicable',
    summarySegmentEvidence: 'Evidence',
    summarySegmentRouteDecision: 'Route decision',
    summarySegmentImplementation: 'Implementation',
    summarySegmentValidation: 'Validation',
    summarySegmentDelivery: 'Delivery',
    summaryCompletedTitle: 'This segment',
    summaryDecisionTitle: 'Decided',
    summaryRejectedTitle: 'Rejected options',
    summaryNextStep: 'Next step',
    summaryBlockers: 'Blockers',
    summaryTechReceipts: 'Technical receipts',
    summaryPendingGate: '⏸️ Waiting for your approval (see the approval panel above)',
    recoveryReasonHostRestart: 'Interrupted by an abnormal app shutdown',
    recoveryReasonExecutionFailure: 'Interrupted by an execution failure',
    recoveryReasonPlanExhausted: 'Interrupted because the plan ran dry: no open todo, no approval gate, no terminal declaration',
    recoveryReasonSettlementUnverified: 'Interrupted because settlement could not validate durable progress (writeback verified, quota spend receipt missing)',
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
    openInGithub: 'Open in GitHub',
    currentWork: 'Current',
    outcomeUpdated: 'Updated {duration} ago',
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
    publishApprovalTitle: 'Publish the fix and create a pull request?',
    publishApprovalSummary: 'The fix is prepared on branch {branch} at commit {commit} for {repository}. Your approval is required before publishing it.',
    publishApprovalSummaryGeneric: 'The fix and publishing materials are ready for {repository}. Your approval is required before creating the pull request.',
    publishApprovalApproveEffect: 'Push the fix branch, create a pull request, then continue with macOS host verification. Approval does not merge code automatically.',
    publishApprovalRejectEffect: 'Do not push the branch or create a pull request. Keep the local branch, commit, and validation results, and stop at this step.',
    publishApprovalRecommendationReady: 'Recommended: approve. The change has validation results and remains reviewable in the pull request; it will not be merged automatically.',
    publishApprovalRecommendationReview: 'Review the change and validation results first. Approval publishes a pull request but does not merge it automatically.',
    publishApprovalApprove: 'Approve and create PR',
    publishApprovalReject: 'Keep local only',
    genericApprovalTitle: 'Continue handling this Issue?',
    genericApprovalSummary: 'The agent requested a decision while working. See the original request below; when unsure, check the timeline first to see what it did.',
    genericApprovalApproveEffect: 'Perform the current operation and continue processing. Results will be reported again afterward.',
    genericApprovalRejectEffect: 'Do not perform this operation or continue to later steps. Keep existing changes, investigation results, and the workspace.',
    genericApprovalRecommendation: 'Recommendation: continue only when the operation below matches your expectation. Otherwise pause and note what information is missing.',
    gateRawDetails: 'Original request (from agent)',
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
    state_running: 'Running',
    state_waiting_for_user: 'Pending approval',
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
  issueLink: byId('issue-link'),
  issueUpdated: byId('issue-updated'),
  issueDetail: byId('issue-detail'),
  issueSplitter: byId('issue-splitter'),
  issueApprovalPanel: byId('issue-approval-panel'),
  issueApprovalRaw: byId('issue-approval-raw'),
  issueApprovalRawText: byId('issue-approval-raw-text'),
  issueApprovalKind: byId('issue-approval-kind'),
  issueApprovalTitle: byId('issue-approval-title'),
  issueApprovalMessage: byId('issue-approval-message'),
  issueApprovalApproveEffect: byId('issue-approval-approve-effect'),
  issueApprovalRejectEffect: byId('issue-approval-reject-effect'),
  issueApprovalRecommendation: byId('issue-approval-recommendation'),
  issueApprovalNote: byId('issue-approval-note'),
  issueApprovalReject: byId('issue-approval-reject'),
  issueApprovalApprove: byId('issue-approval-approve'),
  issueDecisionCard: byId('issue-decision-card'),
  issueSummaryMeta: byId('issue-summary-meta'),
  issueSummary: byId('issue-summary'),
  issueFacts: byId('issue-facts'),
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

const state = {
  snapshot: null,
  events: [],
  eventKeys: new Set(),
  selectedTaskId: null,
  followLogs: true,
  expandedThinking: new Set(),
  preview: null,
  pendingCreate: null,
  pendingRetry: null,
  approvalTaskId: null,
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

function taskStateLabel(task) {
  if (isResolvedUpstream(task)) return stateLabel('resolved_upstream');
  return isWorkspacePreparationFailure(task) ? stateLabel('failed') : stateLabel(task && task.state);
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
  return taskStateLabel(task);
}

function taskPhaseLabel(task) {
  return isWorkspacePreparationFailure(task)
    ? text('workspacePreparationFailed')
    : phaseLabel(task && task.phase);
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

function showNotice(message, tone = 'neutral') {
  if (!message) {
    view.notice.hidden = true;
    view.notice.textContent = '';
    view.notice.dataset.tone = '';
    return;
  }
  view.notice.textContent = message;
  view.notice.dataset.tone = tone;
  view.notice.hidden = false;
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
    .replace(/^\s*[【[]\s*(?:bug|问题)\s*[】\]]\s*/i, '')
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
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event.taskId !== task.taskId || !event.message) continue;
    const message = String(event.message);
    if (/another task for this repository/i.test(message)) return text('queuedRepoBusy');
    if (/bounded turn/i.test(message)) return text('queuedBoundedWait');
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
        const boundedText = rawText.length <= MAX_OUTPUT_EVENT_CHARS
          ? rawText
          : `${rawText.slice(0, MAX_OUTPUT_EVENT_CHARS / 2)}\n...\n${rawText.slice(-MAX_OUTPUT_EVENT_CHARS / 2)}`;
        state.outputKeys.add(outputKey);
        state.outputHistory.push({
          ...event,
          text: boundedText,
          taskId: task.taskId,
          turnId,
        });
        state.outputCharacters += boundedText.length;
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
      showNotice(text('loopxInstallComplete'), 'success');
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
  const installChecking = Boolean(
    sidecar
    && sidecar.status === 'checking'
    && sidecar.version === '0.5.1'
  );
  const installAvailable = Boolean(
    sidecar
    && sidecar.remediationAction === 'install_loopx'
  );
  const installing = state.environmentInstallPending || installChecking;
  view.environmentRemediation.hidden = !installAvailable && !installing;
  if (view.environmentRemediation.hidden) return;

  view.environmentRemediation.dataset.state = installing ? 'installing' : 'blocked';
  view.environmentRemediationTitle.textContent = text(
    installing ? 'loopxInstallingTitle' : 'loopxRepairTitle',
  );
  const detail = String(sidecar && sidecar.detail || '');
  const currentVersion = (detail.match(/got loopx\s+([^\s]+)/i) || [])[1] || statusLabel('unavailable');
  view.environmentRemediationDetail.textContent = installing
    ? text('loopxInstallingDetail')
    : text('loopxRepairDetail', { current: currentVersion });
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
  const rank = {
    running: 0,
    preparing: 1,
    cancelling: 2,
    queued: 3,
    retry_wait: 4,
    waiting_for_user: 5,
    recovery_required: 6,
    stopped: 7,
    failed: 9,
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

function taskButton(task) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'task-item';
  if (task.taskId === state.selectedTaskId) button.classList.add('is-selected');
  button.dataset.taskId = task.taskId;
  button.setAttribute('aria-pressed', String(task.taskId === state.selectedTaskId));

  const main = document.createElement('span');
  main.className = 'task-item__main';
  const label = document.createElement('strong');
  const item = task.identity && task.identity.item;
  const identityTitle = issueDisplayTitle(task);
  label.textContent = identityTitle || compactItemLabel(item);
  const meta = document.createElement('small');
  const activity = task.lastOutputAt || task.updatedAt;
  meta.textContent = `${repositoryLabel(item && item.repository)} · ${compactItemLabel(item)} · ${relativeLabel(activity)}`;
  main.append(label, meta);
  if (task.state === 'queued') {
    const reason = latestTaskWaitReason(task);
    if (reason) main.title = reason;
  }

  const taskState = document.createElement('span');
  taskState.className = 'task-item__state';
  const pendingAction = pendingActionFor(task);
  const visualState = taskVisualState(task);
  button.dataset.state = visualState;
  if (pendingAction) button.dataset.pending = pendingAction;
  taskState.dataset.status = visualState;
  if (pendingAction) {
    taskState.classList.add('task-item__hint', 'task-item__hint--pending');
    taskState.textContent = taskStateDisplayLabel(task);
  } else {
    taskState.classList.add('task-item__hint');
    if (visualState === 'running') taskState.classList.add('task-item__hint--running');
    taskState.textContent = taskStateDisplayLabel(task);
  }
  taskState.title = taskStateDisplayLabel(task);
  button.setAttribute('aria-label', `${label.textContent}, ${taskStateDisplayLabel(task)}`);
  const compact = document.createElement('span');
  compact.className = 'task-item__compact';
  compact.textContent = item && item.number ? `#${item.number}` : shortId(task.taskId);
  button.append(main, compact, taskState);
  button.addEventListener('click', () => selectTask(task.taskId));
  return button;
}

function renderTasks() {
  if (!canRender()) return;
  const tasks = state.snapshot && Array.isArray(state.snapshot.tasks) ? state.snapshot.tasks : [];
  const fragment = document.createDocumentFragment();
  sortedTaskList(tasks).forEach((task) => fragment.append(taskButton(task)));
  view.taskItems.replaceChildren(fragment);
  view.taskCount.textContent = String(tasks.length);
  view.taskEmpty.hidden = tasks.length !== 0;
  renderRepositoryActions(tasks);
  syncApprovalAttention(false);
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
  return { task, gate: latestGate(task.taskId) };
}

function gateRawMessage(gate) {
  return String(gate && gate.event && gate.event.message || '').trim();
}

function stripGatePriorityPrefix(message) {
  return message.replace(/^\[[Pp]\d\]\s*/, '').trim();
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

  const publishPullRequest = actionKind.includes('publish')
    || actionKind.includes('pull_request')
    || /\bpr bundle\b|(?:publish|push|creat(?:e|ing|ion)).{0,100}(?:pull request|\bpr\b)/i.test(body);
  if (publishPullRequest) {
    const branch = body.match(/\bbranch\s+([^,\s)]+)/i)?.[1] || '';
    const commit = body.match(/\bcommit\s+([0-9a-f]{7,40})\b/i)?.[1] || '';
    const messageRepository = body.match(/\bto\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=;|[\s.,]|$)/i)?.[1] || '';
    const item = task && task.identity && task.identity.item;
    const repository = messageRepository || repositoryLabel(item && item.repository) || '--';
    const evidence = taskProgressEvidence(task);
    const validated = evidence.validated || evidence.settled || /\b(?:validated|verified)\b/i.test(body);
    return {
      kind: 'publish',
      title: text('publishApprovalTitle'),
      summary: branch && commit
        ? text('publishApprovalSummary', { branch, commit, repository })
        : text('publishApprovalSummaryGeneric', { repository }),
      rawMessage,
      approveEffect: text('publishApprovalApproveEffect'),
      rejectEffect: text('publishApprovalRejectEffect'),
      recommendation: text(validated ? 'publishApprovalRecommendationReady' : 'publishApprovalRecommendationReview'),
      approveLabel: text('publishApprovalApprove'),
      rejectLabel: text('publishApprovalReject'),
    };
  }

  // LoopX issue-fix 契约中的已知 gate 类型：面向人给出中文说明，
  // 原始待办文本（英文、技术性）折叠进「原始请求」而不是当作正文。
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

  return {
    kind: 'generic',
    title: text('genericApprovalTitle'),
    summary: text('genericApprovalSummary'),
    rawMessage: body,
    approveEffect: text('genericApprovalApproveEffect'),
    rejectEffect: text('genericApprovalRejectEffect'),
    recommendation: text('genericApprovalRecommendation'),
    approveLabel: text('approve'),
    rejectLabel: text('reject'),
  };
}

function syncApprovalAttention(autoOpen = false) {
  const attention = currentApprovalAttention();
  state.approvalTaskId = attention ? attention.task.taskId : null;
  view.approvalAlert.hidden = !attention;
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
  if (['stopped', 'completed', 'failed'].includes(task.state)) {
    fragment.append(makeActionButton(text('archive'), 'archive', task));
  }
  if (task.state === 'archived') {
    fragment.append(makeActionButton(text('restore'), 'restore', task));
  }
  view.taskActions.append(fragment);
}

function safeMarkdownUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl || undefined);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_error) {
    return '';
  }
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
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = parts[1];
        parent.append(link);
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

function renderMarkdown(target, source, baseUrl) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  let code = null;
  let paragraph = null;
  const closeParagraph = () => { paragraph = null; };
  const closeList = () => { list = null; };
  lines.forEach((line) => {
    if (/^```/.test(line)) {
      closeParagraph();
      closeList();
      if (code) {
        code = null;
      } else {
        const pre = document.createElement('pre');
        code = document.createElement('code');
        pre.append(code);
        fragment.append(pre);
      }
      return;
    }
    if (code) {
      code.append(document.createTextNode(`${code.textContent ? '\n' : ''}${line}`));
      return;
    }
    if (!line.trim()) {
      closeParagraph();
      closeList();
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeParagraph();
      closeList();
      const element = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      appendInlineMarkdown(element, heading[2], baseUrl);
      fragment.append(element);
      return;
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
      return;
    }
    closeList();
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeParagraph();
      const element = document.createElement('blockquote');
      appendInlineMarkdown(element, quote[1], baseUrl);
      fragment.append(element);
      return;
    }
    if (!paragraph) {
      paragraph = document.createElement('p');
      fragment.append(paragraph);
    } else {
      paragraph.append(document.createElement('br'));
    }
    appendInlineMarkdown(paragraph, line, baseUrl);
  });
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
  }
  if (!gate) return;
  const presentation = approvalPresentation(task, gate);
  view.issueApprovalKind.textContent = presentation.kind === 'publish'
    ? text('gateKindPublish')
    : text('gateKindDecision');
  view.issueApprovalTitle.textContent = presentation.title;
  view.issueApprovalMessage.textContent = presentation.summary;
  const rawBody = String(presentation.rawMessage || '').trim();
  const rawDiffers = rawBody && rawBody !== presentation.summary;
  view.issueApprovalRaw.hidden = !rawDiffers;
  view.issueApprovalRawText.textContent = rawDiffers ? rawBody : '';
  view.issueApprovalApproveEffect.textContent = presentation.approveEffect;
  view.issueApprovalRejectEffect.textContent = presentation.rejectEffect;
  view.issueApprovalRecommendation.textContent = presentation.recommendation;
  const pending = Boolean(pendingActionFor(task));
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
  const show = Boolean(task)
    && !isResolvedUpstream(task)
    && (waiting || recovery);
  card.hidden = !show;
  if (!show) {
    card.replaceChildren();
    return;
  }
  card.replaceChildren();
  const planExhausted = recovery && task.recoveryReason === 'plan_exhausted';
  const heading = document.createElement('strong');
  heading.textContent = text(waiting
    ? 'decisionCardTitle'
    : (planExhausted ? 'decisionCardTitlePlanExhausted' : 'decisionCardTitleRecovery'));
  const body = document.createElement('p');
  body.className = 'issue-decision-card__message';
  const recoveryHint = String(task.pendingGateMessage || '').trim()
    || text(waiting ? 'decisionCardGateHint' : (planExhausted ? 'decisionCardPlanExhaustedHint' : 'decisionCardRecoveryHint'));
  body.textContent = recoveryHint;
  card.append(heading, body);
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
  card.append(actions);
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

function renderStructuredBrief(container, s, raw, task) {
  container.replaceChildren();
  const badges = document.createElement('div');
  badges.className = 'summary-badges';
  const verdict = document.createElement('span');
  verdict.className = 'summary-badge';
  verdict.textContent = summaryEnumLabel('summaryVerdict', s.issue_verdict) || s.issue_verdict;
  badges.append(verdict);
  if (s.issue_verdict === 'already_fixed_upstream' && s.fixed_by) {
    const fixed = document.createElement('a');
    fixed.className = 'summary-badge summary-badge--link';
    fixed.href = s.fixed_by;
    fixed.target = '_blank';
    fixed.rel = 'noreferrer';
    fixed.textContent = s.fixed_by;
    badges.append(fixed);
  }
  if (s.reproduction && s.reproduction !== 'not_applicable') {
    // Only reproduced / not-reproduced carry signal for the reader;
    // `not_applicable` (monitoring or analysis segments) adds no information
    // and rendered as a badge it reads as duplicated noise.
    const reproduction = document.createElement('span');
    reproduction.className = 'summary-badge';
    reproduction.textContent = summaryEnumLabel('summaryReproduction', s.reproduction) || s.reproduction;
    badges.append(reproduction);
  }
  container.append(badges);

  if (task && task.state === 'waiting_for_user') {
    const pending = document.createElement('p');
    pending.className = 'summary-pending';
    pending.textContent = text('summaryPendingGate');
    container.append(pending);
  }

  if (Array.isArray(s.completed) && s.completed.length) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const title = document.createElement('strong');
    const kind = s.segment_kind ? `（${summaryEnumLabel('summarySegment', s.segment_kind)}）` : '';
    title.textContent = `📋 ${text('summaryCompletedTitle')}${kind}`;
    section.append(title);
    const list = document.createElement('ul');
    s.completed.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = String(item);
      list.append(li);
    });
    section.append(list);
    container.append(section);
  }

  const decision = s.decision && typeof s.decision === 'object' ? s.decision : null;
  if (decision && decision.route) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const title = document.createElement('strong');
    title.textContent = `📌 ${text('summaryDecisionTitle')}`;
    section.append(title);
    const route = document.createElement('p');
    route.textContent = decision.route + (decision.reason ? `（${decision.reason}）` : '');
    section.append(route);
    if (Array.isArray(decision.rejected) && decision.rejected.length) {
      const rejected = document.createElement('details');
      rejected.className = 'summary-rejected';
      const summaryLine = document.createElement('summary');
      summaryLine.textContent = text('summaryRejectedTitle');
      rejected.append(summaryLine);
      decision.rejected.forEach((item) => {
        const line = document.createElement('div');
        line.textContent = `✗ ${item.route}${item.why ? `：${item.why}` : ''}`;
        rejected.append(line);
      });
      section.append(rejected);
    }
    container.append(section);
  }

  if (s.next_step) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const title = document.createElement('strong');
    title.textContent = `⏭️ ${text('summaryNextStep')}`;
    section.append(title);
    const body = document.createElement('p');
    body.textContent = String(s.next_step);
    section.append(body);
    container.append(section);
  }

  if (Array.isArray(s.blockers) && s.blockers.length) {
    const section = document.createElement('div');
    section.className = 'summary-section';
    const title = document.createElement('strong');
    title.textContent = `⚠️ ${text('summaryBlockers')}`;
    section.append(title);
    const list = document.createElement('ul');
    s.blockers.forEach((item) => {
      const li = document.createElement('li');
      li.textContent = String(item);
      list.append(li);
    });
    section.append(list);
    container.append(section);
  }

  const receiptSource = stripSummaryBlock(raw);
  if (receiptSource) {
    const receipts = document.createElement('details');
    receipts.className = 'summary-receipts';
    const summaryLine = document.createElement('summary');
    summaryLine.textContent = text('summaryTechReceipts');
    receipts.append(summaryLine);
    const body = document.createElement('pre');
    body.className = 'summary-receipts__body';
    body.textContent = receiptSource;
    receipts.append(body);
    container.append(receipts);
  }
}

function renderIssueBrief(task) {
  const summary = String(task.lastAgentSummary || '').trim();
  const structured = task.structuredSummary && typeof task.structuredSummary === 'object'
    ? task.structuredSummary
    : null;
  if (structured) {
    renderStructuredBrief(view.issueSummary, structured, summary, task);
    view.issueSummaryMeta.textContent = task.lastAgentSummaryAt
      ? text('outcomeUpdated', { duration: relativeLabel(task.lastAgentSummaryAt) })
      : '';
  } else if (summary) {
    renderMarkdown(view.issueSummary, summary, itemUrl(task.identity && task.identity.item));
    view.issueSummaryMeta.textContent = task.lastAgentSummaryAt
      ? text('outcomeUpdated', { duration: relativeLabel(task.lastAgentSummaryAt) })
      : '';
  } else {
    view.issueSummary.replaceChildren();
    view.issueSummary.append(text('summaryEmpty'));
    view.issueSummaryMeta.textContent = '';
  }

  const evidence = taskProgressEvidence(task);
  const facts = [];
  if (task.workspacePath) {
    facts.push({ label: text('factsWorkspace'), value: compactArtifactPath(task.workspacePath) });
  }
  if (task.goalId) {
    facts.push({ label: text('factsTurn'), value: shortId(task.goalId) });
  }
  if (task.settlement && task.settlement.receiptId) {
    facts.push({ label: text('factsReceipt'), value: shortId(task.settlement.receiptId) });
  }
  if (task.modelId && task.modelId !== 'auto') {
    facts.push({ label: text('factsModel'), value: task.modelId });
  }
  if (isMonitorTodo(task) && task.currentTodo && task.currentTodo.nextDueAt) {
    facts.push({
      label: text('monitor_chip'),
      value: `${text('monitor_next_check')} ${monitorNextCheckLabel(task)}`,
    });
  }
  if (evidence.artifacts.length > 0) {
    facts.push({
      label: text('factsArtifacts'),
      value: evidence.artifacts.join(' · '),
    });
  }
  if (facts.length === 0) {
    facts.push({ label: text('factsArtifacts'), value: text('factsArtifactNone') });
  }
  const factFragment = document.createDocumentFragment();
  facts.slice(0, 6).forEach((fact) => {
    const chip = document.createElement('li');
    chip.className = 'issue-facts__chip';
    const label = document.createElement('span');
    label.className = 'issue-facts__label';
    label.textContent = fact.label;
    const value = document.createElement('strong');
    value.textContent = fact.value;
    value.title = fact.value;
    chip.append(label, value);
    factFragment.append(chip);
  });
  view.issueFacts.replaceChildren(factFragment);

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
  view.issueUpdated.textContent = task.updatedAt
    ? text('updated', { duration: relativeLabel(task.updatedAt) })
    : '';
  view.issueNumber.textContent = item && item.number
    ? `${item.kind === 'pr' ? 'PR' : 'Issue'} #${item.number}`
    : '';
  renderIssueApproval(task);
  renderIssueStatus(task);
  renderIssueBrief(task);

  const description = identityDescriptionOf(task);
  const metadataKey = itemKey(item);
  const loadingDescription = state.metadataRequests.has(metadataKey);
  const descriptionUnavailable = (state.itemMetadata.get(metadataKey) || {}).unavailable === true;
  view.issueDescriptionPanel.hidden = false;
  renderMarkdown(
    view.issueDescription,
    description || (descriptionUnavailable
      ? text('issueDescriptionUnavailable')
      : text('loadingIssueDescription')),
    url,
  );
  renderTaskActions(task);
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

function eventMessage(event) {
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
    // file path, pattern) — show it so tool rows identify what they did.
    const summary = event.details && event.details.summary;
    return summary ? `${label} · ${summary}` : label;
  }
  return event.message || event.kind || 'event';
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
  const combined = existing ? `${existing}${value}` : value;
  if (combined.length <= MAX_OUTPUT_BLOCK_CHARS) return combined;
  return `${combined.slice(0, MAX_OUTPUT_BLOCK_CHARS / 2)}\n...\n${combined.slice(-MAX_OUTPUT_BLOCK_CHARS / 2)}`;
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

function turnOutputBlockRow(block) {
  const row = document.createElement('li');
  row.className = 'log-row turn-output-row';
  row.dataset.kind = block.kind;
  row.dataset.level = block.toolState === 'failed' ? 'error' : 'info';
  row.dataset.cursor = String(block.endCursor);
  row.dataset.taskId = block.taskId;
  row.dataset.blockKey = outputBlockDomKey(block);
  row.dataset.blockVersion = outputBlockDomVersion(block);

  const header = document.createElement('div');
  header.className = 'output-block__header';

  const task = taskForId(block.taskId);
  const item = task && task.identity && task.identity.item;
  const issue = document.createElement(itemUrl(item) ? 'a' : 'span');
  issue.className = 'output-block__issue';
  issue.textContent = item ? compactItemLabel(item) : text('taskNumber', { value: shortId(block.taskId) });
  if (issue.tagName === 'A') {
    issue.href = itemUrl(item);
    issue.target = '_blank';
    issue.rel = 'noopener noreferrer';
    issue.title = issueDisplayTitle(task) || itemLabel(item);
  }

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

  header.append(issue, level, source, cursor);

  if (block.roundId) {
    const round = document.createElement('span');
    round.className = 'output-block__meta';
    round.textContent = shortId(block.roundId);
    round.title = block.roundId;
    header.append(round);
  }
  if (block.toolState) {
    const status = document.createElement('span');
    status.className = 'output-block__meta';
    status.textContent = toolStateLabel(block.toolState);
    header.append(status);
  }
  if (block.eventCount > 1) {
    const chunks = document.createElement('span');
    chunks.className = 'output-block__meta';
    chunks.textContent = text('outputChunks', { value: block.eventCount });
    header.append(chunks);
  }

  if (block.kind === 'thinking') {
    const thinkingKey = outputBlockDomKey(block);
    const details = document.createElement('details');
    details.className = 'output-block__thinking';
    // Expansion is remembered across re-renders: streaming regrows the block
    // and would otherwise collapse it under the reader.
    if (state.expandedThinking.has(thinkingKey)) details.open = true;
    details.addEventListener('toggle', () => {
      if (details.open) state.expandedThinking.add(thinkingKey);
      else state.expandedThinking.delete(thinkingKey);
    });
    const summary = document.createElement('summary');
    summary.textContent = text('outputThinkingSummary', { value: (block.text || '').length });
    const content = document.createElement('div');
    content.className = 'output-block__message';
    content.textContent = block.text || outputKindLabel(block.kind);
    details.append(summary, content);
    row.append(header, details);
    return row;
  }

  const message = document.createElement('div');
  message.className = 'output-block__message';
  message.textContent = block.text || outputKindLabel(block.kind);

  row.append(header, message);
  return row;
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
  content.textContent = eventMessage(event);

  row.append(time, source, content);
  return row;
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
    const elapsed = task.updatedAt ? relativeLabel(task.updatedAt) : '';
    detail.textContent = elapsed
      ? `${text('preparingElapsed', { duration: elapsed })} · ${text('worktreeQuiet', { item: compactItemLabel(item) })}`
      : text('worktreeQuiet', { item: compactItemLabel(item) });
  } else if (task.state === 'running' && task.phase === 'agent_running') {
    detail.textContent = text('awaitingFirstOutput');
  } else {
    detail.textContent = currentProgressDetail(task, taskEvents);
  }
  card.append(detail);
  return card;
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
    toolEvents.forEach((event) => {
      rows.push({ key: `e:${event.cursor}`, kind: 'milestone', event });
    });
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
  const desired = visibleRows.map((row) => {
    if (row.kind === 'block') {
      const node = existingBlocks.get(row.key);
      return node && node.dataset.blockVersion === outputBlockDomVersion(row.block)
        ? node
        : turnOutputBlockRow(row.block);
    }
    const node = existingEvents.get(row.key);
    return node || timelineMilestoneRow(row.event);
  });
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
  } else if (visibleRows.length) {
    view.newEvents.hidden = false;
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
    const response = await app.loopx.resolveIntake({
      input: itemUrl(item),
      modelId: task.modelId || 'auto',
    });
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
  renderIssueView();
  renderTimeline();
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
    showNotice(messages.join(' '), hasError ? 'error' : 'success');
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
      showNotice(text('resetLoopxApplied'), 'success');
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
          : (response && response.message ? response.message : text('actionApplied')),
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
  showNotice(text('loopxInstallStarted'));
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
    return;
  }
  showNotice(text('approvalSubmitting'));
  try {
    const applied = await performAction(action, task, { gateId: gate.gateId, note: note.trim() });
    if (applied && state.selectedTaskId === task.taskId) view.issueApprovalNote.value = '';
  } finally {
    syncApprovalAttention(false);
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
  const task = selectedTask();
  if (!task) return;
  void answerTaskGate(task, action, view.issueApprovalNote.value);
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
  view.issueApprovalApprove.addEventListener('click', () => answerSelectedTaskGate('approve'));
  view.issueApprovalReject.addEventListener('click', () => answerSelectedTaskGate('reject'));
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

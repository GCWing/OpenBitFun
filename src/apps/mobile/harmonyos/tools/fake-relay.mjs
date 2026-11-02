import crypto from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.PORT || 30333);
const ROOM_ID = process.env.ROOM_ID || 'harmony-preview';
const PROTECTED_USER_ID = (process.env.PROTECTED_USER_ID || '').trim();
const SCENARIO = (process.env.SCENARIO || 'default').trim();
const P = (1n << 255n) - 19n;
const A24 = 121665n;

function mod(value) {
  const result = value % P;
  return result >= 0n ? result : result + P;
}

function decodeLittleEndian(bytes) {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    value = (value << 8n) + BigInt(bytes[index]);
  }
  return value;
}

function encodeLittleEndian(value) {
  let current = mod(value);
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number(current & 255n);
    current >>= 8n;
  }
  return Buffer.from(bytes);
}

function powMod(base, exponent) {
  let result = 1n;
  let current = mod(base);
  let exp = exponent;
  while (exp > 0n) {
    if ((exp & 1n) === 1n) {
      result = mod(result * current);
    }
    current = mod(current * current);
    exp >>= 1n;
  }
  return result;
}

function scalarMult(privateKey, publicKey) {
  if (privateKey.length !== 32 || publicKey.length !== 32) {
    throw new Error('X25519 keys must be 32 bytes.');
  }

  const scalar = Uint8Array.from(privateKey);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;

  const uBytes = Uint8Array.from(publicKey);
  uBytes[31] &= 127;

  const x1 = decodeLittleEndian(uBytes);
  let x2 = 1n;
  let z2 = 0n;
  let x3 = x1;
  let z3 = 1n;
  let swap = 0;
  const k = decodeLittleEndian(scalar);

  for (let bit = 254; bit >= 0; bit--) {
    const currentBit = Number((k >> BigInt(bit)) & 1n);
    swap ^= currentBit;
    if (swap === 1) {
      [x2, x3] = [x3, x2];
      [z2, z3] = [z3, z2];
    }
    swap = currentBit;

    const a = mod(x2 + z2);
    const aa = mod(a * a);
    const b = mod(x2 - z2);
    const bb = mod(b * b);
    const e = mod(aa - bb);
    const c = mod(x3 + z3);
    const d = mod(x3 - z3);
    const da = mod(d * a);
    const cb = mod(c * b);
    x3 = mod((da + cb) * (da + cb));
    z3 = mod(x1 * mod((da - cb) * (da - cb)));
    x2 = mod(aa * bb);
    z2 = mod(e * mod(aa + A24 * e));
  }

  if (swap === 1) {
    [x2, x3] = [x3, x2];
    [z2, z3] = [z3, z2];
  }

  return encodeLittleEndian(x2 * powMod(z2, P - 2n));
}

function scalarMultBase(privateKey) {
  const base = Buffer.alloc(32);
  base[0] = 9;
  return scalarMult(privateKey, base);
}

function encryptJson(sharedKey, payload) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, nonce);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted_data: Buffer.concat([encrypted, tag]).toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

function decryptJson(sharedKey, payload) {
  const encrypted = Buffer.from(payload.encrypted_data, 'base64');
  const nonce = Buffer.from(payload.nonce, 'base64');
  const cipherText = encrypted.subarray(0, encrypted.length - 16);
  const tag = encrypted.subarray(encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(cipherText), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function generateKeyPairForAutomation() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const candidatePrivateKey = crypto.randomBytes(32);
    const candidatePublicKey = scalarMultBase(candidatePrivateKey);
    const publicKeyText = candidatePublicKey.toString('base64');
    if (!/[+/]/.test(publicKeyText)) {
      return { privateKey: candidatePrivateKey, publicKey: candidatePublicKey };
    }
  }
  const fallbackPrivateKey = crypto.randomBytes(32);
  return { privateKey: fallbackPrivateKey, publicKey: scalarMultBase(fallbackPrivateKey) };
}

const keyPair = generateKeyPairForAutomation();
const privateKey = keyPair.privateKey;
const publicKey = keyPair.publicKey;
let sharedKey = null;
let createdSession = {
  id: 'session-preview-1',
  title: '完善鸿蒙端远程控制',
  agent_type: 'code',
};
let currentWorkspace = {
  path: '/workspace/OpenBitFun',
  name: 'OpenBitFun',
  git_branch: 'main',
  workspace_kind: 'normal',
  assistant_id: undefined,
};
let activeTurn = false;
// Whether /command answers at all. A test flips this to make the desktop go
// quiet without the pairing being torn down — the exact situation the mobile
// heartbeat exists for, and one a scenario chosen at startup cannot produce.
let reachable = true;
let pollCount = 0;
let cancelled = false;
let sentMessage = '';
let sentImageCount = 0;
let toolApproved = false;
let previewDecisionAttempts = 0;
let toolRejected = false;
let toolCancelled = false;
let questionAnswered = false;
let selectedModelId = 'model-primary-preview';
let selectedReasoningPreset = null;
const deletedSessions = new Set();

const assistants = [
  {
    path: '/workspace/.openbitfun/assistants/daily',
    name: 'Daily Assistant',
    assistant_id: 'assistant-daily-preview',
  },
  {
    path: '/workspace/.openbitfun/assistants/research',
    name: 'Research Assistant',
    assistant_id: 'assistant-research-preview',
  },
];

// A file whose extension the syntax highlighter recognises, so a preview can be
// checked for a line-number gutter and coloured runs rather than only for text.
// Every kind the lexer knows appears once: comment, keyword, type, call,
// constant, string and number.
const PREVIEW_SOURCE = [
  '// openbitfun preview fixture',
  'fn main() {',
  '    let answer: Preview = 42;',
  '    println!("hello");',
  '    return true;',
  '}',
  '',
].join('\n');

const previewFiles = new Map([
  ['README.md', Buffer.from('# OpenBitFun Preview\n\nThis is a fake relay file download.\n', 'utf8')],
  ['/workspace/OpenBitFun/README.md', Buffer.from('# OpenBitFun Preview\n\nThis is a fake relay file download.\n', 'utf8')],
  ['/workspace/OpenBitFun/IDENTITY.md', Buffer.from('# Identity\n\nOpenBitFun preview identity.\n', 'utf8')],
  ['/workspace/OpenBitFun/USER.md', Buffer.from('# User\n\nOpenBitFun preview user.\n', 'utf8')],
  ['/workspace/OpenBitFun/SOUL.md', Buffer.from('# Soul\n\nOpenBitFun preview soul.\n', 'utf8')],
  ['src/preview.rs', Buffer.from(PREVIEW_SOURCE, 'utf8')],
  ['/workspace/OpenBitFun/src/preview.rs', Buffer.from(PREVIEW_SOURCE, 'utf8')],
]);

function isScenario(name) {
  return SCENARIO === name || (SCENARIO === 'mobile-ui-review' && ['model-selection', 'tool-pending-confirmation'].includes(name));
}

function assistantResponseContent() {
  if (isScenario('file-attachments')) {
    return [
      '附件应当保留为正文中的可读文件名，并在正文下方形成独立的纵向卡片列表：',
      '',
      '[IDENTITY.md](computer:///workspace/OpenBitFun/IDENTITY.md)、[USER.md](computer:///workspace/OpenBitFun/USER.md) 和 [SOUL.md](computer:///workspace/OpenBitFun/SOUL.md)。',
    ].join('\n');
  }
  if (isScenario('long-markdown')) {
    return [
      '## 鸿蒙端聊天回归验证',
      '',
      '下面是 fake relay 生成的长 Markdown 响应，用于验证 streaming 投影、Markdown parser 和文件链接渲染。',
      '',
      '- 发送后 active turn 应保持稳定。',
      '- `changed=false` 不应清空正在显示的轮次。',
      '- completed active turn 应等待最终 assistant message。',
      '',
      '> 这段引用用于确认 blockquote 降级显示不会撑破布局。',
      '',
      '```ts',
      'const controller = new ChatSessionController(manager, callbacks);',
      'controller.nudge();',
      '```',
      '',
      '| 场景 | 期望 |',
      '| --- | --- |',
      '| delayed-final | live turn 先 finalizing，最终消息稍后出现 |',
      '| long-markdown | 多 block Markdown 可读 |',
      '',
      '可下载 README.md 查看 fake relay 文件预览。'
    ].join('\n');
  }
  if (sentImageCount > 0) {
    return `收到 ${sentImageCount} 张图片，我会结合图片继续处理。`;
  }
  return '收到，我会继续处理这条指令。';
}

function finalAssistantMessageAvailable() {
  if (!sentMessage || cancelled) {
    return !!sentMessage;
  }
  if (isScenario('completed-without-final')) {
    return false;
  }
  if (isScenario('delayed-final') || isScenario('long-markdown')) {
    return !activeTurn && pollCount >= 4;
  }
  if (isScenario('changed-false-active')) {
    return !activeTurn;
  }
  return true;
}

function assistantResponseItems(status = 'completed') {
  return [
    {
      type: 'thinking',
      content: status === 'completed' ? '已完成，等待最终消息持久化。' : '正在验证连接状态修复。',
    },
    {
      type: 'text',
      content: status === 'completed' ? assistantResponseContent() : activeTurnText(),
    },
    {
      type: 'subagent',
      is_subagent: true,
      content: '子任务：验证移动端渲染',
      subItems: [
        {
          type: 'text',
          content: status === 'completed' ? '子任务已完成，结果已合并到主回复。' : '子任务正在检查 Markdown 与工具调用展示。',
        },
        {
          type: 'tool',
          tool: {
            id: `tool-subagent-${status}`,
            name: '检查渲染',
            status: status === 'completed' ? 'completed' : 'running',
            input_preview: 'mobile chat item rendering',
            result_preview: status === 'completed' ? 'subItems 顺序渲染正常。' : '',
          },
        },
      ],
    },
    {
      type: 'tool',
      tool: {
        id: `tool-item-${status}`,
        name: '运行命令',
        status: status === 'completed' ? 'completed' : 'running',
        input_preview: 'hvigor assembleApp',
        result_preview: status === 'completed' ? 'ArkTS 编译通过。' : '',
      },
    },
  ];
}

function activeTurnText() {
  if (isScenario('slow-active')) {
    return 'OpenBitFun 正在持续执行，用于验证运行态停止按钮。';
  }
  if (isScenario('long-markdown')) {
    return '## 鸿蒙端聊天回归验证\n\n- 正在生成长 Markdown 响应...\n- active turn 应保持稳定。';
  }
  return 'OpenBitFun 正在执行...';
}

function currentModelCatalog() {
  return {
    version: 1,
    models: [
      {
        id: 'model-primary-preview',
        name: 'Preview Primary',
        provider: 'fake',
        base_url: 'http://127.0.0.1/fake',
        model_name: 'preview-primary',
        context_window: 128000,
        enabled: true,
        capabilities: ['text_chat', 'code_specialized', 'function_calling'],
        ...(isScenario('model-selection') ? { reasoning: {
          status: 'known',
          presets: [
            { id: 'low', label: 'Low', order: 0 },
            { id: 'high', label: 'High', order: 1 },
          ],
        } } : {}),
      },
      {
        id: 'model-fast-preview',
        name: 'Preview Fast',
        provider: 'fake',
        base_url: 'http://127.0.0.1/fake',
        model_name: 'preview-fast',
        context_window: 32000,
        enabled: true,
        capabilities: ['text_chat'],
      },
      {
        id: 'model-vision-preview',
        name: 'Preview Vision',
        provider: 'fake',
        base_url: 'http://127.0.0.1/fake',
        model_name: 'preview-vision',
        context_window: 64000,
        enabled: true,
        capabilities: ['text_chat', 'image_understanding'],
      },
      ...(SCENARIO === 'mobile-ui-review' ? Array.from({ length: 9 }, (_, index) => ({
        id: `review-model-${index}`,
        name: 'Preview provider with a long configuration label',
        provider: index % 2 ? 'review-cloud' : 'review-local',
        model_name: `Review model ${index + 1} with extended context and reasoning support`,
        enabled: true,
        capabilities: ['text_chat'],
        context_window: 128000,
      })) : []),
    ],
    default_models: {
      primary: 'model-primary-preview',
      fast: 'model-fast-preview',
      image_understanding: 'model-vision-preview',
    },
    session_model_id: selectedModelId,
    ...(isScenario('model-selection') ? {
      reasoning_preset_selection_supported: true,
      session_reasoning_preset: selectedReasoningPreset,
    } : {}),
  };
}

function currentSessionItems() {
  const now = Date.now();
  return [
    {
      id: createdSession.id,
      session_id: createdSession.id,
      title: createdSession.title,
      name: createdSession.title,
      agent_type: createdSession.agent_type,
      status: activeTurn ? 'running' : 'idle',
      updated_at: new Date(now - 3 * 60 * 1000).toISOString(),
      created_at: new Date(now - 60 * 60 * 1000).toISOString(),
      message_count: 4,
      workspace_path: currentWorkspace.path,
      workspace_name: currentWorkspace.name,
    },
    {
      id: 'session-preview-2',
      session_id: 'session-preview-2',
      title: '整理产品方案文档',
      name: '整理产品方案文档',
      agent_type: 'cowork',
      status: 'idle',
      updated_at: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      message_count: 8,
      workspace_path: currentWorkspace.path,
      workspace_name: currentWorkspace.name,
    },
    {
      id: 'session-preview-3',
      session_id: 'session-preview-3',
      title: '验证鸿蒙端扫码连接',
      name: '验证鸿蒙端扫码连接',
      agent_type: 'code',
      status: 'idle',
      updated_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      message_count: 6,
      workspace_path: currentWorkspace.path,
      workspace_name: currentWorkspace.name,
    },
    {
      id: 'session-preview-4',
      session_id: 'session-preview-4',
      title: '对齐桌面端工具审批协议',
      name: '对齐桌面端工具审批协议',
      agent_type: 'code',
      status: 'idle',
      updated_at: new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      message_count: 11,
      workspace_path: currentWorkspace.path,
      workspace_name: currentWorkspace.name,
    },
    {
      id: 'session-preview-5',
      session_id: 'session-preview-5',
      title: '远程协作入口审阅',
      name: '远程协作入口审阅',
      agent_type: 'cowork',
      status: 'idle',
      updated_at: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date(now - 9 * 24 * 60 * 60 * 1000).toISOString(),
      message_count: 3,
      workspace_path: currentWorkspace.path,
      workspace_name: currentWorkspace.name,
    },
  ].filter(item => !deletedSessions.has(item.session_id));
}

function currentMessages() {
  const messages = [
    {
      id: 'msg-user-1',
      role: 'user',
      content: '完善鸿蒙端远程连接和聊天控制能力',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: 'msg-assistant-1',
      role: 'assistant',
      content: '我来帮你完善鸿蒙端远程控制流程。\n```ts\nawait manager.listSessions(8, 0, query, agentType);\n```\n可以下载 README.md 查看 fake relay 文件预览。',
      thinking: '检查配对、会话创建、轮询和工具审批链路。',
      timestamp: new Date(Date.now() - 45_000).toISOString(),
      tools: [
        { id: 'tool-1', name: '搜索代码', status: 'completed', input_preview: 'entry/src/main/ets', result_preview: '找到连接页、聊天页和远程 manager。' },
        { id: 'tool-2', name: '读取文件', status: 'completed', input_preview: 'RemoteSessionManager.ets', result_preview: '确认远程命令通过 relay 加密发送。' },
        { id: 'tool-3', name: '运行构建', status: activeTurn ? 'running' : 'completed', input_preview: 'hvigor assembleApp', result_preview: 'ArkTS 编译通过。' },
      ],
    },
  ];
  if (sentMessage) {
    messages.push({
      id: 'msg-user-sent',
      role: 'user',
      content: sentImageCount > 0 ? `${sentMessage}\n\n[${sentImageCount} image(s)]` : sentMessage,
      timestamp: new Date(Date.now() - 15_000).toISOString(),
    });
    if (finalAssistantMessageAvailable()) {
      messages.push({
        id: 'msg-assistant-sent',
        role: 'assistant',
        content: cancelled ? '已停止当前任务。' : assistantResponseContent(),
        thinking: cancelled ? '停止执行并整理当前状态。' : '继续分析用户补充指令。',
        items: cancelled ? [] : assistantResponseItems('completed'),
        timestamp: new Date(Date.now() - 5_000).toISOString(),
        tools: [
          {
            id: 'tool-sent-1',
            name: '运行命令',
            status: toolCancelled ? 'cancelled' : cancelled ? 'cancelled' : 'completed',
            input_preview: 'hvigor assembleApp',
            result_preview: toolCancelled ? '工具调用已取消。' : cancelled ? '任务已取消。' : 'BUILD SUCCESSFUL',
          },
          {
            id: 'tool-question-1',
            name: 'AskUserQuestion',
            status: questionAnswered ? 'completed' : 'pending',
            input_preview: JSON.stringify({
              questions: [
                {
                  header: '确认',
                  question: '是否继续执行 fake relay 预览流程？',
                },
              ],
            }),
            result_preview: questionAnswered ? '用户已回答。' : '',
          },
        ],
      });
    }
  }
  return messages;
}

function activeTurnPayload(status = 'active') {
  const text = status === 'completed'
    ? assistantResponseContent()
    : activeTurnText();
  return {
    turn_id: 'turn-preview-1',
    status,
    text,
    thinking: status === 'completed' ? '已完成，等待最终消息持久化。' : '正在验证连接状态修复。',
    round_index: 1,
    items: assistantResponseItems(status),
    tools: [
      {
        id: 'tool-active-1',
        name: '运行命令',
        status: 'pending_confirmation',
        input_preview: 'hvigor assembleApp',
        result_preview: '此命令需要移动端确认后继续执行。',
      },
      {
        id: 'tool-active-2',
        name: 'AskUserQuestion',
        status: questionAnswered ? 'completed' : 'pending',
        input_preview: JSON.stringify({
          questions: [
            {
              header: '确认',
              question: '是否继续执行 fake relay 预览流程？',
            },
          ],
        }),
        result_preview: questionAnswered ? '用户已回答。' : '',
      },
      {
        id: 'tool-active-3',
        name: '长时间任务',
        status: toolCancelled ? 'cancelled' : status === 'completed' ? 'completed' : 'running',
        input_preview: 'sleep 10',
        result_preview: toolCancelled ? '工具调用已取消。' : status === 'completed' ? '任务已完成。' : '',
      },
    ],
  };
}

/**
 * The desktop treats a missing, empty or root `workspace_path` as "no workspace
 * open" and refuses the command. Mirrored here so a client that forgets to send
 * it fails against the simulator too, instead of only in the field.
 * See `RemoteCommand::ListSessions` in `services-integrations/src/remote_connect.rs`.
 */
function hasWorkspacePath(command) {
  const path = String(command.workspace_path || '').trim();
  return path.length > 0 && path !== '/';
}

function isClawAgent(agentType) {
  return String(agentType || '').trim().toLowerCase() === 'claw';
}

function noWorkspaceError() {
  return {
    resp: 'error',
    message: 'No workspace is open on the remote device; select a recent workspace or create one first',
  };
}

function responseFor(command) {
  switch (command.cmd) {
    case 'get_workspace_info':
      return {
        resp: 'ok',
        has_workspace: true,
        path: currentWorkspace.path,
        project_name: currentWorkspace.name,
        git_branch: currentWorkspace.git_branch,
        workspace_kind: currentWorkspace.workspace_kind,
        assistant_id: currentWorkspace.assistant_id,
      };
    case 'list_recent_workspaces':
      return {
        resp: 'ok',
        workspaces: [
          {
            path: currentWorkspace.path,
            name: currentWorkspace.name,
            last_opened: new Date().toISOString(),
            workspace_kind: currentWorkspace.workspace_kind,
          },
          {
            path: '/workspace/OpenBitFun_mobile',
            name: 'OpenBitFun_mobile',
            last_opened: new Date(Date.now() - 86_400_000).toISOString(),
            workspace_kind: 'normal',
          },
          {
            path: '/workspace/OpenBitFun-docs',
            name: 'OpenBitFun-docs',
            last_opened: new Date(Date.now() - 2 * 86_400_000).toISOString(),
            workspace_kind: 'normal',
          },
        ],
      };
    case 'set_workspace':
      {
        const path = String(command.path || '').trim();
        if (!path) {
          return { resp: 'ok', success: false, error: 'Missing workspace path' };
        }
        const parts = path.replace(/\\/g, '/').split('/');
        currentWorkspace = {
          path,
          name: parts[parts.length - 1] || 'Workspace',
          git_branch: path.includes('docs') ? 'docs' : 'main',
          workspace_kind: 'normal',
          assistant_id: undefined,
        };
        return {
          resp: 'ok',
          success: true,
          path: currentWorkspace.path,
          project_name: currentWorkspace.name,
        };
      }
    case 'list_assistants':
      return {
        resp: 'ok',
        assistants,
      };
    case 'set_assistant':
      {
        const path = String(command.path || '').trim();
        const assistant = assistants.find(item => item.path === path) || assistants[0];
        currentWorkspace = {
          path: assistant.path,
          name: assistant.name,
          git_branch: '',
          workspace_kind: 'assistant',
          assistant_id: assistant.assistant_id,
        };
        return {
          resp: 'ok',
          success: true,
          path: currentWorkspace.path,
          name: currentWorkspace.name,
        };
      }
    case 'list_sessions':
      {
        if (!hasWorkspacePath(command)) {
          return noWorkspaceError();
        }
        const allSessions = currentSessionItems();
        const query = String(command.query || '').trim().toLowerCase();
        const agentType = String(command.agent_type || '').trim().toLowerCase();
        const filtered = allSessions.filter(item => {
          const matchesQuery = !query || String(item.title || '').toLowerCase().includes(query);
          const matchesAgent = !agentType || item.agent_type === agentType;
          return matchesQuery && matchesAgent;
        });
        const offset = Number(command.offset || 0);
        const limit = Math.max(1, Number(command.limit || 8));
        const page = filtered.slice(offset, offset + limit);
        return {
          resp: 'ok',
          sessions: page,
          has_more: offset + page.length < filtered.length,
        };
      }
    case 'create_session':
      if (!isClawAgent(command.agent_type) && !hasWorkspacePath(command)) {
        return noWorkspaceError();
      }
      createdSession = {
        id: 'session-created-preview',
        title: command.session_name || 'New Session',
        agent_type: command.agent_type || 'code',
      };
      activeTurn = false;
      cancelled = false;
      sentMessage = '';
      sentImageCount = 0;
      toolApproved = false;
      toolRejected = false;
      toolCancelled = false;
      questionAnswered = false;
      deletedSessions.delete(createdSession.id);
      return { resp: 'ok', session_id: createdSession.id, title: createdSession.title };
    case 'delete_session':
      deletedSessions.add(command.session_id);
      return { resp: 'ok', session_id: command.session_id };
    case 'get_model_catalog':
      return {
        resp: 'ok',
        catalog: currentModelCatalog(),
      };
    case 'get_permission_mode':
      return {
        resp: 'ok',
        mode: 'ask',
      };
    case 'set_permission_mode':
      return {
        resp: 'ok',
        mode: command.mode || 'ask',
      };
    case 'set_session_model':
      selectedModelId = command.model_id || selectedModelId;
      if (isScenario('model-selection')) selectedReasoningPreset = command.reasoning_preset ?? null;
      return {
        resp: 'ok',
        session_id: command.session_id,
        model_id: selectedModelId,
        ...(isScenario('model-selection') ? { reasoning_preset: selectedReasoningPreset } : {}),
      };
    case 'get_session_messages':
      if (command.before_message_id) {
        return {
          resp: 'ok',
          messages: [
            {
              id: 'msg-older-1',
              role: 'assistant',
              content: '这是更早的会话上下文。',
              timestamp: new Date(Date.now() - 3_600_000).toISOString(),
            },
          ],
          has_more: false,
        };
      }
      return {
        resp: 'ok',
        messages: currentMessages(),
        has_more: true,
      };
    case 'send_message':
      sentMessage = command.content || '';
      sentImageCount = Array.isArray(command.image_contexts) ? command.image_contexts.length : 0;
      activeTurn = true;
      pollCount = 0;
      cancelled = false;
      toolApproved = false;
      toolRejected = false;
      toolCancelled = false;
      questionAnswered = false;
      return { resp: 'ok', turn_id: 'turn-preview-1' };
    case 'poll_session':
      pollCount += 1;
      if (activeTurn && isScenario('changed-false-active') && pollCount === 2) {
        return {
          resp: 'ok',
          version: command.since_version || 0,
          changed: false,
          session_state: 'running',
          title: createdSession.title,
          new_messages: [],
          total_msg_count: currentMessages().length,
        };
      }
      if (activeTurn && isScenario('tool-pending-confirmation') && !toolApproved && !toolRejected && !cancelled) {
        const response = {
          resp: 'ok',
          version: (command.since_version || 0) + 1,
          changed: true,
          session_state: 'running',
          title: createdSession.title,
          new_messages: [],
          total_msg_count: currentMessages().length,
          active_turn: activeTurnPayload('active'),
        };
        if ((command.known_model_catalog_version || 0) !== currentModelCatalog().version) {
          response.model_catalog = currentModelCatalog();
        }
        return response;
      }
      if (activeTurn && isScenario('slow-active') && !cancelled) {
        const response = {
          resp: 'ok',
          version: (command.since_version || 0) + 1,
          changed: true,
          session_state: 'running',
          title: createdSession.title,
          new_messages: [],
          total_msg_count: currentMessages().length,
          active_turn: activeTurnPayload('active'),
        };
        if ((command.known_model_catalog_version || 0) !== currentModelCatalog().version) {
          response.model_catalog = currentModelCatalog();
        }
        return response;
      }
      if (activeTurn && (isScenario('completed-without-final') || isScenario('delayed-final') || isScenario('long-markdown')) && pollCount >= 2) {
        const shouldPersistFinal = !isScenario('completed-without-final') && pollCount >= 4;
        if (shouldPersistFinal) {
          activeTurn = false;
        }
        const response = {
          resp: 'ok',
          version: (command.since_version || 0) + 1,
          changed: true,
          session_state: shouldPersistFinal ? 'idle' : 'running',
          title: createdSession.title,
          new_messages: shouldPersistFinal ? currentMessages().slice(-1) : [],
          total_msg_count: currentMessages().length,
        };
        if (!shouldPersistFinal) {
          response.active_turn = activeTurnPayload('completed');
        }
        if ((command.known_model_catalog_version || 0) !== currentModelCatalog().version) {
          response.model_catalog = currentModelCatalog();
        }
        return response;
      }
      if (!activeTurn || cancelled || toolApproved || toolRejected || (command.since_version || 0) > 1) {
        activeTurn = false;
        const response = {
          resp: 'ok',
          version: (command.since_version || 0) + 1,
          changed: true,
          session_state: cancelled || toolRejected ? 'cancelled' : 'idle',
          title: createdSession.title,
          new_messages: sentMessage ? currentMessages().slice(-2) : [],
          total_msg_count: currentMessages().length,
        };
        if ((command.known_model_catalog_version || 0) !== currentModelCatalog().version) {
          response.model_catalog = currentModelCatalog();
        }
        return response;
      }
      {
        const response = {
        resp: 'ok',
        version: (command.since_version || 0) + 1,
        changed: true,
        session_state: 'running',
        title: createdSession.title,
        new_messages: [],
        total_msg_count: currentMessages().length,
        active_turn: activeTurnPayload('active'),
      };
        if ((command.known_model_catalog_version || 0) !== currentModelCatalog().version) {
          response.model_catalog = currentModelCatalog();
        }
        return response;
      }
    case 'confirm_tool':
      if (SCENARIO === 'mobile-ui-review' && previewDecisionAttempts++ === 0) {
        return { resp: 'error', message: 'Preview: decision submission failed; retry is available.' };
      }
      toolApproved = true;
      activeTurn = false;
      return { resp: 'ok' };
    case 'reject_tool':
      toolRejected = true;
      cancelled = true;
      activeTurn = false;
      return { resp: 'ok' };
    case 'cancel_task':
      cancelled = true;
      activeTurn = false;
      return { resp: 'ok' };
    case 'cancel_tool':
      toolCancelled = true;
      return { resp: 'ok', action: 'cancel_tool', target_id: command.tool_id };
    case 'answer_question':
      questionAnswered = true;
      return { resp: 'ok' };
    case 'get_file_info':
      {
        const path = String(command.path || '');
        const content = previewFiles.get(path) || Buffer.from(`Preview file for ${path || 'unknown'}\n`, 'utf8');
        const parts = path.replace(/\\/g, '/').split('/');
        return {
          resp: 'ok',
          name: parts[parts.length - 1] || 'preview.txt',
          size: content.length,
          mime_type: path.endsWith('.md') ? 'text/markdown' : 'text/plain',
        };
      }
    case 'read_file_chunk':
      {
        const path = String(command.path || '');
        const content = previewFiles.get(path) || Buffer.from(`Preview file for ${path || 'unknown'}\n`, 'utf8');
        const offset = Math.max(0, Number(command.offset || 0));
        const limit = Math.max(1, Number(command.limit || content.length));
        const chunk = content.subarray(offset, Math.min(content.length, offset + limit));
        const parts = path.replace(/\\/g, '/').split('/');
        return {
          resp: 'ok',
          name: parts[parts.length - 1] || 'preview.txt',
          chunk_base64: chunk.toString('base64'),
          offset,
          chunk_size: chunk.length,
          total_size: content.length,
          mime_type: path.endsWith('.md') ? 'text/markdown' : 'text/plain',
        };
      }
    case 'update_session_title':
      createdSession = {
        id: createdSession.id,
        title: command.title || createdSession.title,
        agent_type: createdSession.agent_type,
      };
      return { resp: 'ok', title: createdSession.title };
    case 'ping':
      return { resp: 'ok' };
    default:
      return { resp: 'error', message: `Unsupported command: ${command.cmd}` };
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readBody(req);
    // POST {"reachable": false} to make the relay behave as it does when the
    // desktop has gone: the room still exists, so pairing is untouched, but no
    // command gets through. Test-only; nothing in either app calls it.
    if (req.url === '/control/reachable') {
      reachable = body.reachable !== false;
      console.log(`control reachable=${reachable}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ resp: 'ok', reachable }));
      return;
    }
    if (req.url === `/api/rooms/${ROOM_ID}/pair`) {
      const mobilePublicKey = Buffer.from(body.public_key, 'base64');
      sharedKey = scalarMult(privateKey, mobilePublicKey);
      // Shape must match PairingChallenge in
      // src/crates/services/services-integrations/src/remote_connect/pairing.rs:
      // a flat 32-char lowercase-hex string plus a unix-seconds timestamp. The
      // desktop validates the echo against exactly that, so a stub that sends
      // anything else only passes because nothing here checks it back.
      const payload = encryptJson(sharedKey, {
        challenge: crypto.randomBytes(16).toString('hex'),
        timestamp: Math.floor(Date.now() / 1000),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === `/api/rooms/${ROOM_ID}/command`) {
      if (!reachable) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (!sharedKey) throw new Error('Not paired');
      const command = decryptJson(sharedKey, body);
      console.log('command', command.cmd || 'pair_challenge', command.session_id || '', command.workspace_path || '');
      const response = command.challenge_echo
        ? PROTECTED_USER_ID && command.user_id !== PROTECTED_USER_ID
          ? {
              resp: 'error',
              message: 'This remote URL is already protected by a different user ID.',
            }
          : {
              resp: 'ok',
              has_workspace: true,
              path: currentWorkspace.path,
              project_name: currentWorkspace.name,
              git_branch: currentWorkspace.git_branch,
              workspace_kind: currentWorkspace.workspace_kind,
              assistant_id: currentWorkspace.assistant_id,
              authenticated_user_id: command.user_id,
              sessions: currentSessionItems().slice(0, 8),
              has_more_sessions: currentSessionItems().length > 8,
            }
        : responseFor(command);
      if (SCENARIO === 'mobile-ui-review' && ['confirm_tool', 'reject_tool'].includes(command.cmd)) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      const payload = encryptJson(sharedKey, response);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const relay = `http://127.0.0.1:${PORT}`;
  const url = `${relay}/#/pair?room=${encodeURIComponent(ROOM_ID)}&pk=${encodeURIComponent(publicKey.toString('base64'))}&relay=${encodeURIComponent(relay)}`;
  const automationUrl = `${relay}/#/pair?room=${ROOM_ID}&pk=${publicKey.toString('base64')}`;
  console.log(`Fake relay listening on ${relay}`);
  console.log(`Scenario: ${SCENARIO}`);
  console.log(url);
  console.log(`Automation URL: ${automationUrl}`);
  console.log(`Escaped automation URL: ${automationUrl.replace(/&/g, '\\&')}`);
});

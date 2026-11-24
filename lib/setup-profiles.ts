import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { endpoint } from './config.ts';

export type Agent = 'openclaw' | 'hermes';
export type Model = { id: string; label: string; context: number; output: number; vision: boolean };
export type Telegram = { token: string; userId: string };
export const capabilityNames = ['read', 'write', 'shell', 'browser', 'screen', 'schedule', 'send', 'outside', 'vault', 'sudo', 'accounts', 'skills', 'awake'] as const;
export type Permissions = Partial<Record<(typeof capabilityNames)[number], boolean>>;
export function parsePermissions(value: unknown): Permissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  return Object.fromEntries(capabilityNames.map(name => [name, raw[name] === true]));
}
export const preferredModel = 'cbgpu-qwen38';
export const minimumContext: Record<Agent, number> = { openclaw: 16000, hermes: 64000 };
export const validKey = (value: unknown): value is string =>
  typeof value === 'string' && /^cbgpu_ai_[a-zA-Z0-9_-]{12,250}$/.test(value);

export function modelsFromCatalog(raw: unknown): Model[] {
  if (!Array.isArray(raw)) return [];
  const models: Model[] = [];
  for (const row of raw) {
    if (!row || row.ready === false || typeof row.id !== 'string' || !/^cbgpu-[a-z0-9-]{1,60}$/.test(row.id)) continue;
    if (!Array.isArray(row.capabilities) || !row.capabilities.includes('tools')) continue;
    if (!Number.isSafeInteger(row.context_window) || row.context_window < 1024 || row.context_window > 1048576) continue;
    if (!Number.isSafeInteger(row.max_output_tokens) || row.max_output_tokens < 1 || row.max_output_tokens >= row.context_window) continue;
    models.push({
      id: row.id, label: typeof row.name === 'string' ? row.name.slice(0, 80) : row.id,
      context: row.context_window, output: row.max_output_tokens,
      vision: row.capabilities.includes('vision') || row.capabilities.includes('image'),
    });
  }
  return models.sort((a, b) => Number(b.id === preferredModel) - Number(a.id === preferredModel));
}

export const validTelegramToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[0-9]{5,20}:[A-Za-z0-9_-]{25,100}$/.test(token);

export function parseTelegram(token: unknown, userId: unknown): Telegram | null {
  if (!token && !userId) return null;
  if (!validTelegramToken(token)) throw new Error('BotFather에서 받은 봇 토큰을 콜론 앞뒤 전체 복사해 주세요.');
  if (typeof userId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(userId)) {
    throw new Error('Telegram 봇 토큰과 내 숫자 사용자 ID를 모두 입력해 주세요.');
  }
  return { token, userId };
}

export function serverSetupPrompt(agent: Agent, input: Record<string, unknown>) {
  const modelId = input.model;
  const context = input.context;
  const output = input.output;
  if (typeof modelId !== 'string' || !/^cbgpu-[a-z0-9-]{1,60}$/.test(modelId) ||
      typeof context !== 'number' || !Number.isSafeInteger(context) || context < minimumContext[agent] || context > 1048576 ||
      typeof output !== 'number' || !Number.isSafeInteger(output) || output < 1 || output >= context) {
    throw new Error('CBGPU 모델을 먼저 확인하고 선택해 주세요.');
  }
  const telegram = input.telegram === true;
  const userId = input.user;
  if (telegram && (typeof userId !== 'string' || !/^[1-9][0-9]{0,15}$/.test(userId))) {
    throw new Error('Telegram에서 봇에게 말할 내 숫자 사용자 ID를 입력해 주세요.');
  }
  const openClaw = agent === 'openclaw';
  const name = openClaw ? 'OpenClaw' : 'Hermes Agent';
  const permissions = parsePermissions(input.permissions);
  const enabled = capabilityNames.filter(key => permissions[key]);
  return [
    `현재 접속한 Linux 서버에 ${name}를 설치하고 CBGPU에 연결해 주세요. 이미 설치된 런타임과 프로필은 재사용하고 기존 설정과 작업 파일을 보존하세요.`,
    openClaw ? '공식 설치 및 설정 문서는 https://docs.openclaw.ai/install 과 https://docs.openclaw.ai/gateway/config-tools/custom-providers 를 사용하세요.'
      : '공식 설치는 https://github.com/NousResearch/hermes-agent 를, 설정은 https://hermes-agent.nousresearch.com/docs/integrations/providers 와 https://hermes-agent.nousresearch.com/docs/user-guide/messaging 를 사용하세요.',
    `OpenAI 호환 API는 ${endpoint} 입니다. 모델 ID는 ${modelId}, 대화 길이는 ${context}토큰, 최대 출력은 ${output}토큰, 이미지 입력은 ${input.vision === true ? '지원' : '미지원'}입니다.`,
    openClaw ? `공급자 이름을 cbgpu, API 형식을 openai-completions, 기본 모델을 cbgpu/${modelId}로 설정하세요.`
      : `model.provider를 custom, model.base_url을 위 API 주소, model.default를 ${modelId}, model.key_env를 CBGPU_API_KEY로 맞추세요.`,
    'API 키는 서버에서 CBGPU_API_KEY라는 비밀 환경변수로 읽으세요. 값이 비어 있으면 시스템의 비밀 설정에 직접 입력할 위치를 알려주세요. 키를 채팅, 명령 인자, 소스 또는 로그에 남기지 마세요.',
    telegram
      ? `Telegram 봇 토큰은 서버의 비밀 설정 TELEGRAM_BOT_TOKEN에서 읽으세요. ${userId} 계정의 개인 메시지만 받고 그룹을 비활성화하세요. 설치 검증에는 봇 정보 확인(getMe)만 사용하세요.`
      : '신규 설정에서 Telegram을 사용하지 않아요. 기존에 설정된 채널은 보존하세요.',
    `허용할 권한은 ${enabled.length ? enabled.join(', ') : '없음'}입니다. 선택하지 않은 도구 권한은 부여하지 마세요. Linux 서버에 화면 세션이나 키체인이 없으면 관련 권한의 설정이 필요한지 알려주세요. sudo는 OS의 승인 절차를 따르고 암호를 저장하지 마세요.`,
    input.autoStart === true ? '서버가 다시 켜질 때도 시작하도록 자동 실행을 설정하세요. systemd 서버는 서비스, 컨테이너는 재시작 정책과 영구 볼륨을 사용하세요.'
      : '자동 실행은 끄고 수동 시작 명령을 알려주세요.',
    '관리 인터페이스는 로컬 또는 이미 승인된 비공개 접근 경로로 유지하세요. 설정 후 CBGPU 모델 조회와 짧은 답변 요청을 검증하고, 실행 상태와 다시 시작하는 방법을 알려주세요.',
  ].join('\n\n');
}

export function makeProfile(agent: Agent, model: Model, root: string, telegram: Telegram | null, permissions: Permissions = {}) {
  if (model.context < minimumContext[agent]) throw new Error('이 모델은 에이전트에 필요한 대화 길이를 지원하지 않아요.');
  const workspace = path.join(root, 'workspace');
  const gatewayToken = randomBytes(32).toString('base64url');
  if (permissions.screen && !['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('이 운영체제에서는 화면 제어를 지원하지 않아요.');
  if (permissions.screen && agent === 'openclaw' && !model.vision) throw new Error('OpenClaw에서 화면을 제어하려면 이미지 입력을 지원하는 모델이 필요해요.');
  if (permissions.sudo && (agent !== 'hermes' || !permissions.shell || !['linux','darwin'].includes(process.platform))) throw new Error('sudo 인증은 Linux·macOS의 Hermes에서 명령 실행을 켠 뒤 사용할 수 있어요.');
  if (permissions.vault && (agent !== 'hermes' || !permissions.browser)) throw new Error('저장된 로그인은 Hermes의 브라우저 조작과 함께 사용할 수 있어요.');
  if (permissions.accounts && !permissions.browser && !permissions.screen) throw new Error('로그인과 가입을 하려면 브라우저 또는 화면 조작 권한을 켜 주세요.');
  if (permissions.skills && !permissions.shell) throw new Error('스킬을 설치하려면 명령 실행 권한도 켜 주세요.');
  if (permissions.browser && agent === 'hermes' && !permissions.shell) throw new Error('Hermes의 브라우저 조작에는 터미널 권한도 필요해요. 두 권한을 함께 선택해 주세요.');
  if (agent === 'openclaw') {
    const allow = ['session_status',
      ...(permissions.read ? ['read'] : []),
      ...(permissions.write ? ['edit', 'write', 'apply_patch'] : []),
      ...(permissions.shell ? ['exec', 'process'] : []),
      ...(permissions.browser ? ['browser', 'web_fetch'] : []),
      ...(permissions.screen ? ['computer'] : []),
      ...(permissions.schedule ? ['automations'] : []),
      ...(permissions.send && telegram ? ['message'] : []),
    ];
    return {
      filename: 'openclaw.json',
      config: {
        gateway: { mode: 'local', bind: 'loopback', port: 19349, auth: { mode: 'token', token: gatewayToken } },
        models: { mode: 'replace', providers: { cbgpu: {
          baseUrl: endpoint, api: 'openai-completions', apiKey: { source: 'env', provider: 'default', id: 'CBGPU_API_KEY' },
          models: [{ id: model.id, name: model.label, input: model.vision ? ['text', 'image'] : ['text'], contextWindow: model.context, maxTokens: model.output }],
        } } },
        tools: { allow, fs: { workspaceOnly: !permissions.outside }, elevated: { enabled: false },
          exec: { security: permissions.shell ? 'allowlist' : 'deny', ask: 'always' } },
        ...(permissions.screen && process.platform !== 'darwin' &&
          { plugins: { entries: { 'cua-computer': { enabled: true } } } }),
        agents: { defaults: { workspace, model: { primary: 'cbgpu/' + model.id } } },
        ...(telegram && { channels: { telegram: {
          enabled: true, dmPolicy: 'allowlist', allowFrom: [telegram.userId], groupPolicy: 'disabled',
        } } }),
      },
    };
  }
  const tools = ['clarify', 'no_mcp',
    ...(permissions.read || permissions.write ? ['file'] : []),
    ...(permissions.shell ? ['terminal'] : []),
    ...(permissions.browser ? ['browser', 'web'] : []),
    ...(permissions.screen ? ['computer_use'] : []),
    ...(permissions.schedule ? ['cronjob'] : []),
    ...(permissions.skills ? ['skills'] : []),
  ];
  const disabled = [
    ...(!permissions.read ? ['read_file', 'search_files'] : []),
    ...(!permissions.write ? ['write_file', 'patch'] : []),
    ...(!permissions.send ? ['send_message'] : []),
    ...(!permissions.vault ? ['browser_vault'] : []),
  ];
  return {
    filename: 'config.yaml',
    config: {
      model: { provider: 'custom', default: model.id, base_url: endpoint, key_env: 'CBGPU_API_KEY', context_length: model.context, max_tokens: model.output },
      toolsets: tools, platform_toolsets: { cli: tools, telegram: tools, cron: tools },
      agent: { disabled_toolsets: disabled },
      approvals: { mode: 'manual', cron_mode: 'deny', unattended_mode: 'deny' },
      computer_use: { permission_mode: 'standard', autostart: false },
      terminal: { cwd: workspace, backend: 'local' },
      vault: { key_storage: 'keychain' },
    },
  };
}

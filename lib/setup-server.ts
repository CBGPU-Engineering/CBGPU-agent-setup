import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, get as httpsGet } from 'node:https';
import os from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { getCACertificates } from 'node:tls';
import path from 'node:path';
import { endpoint } from './config.ts';
import { client, page, stylesheet } from './setup-page.ts';
import { makeProfile, modelsFromCatalog, parsePermissions, parseTelegram, serverSetupPrompt, validKey, validTelegramToken, type Agent } from './setup-profiles.ts';
import { findRuntime, installRuntime, prepareDesktop, openBrowser, runtimeEnvironment } from './setup-runtime.ts';
import { configureAutostart, configureManualLauncher, saveSetupFile } from './setup-autostart.ts';
import { readSetupLogo, setupLogos } from './setup-assets.ts';
import { inhibitSleep } from './setup-power.ts';
import { readHermesModel } from './setup-config.ts';

export const systemRoot = path.join(os.homedir(), '.config', 'cbgpu-agent', 'setup');
const parseAgent = (value: unknown): Agent => {
  if (value !== 'openclaw' && value !== 'hermes') throw new Error('설치할 에이전트를 선택해 주세요.');
  return value;
};
const agents: Agent[] = ['openclaw', 'hermes'];

async function jsonBody(request: IncomingMessage) {
  if (request.headers['content-type'] !== 'application/json') throw new Error('설치 화면에서 다시 시도해 주세요.');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error('입력한 값이 너무 길어요.');
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('입력 내용을 확인해 주세요.');
  return value;
}

async function modelCatalog(key: unknown) {
  if (!validKey(key)) throw new Error('CBGPU에서 만든 API 키를 입력해 주세요.');
  let response;
  try {
    response = await fetch(endpoint + '/models', {
      headers: { authorization: 'Bearer ' + key }, redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error('CBGPU에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'); }
  if (response.status === 401 || response.status === 403) throw new Error('사용할 수 없는 API 키예요. CBGPU에서 키를 확인해 주세요.');
  if (!response.ok) throw new Error('모델 목록을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.');
  return modelsFromCatalog((await response.json()).data);
}

type TelegramRequest = (url: string, options: { signal: AbortSignal; redirect: 'manual' }) => Promise<Response>;
let telegramAgent: HttpsAgent | undefined;

const telegramRequest: TelegramRequest = (url, { signal }) => new Promise((resolve, reject) => {
  // Only Telegram uses this agent. Local setup requests keep their loopback connection.
  if (!telegramAgent) {
    const options = {
      ca: [...new Set([...getCACertificates('default'), ...getCACertificates('system')])],
      // Node supports this option even though the pinned Node 22 types omit it.
      proxyEnv: process.env,
    };
    telegramAgent = new HttpsAgent(options);
  }
  const request = httpsGet(url, { agent: telegramAgent, signal, headers: { accept: 'application/json' } }, response => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) { response.destroy(new Error('Unexpected Telegram response size')); return; }
      chunks.push(chunk);
    });
    response.once('error', reject);
    response.once('end', () => {
      const status = response.statusCode ?? 502;
      resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks).toString('utf8'), { status }));
    });
  });
  request.once('error', reject);
});

async function verifyTelegramBot(token: unknown, request: TelegramRequest) {
  if (!validTelegramToken(token)) throw new Error('BotFather에서 받은 봇 토큰을 콜론 앞뒤 전체 복사해 주세요.');
  const url = 'https://api.telegram.org/bot' + token + '/getMe';
  async function attempt(retry: boolean): Promise<{ username: string | null }> {
    let response: Response;
    try {
      response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) throw new Error('이 컴퓨터에서 Telegram 인증서를 확인하지 못했어요. 네트워크의 인증서 설정을 확인해 주세요.');
      if (retry) { await wait(400); return attempt(false); }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') throw new Error('이 컴퓨터에서 Telegram 주소를 찾지 못했어요. 인터넷 연결과 DNS를 확인해 주세요.');
      throw new Error('이 컴퓨터에서 Telegram에 연결하지 못했어요. 네트워크나 프록시 설정을 확인해 주세요.');
    }
    const result = await response.json().catch(() => null);
    if (response.ok && result?.ok === true && result.result?.is_bot === true) {
      const username = result.result.username;
      return { username: typeof username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null };
    }
    if ([401, 404].includes(response.status) && result?.ok === false && result.error_code === response.status) {
      throw new Error('Telegram이 봇 토큰을 거부했어요 (' + response.status + '). BotFather에서 현재 토큰을 확인해 주세요.');
    }
    if (response.status === 429) {
      const delay = result?.parameters?.retry_after;
      const when = Number.isSafeInteger(delay) && delay > 0 && delay < 86400 ? delay + '초 뒤' : '잠시 뒤';
      throw new Error('Telegram에 연결 확인 요청이 많아요. ' + when + ' 다시 확인해 주세요.');
    }
    if (response.status === 408 || response.status >= 500) {
      if (retry) { await wait(400); return attempt(false); }
      throw new Error('Telegram 서버가 연결 확인에 응답하지 못했어요 (HTTP ' + response.status + '). 잠시 뒤 다시 확인해 주세요.');
    }
    if (response.status === 403) throw new Error('현재 네트워크에서 Telegram에 접근할 수 없어요 (HTTP 403). 네트워크나 프록시 설정을 확인해 주세요.');
    throw new Error('Telegram 연결 확인에 예상과 다른 응답이 왔어요 (HTTP ' + response.status + '). 네트워크 설정을 확인해 주세요.');
  }
  return attempt(true);
}

export function startSetup({
  root = systemRoot, browser = true, port = 0, portable = false, getModels = modelCatalog, enroll = configureAutostart,
  shortcut = configureManualLauncher,
  install = installRuntime, runtime = findRuntime, fetchBot = telegramRequest, prepareScreen = prepareDesktop,
} = {}) {
  const ticket = randomBytes(24).toString('base64url');
  let origin = '';
  let busy = false;
  let runtimeReady = false;
  const running = new Map<Agent, ChildProcess>();
  async function save(folder: string, filename: string, value: unknown, text = false) {
    await saveSetupFile(folder, filename, text ? String(value) : JSON.stringify(value, null, 2) + '\n');
  }
  async function read(folder: string, filename: string) {
    return JSON.parse(await readFile(path.join(folder, filename), 'utf8'));
  }
  async function readSelection() {
    return await read(root, 'selection.json').catch(() => null);
  }
  async function loginOptions() {
    const current = await read(root, 'autostart.json').catch(() => null);
    if (current) return { openclaw: current.openclaw === true, hermes: current.hermes === true };
    const old = await readSelection();
    return { openclaw: old?.autoStart === true && old.agent === 'openclaw',
      hermes: old?.autoStart === true && old.agent === 'hermes' };
  }
  async function setLoginOption(agent: Agent, enabled: boolean) {
    const state = await loginOptions();
    const wasEnabled = state.openclaw || state.hermes;
    state[agent] = enabled;
    if (wasEnabled || enabled) await enroll(root, state.openclaw || state.hermes);
    await save(root, 'autostart.json', state);
  }
  async function configure(payload: Record<string, unknown>) {
    const agent = parseAgent(payload.agent);
    if (busy || running.has(agent)) throw new Error('설치가 진행 중이거나 에이전트가 실행 중이에요.');
    busy = true;
    try {
      if (payload.accepted !== true) throw new Error('설치 전에 접근 권한과 위험을 확인해 주세요.');
      const models = await getModels(payload.key);
      const model = models.find(entry => entry.id === payload.model);
      if (!model) throw new Error('CBGPU에서 사용할 수 있는 모델을 선택해 주세요.');
      const telegram = parseTelegram(payload.token, payload.user);
      const autoStart = payload.autoStart === true;
      if (autoStart && !telegram) throw new Error('자동 시작을 켜려면 Telegram 봇을 먼저 연결해 주세요.');
      const folder = path.join(root, agent);
      const permissions = parsePermissions(payload.permissions);
      const profile = makeProfile(agent, model, folder, telegram, permissions);
      if (telegram) {
        const other = agent === 'hermes' ? 'openclaw' : 'hermes';
        const current = await read(path.join(root, other), 'credentials.json').catch(() => null);
        if (current?.telegram?.token === telegram.token) {
          throw new Error('OpenClaw와 Hermes에 서로 다른 Telegram 봇을 연결해 주세요.');
        }
        await verifyTelegramBot(telegram.token, fetchBot);
      }
      await mkdir(path.join(folder, 'workspace'), { recursive: true, mode: 0o700 });
      await install(agent, folder, permissions);
      runtimeReady = true;
      if (permissions.screen) await prepareScreen(agent, folder);
      const workspace = path.join(folder, 'workspace');
      const accountInstructions = permissions.accounts
        ? 'When the owner asks you to sign in or create an account, use the enabled browser or desktop tools for the named app or site, including services you have not used before. Complete and submit the requested forms. Fill secrets through the local credential vault when available, or hand the form back to the owner for secret entry. Hand off provider verification steps, such as CAPTCHA or multi-factor authentication, to the owner.'
        : 'Ask the owner to enable account tasks before submitting login or signup forms.';
      const skillInstructions = permissions.skills
        ? 'When the owner’s task needs a missing skill, search and review its source and requested access before installing it in this profile. Use the runtime’s built-in trust checks. Do not override blocked installs. Report the skill and version you installed. ' + (agent === 'openclaw'
          ? 'Use openclaw skills search, verify, and install in the workspace. Pick a specific available version.'
          : 'Use hermes skills search and install. Use skill_manage to save useful local procedures.')
        : 'Ask the owner to enable skill installation before adding external skills.';
      const file = path.join(workspace, 'AGENTS.md');
      let existing = '';
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > 65536) throw new Error('작업 폴더의 AGENTS.md를 확인해 주세요.');
        existing = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const grant = '<!-- cbgpu-setup:start -->\n' + accountInstructions + '\n\n' + skillInstructions + '\n<!-- cbgpu-setup:end -->';
      const bound = /<!-- cbgpu-setup:start -->[\s\S]*?<!-- cbgpu-setup:end -->/;
      const instructions = bound.test(existing) ? existing.replace(bound, grant) : existing.trimEnd() + '\n\n' + grant + '\n';
      await save(workspace, 'AGENTS.md', instructions, true);
      await save(folder, profile.filename, profile.config);
      await save(folder, 'credentials.json', { key: payload.key, telegram, permissions });
      const launcher = portable ? await shortcut(root, agent) : null;
      await setLoginOption(agent, autoStart);
      await save(root, 'selection.json', { agent });
      return { ready: true, launcher };
    } finally { busy = false; }
  }
  async function launch(agent: Agent, sudoPassword: unknown) {
    const folder = path.join(root, agent);
    const installed = await runtime(agent, folder);
    if (!installed) throw new Error('에이전트를 먼저 설치하고 연결해 주세요.');
    const { key, telegram, permissions } = await read(folder, 'credentials.json');
    if (!validKey(key)) throw new Error('CBGPU에 다시 연결해 주세요.');
    const configFile = agent === 'openclaw' ? 'openclaw.json' : 'config.yaml';
    const config = agent === 'openclaw' ? await read(folder, configFile) : null;
    const context = config ? config.models.providers.cbgpu.models[0].id : await readHermesModel(path.join(folder, configFile));
    if (sudoPassword !== undefined && sudoPassword !== '' && (agent !== 'hermes' || !permissions?.sudo ||
        typeof sudoPassword !== 'string' || sudoPassword.length > 256 || sudoPassword.includes('\0'))) {
      throw new Error('이 프로필에서는 sudo 비밀번호를 사용할 수 없어요.');
    }
    const toolPaths = agent === 'openclaw'
      ? [path.dirname(installed.program), path.join(folder, 'runtime', 'node_modules', '.bin')]
      : [path.dirname(installed.prefix.at(-1)?.endsWith('.ps1') ? installed.prefix.at(-1)! : installed.program)];
    const env = {
      ...runtimeEnvironment(toolPaths.filter(item => path.isAbsolute(item))), CBGPU_API_KEY: key,
      ...(agent === 'openclaw'
        ? { OPENCLAW_STATE_DIR: folder, OPENCLAW_CONFIG_PATH: path.join(folder, configFile) }
        : { HERMES_HOME: folder, HERMES_CONFIG_BACKEND: 'file',
          ...(!permissions?.outside && { HERMES_WRITE_SAFE_ROOT: path.join(folder, 'workspace') }) }),
      ...(telegram && { TELEGRAM_BOT_TOKEN: telegram.token, TELEGRAM_ALLOWED_USERS: telegram.userId }),
    };
    if (agent === 'hermes' && permissions?.sudo && typeof sudoPassword === 'string' && sudoPassword) {
      Object.assign(env, { TERMINAL_ENV: 'local', SUDO_PASSWORD: sudoPassword });
    }
    const verifiedModel = (await getModels(key)).find(item => item.id === context);
    if (!verifiedModel) throw new Error('연결한 모델을 사용할 수 없어요. 모델을 다시 선택해 주세요.');
    makeProfile(agent, verifiedModel, folder, telegram, permissions);
    const command = agent === 'hermes' && !telegram ? 'dashboard' : 'gateway';
    const child = spawn(installed.program, [...installed.prefix, command], {
      env, cwd: path.join(folder, 'workspace'), stdio: 'ignore', windowsHide: true, detached: portable,
    });
    running.set(agent, child);
    const clear = () => { if (running.get(agent) === child) running.delete(agent); };
    child.once('error', clear);
    child.once('exit', clear);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('에이전트를 시작하지 못했어요. 다시 설치해 주세요.')));
    });
    if (permissions?.awake) inhibitSleep(child);
    return {
      message: telegram ? '에이전트를 시작했어요. Telegram에서 내 봇에게 메시지를 보내 연결을 확인해 주세요.'
        : '에이전트를 시작했어요. 창이 열리기까지 잠시 기다려 주세요.',
      url: agent === 'openclaw' && !telegram
        ? 'http://127.0.0.1:19349/#token=' + encodeURIComponent(config.gateway.auth.token)
        : null,
    };
  }
  async function updateHermesLauncher() {
    if (!portable || busy) throw new Error('설치가 끝난 뒤 바로가기를 업데이트해 주세요.');
    busy = true;
    try {
      const folder = path.join(root, 'hermes');
      const current = await read(folder, 'credentials.json').catch(() => null);
      if (!validKey(current?.key)) throw new Error('이 컴퓨터에서 CBGPU에 연결한 Hermes를 찾지 못했어요.');
      await readHermesModel(path.join(folder, 'config.yaml'));
      const launcher = await shortcut(root, 'hermes');
      if ((await loginOptions()).hermes) await enroll(root, true);
      runtimeReady = true;
      return { launcher };
    } finally { busy = false; }
  }
  async function startManually(agent: Agent, sudoPassword?: unknown) {
    if (portable) throw new Error('설치 도우미를 닫고 OpenClaw 또는 Hermes 바로가기에서 시작해 주세요.');
    if (busy) throw new Error('설치 중이거나 시작 중이에요.');
    if (running.has(agent)) return { message: '에이전트가 이미 실행 중이에요.', url: null };
    busy = true;
    try {
      const result = await launch(agent, sudoPassword);
      await save(root, 'selection.json', { agent });
      return result;
    } finally { busy = false; }
  }
  async function resumeSaved() {
    if (portable) return { active: false, pending: true };
    const options = await loginOptions();
    if (busy) throw new Error('에이전트를 시작하는 중이에요.');
    busy = true;
    let pending = false;
    try {
      for (const agent of agents.filter(item => options[item] && !running.has(item))) {
        try {
          const current = await read(path.join(root, agent), 'credentials.json');
          if (current.telegram) await launch(agent, undefined);
        } catch { pending = true; }
      }
      return { active: running.size > 0, pending };
    } finally { busy = false; }
  }
  const assets = new Map([
    ['/', ['text/html; charset=utf-8', page]],
    ['/setup.css', ['text/css; charset=utf-8', stylesheet]],
    ['/setup.js', ['text/javascript; charset=utf-8', client]],
  ]);
  const reply = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'same-origin');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const pathname = request.url ?? '/';
    if (request.headers.host !== new URL(origin).host) return reply(response, 403, { error: '설치 창을 다시 열어 주세요.' });
    const challenge = /^\/session-check\?challenge=([0-9a-f]{32})$/.exec(pathname)?.[1];
    if (request.method === 'GET' && challenge) {
      return reply(response, 200, { proof: createHmac('sha256', ticket).update(challenge).digest('hex') });
    }
    const asset = request.method === 'GET' && assets.get(pathname);
    if (asset) { response.writeHead(200, { 'content-type': asset[0] }); response.end(asset[1]); return; }
    const logo = request.method === 'GET' && setupLogos.find(file => pathname === '/marks/' + file);
    if (logo) {
      const data = await readSetupLogo(logo).catch(() => null);
      if (!data) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(data);
      return;
    }
    const token = request.headers['x-cbgpu-setup'];
    const sameOrigin = request.headers.origin === origin ||
      (request.headers.origin === undefined && request.headers['sec-fetch-site'] === 'same-origin');
    if (request.method !== 'POST' || !sameOrigin || typeof token !== 'string' ||
        Buffer.byteLength(token) !== Buffer.byteLength(ticket) || !timingSafeEqual(Buffer.from(token), Buffer.from(ticket))) {
      return reply(response, 403, { error: '이 설치 창을 다시 열어 주세요.' });
    }
    try {
      const payload = await jsonBody(request);
      let result;
      switch (pathname) {
        case '/status': {
          const selection = await readSelection();
          const saved = payload.agent ?? selection?.agent;
          const current = saved === 'openclaw' || saved === 'hermes' ? await read(path.join(root, saved), 'credentials.json').catch(() => null) : null;
          const permissions = parsePermissions(current?.permissions);
          const flags = await loginOptions();
          const hermesConfigured = portable && validKey((saved === 'hermes' ? current
            : await read(path.join(root, 'hermes'), 'credentials.json').catch(() => null))?.key);
          result = { saved: current ? saved : '', permissions, platform: process.platform,
            running: typeof saved === 'string' && running.has(saved as Agent),
            autoStart: Boolean(current?.telegram && flags[saved as Agent]),
            telegram: Boolean(current?.telegram), portable, hermesConfigured };
          break;
        }
        case '/models': result = { models: await getModels(payload.key) }; break;
        case '/telegram/check': result = await verifyTelegramBot(payload.token, fetchBot); break;
        case '/server-prompt': result = { prompt: serverSetupPrompt(parseAgent(payload.agent), payload) }; break;
        case '/install': result = await configure(payload); break;
        case '/update-hermes-launcher': result = await updateHermesLauncher(); break;
        case '/install-runtime': {
          if (!portable || busy || running.has(parseAgent(payload.agent))) throw new Error('설치가 진행 중인지 확인해 주세요.');
          if (payload.accepted !== true) throw new Error('설치 전에 접근 권한과 위험을 확인해 주세요.');
          busy = true;
          try {
            const agent = parseAgent(payload.agent);
            const folder = path.join(root, agent);
            await install(agent, folder, parsePermissions(payload.permissions));
            runtimeReady = true;
            result = { ready: true };
          } finally { busy = false; }
          break;
        }
        case '/finish': {
          if (!portable || busy || !runtimeReady) throw new Error('설치를 마친 뒤 창을 닫아 주세요.');
          response.once('finish', () => server.close());
          result = { closed: true };
          break;
        }
        case '/resume': result = await resumeSaved(); break;
        case '/autostart': {
          if (busy) throw new Error('설치나 시작이 끝난 뒤 다시 설정해 주세요.');
          busy = true;
          try {
            const current = await readSelection();
            const agent = parseAgent(payload.agent ?? current?.agent);
            const { telegram } = await read(path.join(root, agent), 'credentials.json');
            const autoStart = payload.enabled === true;
            if (autoStart && !telegram) throw new Error('자동 시작을 켜려면 Telegram 봇을 먼저 연결해 주세요.');
            await setLoginOption(agent, autoStart);
            result = { autoStart };
          } finally { busy = false; }
          break;
        }
        case '/start':
          result = await startManually(parseAgent(payload.agent), payload.sudoPassword);
          break;
        case '/stop': {
          if (busy) throw new Error('시작이 끝난 뒤 멈춰 주세요.');
          const selected = parseAgent(payload.agent ?? (await readSelection())?.agent);
          const child = running.get(selected);
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill();
            for (let tick = 0; tick < 20 && running.get(selected) === child; tick++) await wait(100);
            if (running.get(selected) === child) throw new Error('에이전트가 종료되는 중이에요. 잠시 뒤 다시 확인해 주세요.');
          }
          result = { stopped: true };
          break;
        }
        default: return reply(response, 404, { error: '설치 창을 다시 열어 주세요.' });
      }
      reply(response, 200, result);
    } catch (error) {
      const message = error instanceof Error && /[가-힣]/.test(error.message) && !error.message.includes('cbgpu_ai_')
        ? error.message : '설정을 처리하지 못했어요. 입력 내용을 확인한 뒤 다시 시도해 주세요.';
      reply(response, 400, { error: message });
    }
  });
  server.on('close', () => {
    for (const child of running.values()) {
      if (portable) child.unref();
      else child.kill();
    }
  });
  return new Promise<{ url: string; server: typeof server; resumeSaved: typeof resumeSaved; startManually: typeof startManually }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('설치 창을 열지 못했어요.')); return; }
      origin = 'http://127.0.0.1:' + address.port;
      const url = origin + '/#' + ticket;
      if (browser) openBrowser(url);
      resolve({ url, server, resumeSaved, startManually });
    });
  });
}

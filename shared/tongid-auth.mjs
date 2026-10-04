#!/usr/bin/env node

/**
 * TongID Agent 技能共享授权模块（唯一源码：shared/tongid-auth.mjs）。
 *
 * 各技能 scripts/tongid-auth.mjs 是本文件的副本，由仓库根 scripts/sync-shared.mjs
 * 在提交前同步；请勿直接修改技能里的副本。
 *
 * 设计约定：
 * - 所有 TongID 技能共用同一份本机登录态（~/.tongid/agent/session.json），
 *   授权命令固定为 login / whoami / logout，与具体技能无关。
 * - 登录态是账号级的，不含应用归属；业务数据按应用隔离，
 *   业务命令必须显式传入 applicationId（对应 CLI 的 --application-id）。
 * - 不读取任何环境变量；TongID 地址在 login 时确定并写入 session。
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://tongid.dev';
export const TONGID_AGENT_CALLBACK_URL = 'http://127.0.0.1:43173/tongid-skills/callback';
export const TONGID_AGENT_CLIENT_TYPE = 'tongid-local-agent';

function fail(message) {
  throw new Error(message);
}

export function normalizeBaseUrl(value) {
  if (!value) fail('缺少 TongID 地址：请先执行 login，或在 login 时用 --base-url 指定');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('TongID 地址必须是有效的 http(s) 地址');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('TongID 地址必须使用 http 或 https');
  }
  return url.origin;
}

export function buildAgentAuthorizeUrl(baseUrl, state, codeChallenge) {
  const url = new URL('/auth/login', normalizeBaseUrl(baseUrl));
  url.searchParams.set('redirect', TONGID_AGENT_CALLBACK_URL);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  return url;
}

export function buildIssueHeaders(token, applicationId) {
  if (!token) fail('本机登录态缺失，请先执行 login（node scripts/tongid-auth.mjs login）');
  if (!applicationId) fail('缺少 applicationId：应用间数据相互隔离，必须显式指定目标应用（CLI 对应 --application-id）');
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-tongid-application-id': applicationId,
  };
}

/**
 * 统一的失败解释：技能对 401/403 提示同一套处置动作，不自行猜测或绕过。
 */
export function describeApiFailure(status) {
  if (status === 401) return '登录态无效或已过期，请重新执行 login（node scripts/tongid-auth.mjs login）。';
  if (status === 403) return '当前登录账号对目标应用缺少所需权限（如 workspace manager），请勿绕过该边界。';
  return undefined;
}

export function parseAgentCallback(callbackUrl, expectedState) {
  let url;
  try {
    url = new URL(callbackUrl);
  } catch {
    fail('本机回调 URL 无效');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '43173' ||
    url.pathname !== '/tongid-skills/callback'
  ) {
    fail('回调未使用固定回调地址');
  }

  const error = url.searchParams.get('error');
  if (error) fail(`TongID 登录未完成：${error}`);

  const code = url.searchParams.get('code')?.trim();
  const state = url.searchParams.get('state')?.trim();
  if (!code) fail('回调缺少授权码');
  if (!state || state !== expectedState) fail('回调 state 校验失败');
  return { code, state };
}

function createPkcePair() {
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

function createState() {
  return randomBytes(32).toString('base64url');
}

function sessionDirectory(homeDir = os.homedir()) {
  return path.join(homeDir, '.tongid', 'agent');
}

export function sessionFile(homeDir = os.homedir()) {
  return path.join(sessionDirectory(homeDir), 'session.json');
}

export async function saveSession(session, homeDir = os.homedir()) {
  const directory = sessionDirectory(homeDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const target = sessionFile(homeDir);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function loadSession(homeDir = os.homedir()) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(sessionFile(homeDir), 'utf8'));
  } catch {
    fail('未找到可用的本机登录态，请先执行 login（node scripts/tongid-auth.mjs login）');
  }
  if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) {
    fail('本机登录态格式无效，请重新执行 login（node scripts/tongid-auth.mjs login）');
  }
  if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) {
    fail('本机登录态缺少 TongID 地址，请重新执行 login（node scripts/tongid-auth.mjs login）');
  }
  return parsed;
}

export async function removeSession(homeDir = os.homedir()) {
  await rm(sessionFile(homeDir), { force: true });
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeCallbackResponse(response, status, title, message) {
  const success = status === 200;
  const icon = success
    ? '<svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26" stroke="#22c55e" stroke-width="3"/><path d="M17.5 29l7.5 7.5L38.5 20" stroke="#22c55e" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26" stroke="#ef4444" stroke-width="3"/><path d="M19 19l18 18M37 19L19 37" stroke="#ef4444" stroke-width="4" stroke-linecap="round"/></svg>';
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: #f4f5f7;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 380px;
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.06);
    padding: 44px 36px 40px;
    text-align: center;
  }
  h1 { font-size: 19px; font-weight: 600; color: #17181c; margin-top: 20px; }
  p { font-size: 14px; line-height: 1.7; color: #7a7f89; margin-top: 10px; }
  @media (prefers-color-scheme: dark) {
    body { background: #131417; }
    .card { background: #1d1e23; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); }
    h1 { color: #f2f3f5; }
    p { color: #9aa0aa; }
  }
</style>
</head>
<body>
<main class="card">
  ${icon}
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main>
</body>
</html>
`);
}

/**
 * 在固定 loopback 地址接收一次授权回跳。端口冲突和超时都会关闭 listener；
 * 调用方只会拿到已验证 state 的 code，绝不输出 token。
 */
export function waitForAgentCallback({ state, timeoutMs = 5 * 60_000, onListening } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const server = createServer((request, response) => {
      const host = request.headers.host ?? '127.0.0.1:43173';
      const callbackUrl = new URL(request.url ?? '/', `http://${host}`).toString();
      try {
        const result = parseAgentCallback(callbackUrl, state);
        writeCallbackResponse(
          response,
          200,
          'TongID 登录成功',
          'TongID 授权已完成，本机会自动完成后续登录步骤。现在可以关闭此窗口，回到终端继续操作。',
        );
        finish(null, result);
      } catch (error) {
        writeCallbackResponse(
          response,
          400,
          'TongID 登录失败',
          '回调校验未通过，请回到终端查看具体错误后重试。',
        );
        finish(error);
      }
    });

    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const settle = () => {
        if (error) reject(error);
        else resolve(value);
      };

      // listen() can fail before the server is actually listening (notably
      // EADDRINUSE). Calling close() in that state raises a second
      // ERR_SERVER_NOT_RUNNING and obscures the useful port-conflict error.
      if (!server.listening) {
        settle();
        return;
      }
      server.close(settle);
    }

    server.once('error', (error) => {
      if (settled) return;
      const message =
        error && typeof error === 'object' && error.code === 'EADDRINUSE'
          ? '本机回调端口 43173 已被占用；请关闭占用进程后重试 login'
          : `本机回调监听失败：${error instanceof Error ? error.message : String(error)}`;
      finish(new Error(message));
    });
    server.once('listening', () => {
      timer = setTimeout(() => finish(new Error('等待 TongID 登录回调超时（5 分钟）')), timeoutMs);
      onListening?.();
    });
    server.listen(43173, '127.0.0.1');
  });
}

function openBrowser(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.once('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function postTokenOnce(url, form) {
  // 单次 15 秒封顶：网络黑洞地址（如被墙的 Cloudflare IP）不会拖过授权码 2 分钟 TTL
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, payload: await response.json().catch(() => null) };
}

async function exchangeAgentCode(baseUrl, { code, state, codeVerifier }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    state,
    code_verifier: codeVerifier,
    client_type: TONGID_AGENT_CLIENT_TYPE,
  });
  let lastNetworkError = '未知网络错误';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { status, payload } = await postTokenOnce(`${baseUrl}/api/v1/oauth/token`, form);
      const token = payload?.data?.access_token;
      if (status === 200 && typeof token === 'string' && token) return token;
      fail(`TongID 登录 token 兑换失败：${payload?.error?.message ?? `HTTP ${status}`}`);
    } catch (error) {
      // 服务端已定论的失败直接抛出；仅网络类失败（超时/连接不通）换 DNS 轮询结果重试
      if (error instanceof Error && error.message.startsWith('TongID 登录 token 兑换失败')) throw error;
      lastNetworkError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail(
    `TongID 登录 token 兑换失败：网络连续 3 次未连通（${lastNetworkError}）。` +
      '请重试 login；反复失败请检查本机网络或代理（本地回调 127.0.0.1 需绕过代理）。',
  );
}

/**
 * 完整登录流程：起固定回调 → 打开浏览器 → 校验回跳 → 兑换 token → 原子落盘。
 * 返回写入 session 的 baseUrl；成功提示由调用方 CLI 打印。
 */
export async function runLogin({ baseUrl } = {}) {
  const normalized = normalizeBaseUrl(baseUrl ?? DEFAULT_BASE_URL);
  const state = createState();
  const { codeVerifier, codeChallenge } = createPkcePair();
  const authorizeUrl = buildAgentAuthorizeUrl(normalized, state, codeChallenge).toString();
  let opened = false;

  const callback = await waitForAgentCallback({
    state,
    onListening: () => {
      opened = openBrowser(authorizeUrl);
      console.log(
        opened
          ? '已打开浏览器，请完成 TongID 登录。'
          : `请在浏览器打开以下地址完成登录：\n${authorizeUrl}`,
      );
    },
  });
  const accessToken = await exchangeAgentCode(normalized, {
    code: callback.code,
    state,
    codeVerifier,
  });
  const session = { baseUrl: normalized, accessToken, createdAt: new Date().toISOString() };
  await saveSession(session);
  return session;
}

/**
 * 所有技能共用的 API 调用入口：Bearer + 应用头，返回状态与解析后的响应体。
 * 业务脚本负责把失败转成输出（401/403 用 describeApiFailure 统一解释）。
 */
export async function callApi({ session, applicationId, method, path: pathName, body, fetchImpl = fetch }) {
  const headers = buildIssueHeaders(session?.accessToken, applicationId);
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetchImpl(`${normalizeBaseUrl(session.baseUrl)}/api/v1${pathName}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, payload };
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/tongid-auth.mjs login [--base-url URL]   # 缺省 https://tongid.dev；本地联调如 http://localhost:3000',
    '  node scripts/tongid-auth.mjs whoami',
    '  node scripts/tongid-auth.mjs logout',
    '',
    '所有 TongID 技能共用这份登录态（~/.tongid/agent/session.json）。',
    '看板等业务命令与登录无关地要求显式传 --application-id 指定目标应用。',
  ].join('\n'));
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`缺少 --${rawKey} 的值`);
    flags[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }

  if (command === 'login') {
    await runLogin({ baseUrl: flags['base-url'] });
    console.log('TongID 本机登录成功。');
    return;
  }
  if (command === 'whoami') {
    const session = await loadSession();
    console.log(JSON.stringify(
      { baseUrl: session.baseUrl, createdAt: session.createdAt ?? null, sessionFile: sessionFile() },
      null,
      2,
    ));
    return;
  }
  if (command === 'logout') {
    await removeSession();
    console.log('TongID 本机登录态已清除。');
    return;
  }
  fail(`未知命令：${command}（支持 login、whoami、logout）`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`tongid-auth: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TONGID_AGENT_CALLBACK_URL = 'http://127.0.0.1:43173/tongid-agent/callback';
export const TONGID_AGENT_CLIENT_TYPE = 'tongid-local-agent';

function fail(message) {
  throw new Error(message);
}

function normalizeBaseUrl(value) {
  if (!value) fail('请设置 TONGID_BASE_URL，或先执行 login');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('TONGID_BASE_URL 必须是有效的 http(s) 地址');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('TONGID_BASE_URL 必须使用 http 或 https');
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
  if (!token) fail('本机登录态缺失，请先执行 login');
  if (!applicationId) fail('看板操作需要设置 TONGID_APPLICATION_ID');
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-tongid-application-id': applicationId,
  };
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
    url.pathname !== '/tongid-agent/callback'
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
  return path.join(homeDir, '.tongid', 'tongid-skills');
}

export function localSessionFile(homeDir = os.homedir()) {
  return path.join(sessionDirectory(homeDir), 'session.json');
}

export async function saveLocalSession(session, homeDir = os.homedir()) {
  const directory = sessionDirectory(homeDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const target = localSessionFile(homeDir);
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function loadLocalSession(homeDir = os.homedir()) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(localSessionFile(homeDir), 'utf8'));
  } catch {
    fail('未找到可用的本机登录态，请先执行 login');
  }
  if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) {
    fail('本机登录态格式无效，请重新执行 login');
  }
  if (typeof parsed.baseUrl !== 'string' || !parsed.baseUrl) {
    fail('本机登录态缺少 TongID 地址，请重新执行 login');
  }
  return parsed;
}

export async function removeLocalSession(homeDir = os.homedir()) {
  await rm(localSessionFile(homeDir), { force: true });
}

function writeCallbackResponse(response, status, title, message) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>${title}</title><p>${message}</p>`);
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
        writeCallbackResponse(response, 200, 'TongID 登录完成', '可以关闭此页面并回到终端。');
        finish(null, result);
      } catch (error) {
        writeCallbackResponse(response, 400, 'TongID 登录失败', '回调校验失败，请回到终端查看错误。');
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

async function exchangeAgentCode(baseUrl, { code, state, codeVerifier }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    state,
    code_verifier: codeVerifier,
    client_type: TONGID_AGENT_CLIENT_TYPE,
  });
  const response = await fetch(`${baseUrl}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const payload = await response.json().catch(() => null);
  const token = payload?.data?.access_token;
  if (!response.ok || typeof token !== 'string' || !token) {
    const message = payload?.error?.message ?? `HTTP ${response.status}`;
    fail(`TongID 登录 token 兑换失败：${message}`);
  }
  return token;
}

async function login() {
  const baseUrl = normalizeBaseUrl(process.env.TONGID_BASE_URL);
  const state = createState();
  const { codeVerifier, codeChallenge } = createPkcePair();
  const authorizeUrl = buildAgentAuthorizeUrl(baseUrl, state, codeChallenge).toString();
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
  const accessToken = await exchangeAgentCode(baseUrl, {
    code: callback.code,
    state,
    codeVerifier,
  });
  await saveLocalSession({ baseUrl, accessToken, createdAt: new Date().toISOString() });
  console.log('TongID 本机登录成功。');
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/tongid-skills.mjs login',
    '  node scripts/tongid-skills.mjs logout',
    '  node scripts/tongid-skills.mjs list [--search TEXT] [--lane LANE] [--category-id ID] [--tag-id ID] [--source SOURCE] [--page N] [--page-size N]',
    '  node scripts/tongid-skills.mjs get ISSUE_ID',
    '  node scripts/tongid-skills.mjs stats',
    '  node scripts/tongid-skills.mjs create --title TEXT --content TEXT --source TEXT [--category-id ID] [--tags ID,ID] [--user-name NAME]',
    '  node scripts/tongid-skills.mjs reply ISSUE_ID --content TEXT [--author-name NAME]',
    '  node scripts/tongid-skills.mjs move ISSUE_ID --lane pending|in_progress|review|done|closed',
    '  node scripts/tongid-skills.mjs categories list|create|rename|delete ...',
    '  node scripts/tongid-skills.mjs tags list|create|rename|delete ...',
    '  node scripts/tongid-skills.mjs board get|update [--enabled true] [--show-content false]',
    '',
    'login 只需要 TONGID_BASE_URL；看板操作还需要 TONGID_APPLICATION_ID。',
  ].join('\n'));
}

function parseFlags(tokens) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const value = inlineValue ?? tokens[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`缺少 --${rawKey} 的值`);
    flags[rawKey] = value;
    if (inlineValue === undefined) index += 1;
  }
  return { flags, positional };
}

function required(flags, key) {
  const value = flags[key];
  if (!value) fail(`缺少 --${key}`);
  return value;
}

function boolean(value, key) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`--${key} 必须为 true 或 false`);
}

function queryString(flags, allowedKeys) {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    const value = flags[key];
    if (value !== undefined) params.set(key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function api(method, pathName, body) {
  const session = await loadLocalSession();
  const baseUrl = normalizeBaseUrl(process.env.TONGID_BASE_URL ?? session.baseUrl);
  const applicationId = process.env.TONGID_APPLICATION_ID?.trim();
  const headers = buildIssueHeaders(session.accessToken, applicationId);
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${baseUrl}/api/v1${pathName}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(JSON.stringify(payload ?? { status: response.status }, null, 2));
    if (response.status === 401) console.error('登录态无效或已过期，请重新执行 login。');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(payload?.data ?? payload, null, 2));
}

async function main() {
  const [command, ...tokens] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'login') {
    await login();
    return;
  }
  if (command === 'logout') {
    await removeLocalSession();
    console.log('TongID 本机登录态已清除。');
    return;
  }

  const { flags, positional } = parseFlags(tokens);
  if (command === 'list') {
    await api('GET', `/issues${queryString(flags, ['search', 'lane', 'category-id', 'tag-id', 'source', 'page', 'page-size'])}`);
  } else if (command === 'get') {
    await api('GET', `/issues/${encodeURIComponent(positional[0] ?? fail('缺少 ISSUE_ID'))}`);
  } else if (command === 'stats') {
    await api('GET', '/issues/stats');
  } else if (command === 'create') {
    await api('POST', '/issues', {
      title: required(flags, 'title'),
      content: required(flags, 'content'),
      source: required(flags, 'source'),
      ...(flags['category-id'] ? { categoryId: flags['category-id'] } : {}),
      tagIds: flags.tags ? flags.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      ...(flags['user-name'] ? { userName: flags['user-name'] } : {}),
    });
  } else if (command === 'reply') {
    await api('POST', `/issues/${encodeURIComponent(positional[0] ?? fail('缺少 ISSUE_ID'))}/replies`, {
      content: required(flags, 'content'),
      ...(flags['author-name'] ? { authorName: flags['author-name'] } : {}),
    });
  } else if (command === 'move') {
    await api('PATCH', `/issues/${encodeURIComponent(positional[0] ?? fail('缺少 ISSUE_ID'))}`, {
      lane: required(flags, 'lane'),
    });
  } else if (command === 'categories' || command === 'tags') {
    const resource = command;
    const action = positional[0];
    const id = positional[1];
    if (action === 'list') await api('GET', `/issues/${resource}`);
    else if (action === 'create') await api('POST', `/issues/${resource}`, { name: required(flags, 'name') });
    else if (action === 'rename') await api('PATCH', `/issues/${resource}/${encodeURIComponent(id ?? fail('缺少 ID'))}`, { name: required(flags, 'name') });
    else if (action === 'delete') await api('DELETE', `/issues/${resource}/${encodeURIComponent(id ?? fail('缺少 ID'))}`);
    else fail(`${resource} 仅支持 list、create、rename、delete`);
  } else if (command === 'board') {
    const action = positional[0];
    if (action === 'get') {
      await api('GET', '/issues/board-settings');
    } else if (action === 'update') {
      const settings = {};
      for (const key of [
        'enabled', 'show-pending-lane', 'show-in-progress-lane', 'show-review-lane', 'show-done-lane',
        'show-closed-lane', 'show-title', 'show-content', 'show-category', 'show-tags', 'show-source',
        'show-user-name', 'show-created-at', 'show-updated-at',
      ]) {
        if (flags[key] !== undefined) {
          settings[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = boolean(flags[key], key);
        }
      }
      if (Object.keys(settings).length === 0) fail('board update 至少提供一个布尔设置');
      await api('PATCH', '/issues/board-settings', settings);
    } else fail('board 仅支持 get、update');
  } else {
    fail(`未知命令：${command}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`tongid-skills: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

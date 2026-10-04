import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_BASE_URL,
  buildAgentAuthorizeUrl,
  buildIssueHeaders,
  callApi,
  describeApiFailure,
  loadSession,
  normalizeBaseUrl,
  parseAgentCallback,
  removeSession,
  saveSession,
  sessionFile,
  waitForAgentCallback,
} from './tongid-auth.mjs';

test('builds a fixed Agent authorization callback URL', () => {
  const url = buildAgentAuthorizeUrl('https://tongid.example.com/', 'state_1', 'challenge_1');

  assert.equal(url.origin, 'https://tongid.example.com');
  assert.equal(url.pathname, '/auth/login');
  assert.equal(
    url.searchParams.get('redirect'),
    'http://127.0.0.1:43173/tongid-agent/callback',
  );
  assert.equal(url.searchParams.get('state'), 'state_1');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge_1');
});

test('builds board requests with a Bearer token and target application header', () => {
  assert.deepEqual(buildIssueHeaders('session_1', 'app_1'), {
    accept: 'application/json',
    authorization: 'Bearer session_1',
    'x-tongid-application-id': 'app_1',
  });
});

test('requires an explicit application id because application data is isolated', () => {
  assert.throws(() => buildIssueHeaders('session_1', ''), /--application-id/);
  assert.throws(() => buildIssueHeaders('', 'app_1'), /login/);
});

test('maps 401 and 403 to the unified remediation hints', () => {
  assert.match(describeApiFailure(401), /重新执行 login/);
  assert.match(describeApiFailure(403), /权限/);
  assert.equal(describeApiFailure(404), undefined);
});

test('rejects a callback that does not use the exact loopback host and path', () => {
  assert.throws(
    () => parseAgentCallback('http://localhost:43173/tongid-agent/callback?code=x&state=state_1', 'state_1'),
    /固定回调地址/,
  );
  assert.throws(
    () => parseAgentCallback('http://127.0.0.1:43173/tongid-agent/callback?code=x&state=wrong', 'state_1'),
    /state/,
  );
});

test('explains when the fixed local callback port is already occupied', async (t) => {
  const blocker = createServer();
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(43173, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'EADDRINUSE') {
      t.skip('测试环境已占用固定 Agent 回调端口');
      return;
    }
    throw error;
  }

  try {
    await assert.rejects(
      waitForAgentCallback({ state: 'state_1', timeoutMs: 100 }),
      /端口 43173 已被占用/,
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

test('saves, loads, and removes the shared session atomically at the agent path', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tongid-auth-test-'));
  try {
    await assert.rejects(() => loadSession(home), /请先执行 login/);

    await saveSession({ baseUrl: 'https://tongid.dev', accessToken: 'token_1' }, home);
    const session = await loadSession(home);
    assert.equal(session.baseUrl, 'https://tongid.dev');
    assert.equal(session.accessToken, 'token_1');
    assert.equal(sessionFile(home), path.join(home, '.tongid', 'agent', 'session.json'));

    await removeSession(home);
    await assert.rejects(() => loadSession(home), /请先执行 login/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('rejects a session that is missing the TongID base URL', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'tongid-auth-test-'));
  try {
    await saveSession({ accessToken: 'token_1' }, home);
    await assert.rejects(() => loadSession(home), /缺少 TongID 地址/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('normalizes the base URL and keeps the production default', () => {
  assert.equal(DEFAULT_BASE_URL, 'https://tongid.dev');
  assert.equal(normalizeBaseUrl('https://tongid.example.com/'), 'https://tongid.example.com');
  assert.throws(() => normalizeBaseUrl('ftp://tongid.example.com'), /http 或 https/);
  assert.throws(() => normalizeBaseUrl(''), /缺少 TongID 地址/);
});

test('callApi sends Bearer and application headers and reports failure status', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'expired' } }),
    };
  };

  const result = await callApi({
    session: { baseUrl: 'https://tongid.dev', accessToken: 'token_1' },
    applicationId: 'app_1',
    method: 'POST',
    path: '/issues',
    body: { title: '导出失败' },
    fetchImpl,
  });

  assert.equal(result.status, 401);
  assert.equal(result.ok, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://tongid.dev/api/v1/issues');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer token_1');
  assert.equal(requests[0].init.headers['x-tongid-application-id'], 'app_1');
  assert.equal(requests[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].init.body), { title: '导出失败' });
});

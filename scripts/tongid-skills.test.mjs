import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  buildAgentAuthorizeUrl,
  buildIssueHeaders,
  parseAgentCallback,
  waitForAgentCallback,
} from './tongid-skills.mjs';

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

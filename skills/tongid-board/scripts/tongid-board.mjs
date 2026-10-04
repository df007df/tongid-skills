#!/usr/bin/env node

/**
 * TongID 看板技能 CLI。
 *
 * 授权统一走共享模块 ./tongid-auth.mjs（login / whoami / logout，命令与登录态全局唯一）；
 * 本脚本只负责看板业务命令。登录态是账号级的，应用数据相互隔离，
 * 因此每条业务命令必须显式传 --application-id 指定目标应用，不读取任何环境变量。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callApi, describeApiFailure, loadSession } from './tongid-auth.mjs';

function fail(message) {
  throw new Error(message);
}

function printHelp() {
  console.log([
    'Usage:',
    '  # 授权（所有 TongID 技能共用同一命令与登录态）',
    '  node scripts/tongid-auth.mjs login [--base-url URL]',
    '  node scripts/tongid-auth.mjs whoami',
    '  node scripts/tongid-auth.mjs logout',
    '',
    '  # 看板操作（每条命令必须显式传 --application-id 指定目标应用）',
    '  node scripts/tongid-board.mjs --application-id app_xxx stats',
    '  node scripts/tongid-board.mjs --application-id app_xxx list [--search TEXT] [--lane LANE] [--category-id ID] [--tag-id ID] [--source SOURCE] [--page N] [--page-size N]',
    '  node scripts/tongid-board.mjs --application-id app_xxx get ISSUE_ID',
    '  node scripts/tongid-board.mjs --application-id app_xxx create --title TEXT --content TEXT --source TEXT [--category-id ID] [--tags ID,ID] [--user-name NAME]',
    '  node scripts/tongid-board.mjs --application-id app_xxx reply ISSUE_ID --content TEXT [--author-name NAME]',
    '  node scripts/tongid-board.mjs --application-id app_xxx move ISSUE_ID --lane pending|in_progress|review|done|closed',
    '  node scripts/tongid-board.mjs --application-id app_xxx categories list|create|rename|delete ...',
    '  node scripts/tongid-board.mjs --application-id app_xxx tags list|create|rename|delete ...',
    '  node scripts/tongid-board.mjs --application-id app_xxx board get|update [--enabled true] [--show-content false]',
    '',
    '未登录先执行 tongid-auth 的 login；401 重新 login；403 表示当前账号对目标应用缺少管理权限。',
  ].join('\n'));
}

export function parseFlags(tokens) {
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

export function required(flags, key) {
  const value = flags[key];
  if (!value) fail(`缺少 --${key}`);
  return value;
}

function boolean(value, key) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`--${key} 必须为 true 或 false`);
}

export function queryString(flags, allowedKeys) {
  const params = new URLSearchParams();
  for (const key of allowedKeys) {
    const value = flags[key];
    if (value !== undefined) params.set(key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function api(method, pathName, body, flags) {
  const session = await loadSession();
  const { status, ok, payload } = await callApi({
    session,
    applicationId: required(flags, 'application-id').trim(),
    method,
    path: pathName,
    body,
  });
  if (!ok) {
    console.error(JSON.stringify(payload ?? { status }, null, 2));
    const hint = describeApiFailure(status);
    if (hint) console.error(hint);
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

  const { flags, positional } = parseFlags(tokens);
  if (command === 'list') {
    await api('GET', `/issues${queryString(flags, ['search', 'lane', 'category-id', 'tag-id', 'source', 'page', 'page-size'])}`, undefined, flags);
  } else if (command === 'get') {
    await api('GET', `/issues/${encodeURIComponent(positional[0] ?? fail('缺少 ISSUE_ID'))}`, undefined, flags);
  } else if (command === 'stats') {
    await api('GET', '/issues/stats', undefined, flags);
  } else if (command === 'create') {
    await api('POST', '/issues', {
      title: required(flags, 'title'),
      content: required(flags, 'content'),
      source: required(flags, 'source'),
      ...(flags['category-id'] ? { categoryId: flags['category-id'] } : {}),
      tagIds: flags.tags ? flags.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      ...(flags['user-name'] ? { userName: flags['user-name'] } : {}),
    }, flags);
  } else if (command === 'reply') {
    await api('POST', `/issues/${encodeURIComponent(positional[0] ?? fail('缺少 ISSUE_ID'))}/replies`, {
      content: required(flags, 'content'),
      ...(flags['author-name'] ? { authorName: flags['author-name'] } : {}),
    }, flags);
  } else if (command === 'move') {
    await api('PATCH', `/issues/${encodeURIComponent(positional[0] ?? fail('缺少 ISSUE_ID'))}`, {
      lane: required(flags, 'lane'),
    }, flags);
  } else if (command === 'categories' || command === 'tags') {
    const resource = command;
    const action = positional[0];
    const id = positional[1];
    if (action === 'list') await api('GET', `/issues/${resource}`, undefined, flags);
    else if (action === 'create') await api('POST', `/issues/${resource}`, { name: required(flags, 'name') }, flags);
    else if (action === 'rename') await api('PATCH', `/issues/${resource}/${encodeURIComponent(id ?? fail('缺少 ID'))}`, { name: required(flags, 'name') }, flags);
    else if (action === 'delete') await api('DELETE', `/issues/${resource}/${encodeURIComponent(id ?? fail('缺少 ID'))}`, undefined, flags);
    else fail(`${resource} 仅支持 list、create、rename、delete`);
  } else if (command === 'board') {
    const action = positional[0];
    if (action === 'get') {
      await api('GET', '/issues/board-settings', undefined, flags);
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
      await api('PATCH', '/issues/board-settings', settings, flags);
    } else fail('board 仅支持 get、update');
  } else {
    fail(`未知命令：${command}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`tongid-board: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

/**
 * 把 shared/ 共享模块同步到各技能的 scripts/ 副本。
 *
 * 约定：技能通过「scripts/ 下存在同名副本文件」声明接入（新技能首次接入时手动
 * cp 一次即可），之后一律由本脚本维护，禁止手改副本。
 *
 * 修改 shared/ 后、git 提交前运行：
 *   node scripts/sync-shared.mjs          # 覆盖所有副本
 *   node scripts/sync-shared.mjs --check  # 只校验，存在漂移时退出码 1
 *
 * 自动化：.githooks/pre-commit 在每次 git commit 时自动执行同步并把副本加入提交
 * （本克隆需一次性启用：npm run setup 或 git config core.hooksPath .githooks）；
 * scripts/sync-shared.test.mjs 作为第二道网校验副本一致。
 */

import { copyFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 共享模块清单：新增共享文件时在此登记，并同步登记到 sync-shared.test.mjs。 */
export const SHARED_FILES = ['tongid-auth.mjs'];

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * 收集需要同步的 (源码, 副本) 对。只有技能目录里已存在同名副本才算接入，
 * 避免把共享文件塞进未使用它的技能。
 */
export async function collectTargets() {
  const root = repoRoot();
  const skillsDir = path.join(root, 'skills');
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const targets = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    for (const name of SHARED_FILES) {
      const target = path.join(skillsDir, entry.name, 'scripts', name);
      let exists = false;
      try {
        exists = (await stat(target)).isFile();
      } catch {
        exists = false;
      }
      if (exists) {
        targets.push({ skill: entry.name, name, source: path.join(root, 'shared', name), target });
      }
    }
  }
  return targets;
}

/** 返回内容与 shared/ 源码不一致的副本路径列表；空数组表示全部一致。 */
export async function checkSync() {
  const drifted = [];
  for (const item of await collectTargets()) {
    const [source, target] = await Promise.all([readFile(item.source), readFile(item.target)]);
    if (!source.equals(target)) drifted.push(item.target);
  }
  return drifted;
}

/** 用 shared/ 源码覆盖所有已接入技能的副本，返回写入路径列表。 */
export async function syncShared() {
  const written = [];
  for (const item of await collectTargets()) {
    const source = await readFile(item.source);
    await writeFile(item.target, source);
    written.push(item.target);
  }
  return written;
}

async function main() {
  if (process.argv.includes('--check')) {
    const drifted = await checkSync();
    if (drifted.length > 0) {
      console.error(`以下副本与 shared/ 源码不一致，请运行 node scripts/sync-shared.mjs：\n${drifted.join('\n')}`);
      process.exitCode = 1;
      return;
    }
    console.log('所有技能的共享模块副本与 shared/ 源码一致。');
    return;
  }

  const written = await syncShared();
  if (written.length === 0) {
    console.log('没有技能接入共享模块（skills/*/scripts/ 下不存在同名副本）。');
    return;
  }
  console.log(`已同步 ${written.length} 个副本：\n${written.join('\n')}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`sync-shared: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

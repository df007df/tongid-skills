import assert from 'node:assert/strict';
import test from 'node:test';
import { SHARED_FILES, checkSync, collectTargets } from './sync-shared.mjs';

test('技能里的共享模块副本与 shared/ 源码字节一致', async () => {
  const drifted = await checkSync();
  assert.deepEqual(
    drifted,
    [],
    `共享模块副本漂移，请先运行：node scripts/sync-shared.mjs\n漂移文件：\n${drifted.join('\n')}`,
  );
});

test('登记的每个共享文件都有源码，且至少被一个技能接入', async () => {
  const targets = await collectTargets();
  for (const name of SHARED_FILES) {
    const source = targets.find((item) => item.name === name)?.source;
    assert.ok(source, `共享文件 ${name} 没有任何技能接入（skills/*/scripts/${name} 不存在）`);
  }
});

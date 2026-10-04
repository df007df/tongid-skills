import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillDir = path.dirname(fileURLToPath(import.meta.url));

test('documents Agent login instead of asking the Agent for a Secret Key', async () => {
  const skill = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');

  assert.match(skill, /node scripts\/tongid-skills\.mjs login/);
  assert.match(skill, /TONGID_APPLICATION_ID/);
  assert.doesNotMatch(skill, /- TONGID_SECRET_KEY/);
  assert.match(skill, /本机 Agent 不使用 Secret Key/);
  assert.match(skill, /Authorization: Bearer/);
});

test('describes one board API with service, manager, signed-in, and guest authorization lanes', async () => {
  const reference = JSON.parse(
    await readFile(path.join(skillDir, 'references', 'tongid-board.json'), 'utf8'),
  );
  const create = reference.paths['/issues'].post;

  assert.deepEqual(create.security, [
    { TongIdSecretKey: [] },
    { TongIdBearer: [], TongIdApplicationId: [] },
    { TongIdApplicationId: [] },
  ]);
  const input = reference.components.schemas.IssueCreateInput;
  assert.ok(input.properties.guestId);
  assert.ok(input.properties.contactEmail);
  assert.equal(input.required.includes('categoryId'), false);
  assert.deepEqual(reference.paths['/issues'].get.security, [
    { TongIdSecretKey: [] },
    { TongIdBearer: [], TongIdApplicationId: [] },
  ]);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFlags, queryString, required } from './tongid-board.mjs';

test('parseFlags 支持旗标与位置参数混排（--application-id 可放任意位置）', () => {
  assert.deepEqual(
    parseFlags(['--application-id', 'app_1', 'stats']),
    { flags: { 'application-id': 'app_1' }, positional: ['stats'] },
  );
  assert.deepEqual(
    parseFlags(['get', 'issue_1', '--application-id=app_2']),
    { flags: { 'application-id': 'app_2' }, positional: ['get', 'issue_1'] },
  );
});

test('parseFlags 拒绝缺少取值的旗标', () => {
  assert.throws(() => parseFlags(['--application-id', '--lane']), /缺少 --application-id 的值/);
});

test('业务命令必须显式传 --application-id', () => {
  assert.throws(() => required({}, 'application-id'), /--application-id/);
  assert.equal(required({ 'application-id': 'app_1' }, 'application-id'), 'app_1');
});

test('queryString 将已知旗标转成驼峰查询参数', () => {
  assert.equal(
    queryString({ 'page-size': '25', lane: 'pending' }, ['lane', 'page-size']),
    '?lane=pending&pageSize=25',
  );
  assert.equal(queryString({}, ['lane']), '');
});

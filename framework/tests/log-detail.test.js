import test from 'node:test';
import assert from 'node:assert/strict';
import { logDetail, logErrorCode, logSummary } from '../src/log-detail.js';

test('failed logs expose stable codes with concise localized explanations', () => {
  const event = { result: 'failed', code: 'INVALID_SETTINGS' };
  assert.match(logDetail(event, 'zh-CN', '保存配置'), /配置内容不符合插件的配置规则。 \[INVALID_SETTINGS\]/);
  assert.match(logDetail(event, 'en-US', 'Save settings'), /Settings do not match the plugin schema/);
  assert.match(logDetail({ result: 'failed', code: 'EXAMPLE_UNKNOWN_CODE' }, 'en-US', 'Save'), /\[EXAMPLE_UNKNOWN_CODE\]/);
});

test('unsafe error text and arbitrary payloads do not enter log descriptions', () => {
  const detail = logDetail({ result: 'failed', code: 'EXAMPLE_PRIVATE_DIAGNOSTIC\npassword=EXAMPLE_SECRET', message: 'EXAMPLE_SECRET', settings: { password: 'EXAMPLE_SECRET' } }, 'zh-CN', '保存配置');
  assert.match(detail, /OPERATION_FAILED/); assert.equal(detail.includes('EXAMPLE_SECRET'), false);
});

test('native audit delivery errors remain distinguishable from successful primary operations', () => {
  const detail = logDetail({ result: 'success', towerDelivery: { state: 'permission-denied', code: 'TOWER_AUDIT_SYSTEM_USER_REQUIRED' } }, 'zh-CN', '保存配置');
  assert.match(detail, /保存配置 · 操作已完成/); assert.match(detail, /原生日志副本/);
  assert.match(detail, /only allow by system user/); assert.match(detail, /TOWER_AUDIT_SYSTEM_USER_REQUIRED/);
  assert.equal(logDetail({ result: 'started' }, 'en-US', 'Save settings').includes('Request accepted for processing'), true);
});

test('table summaries keep failure explanations short and audit diagnostics in record details', () => {
  const event = { result: 'failed', code: 'INVALID_SETTINGS', towerDelivery: { state: 'permission-denied', code: 'TOWER_AUDIT_SYSTEM_USER_REQUIRED' } };
  assert.equal(logSummary(event, 'zh-CN'), '配置内容不符合插件的配置规则 · 原生日志副本失败');
  assert.equal(logSummary(event, 'en-US'), 'Settings do not match the plugin schema · Audit copy failed');
  assert.equal(logErrorCode(event), 'INVALID_SETTINGS');
  for (const locale of ['zh-CN', 'en-US']) {
    assert.doesNotMatch(logSummary(event, locale), /only allow by system user|TOWER_AUDIT_SYSTEM_USER_REQUIRED|\n/);
    assert.match(logDetail(event, locale, 'Save settings'), /only allow by system user/);
  }
  assert.equal(logSummary({ result: 'success' }, 'zh-CN'), '操作已完成');
  assert.equal(logSummary({ result: 'started' }, 'zh-CN'), '正在处理请求');
  assert.equal(logSummary({ result: 'success' }, 'en-US'), 'Operation completed');
  assert.equal(logSummary({ result: 'started' }, 'en-US'), 'Processing request');
  assert.equal(logErrorCode({ result: 'success', code: 'INVALID_SETTINGS' }), null);
});

test('summary and detail metadata never reuse arbitrary diagnostics or malformed codes', () => {
  const event = { result: 'failed', code: 'INVALID_SETTINGS\nEXAMPLE_SECRET', message: 'EXAMPLE_SECRET', settings: { password: 'EXAMPLE_SECRET' }, towerDelivery: { state: 'failed', code: 'EXAMPLE_SECRET\nvalue' } };
  for (const locale of ['zh-CN', 'en-US']) {
    assert.doesNotMatch(logSummary(event, locale), /EXAMPLE_SECRET|\n/);
    assert.doesNotMatch(logDetail(event, locale, 'Save'), /EXAMPLE_SECRET/);
  }
  assert.equal(logErrorCode(event), 'OPERATION_FAILED');
  assert.equal(logSummary({ result: 'failed', code: 'EXAMPLE_UNKNOWN_CODE' }, 'en-US'), 'The operation was rejected');
});

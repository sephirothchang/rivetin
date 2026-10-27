import test from 'node:test';
import assert from 'node:assert/strict';
import { logDetail } from '../src/log-detail.js';

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

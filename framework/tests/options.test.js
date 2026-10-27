import test from 'node:test';
import assert from 'node:assert/strict';
import { listenPort } from '../server/options.js';

test('Rivetin listener uses only its explicit port configuration', () => {
  assert.equal(listenPort({}), 8787);
  assert.equal(listenPort({ RIVETIN_LISTEN_PORT: '8789' }), 8789);
  assert.equal(listenPort({ PLUGINKIT_LISTEN_PORT: '8790' }), 8787);
  assert.equal(listenPort({ PLUGINKIT_LISTEN_PORT: '8790', RIVETIN_LISTEN_PORT: '8789' }), 8789);
  for (const value of ['0', '65536', '', 'NaN', 'tcp://example.invalid:8787']) {
    assert.throws(() => listenPort({ RIVETIN_LISTEN_PORT: value }), /INVALID_LISTEN_PORT/);
  }
});

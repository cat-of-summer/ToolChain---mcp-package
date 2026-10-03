import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, fallbackEnv, reset } from '../src/local/reach.js';

test('пока хост доступен или не проверен, окружение не трогается', async () => {
  reset(null);
  assert.deepEqual(fallbackEnv({}), {});
  await probe(async () => ({ status: 200 }));
  assert.deepEqual(fallbackEnv({}), {});
});

test('недоступный хост переключает mise на первоисточники', async () => {
  await probe(async () => { throw new Error('tls handshake eof'); });
  assert.deepEqual(fallbackEnv({}), { MISE_USE_VERSIONS_HOST: 'false', MISE_PYTHON_COMPILE: 'true' });
});

test('явно заданное человеком не перебивается', async () => {
  await probe(async () => { throw new Error('timeout'); });
  assert.deepEqual(fallbackEnv({ MISE_PYTHON_COMPILE: 'false' }), { MISE_USE_VERSIONS_HOST: 'false' });
  reset(null);
});

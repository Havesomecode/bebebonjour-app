import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeProviderToken } from '../../src/delivery-loop/provider-transport.mjs';

const token = 'loop-test-token-'.repeat(4);
const environment = { BEBEBONJOUR_DELIVERY_LOOP_TOKEN: token };

test('provider authorization rejects wrong tokens without exposing a credential', () => {
  assert.doesNotThrow(() => authorizeProviderToken(token, environment));
  assert.throws(() => authorizeProviderToken('bad', environment), /provider_unauthorized/);
});

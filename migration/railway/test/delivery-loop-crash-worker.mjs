import { createPool } from '../database.mjs';
import { createDeliveryLoopEmailBridge } from '../delivery-loop-email-bridge.mjs';

const url = new URL(process.env.BB_TEST_DATABASE_URL);
if (url.hostname !== '127.0.0.1' || !/^\/bb_candidate[a-z0-9_]*$/.test(url.pathname)) throw new Error('synthetic_database_required');
const pool = createPool(url.toString());
const bridge = createDeliveryLoopEmailBridge({ pool, mode: 'synthetic',
  workerToken: process.env.BEBEBONJOUR_DELIVERY_LOOP_TOKEN, provider: 'resend',
  transport: { async send(message, { fenceExternalEffect }) {
    return fenceExternalEffect({ effectMayBeIssued: true }, async () => {
      // Simulates a process dying after admission and before any network call.
      process.stdout.write('synthetic_admission_committed_no_network\n');
      process.exit(73);
    });
  } },
});
await bridge.send(JSON.parse(process.env.BB_SYNTHETIC_COMMAND));
throw new Error('crash_probe_did_not_exit');

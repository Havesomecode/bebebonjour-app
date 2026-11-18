'use node';

import { internalActionGeneric } from 'convex/server';
import { v } from 'convex/values';

// Keep a refusal for direct/previously queued calls. Historical ledger rows and
// their reconciliation mutations remain intact; no flag can reopen forwarding.
export const receive = internalActionGeneric({
  args: { eventId: v.string(), emailId: v.string(), rawBodySha256: v.string(),
    disposition: v.union(v.literal('forward'), v.literal('ignored')) },
  handler: async () => { throw new Error('support_forward_retired'); },
});

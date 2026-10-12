import { mutationGeneric } from "convex/server";
import { v } from "convex/values";
import { advanceBudget } from "./abusePolicy.js";

export const consume = mutationGeneric({
  args: {
    backendToken: v.string(),
    scope: v.union(v.literal("intake"), v.literal("checkout"), v.literal("status"),
      v.literal("stripe"), v.literal("tally")),
  },
  handler: async (context, args) => {
    const expected = process.env.CUSTOMER_FLOW_BACKEND_TOKEN;
    if (!expected || expected.length < 32 || args.backendToken !== expected) {
      throw new Error("Abuse budget authorization failed.");
    }
    const existing = await context.db.query("customerFlowAbuseBudgets")
      .withIndex("by_scope", (query) => query.eq("scope", args.scope)).unique();
    // Clock, policies, and increments are backend-owned. Convex OCC serializes
    // contenders across all replicas; a denied attempt writes nothing.
    const { next, ...result } = advanceBudget(existing, args.scope, Date.now());
    if (next) {
      if (existing) await context.db.patch(existing._id, next);
      else await context.db.insert("customerFlowAbuseBudgets", next);
    }
    return result;
  },
});

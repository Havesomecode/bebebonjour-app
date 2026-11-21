// Adapter used only by the retained legacy Convex HTTP entry point.
import { makeFunctionReference } from 'convex/server';
export function legacyContext(ctx) {
  return {...ctx, runQuery:(ref,args)=>ctx.runQuery(makeFunctionReference(ref),args), runMutation:(ref,args)=>ctx.runMutation(makeFunctionReference(ref),args), runAction:(ref,args)=>ctx.runAction(makeFunctionReference(ref),args)};
}

// Bridge moved local registrations into convex-test for retained legacy-only assertions.
import { queryGeneric, mutationGeneric, actionGeneric, internalQueryGeneric, internalMutationGeneric, internalActionGeneric, makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
function convert(s) {
  if (s.type === 'object') return v.object(Object.fromEntries(Object.entries(s.value).map(([k,f]) => [k,f.optional ? v.optional(convert(f.fieldType)) : convert(f.fieldType)])));
  if (s.type === 'union') return v.union(...s.value.map(convert));
  if (s.type === 'array') return v.array(convert(s.value));
  if (s.type === 'literal') return v.literal(s.value);
  if (s.type === 'id') return v.id('_storage');
  return v[s.type]();
}
export function bridge(fn) {
  const register = ({query:fn.isPublic ? queryGeneric : internalQueryGeneric,mutation:fn.isPublic ? mutationGeneric : internalMutationGeneric,action:fn.isPublic ? actionGeneric : internalActionGeneric})[fn.kind];
  const args=Object.fromEntries(Object.entries(fn.args.value).map(([key,f])=>[key, f.optional ? v.optional(convert(f.fieldType)) : convert(f.fieldType)]));
  return register({args, handler(ctx, args) { const ref = name => makeFunctionReference(name); const local = {...ctx};
    for (const method of ['runQuery','runMutation','runAction']) if (ctx[method]) local[method]=(name, values)=>ctx[method](ref(name),values);
    if (ctx.scheduler) local.scheduler={...ctx.scheduler,runAfter:(delay,name,values)=>ctx.scheduler.runAfter(delay,ref(name),values)};
    return fn.handler(local,args);
  }});
}

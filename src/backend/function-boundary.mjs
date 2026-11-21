import { validate } from './functions.mjs';
// Resolve only the modules needed by the delivery loop. Never derive an import
// path from a caller-supplied function name.
const modules = {
  deliveryLoop: () => import('./deliveryLoop.js'),
  deliveryLoopData: () => import('./deliveryLoopData.js'),
  deliveryLoopProviders: () => import('./deliveryLoopProviders.js'),
  deliveryLoopNotices: () => import('./deliveryLoopNotices.js'),
  deliveryLoopDataProviders: () => import('./deliveryLoopDataProviders.js'),
  deliveryLoopPaymentEvents: () => import('./deliveryLoopPaymentEvents.js'),
  operations: () => import('./operations.js'),
};
const publicModules = new Set(['deliveryLoop', 'deliveryLoopData', 'deliveryLoopProviders']);
const operations = new Set(['consumeLoginAttempt', 'resetLoginThrottle']);

export async function resolveFunction(path, kind, { internal = false } = {}) {
  if (typeof path !== 'string' || !/^[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]*$/.test(path)) throw new Error('function_not_found');
  const [module, name] = path.split(':');
  if (!Object.hasOwn(modules, module) || (module === 'operations' && !operations.has(name)) || (!internal && !publicModules.has(module) && module !== 'operations')) throw new Error('function_not_found');
  const fn = (await modules[module]())[name];
  if (!['query', 'mutation', 'action'].includes(kind) || fn?.kind !== kind || (!internal && !fn.isPublic)) throw new Error('function_not_found');
  return fn;
}

export class ArgumentValidationError extends Error {
  constructor() { super('invalid_arguments'); this.name = 'ArgumentValidationError'; }
}

export function validateArguments(fn, args) {
  if (!validate(fn.args, args)) throw new ArgumentValidationError();
}

// Resolve only the modules needed by the delivery loop. Never derive an import
// path from a caller-supplied function name.
const modules = {
  deliveryLoop: () => import('../../convex/deliveryLoop.js'),
  deliveryLoopData: () => import('../../convex/deliveryLoopData.js'),
  deliveryLoopProviders: () => import('../../convex/deliveryLoopProviders.js'),
  deliveryLoopNotices: () => import('../../convex/deliveryLoopNotices.js'),
  deliveryLoopDataProviders: () => import('../../convex/deliveryLoopDataProviders.js'),
  deliveryLoopPaymentEvents: () => import('../../convex/deliveryLoopPaymentEvents.js'),
  operations: () => import('../../convex/operations.js'),
};
const publicModules = new Set(['deliveryLoop', 'deliveryLoopData', 'deliveryLoopProviders']);
const operations = new Set(['consumeLoginAttempt', 'resetLoginThrottle']);

export async function resolveFunction(path, kind, { internal = false } = {}) {
  if (typeof path !== 'string' || !/^[A-Za-z][A-Za-z0-9]*:[A-Za-z][A-Za-z0-9]*$/.test(path)) throw new Error('function_not_found');
  const [module, name] = path.split(':');
  if (!Object.hasOwn(modules, module) || (module === 'operations' && !operations.has(name)) || (!internal && !publicModules.has(module) && module !== 'operations')) throw new Error('function_not_found');
  const fn = (await modules[module]())[name];
  const flag = { query: 'isQuery', mutation: 'isMutation', action: 'isAction' }[kind];
  if (!flag || !fn?.[flag] || (!internal && !fn.isPublic)) throw new Error('function_not_found');
  return fn;
}

function matches(schema, value) {
  switch (schema.type) {
    case 'any': return value !== undefined;
    case 'null': return value === null;
    case 'string': case 'id': return typeof value === 'string';
    case 'number': case 'float64': return typeof value === 'number';
    case 'int64': return typeof value === 'bigint';
    case 'boolean': return typeof value === 'boolean';
    case 'bytes': return value instanceof ArrayBuffer;
    case 'literal': return Object.is(value, schema.value);
    case 'array': return Array.isArray(value) && value.every(item => matches(schema.value, item));
    case 'union': return schema.value.some(member => matches(member, value));
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.keys(value).every(key => Object.hasOwn(schema.value, key)) && Object.entries(schema.value).every(([key, field]) =>
        Object.hasOwn(value, key) ? matches(field.fieldType, value[key]) : field.optional);
    }
    case 'record': return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, item]) => matches(schema.keys, key) && matches(schema.values, item));
    default: return false;
  }
}

export class ArgumentValidationError extends Error {
  constructor() { super('invalid_arguments'); this.name = 'ArgumentValidationError'; }
}

export function validateArguments(fn, args) {
  if (!matches(JSON.parse(fn.exportArgs()), args)) throw new ArgumentValidationError();
}

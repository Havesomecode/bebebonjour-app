// The narrow registration and validator API used by the local backend.
const primitive = type => () => ({ type });
export const v = {
  any: primitive('any'), null: primitive('null'), string: primitive('string'), number: primitive('number'),
  boolean: primitive('boolean'), id: () => ({type:'id'}), bytes: primitive('bytes'),
  literal: value => ({type:'literal', value}), array: value => ({type:'array', value}),
  union: (...value) => ({type:'union', value}), optional: value => ({...value, optional:true}),
  object: fields => ({type:'object', value:Object.fromEntries(Object.entries(fields).map(([k, field]) => [k, {fieldType: field, optional: !!field.optional}]))}),
  record: (keys, values) => ({type:'record',keys,values}),
};
const register = (kind, isPublic) => ({args = {}, handler}) => Object.freeze({kind, isPublic, args:v.object(args), handler});
export const query=register('query',true), mutation=register('mutation',true), action=register('action',true);
export const internalQuery=register('query',false), internalMutation=register('mutation',false), internalAction=register('action',false);
export const httpAction = handler => Object.freeze({handler});
export const paginationOpts = v.object({numItems:v.number(), cursor:v.union(v.string(),v.null())});
function isValue(value) {
  if (typeof value === 'bigint') return value >= -(1n << 63n) && value < (1n << 63n);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value) || value instanceof ArrayBuffer) return true;
  if (Array.isArray(value)) return value.every(isValue);
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.entries(value).every(([key, item]) => key.length <= 1024 && !key.startsWith('$') && /^[\x20-\x7e]*$/.test(key) && isValue(item));
}

export function validate(schema, value) {
  switch (schema.type) {
    case 'any': return isValue(value);
    case 'null': return value === null;
    case 'string': case 'id': return typeof value === 'string';
    case 'number': case 'float64': return typeof value === 'number';
    case 'int64': return typeof value === 'bigint';
    case 'boolean': return typeof value === 'boolean';
    case 'bytes': return value instanceof ArrayBuffer;
    case 'literal': return Object.is(value, schema.value);
    case 'array': return Array.isArray(value) && value.every(item => validate(schema.value, item));
    case 'union': return schema.value.some(member => validate(member, value));
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
      return Object.keys(value).every(key => Object.hasOwn(schema.value, key)) && Object.entries(schema.value).every(([key, field]) =>
        Object.hasOwn(value, key) ? validate(field.fieldType, value[key]) : field.optional);
    }
    case 'record': return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, item]) => validate(schema.keys, key) && validate(schema.values, item));
    default: return false;
  }
}

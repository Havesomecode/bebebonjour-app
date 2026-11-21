// The API returns function errors as JSON even when the HTTP status is 200.
// Never log provider-supplied response bodies or logLines.
export function createBackendClient(origin, { fetch: fetchImpl = globalThis.fetch } = {}) {
  async function call(kind, path, args) {
    const response = await fetchImpl(`${origin}/api/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, args: [args] }),
    });
    if (!response.ok) throw new Error('backend_response_invalid');
    let result;
    try { result = await response.json(); } catch { throw new Error('backend_response_invalid'); }
    if (result?.status === 'error' && typeof result.errorMessage === 'string') throw new Error(result.errorMessage);
    if (result?.status !== 'success' || !Object.hasOwn(result, 'value')) throw new Error('backend_response_invalid');
    return result.value;
  }
  return Object.fromEntries(['query', 'mutation', 'action'].map(kind => [kind, (path, args) => call(kind, path, args)]));
}

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const copy = value => JSON.parse(JSON.stringify(value));

// The envelope is frozen with the host. Action-specific choices are deliberately
// kept separate: a choices property cannot overwrite VM identity or permission.
export async function readActionData(bridge, resource, actionId, { signal } = {}) {
  if (signal?.aborted) throw new Error('ACTION_READ_CANCELLED');
  if (typeof bridge?.choices !== 'function' || resource?.type !== 'vm' || !identifier(resource.id) ||
      typeof actionId !== 'string' || !/^vm\.[A-Za-z0-9_.]{1,120}$/.test(actionId)) throw new Error('ACTION_CHOICES_UNAVAILABLE');
  const result = await bridge.choices({ type: 'vm', id: resource.id }, { actionId, signal });
  if (signal?.aborted) throw new Error('ACTION_READ_CANCELLED');
  if (!plain(result) || result.actionId !== actionId || !plain(result.snapshot) ||
      result.snapshot.id !== resource.id || result.snapshot.type !== resource.type ||
      !plain(result.capabilities) || !plain(result.choices)) throw new Error('ACTION_CHOICES_INVALID');
  return copy({ actionId, snapshot: result.snapshot, capabilities: result.capabilities, choices: result.choices });
}

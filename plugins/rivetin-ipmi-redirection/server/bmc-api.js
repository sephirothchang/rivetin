import { createRedfishClient, RedfishError } from './redfish-adapter.js';

// Protocol selection is explicit. This module has no HTTP listener, credential store, or automatic network transport.
export function createBmcApiClient(options) { return createRedfishClient(options); }
export async function inspectBmc(options, credentials) {
  const client = createBmcApiClient(options);
  const session = await client.login(credentials);
  let inventory, readError;
  try { inventory = await session.readInventory(); } catch (error) { readError = error; }
  try { await session.logout(); } catch {
    throw new RedfishError(readError ? 'INVENTORY_AND_SESSION_CLEANUP_FAILED' : 'SESSION_CLEANUP_FAILED');
  }
  if (readError) throw readError;
  return inventory;
}

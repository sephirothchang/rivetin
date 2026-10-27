const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const devicePath = value => text(value, 256) && /^\/dev\/[A-Za-z0-9._/-]+$/.test(value) && value.slice(5).split('/').every(part => part && part !== '.' && part !== '..');
const authenticated = actor => object(actor?.auth) && ['Authorization', 'Cookie'].some(name => text(actor.auth[name], name === 'Cookie' ? 16384 : 8192));

// CloudTower 4.9 GetDisks returns Disk[]; host is one NestedHost object.
// Keep this result server-side: command policy separately checks device paths.
export function createTowerDiskReader({ request } = {}) {
  if (typeof request !== 'function') throw new Error('TOWER_TRANSPORT_REQUIRED');
  return async function readDisk(input) {
    if (!object(input) || !identifier(input.diskId)) throw new Error('TOWER_DISK_REQUEST_INVALID');
    const { diskId, actor } = input;
    if (!authenticated(actor)) throw new Error('AUTHENTICATION_REQUIRED');
    let result;
    try { result = await request('/v2/api/get-disks', { where: { id: diskId }, first: 2 }, actor); }
    catch (error) { throw Object.assign(new Error('TOWER_DISK_READ_FAILED'), { status: [401, 403, 404].includes(error.status) ? error.status : 503 }); }
    if (!Array.isArray(result) || Object.hasOwn(result, 'errors')) throw new Error('TOWER_DISK_RESPONSE_INVALID');
    if (result.length === 0) throw new Error('TOWER_DISK_NOT_FOUND');
    if (result.length !== 1) throw new Error('TOWER_DISK_AMBIGUOUS');
    const disk = result[0];
    if (!object(disk) || disk.id !== diskId || !object(disk.host) || !identifier(disk.host.id) ||
        !text(disk.serial, 256) || !devicePath(disk.path) || !text(disk.model, 512)) throw new Error('TOWER_DISK_RESPONSE_INVALID');
    return { id: disk.id, hostId: disk.host.id, serial: disk.serial, path: disk.path, model: disk.model };
  };
}

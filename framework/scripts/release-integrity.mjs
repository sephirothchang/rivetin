import { createHash } from 'node:crypto';

const MiB = 1024 * 1024;
const relative = value => typeof value === 'string' && value.length <= 180 && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(value) && value.split('/').every(part => !['.', '..'].includes(part) && !/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(part));
const releasePath = value => relative(value) && /^(?:(?:server|shared)\/.*\.(?:js|mjs|cjs|json)|deploy\/[a-z][a-z0-9-]*\.(?:sh|yaml)|cli\.mjs|package\.json|LICENSE|THIRD_PARTY_NOTICES\.txt)$/.test(value);

// A local measurement baseline, not a publisher signature or independent trust root.
export function buildIntegrity({ frameworkVersion, files } = {}) {
  if (typeof frameworkVersion !== 'string' || frameworkVersion !== frameworkVersion.trim() || !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(frameworkVersion)) throw new Error('INTEGRITY_VERSION_INVALID');
  if (!Array.isArray(files) || !files.length || files.length > 200) throw new Error('INTEGRITY_FILE_LIMIT');
  const names = new Set(); let total = 0;
  for (const row of files) {
    if (!row || Object.keys(row).sort().join() !== 'content,path' || !releasePath(row.path) || names.has(row.path.toLowerCase()) || !Buffer.isBuffer(row.content)) throw new Error('INTEGRITY_INPUT_INVALID');
    if (row.content.length > 16 * MiB || (total += row.content.length) > 32 * MiB) throw new Error('INTEGRITY_BYTE_LIMIT');
    names.add(row.path.toLowerCase());
  }
  return { schemaVersion: 1, frameworkVersion, files: [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(row => ({ path: row.path, sha256: createHash('sha256').update(row.content).digest('hex'), bytes: row.content.length })) };
}

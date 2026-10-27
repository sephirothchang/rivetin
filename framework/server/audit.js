import { open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, json } from './storage.js';

export function auditStore(root, towerSink) {
  const file = path.join(root, 'audit.jsonl');
  let towerStatus = towerSink ? 'pending' : 'local-only';
  return {
    status: () => towerStatus,
    async append({ actor, action, pluginId = null, result = 'success', code = null }) {
      const event = { id: randomUUID(), time: new Date().toISOString(), actor: { id: actor.id, name: actor.name, source: actor.source }, action, pluginId, result, code };
      const handle = await open(file, 'a', 0o600);
      try { await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); } finally { await handle.close(); }
      return event;
    },
    async recent({ pluginId, limit = 50, before } = {}) {
      const count = Math.max(1, Math.min(100, Number(limit) || 50));
      let handle;
      try {
        handle = await open(file, 'r'); const info = await handle.stat(), size = Math.min(info.size, 1024 * 1024);
        const buffer = Buffer.alloc(size); await handle.read(buffer, 0, size, info.size - size);
        const lines = buffer.toString('utf8').split('\n'); if (info.size > size) lines.shift();
        const events = lines.filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
        const filtered = events.filter(event => (!pluginId || event.pluginId === pluginId));
        const index = before ? filtered.findIndex(event => event.id === before) + 1 : 0;
        if (before && index === 0) return { items: [], next: null };
        const items = filtered.slice(index, index + count);
        for (const item of items) item.towerDelivery = await json(path.join(root, 'audit-delivery', `${item.id}.json`), { state: 'local-only' });
        return { items, next: filtered.length > index + count ? items.at(-1).id : null };
      } catch (error) { if (error.code === 'ENOENT') return { items: [], next: null }; throw error; }
      finally { await handle?.close(); }
    },
    // Explicit delivery only. A failed mirror never erases the local audit record.
    async mirror(event, actor) {
      if (!towerSink || event.actor.source !== 'tower') return { state: 'local-only' };
      if (towerStatus === 'permission-denied') {
        const delivery = { state: 'permission-denied', code: 'TOWER_AUDIT_SYSTEM_USER_REQUIRED' };
        await atomic(path.join(root, 'audit-delivery', `${event.id}.json`), delivery); return delivery;
      }
      let delivery;
      try { await towerSink(event, actor); delivery = { state: 'confirmed' }; }
      catch (error) { delivery = { state: error.message === 'TOWER_AUDIT_SYSTEM_USER_REQUIRED' ? 'permission-denied' : 'failed', code: /^[A-Z_]+$/.test(error.message) ? error.message : 'TOWER_AUDIT_FAILED' }; }
      towerStatus = delivery.state;
      await atomic(path.join(root, 'audit-delivery', `${event.id}.json`), delivery);
      return delivery;
    },
  };
}
export function createTowerAuditSink({ request }) {
  if (typeof request !== 'function') throw new Error('TOWER_TRANSPORT_REQUIRED');
  return async (event, actor) => {
    let timer;
    const response = await Promise.race([request('/v2/api/create-user-audit-log', [{
      user_id: event.actor.id, started_at: event.time, finished_at: event.time,
      resource_id: event.pluginId || 'pluginkit', resource_type: 'pluginkit', action: event.action,
      status: event.result === 'success' ? 'SUCCESSED' : 'FAILED',
      message: { 'zh-CN': `PluginKit：${event.action}，对象：${event.pluginId || 'pluginkit'}，结果：${event.result}，记录：${event.id}`,
        'en-US': `PluginKit: ${event.action}; target: ${event.pluginId || 'pluginkit'}; result: ${event.result}; record: ${event.id}` },
    }], actor), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TOWER_AUDIT_TIMEOUT')), 4000); })]).finally(() => clearTimeout(timer));
    if (!Array.isArray(response) || response.length !== 1 || !response[0]?.data?.id) throw new Error('TOWER_AUDIT_NOT_CONFIRMED');
    // CloudTower may return an asynchronous task. Submission is not completion.
    if (response[0].task_id) throw new Error('TOWER_AUDIT_TASK_PENDING');
    return { id: response[0].data.id };
  };
}

const copy = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({ version: 1, revision: 0, updatedAt: null, operationId: null, global: null, clusters: [], hosts: [] });
const keep = () => ({ action: 'keep' });
const newConnection = () => ({ username: 'root', authType: 'password', password: keep(), privateKey: keep() });
const draftConnection = value => value === null ? null : { username: value.username, authType: value.authType, password: keep(), privateKey: keep() };
function checkConnection(value) {
  if (value === null) return;
  if (!object(value) || Object.keys(value).some(key => !['username', 'authType', 'hasPassword', 'hasPrivateKey'].includes(key)) || typeof value.username !== 'string' || !['password', 'private-key'].includes(value.authType) || typeof value.hasPassword !== 'boolean' || typeof value.hasPrivateKey !== 'boolean') throw new Error('SSH_CONNECTION_RESPONSE_INVALID');
}
function checked(value) {
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.updatedAt === null || typeof value.updatedAt === 'string') || !(value.operationId === null || typeof value.operationId === 'string') || !Array.isArray(value.clusters) || value.clusters.length > 500 || !Array.isArray(value.hosts) || value.hosts.length > 500) throw new Error('SSH_CONNECTION_RESPONSE_INVALID');
  if (Object.keys(value).some(key => !['version', 'revision', 'updatedAt', 'operationId', 'global', 'clusters', 'hosts'].includes(key))) throw new Error('SSH_CONNECTION_RESPONSE_INVALID');
  checkConnection(value.global);
  for (const row of value.clusters) { if (!object(row) || Object.keys(row).some(key => !['clusterId', 'connection'].includes(key)) || typeof row.clusterId !== 'string') throw new Error('SSH_CONNECTION_RESPONSE_INVALID'); checkConnection(row.connection); }
  for (const row of value.hosts) {
    if (!object(row) || Object.keys(row).some(key => !['hostId', 'clusterId', 'address', 'port', 'hostKeySha256', 'devices', 'connection', 'effective'].includes(key)) || typeof row.hostId !== 'string' || typeof row.clusterId !== 'string' || typeof row.address !== 'string' || !Number.isInteger(row.port) || typeof row.hostKeySha256 !== 'string' || !Array.isArray(row.devices)) throw new Error('SSH_CONNECTION_RESPONSE_INVALID');
    for (const device of row.devices) if (!object(device) || Object.keys(device).some(key => !['deviceId', 'path', 'serial'].includes(key)) || typeof device.deviceId !== 'string' || typeof device.path !== 'string' || device.serial !== undefined && typeof device.serial !== 'string') throw new Error('SSH_CONNECTION_RESPONSE_INVALID');
    checkConnection(row.connection);
    if (!object(row.effective) || Object.keys(row.effective).some(key => !['source', 'username', 'authType', 'hasPassword', 'hasPrivateKey', 'ready'].includes(key)) || !['host', 'cluster', 'global', 'none'].includes(row.effective.source) || typeof row.effective.ready !== 'boolean') throw new Error('SSH_CONNECTION_RESPONSE_INVALID');
  }
  return copy(value);
}
function draftOf(value) {
  return { version: 1, global: draftConnection(value.global), clusters: value.clusters.map(row => ({ clusterId: row.clusterId, connection: draftConnection(row.connection) })),
    hosts: value.hosts.map(({ connection, effective, ...target }) => ({ ...copy(target), connection: draftConnection(connection) })) };
}
export function createSshConnectionsStore({ client, crypto } = {}) {
  if (typeof client !== 'function') throw new Error('SSH_CONNECTION_CLIENT_REQUIRED');
  let saved = empty(), baseline = draftOf(saved), draft = copy(baseline), disposed = false, pending = null, epoch = 0, loadControl = null;
  let state = { loaded: false, loading: false, saving: false, error: '', revision: 0, updatedAt: null };
  const listeners = new Set(), controls = new Set();
  const status = () => ({ ...state, dirty: JSON.stringify(draft) !== JSON.stringify(baseline) });
  const emit = () => { if (!disposed) for (const listener of listeners) listener(copy(saved)); };
  const safeErrors = new Set(['SSH_CONNECTION_RESPONSE_INVALID', 'SSH_CONNECTION_RANDOM_UNAVAILABLE', 'SSH_CONNECTION_SAVE_NOT_CONFIRMED', 'SSH_CONNECTION_SETTINGS_INVALID', 'SSH_CONNECTION_SETTINGS_TOO_LARGE', 'SSH_CONNECTION_OPERATION_CONFLICT', 'SSH_VAULT_KEY_MISSING', 'SSH_VAULT_INVALID', 'SSH_VAULT_PERMISSIONS', 'SSH_HOST_INVALID', 'SSH_HOST_ADDRESS_REJECTED', 'SSH_HOST_KEY_REQUIRED', 'SSH_DEVICE_INVALID', 'SSH_CREDENTIAL_REQUIRED', 'ADMIN_OR_ORIGIN_REQUIRED', 'ADMIN_REQUIRED', 'AUTHENTICATION_REQUIRED', 'STORE_BUSY']);
  const code = error => safeErrors.has(error?.message) ? error.message : 'SSH_CONNECTION_REQUEST_FAILED';
  function accept(value) { saved = checked(value); baseline = draftOf(saved); draft = copy(baseline); pending = null; state = { ...state, loaded: true, revision: saved.revision, updatedAt: saved.updatedAt, error: '' }; }
  async function request(method, body, control = new AbortController()) {
    controls.add(control);
    try { return checked(await client('/ssh-channel/connections', method, body, { signal: control.signal })); }
    finally { controls.delete(control); }
  }
  return {
    status, get: () => copy(saved), getDraft: () => copy(draft),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    update(patch) { if (!disposed && state.loaded && !state.saving) { epoch++; draft = copy({ ...draft, ...patch }); pending = null; emit(); } return copy(draft); },
    async load() {
      if (disposed || state.loading || state.saving) return;
      const generation = epoch, control = new AbortController(); loadControl = control; state.loading = true; emit();
      try { const value = await request('GET', undefined, control); if (!disposed && generation === epoch && value.revision >= saved.revision) { if (!status().dirty || pending && value.operationId === pending.operationId) accept(value); else { saved = value; baseline = draftOf(value); state = { ...state, loaded: true, revision: value.revision, updatedAt: value.updatedAt, error: '' }; } } }
      catch (error) { if (!disposed && generation === epoch) state.error = code(error); }
      finally { if (loadControl === control) { loadControl = null; state.loading = false; emit(); } }
    },
    async save() {
      if (disposed || !state.loaded || state.saving) return false;
      if (!status().dirty) return true;
      epoch++; loadControl?.abort(); loadControl = null; state.loading = false; state.saving = true; state.error = ''; emit();
      try {
        if (!pending) {
          if (typeof crypto?.randomUUID !== 'function') throw new Error('SSH_CONNECTION_RANDOM_UNAVAILABLE');
          pending = { ...copy(draft), operationId: crypto.randomUUID() };
        }
        const operationId = pending.operationId;
        let response;
        try { response = await request('PUT', pending); if (response.operationId !== operationId) throw new Error('SSH_CONNECTION_SAVE_NOT_CONFIRMED'); }
        catch { response = await request('GET'); if (response.operationId !== operationId) throw new Error('SSH_CONNECTION_SAVE_NOT_CONFIRMED'); }
        if (disposed) return false;
        accept(response); return true;
      } catch (error) { if (!disposed) state.error = code(error); return false; }
      finally { state.saving = false; emit(); }
    },
    discard() { if (!state.saving && !disposed) { epoch++; loadControl?.abort(); loadControl = null; state.loading = false; draft = copy(baseline); pending = null; state.error = ''; emit(); } },
    dispose() { disposed = true; epoch++; for (const control of controls) control.abort(); controls.clear(); loadControl = null; saved = empty(); baseline = draftOf(saved); draft = copy(baseline); pending = null; listeners.clear(); },
  };
}

export function createSshConnectionSettings(React) {
  const h = React.createElement, { useEffect, useState } = React;
  return function SshConnectionSettings({ store, client, locale = 'zh-CN' }) {
    const [, render] = useState(0), en = locale === 'en-US', t = (zh, english) => en ? english : zh;
    const [inventory, setInventory] = useState({ clusters: [], hosts: [] }), [inventoryError, setInventoryError] = useState(''), [inventoryBusy, setInventoryBusy] = useState(false);
    useEffect(() => {
      if (!client) return;
      let alive = true; const control = new AbortController();
      loadInventory(() => alive, control.signal);
      return () => { alive = false; control.abort(); };
    }, [client]);
    async function loadInventory(alive = () => true, signal) {
      if (!client) return;
      setInventoryBusy(true);
      try {
        const value = await client('/ssh-channel/inventory', 'GET', undefined, { signal });
        if (!object(value) || !Array.isArray(value.clusters) || value.clusters.length > 500 || !Array.isArray(value.hosts) || value.hosts.length > 500 || value.clusters.some(row => typeof row?.id !== 'string' || typeof row?.name !== 'string') || value.hosts.some(row => typeof row?.id !== 'string' || typeof row?.name !== 'string' || typeof row?.clusterId !== 'string' || typeof row?.address !== 'string')) throw new Error('SSH_INVENTORY_RESPONSE_INVALID');
        if (alive()) { setInventory({ clusters: value.clusters.map(({ id, name }) => ({ id, name })), hosts: value.hosts.map(({ id, name, clusterId, address }) => ({ id, name, clusterId, address })) }); setInventoryError(''); }
      } catch { if (alive()) setInventoryError('SSH_INVENTORY_UNAVAILABLE'); }
      finally { if (alive()) setInventoryBusy(false); }
    }
    useEffect(() => { const unsubscribe = store.subscribe(() => render(value => value + 1)); store.load(); return unsubscribe; }, [store]);
    const status = store.status(), draft = store.getDraft(), saved = store.get();
    function field(label, value, onChange, options = {}) {
      return h('label', { className: 'pk-ssh-connection-field' }, h('span', null, label), h('input', { type: 'text', value, onChange: event => onChange(event.target.value), autoComplete: 'off', spellCheck: false, ...options }));
    }
    function patchRow(type, index, patch) { store.update({ [type]: draft[type].map((row, n) => n === index ? { ...row, ...patch } : row) }); }
    function removeRow(type, index) { store.update({ [type]: draft[type].filter((_, n) => n !== index) }); }
    function clusterSelector(value, update) {
      return h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('选择集群', 'Select cluster')),
        h('select', { value, onChange: event => update(event.target.value) }, h('option', { value: '' }, t('请选择集群', 'Select a cluster')),
          value && !inventory.clusters.some(row => row.id === value) && h('option', { value }, t('已配置映射：', 'Configured mapping: ') + value),
          ...inventory.clusters.map(row => h('option', { value: row.id, key: row.id }, `${row.name} (${row.id})`))));
    }
    function connectionEditor(connection, previous, update) {
      if (!connection) return null;
      const secret = connection.authType === 'password' ? 'password' : 'privateKey', edit = connection[secret];
      return h('div', { className: 'pk-ssh-credential-editor' },
        field(t('账户', 'Username'), connection.username, username => update({ ...connection, username })),
        h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('认证方式', 'Authentication')),
          h('select', { value: connection.authType, onChange: event => update({ ...connection, authType: event.target.value, password: keep(), privateKey: keep() }) }, h('option', { value: 'password' }, t('密码', 'Password')), h('option', { value: 'private-key' }, t('私钥', 'Private key')))),
        h('p', { className: 'pk-ssh-muted' }, t('已保存凭据：', 'Saved credential: ') + (previous?.[secret === 'password' ? 'hasPassword' : 'hasPrivateKey'] ? t('已配置（不回显）', 'Configured (never returned)') : t('未配置', 'Not configured'))),
        h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('凭据操作', 'Credential action')),
          h('select', { value: edit.action, onChange: event => update({ ...connection, [secret]: event.target.value === 'replace' ? { action: 'replace', value: '' } : { action: event.target.value } }) },
            h('option', { value: 'keep' }, t('保留已有凭据', 'Keep existing credential')), h('option', { value: 'replace' }, t('替换为新凭据', 'Replace credential')), h('option', { value: 'clear' }, t('清除已有凭据', 'Clear credential')))),
        edit.action === 'replace' && (secret === 'password' ? field(t('新密码', 'New password'), edit.value, value => update({ ...connection, password: { action: 'replace', value } }), { type: 'password', autoComplete: 'new-password' }) : h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('新私钥', 'New private key')), h('textarea', { value: edit.value, rows: 5, autoComplete: 'off', spellCheck: false, onChange: event => update({ ...connection, privateKey: { action: 'replace', value: event.target.value } }) }))),
        edit.action === 'clear' && h('p', { className: 'pk-ssh-note pk-ssh-warning' }, t('保存后此层凭据将不可用，不会静默回退到更低层凭据。', 'After saving, this scope is unready and will not silently fall back to a lower scope.')));
    }
    const sourceNames = { host: t('主机', 'Host'), cluster: t('集群', 'Cluster'), global: t('全局', 'Global'), none: t('无可用配置', 'No configuration') };
    return h('section', { className: 'pk-ssh-connections' },
      h('style', null, '.pk-ssh-connections fieldset{border:1px solid #dce5ef;border-radius:8px;padding:14px;margin:14px 0;min-width:0}.pk-ssh-connection-field{display:flex;flex-direction:column;gap:5px;margin:10px 0}.pk-ssh-connection-field input,.pk-ssh-connection-field select,.pk-ssh-connection-field textarea{font:inherit;padding:7px;border:1px solid #c9d6e5;border-radius:5px;min-width:0;max-width:100%;box-sizing:border-box}.pk-ssh-connections legend{font-weight:600}.pk-ssh-connections button{margin-right:8px}.pk-ssh-device{border-left:3px solid #e0e7f0;padding-left:12px;margin:12px 0}.pk-ssh-credential-editor{padding:8px 12px;background:#f7f9fc;border-radius:6px}'),
      h('h4', null, t('SSH 连接设置', 'SSH connection settings')),
      h('p', { className: 'pk-ssh-note' }, t('凭据优先级：主机 > 集群 > 全局。地址、主机密钥指纹及设备映射必须逐主机配置。所有编辑仅为草稿，使用插件中心“保存”或“保存并退出”后生效；保存会撤销全部 SSH 授权并中止在途连接。', 'Credential precedence: host > cluster > global. Each host needs its own address, host key pin and device mapping. Edits are drafts until Plugin center Save or Save and exit. Saving revokes all SSH approvals and cancels in-flight connections.')),
      h('p', { className: 'pk-ssh-muted' }, t('留空保留已有凭据。只有明确选择替换或清除才修改秘密；此页面不会读回已保存的密码或私钥。', 'Blank fields keep existing credentials. Secrets change only through explicit Replace or Clear; saved passwords and private keys are never returned.')),
      client && h('div', { className: 'pk-ssh-note' }, inventoryError ? h('span', { role: 'alert' }, t('无法读取集群与主机清单，连接草稿已保留。可重试或使用高级映射配置。', 'Cluster and host inventory unavailable; connection drafts are retained. Retry or use advanced mapping configuration.')) : h('span', null, inventoryBusy ? t('正在读取集群与主机清单…', 'Loading cluster and host inventory…') : t('可从当前 CloudTower 清单选择目标；不会自动配置或连接主机。', 'Choose targets from the current CloudTower inventory; hosts are never configured or connected automatically.')),
        h('button', { type: 'button', disabled: inventoryBusy, onClick: () => loadInventory() }, t('刷新目标清单', 'Refresh target inventory'))),
      status.error && h('p', { className: 'pk-ssh-error', role: 'alert' }, t('连接设置操作未完成：', 'Connection settings incomplete: ') + status.error),
      !status.loaded ? h('p', null, status.loading ? t('正在读取连接设置…', 'Loading connection settings…') : t('无法读取连接设置。', 'Connection settings unavailable.')) : h('fieldset', { disabled: status.saving },
        h('legend', null, status.dirty ? t('未保存的连接草稿', 'Unsaved connection draft') : t('已保存的连接设置', 'Saved connection settings')),
        h('fieldset', null, h('legend', null, t('全局凭据', 'Global credentials')),
          h('label', null, h('input', { type: 'checkbox', checked: Boolean(draft.global), onChange: event => store.update({ global: event.target.checked ? newConnection() : null }) }), t(' 配置全局凭据', ' Configure global credentials')),
          connectionEditor(draft.global, saved.global, global => store.update({ global }))),
        h('h4', null, t('集群例外', 'Cluster overrides')),
        ...draft.clusters.map((row, index) => h('fieldset', { key: index }, h('legend', null, t('集群例外', 'Cluster override') + ' ' + (index + 1)),
          clusterSelector(row.clusterId, clusterId => patchRow('clusters', index, { clusterId })),
          h('details', null, h('summary', null, t('高级映射配置', 'Advanced mapping configuration')), field(t('集群映射标识', 'Cluster mapping ID'), row.clusterId, clusterId => patchRow('clusters', index, { clusterId }))),
          connectionEditor(row.connection, saved.clusters.find(item => item.clusterId === row.clusterId)?.connection, connection => patchRow('clusters', index, { connection })),
          h('button', { type: 'button', onClick: () => removeRow('clusters', index) }, t('移除集群例外（草稿）', 'Remove cluster override (draft)')))),
        h('button', { type: 'button', onClick: () => store.update({ clusters: [...draft.clusters, { clusterId: '', connection: newConnection() }] }) }, t('添加集群例外', 'Add cluster override')),
        h('h4', null, t('主机目标与例外', 'Host targets and overrides')),
        ...draft.hosts.map((row, index) => {
          const previous = saved.hosts.find(item => item.hostId === row.hostId);
          function devicePatch(n, patch) { patchRow('hosts', index, { devices: row.devices.map((device, i) => i === n ? { ...device, ...patch } : device) }); }
          return h('fieldset', { key: index }, h('legend', null, t('主机', 'Host') + ' ' + (index + 1)),
            h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('选择主机', 'Select host')),
              h('select', { value: row.hostId, onChange: event => { const selected = inventory.hosts.find(item => item.id === event.target.value); if (selected && selected.id !== row.hostId) patchRow('hosts', index, { hostId: selected.id, clusterId: selected.clusterId, address: selected.address, hostKeySha256: '', devices: [], connection: null }); } },
                h('option', { value: '' }, t('请选择主机', 'Select a host')),
                row.hostId && !inventory.hosts.some(item => item.id === row.hostId) && h('option', { value: row.hostId }, t('已配置映射：', 'Configured mapping: ') + row.hostId),
                ...inventory.hosts.map(item => h('option', { value: item.id, key: item.id }, `${item.name} (${item.id})`)))),
            clusterSelector(row.clusterId, clusterId => patchRow('hosts', index, { clusterId })),
            h('details', null, h('summary', null, t('高级映射配置', 'Advanced mapping configuration')),
              field(t('主机映射标识', 'Host mapping ID'), row.hostId, hostId => patchRow('hosts', index, { hostId })),
              field(t('集群映射标识', 'Cluster mapping ID'), row.clusterId, clusterId => patchRow('hosts', index, { clusterId }))),
            field(t('IP 地址', 'IP address'), row.address, address => patchRow('hosts', index, { address })),
            field(t('端口', 'Port'), row.port, value => patchRow('hosts', index, { port: Number(value) }), { type: 'number', min: 1, max: 65535 }),
            field(t('已独立核验的主机密钥 SHA-256（64 位十六进制）', 'Independently verified host key SHA-256 (64 hex characters)'), row.hostKeySha256, hostKeySha256 => patchRow('hosts', index, { hostKeySha256 })),
            h('p', { className: 'pk-ssh-muted' }, t('已保存的有效来源：', 'Saved effective source: ') + (sourceNames[previous?.effective.source || 'none']) + (previous && !previous.effective.ready ? t('（凭据未就绪）', ' (credential unready)') : '')),
            h('label', null, h('input', { type: 'checkbox', checked: Boolean(row.connection), onChange: event => patchRow('hosts', index, { connection: event.target.checked ? newConnection() : null }) }), t(' 使用主机专属凭据', ' Use host-specific credentials')),
            connectionEditor(row.connection, previous?.connection, connection => patchRow('hosts', index, { connection })),
            h('h5', null, t('可信设备映射', 'Trusted device mappings')),
            ...row.devices.map((device, n) => h('div', { className: 'pk-ssh-device', key: n },
              field(t('设备映射标识', 'Device mapping ID'), device.deviceId, deviceId => devicePatch(n, { deviceId })),
              field(t('设备路径', 'Device path'), device.path, path => devicePatch(n, { path })),
              field(t('可信序列号', 'Trusted serial number'), device.serial || '', serial => devicePatch(n, serial ? { serial } : { serial: undefined })),
              h('button', { type: 'button', onClick: () => patchRow('hosts', index, { devices: row.devices.filter((_, i) => i !== n) }) }, t('移除设备映射（草稿）', 'Remove device mapping (draft)')))),
            h('button', { type: 'button', onClick: () => patchRow('hosts', index, { devices: [...row.devices, { deviceId: '', path: '', serial: '' }] }) }, t('添加设备映射', 'Add device mapping')),
            h('button', { type: 'button', onClick: () => removeRow('hosts', index) }, t('移除主机配置（草稿）', 'Remove host profile (draft)')));
        }),
        h('button', { type: 'button', onClick: () => store.update({ hosts: [...draft.hosts, { hostId: '', clusterId: '', address: '', port: 22, hostKeySha256: '', devices: [], connection: null }] }) }, t('添加主机配置', 'Add host profile'))));
  };
}

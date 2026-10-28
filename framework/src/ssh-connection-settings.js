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

function hostPreflightContext(store, index) {
  const target = store.getDraft().hosts[index];
  return target ? JSON.stringify([target.hostId, target.clusterId, target.address, target.port, target.hostKeySha256, store.status().revision]) : '';
}
function candidateFingerprint(value) {
  const bytes = value.match(/../g).map(byte => parseInt(byte, 16));
  return 'SHA256:' + btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
}
function createHostPreflight(React) {
  const h = React.createElement, { useState, useRef, useEffect } = React;
  const allowedErrors = new Set(['ADMIN_REQUIRED', 'ADMIN_OR_ORIGIN_REQUIRED', 'AUTHENTICATION_REQUIRED', 'SSH_CHANNEL_DISABLED', 'SSH_AUTHENTICATION_FAILED', 'SSH_HOST_KEY_MISMATCH', 'SSH_CONNECTION_FAILED', 'SSH_CONNECTION_CLOSED', 'SSH_KEY_UNAVAILABLE', 'SSH_UNAVAILABLE', 'SSH_ABORTED', 'SSH_TIMEOUT', 'SSH_HANDSHAKE_TIMEOUT', 'SSH_PREFLIGHT_DISABLED', 'SSH_PREFLIGHT_BUSY', 'SSH_PREFLIGHT_LIMIT', 'SSH_PREFLIGHT_TARGET_INVALID', 'SSH_PREFLIGHT_TARGET_REJECTED', 'SSH_PREFLIGHT_TARGET_MISMATCH', 'SSH_PREFLIGHT_TARGET_CHANGED', 'SSH_PREFLIGHT_CONFIRMATION_REQUIRED', 'SSH_PREFLIGHT_CHALLENGE_INVALID', 'SSH_PREFLIGHT_CHALLENGE_EXPIRED', 'SSH_PREFLIGHT_CHALLENGE_LIMIT', 'SSH_PREFLIGHT_CANCELLED', 'SSH_PREFLIGHT_TIMEOUT', 'SSH_PREFLIGHT_UNAVAILABLE', 'SSH_PREFLIGHT_STOPPED', 'SSH_PREFLIGHT_AUDIT_FAILED', 'SSH_PREFLIGHT_FORBIDDEN', 'SSH_PREFLIGHT_INVENTORY_FAILED', 'SSH_PREFLIGHT_HOST_UNAVAILABLE', 'SSH_PREFLIGHT_REQUEST_INVALID', 'SSH_PREFLIGHT_CONNECTION_UNAVAILABLE', 'SSH_PREFLIGHT_CONNECTION_CHANGED', 'SSH_PREFLIGHT_FAILED', 'SSH_PREFLIGHT_RESPONSE_INVALID', 'SSH_PREFLIGHT_CANDIDATE_EXPIRED']);
  return function HostPreflight({ store, index, client, enabled = false, locale }) {
    const en = locale === 'en-US', t = (zh, english) => en ? english : zh;
    const alive = useRef(false), active = useRef(null), enabledRef = useRef(enabled); enabledRef.current = enabled;
    const empty = context => ({ context, busy: false, candidate: null, acknowledged: false, confirmed: false, verified: null, error: '' });
    const context = hostPreflightContext(store, index), status = store.status(), target = store.getDraft().hosts[index];
    const [result, setResult] = useState(() => empty(context));
    const current = result.context === context ? result : empty(context);
    const saved = store.get().hosts.find(row => row.hostId === target?.hostId);
    const validTarget = Boolean(target && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(target.hostId) && typeof target.address === 'string' && target.address.length > 0 && target.address.length <= 253 && !/\s/.test(target.address) && Number.isInteger(target.port) && target.port > 0 && target.port <= 65535);
    const canVerify = Boolean(validTarget && !status.dirty && saved && saved.address === target.address && saved.port === target.port && saved.hostKeySha256 === target.hostKeySha256 && /^[a-f0-9]{64}$/.test(saved.hostKeySha256) && saved.effective.ready);
    useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.control.abort(); active.current = null; }; }, []);
    useEffect(() => {
      if (active.current && (!enabled || active.current.context !== context || active.current.action === 'verify' && status.dirty)) { active.current.control.abort(); active.current = null; }
      setResult(previous => {
        if (!enabled || previous.context !== context) return previous.context === context && !previous.busy && !previous.candidate && !previous.verified && !previous.confirmed && !previous.error ? previous : empty(context);
        if (status.dirty && previous.verified) return { ...previous, verified: null };
        return previous;
      });
    }, [context, enabled, status.dirty]);
    useEffect(() => {
      if (!current.candidate) return;
      const expiry = typeof current.candidate.expiresAt === 'number' ? current.candidate.expiresAt : Date.parse(current.candidate.expiresAt);
      const timer = setTimeout(() => setResult(previous => previous.candidate === current.candidate ? { ...previous, candidate: null, acknowledged: false, error: 'SSH_PREFLIGHT_CANDIDATE_EXPIRED' } : previous), Math.max(1, expiry - Date.now()));
      return () => clearTimeout(timer);
    }, [current.candidate]);
    function stillCurrent(job) {
      return alive.current && enabledRef.current && active.current === job && !job.control.signal.aborted && hostPreflightContext(store, index) === job.context && !(job.action === 'verify' && store.status().dirty);
    }
    async function run(action) {
      if (!client || !enabled || !validTarget || current.busy || active.current || status.saving || status.loading || action === 'verify' && !canVerify) return;
      const candidate = current.candidate;
      if (action === 'confirm' && (!candidate || !current.acknowledged)) return;
      if (action === 'confirm' && (typeof candidate.expiresAt === 'number' ? candidate.expiresAt : Date.parse(candidate.expiresAt)) <= Date.now()) { setResult(previous => ({ ...previous, candidate: null, acknowledged: false, error: 'SSH_PREFLIGHT_CANDIDATE_EXPIRED' })); return; }
      const job = { action, context, control: new AbortController() }; active.current = job;
      setResult(previous => ({ ...previous, context, busy: true, error: '', verified: null, ...(action === 'discover' ? { candidate: null, acknowledged: false, confirmed: false } : {}) }));
      const body = action === 'verify' ? { action, hostId: target.hostId } : { action, hostId: target.hostId, address: target.address, port: target.port, ...(action === 'confirm' ? { challenge: candidate.challenge, acknowledged: true } : {}) };
      try {
        const response = await client('/ssh-channel/preflight', 'POST', body, { signal: job.control.signal });
        if (!stillCurrent(job)) return;
        if (!object(response) || response.hostId !== target.hostId) throw new Error('SSH_PREFLIGHT_RESPONSE_INVALID');
        if (action !== 'verify' && (response.address !== target.address || response.port !== target.port || !/^[a-f0-9]{64}$/.test(response.sha256Hex || ''))) throw new Error('SSH_PREFLIGHT_RESPONSE_INVALID');
        if (action === 'discover') {
          const expires = typeof response.expiresAt === 'number' ? response.expiresAt : Date.parse(response.expiresAt);
          if (typeof response.algorithm !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,95}$/.test(response.algorithm) || typeof response.fingerprint !== 'string' || response.fingerprint.replace(/=+$/, '') !== candidateFingerprint(response.sha256Hex) || typeof response.challenge !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(response.challenge) || !Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 600000) throw new Error('SSH_PREFLIGHT_RESPONSE_INVALID');
          const value = { hostId: response.hostId, address: response.address, port: response.port, algorithm: response.algorithm, fingerprint: response.fingerprint, sha256Hex: response.sha256Hex, challenge: response.challenge, expiresAt: response.expiresAt };
          setResult({ ...empty(context), candidate: value });
        } else if (action === 'confirm') {
          if (response.confirmed !== true || response.sha256Hex !== candidate.sha256Hex) throw new Error('SSH_PREFLIGHT_RESPONSE_INVALID');
          const latest = store.getDraft();
          store.update({ hosts: latest.hosts.map((row, n) => n === index ? { ...row, hostKeySha256: response.sha256Hex } : row) });
          setResult({ ...empty(hostPreflightContext(store, index)), confirmed: true });
        } else {
          if (response.verified !== true || typeof response.checkedAt !== 'string' || !Number.isFinite(Date.parse(response.checkedAt))) throw new Error('SSH_PREFLIGHT_RESPONSE_INVALID');
          setResult({ ...empty(context), verified: response.checkedAt });
        }
      } catch (failure) {
        if (stillCurrent(job)) setResult(previous => ({ ...previous, candidate: action === 'confirm' ? null : previous.candidate, acknowledged: false, error: allowedErrors.has(failure?.message) ? failure.message : 'SSH_PREFLIGHT_REQUEST_FAILED' }));
      } finally {
        if (active.current === job) { active.current = null; if (alive.current) setResult(previous => ({ ...previous, busy: false })); }
      }
    }
    const disabled = !enabled || !client || !validTarget || current.busy || status.saving || status.loading;
    return h('section', { className: 'pk-ssh-preflight', 'aria-label': t(`主机 ${index + 1} 指纹与 SSH 验证`, `Host ${index + 1} fingerprint and SSH verification`) },
      h('h5', null, t('指纹确认与提前 SSH 验证', 'Fingerprint confirmation and SSH preflight')),
      h('p', { className: 'pk-ssh-rule-note' }, t('获取候选指纹只进行未认证握手；验证 SSH 仅使用已保存指纹和凭据认证后断开，不执行命令、不启用采集或审批。', 'Discovery only performs an unauthenticated handshake. SSH verification authenticates using the saved pin and credential, then disconnects without running commands or enabling collection or approvals.')),
      !enabled && h('p', { className: 'pk-ssh-notice' }, t('请先启用框架与 SSH 通道插件，预验证不会绕过禁用开关。', 'Enable the framework and SSH channel plugin first. Preflight never bypasses disabled state.')),
      !validTarget && h('p', { className: 'pk-ssh-rule-note' }, t('先选择主机并填写管理地址和端口。', 'Select a host and enter its management address and port first.')),
      h('p', { className: 'pk-ssh-rule-note' }, t('本次目标：', 'Target: ') + `${target?.hostId || '—'} · ${target?.address || '—'}:${target?.port || '—'}`),
      h('div', { className: 'pk-ssh-preflight-actions' }, h('button', { type: 'button', className: 'c89-text-button', disabled, onClick: () => run('discover') }, t('获取候选指纹（不认证）', 'Discover fingerprint (no authentication)')),
        h('button', { type: 'button', className: 'c89-text-button', disabled: disabled || !canVerify, onClick: () => run('verify') }, t('验证 SSH（不执行命令）', 'Verify SSH (no commands)'))),
      status.dirty && h('p', { className: 'pk-ssh-rule-note' }, t('SSH 验证仅针对已保存配置；请先保存连接草稿。', 'SSH verification uses saved settings only. Save the connection draft first.')),
      !status.dirty && !canVerify && h('p', { className: 'pk-ssh-rule-note' }, t('SSH 验证需要此主机已有已保存的指纹和有效凭据。', 'SSH verification requires this host to have a saved pin and a ready credential.')),
      current.busy && h('p', { role: 'status' }, t('正在进行单次预验证…', 'Running a one-time preflight…')),
      current.error && h('p', { className: 'pk-ssh-error', role: 'alert' }, t('预验证未完成：', 'Preflight incomplete: ') + current.error),
      current.candidate && h('div', { className: 'pk-ssh-candidate' }, h('strong', null, t('候选指纹：尚未受信任', 'Candidate fingerprint: not trusted')),
        h('dl', { className: 'pk-ssh-meta' }, h('dt', null, t('算法', 'Algorithm')), h('dd', null, current.candidate.algorithm), h('dt', null, 'SHA256'), h('dd', null, h('code', null, current.candidate.fingerprint)), h('dt', null, t('十六进制', 'Hexadecimal')), h('dd', null, h('code', null, current.candidate.sha256Hex))),
        h('p', { className: 'pk-ssh-rule-note' }, t('请通过主机控制台或已有可信渠道独立核对。网络读取的候选值本身不能证明主机身份。', 'Compare through the host console or another trusted channel. The network-observed candidate alone does not prove host identity.')),
        h('label', { className: 'pk-ssh-pin-ack' }, h('input', { type: 'checkbox', checked: current.acknowledged, disabled: current.busy, onChange: event => { const acknowledged = event.target.checked; setResult(previous => ({ ...previous, acknowledged })); } }), t(' 我已通过独立可信渠道核对该主机、地址、端口和完整指纹一致。', ' I independently verified this host, address, port and complete fingerprint through a trusted channel.')),
        h('button', { type: 'button', className: 'c89-text-button', disabled: disabled || !current.acknowledged, onClick: () => run('confirm') }, t('二次确认并写入指纹草稿', 'Confirm again and put pin in draft'))),
      current.confirmed && h('p', { className: 'pk-ssh-notice', role: 'status' }, t('指纹已写入连接草稿，尚未保存。保存后才可用于 SSH 验证。', 'The pin is in the connection draft and is not saved yet. Save before using it for SSH verification.')),
      current.verified && h('div', { className: 'pk-ssh-verified', role: 'status' },
        h('div', null, t('SSH 认证验证成功，未执行命令。核验时间：', 'SSH authentication verified; no commands executed. Checked at: ') + new Date(current.verified).toLocaleString(locale)),
        h('div', { className: 'pk-ssh-muted' }, t('仅确认本次 SSH 认证成功；命令执行权限、设备 SMART 支持和磁盘健康均未验证。', 'Only this SSH authentication was verified. Command permissions, device SMART support and disk health were not verified.'))));
  };
}

export function createSshConnectionSettings(React) {
  const h = React.createElement, { useEffect, useState } = React, HostPreflight = createHostPreflight(React);
  const CSS = `
.pk-ssh-connections{margin-top:22px;padding-top:18px;border-top:1px solid #dfe8f3}.pk-ssh-connections .c89-section-heading,.pk-ssh-connections .c89-exception-heading,.pk-ssh-connections .c89-rule-top{display:flex;align-items:center;justify-content:space-between;gap:10px}.pk-ssh-connections .c89-section-heading h4{margin:0}.pk-ssh-connections .c89-exception-heading{margin:20px 0 10px}.pk-ssh-connections .pk-ssh-draft-badge{font-size:11px;color:#71849b}.pk-ssh-connections fieldset.pk-ssh-draft{border:0;padding:0;margin:0;min-width:0}.pk-ssh-connections .c89-setting{border:1px solid #dfe8f2;border-radius:8px;padding:14px;background:#fff}.pk-ssh-connections .c89-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.pk-ssh-connections .c89-rule{border:1px solid #dfe8f2;border-radius:8px;padding:12px;margin:12px 0;background:#fbfcff}.pk-ssh-connections .c89-rule-top{font-size:12px;color:#637d9a;margin-bottom:10px}.pk-ssh-connections .c89-rule-fields.pk-ssh-rule-fields{display:grid;grid-template-columns:110px minmax(0,1fr);gap:10px}.pk-ssh-connections .pk-ssh-credential-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(100px,.8fr) minmax(0,1fr);gap:10px}.pk-ssh-connections .pk-ssh-credential-editor{padding-top:12px}.pk-ssh-connection-field{display:flex;flex-direction:column;gap:5px;margin:6px 0;font-size:12px;color:#71849b}.pk-ssh-connection-field input,.pk-ssh-connection-field select,.pk-ssh-connection-field textarea{font:inherit;color:#243650;padding:8px;border:1px solid #d7e3f0;border-radius:6px;min-width:0;width:100%;max-width:100%;box-sizing:border-box;background:#fff}.pk-ssh-connections .c89-remove-rule{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;border:0;border-radius:5px;padding:5px;color:#d9363e;background:transparent;cursor:pointer}.pk-ssh-connections .c89-remove-rule:hover{background:#fff1f0}.pk-ssh-connections .c89-remove-rule:focus-visible{outline:2px solid #d9363e;outline-offset:2px}.pk-ssh-connections .c89-add-rule{color:#117ad4;border:1px solid #d2e5f9;background:#f4f9ff;border-radius:6px;padding:6px 10px;cursor:pointer}.pk-ssh-connections .c89-empty-rules{padding:16px;border:1px dashed #d8e3ef;border-radius:7px;color:#8495aa;font-size:12px;margin-top:12px}.pk-ssh-connections .c89-rule-help{display:inline-flex;position:relative;vertical-align:middle;margin-left:4px}.pk-ssh-connections .c89-disclaimer-icon{display:inline-flex;align-items:center;justify-content:center;padding:2px!important;width:21px;height:21px;border:0!important;background:transparent!important;color:#71849b;cursor:help}.pk-ssh-connections .pk-ssh-priority-popup{display:none;position:absolute;left:0;top:26px;width:300px;max-width:65vw;box-sizing:border-box;padding:12px;background:#fff;border:1px solid #dce5ef;border-radius:8px;box-shadow:0 5px 20px #1f3d601a;font-size:12px;line-height:1.7;color:#42566f;font-weight:400;z-index:5}.pk-ssh-connections .c89-rule-help:hover .pk-ssh-priority-popup,.pk-ssh-connections .c89-rule-help:focus-within .pk-ssh-priority-popup,.pk-ssh-connections .pk-ssh-priority-popup.pk-open{display:block}.pk-ssh-connections .pk-ssh-rule-note{font-size:12px;color:#71849b;line-height:1.6;margin:8px 0}.pk-ssh-connections .pk-ssh-notice{padding:10px 12px;border-radius:6px;background:#fff8e8;color:#80551b;line-height:1.6}.pk-ssh-connections .pk-ssh-target{border:1px solid #dfe8f2;border-radius:8px;margin:10px 0;background:#fff}.pk-ssh-connections .pk-ssh-target>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;cursor:pointer;font-size:12px;font-weight:600;color:#42566f}.pk-ssh-connections .pk-ssh-target-name{min-width:0;overflow-wrap:anywhere}.pk-ssh-connections .pk-ssh-target-body{border-top:1px solid #e7edf5;padding:12px}.pk-ssh-connections .pk-ssh-target-grid{display:grid;grid-template-columns:minmax(0,1fr) 110px;gap:10px}.pk-ssh-connections .pk-ssh-target-grid .pk-ssh-pin{grid-column:1/-1}.pk-ssh-device{border-left:3px solid #e0e7f0;padding:0 0 0 12px;margin:12px 0}.pk-ssh-connections .pk-ssh-device-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 28px;gap:10px;align-items:end}.pk-ssh-connections .pk-ssh-inventory{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#71849b;margin:12px 0}.pk-ssh-connections .pk-ssh-global-title{font-size:13px;font-weight:600;color:#42566f}.pk-ssh-connections .pk-ssh-map-edit{margin-top:10px;font-size:12px;color:#71849b}.pk-ssh-connections .pk-ssh-map-edit summary{cursor:pointer}.pk-ssh-connections button:disabled{cursor:default;opacity:.5}@media(max-width:620px){.pk-ssh-connections .pk-ssh-credential-fields,.pk-ssh-connections .c89-rule-fields.pk-ssh-rule-fields,.pk-ssh-connections .pk-ssh-target-grid,.pk-ssh-connections .pk-ssh-device-fields{grid-template-columns:minmax(0,1fr)}.pk-ssh-connections .c89-setting-row,.pk-ssh-connections .pk-ssh-inventory{align-items:flex-start;flex-wrap:wrap}.pk-ssh-connections .pk-ssh-priority-popup{width:245px}}
`;
  return function SshConnectionSettings({ store, client, locale = 'zh-CN', preflightEnabled = false }) {
    const [, render] = useState(0), en = locale === 'en-US', t = (zh, english) => en ? english : zh;
    const [inventory, setInventory] = useState({ clusters: [], hosts: [] }), [inventoryError, setInventoryError] = useState(''), [inventoryBusy, setInventoryBusy] = useState(false);
    const [priorityOpen, setPriorityOpen] = useState(false), [notice, setNotice] = useState('');
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
    const blankTarget = connection => ({ hostId: '', clusterId: '', address: '', port: 22, hostKeySha256: '', devices: [], connection });
    const pristine = row => !row.hostId && !row.clusterId && !row.address && !row.hostKeySha256 && !row.devices.length;
    const rules = [...draft.clusters.map((row, index) => ({ scope: 'cluster', index, targetId: row.clusterId, connection: row.connection })),
      ...draft.hosts.map((row, index) => ({ scope: 'host', index, targetId: row.hostId, connection: row.connection })).filter(rule => rule.connection !== null)];
    const hosts = [...inventory.hosts, ...draft.hosts.filter(row => row.hostId && !inventory.hosts.some(item => item.id === row.hostId)).map(row => ({ id: row.hostId, name: t('已配置映射', 'Configured mapping'), clusterId: row.clusterId, address: row.address }))];
    function field(label, value, onChange, options = {}) {
      return h('label', { className: 'pk-ssh-connection-field' }, h('span', null, label), h('input', { type: 'text', value, onChange: event => onChange(event.target.value), autoComplete: 'off', spellCheck: false, ...options }));
    }
    function trash(label, onClick) {
      return h('button', { type: 'button', className: 'c89-remove-rule', 'aria-label': label, title: label, onClick },
        h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6' })));
    }
    function patchTarget(index, patch) { store.update({ hosts: draft.hosts.map((row, n) => n === index ? { ...row, ...patch } : row) }); }
    function updateCredential(rule, connection) {
      if (rule.scope === 'cluster') store.update({ clusters: draft.clusters.map((row, n) => n === rule.index ? { ...row, connection } : row) });
      else patchTarget(rule.index, { connection });
    }
    function removeRule(rule) {
      if (rule.scope === 'cluster') store.update({ clusters: draft.clusters.filter((_, n) => n !== rule.index) });
      else store.update({ hosts: draft.hosts.filter((row, n) => n !== rule.index || !pristine(row)).map(row => row === draft.hosts[rule.index] ? { ...row, connection: null } : row) });
      setNotice('inherit');
    }
    function switchScope(rule, scope) {
      if (scope === rule.scope) return;
      if (scope === 'host' && draft.hosts.length >= 500 || scope === 'cluster' && draft.clusters.length >= 500) { setNotice('capacity'); return; }
      if (scope === 'host') store.update({ clusters: draft.clusters.filter((_, n) => n !== rule.index), hosts: [...draft.hosts, blankTarget(rule.connection)] });
      else store.update({ hosts: draft.hosts.filter((row, n) => n !== rule.index || !pristine(row)).map(row => row === draft.hosts[rule.index] ? { ...row, connection: null } : row), clusters: [...draft.clusters, { clusterId: '', connection: rule.connection }] });
      setNotice('scope');
    }
    function selectRuleTarget(rule, targetId) {
      if (targetId === rule.targetId) return;
      if (rule.scope === 'cluster') store.update({ clusters: draft.clusters.map((row, n) => n === rule.index ? { ...row, clusterId: targetId } : row) });
      else {
        const source = draft.hosts[rule.index], existing = draft.hosts.find((row, n) => n !== rule.index && row.hostId === targetId), selected = inventory.hosts.find(row => row.id === targetId);
        if (existing && existing.connection !== null) return;
        if (!existing && !pristine(source) && draft.hosts.length >= 500) { setNotice('capacity'); return; }
        const next = draft.hosts.filter((row, n) => n !== rule.index || !pristine(row)).map(row => row === source ? { ...row, connection: null } : row === existing ? { ...row, connection: rule.connection } : row);
        if (!existing) next.push({ ...blankTarget(rule.connection), hostId: targetId, clusterId: selected?.clusterId || '', address: selected?.address || '' });
        store.update({ hosts: next });
      }
      setNotice('scope');
    }
    function clusterSelector(value, update) {
      return h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('选择集群', 'Select cluster')),
        h('select', { value, 'aria-label': t('选择集群', 'Select cluster'), onChange: event => update(event.target.value) }, h('option', { value: '' }, t('请选择集群', 'Select a cluster')),
          value && !inventory.clusters.some(row => row.id === value) && h('option', { value }, t('已配置映射：', 'Configured mapping: ') + value),
          ...inventory.clusters.map(row => h('option', { value: row.id, key: row.id }, `${row.name} (${row.id})`))));
    }
    function connectionEditor(connection, previous, update) {
      if (!connection) return null;
      const secret = connection.authType === 'password' ? 'password' : 'privateKey', edit = connection[secret];
      return h('div', { className: 'pk-ssh-credential-editor' }, h('div', { className: 'pk-ssh-credential-fields' },
        field(t('账户', 'Username'), connection.username, username => update({ ...connection, username })),
        h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('认证方式', 'Authentication')),
          h('select', { 'aria-label': t('认证方式', 'Authentication'), value: connection.authType, onChange: event => update({ ...connection, authType: event.target.value, password: keep(), privateKey: keep() }) }, h('option', { value: 'password' }, t('密码', 'Password')), h('option', { value: 'private-key' }, t('私钥', 'Private key')))),
        h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('凭据操作', 'Credential action')),
          h('select', { 'aria-label': t('凭据操作', 'Credential action'), value: edit.action, onChange: event => update({ ...connection, [secret]: event.target.value === 'replace' ? { action: 'replace', value: '' } : { action: event.target.value } }) },
            h('option', { value: 'keep' }, t('保留已有凭据', 'Keep existing credential')), h('option', { value: 'replace' }, t('替换为新凭据', 'Replace credential')), h('option', { value: 'clear' }, t('清除已有凭据', 'Clear credential'))))),
        h('p', { className: 'pk-ssh-rule-note' }, t('此对象已保存凭据：', 'Saved credential for this scope: ') + (previous?.[secret === 'password' ? 'hasPassword' : 'hasPrivateKey'] ? t('已配置（不回显）', 'Configured (never returned)') : t('未配置', 'Not configured'))),
        edit.action === 'replace' && (secret === 'password' ? field(t('新密码', 'New password'), edit.value, value => update({ ...connection, password: { action: 'replace', value } }), { type: 'password', autoComplete: 'new-password' }) : h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('新私钥', 'New private key')), h('textarea', { value: edit.value, rows: 5, autoComplete: 'off', spellCheck: false, onChange: event => update({ ...connection, privateKey: { action: 'replace', value: event.target.value } }) }))),
        edit.action === 'clear' && h('p', { className: 'pk-ssh-notice' }, t('保存后此层凭据将不可用，不会静默回退到更低层凭据。', 'After saving, this scope is unready and will not silently fall back to a lower scope.')));
    }
    const priority = t('优先级：主机例外 > 集群例外 > 全局默认。保留只保留当前对象自己的秘密。更改范围或对象不会迁移已保存秘密，须为新对象明确替换或保留其已有凭据。', 'Priority: host > cluster > global. Keep retains only the current scope’s own secret. Changing scope or target does not transfer saved secrets; explicitly replace or keep the new target’s existing credential.');
    const sourceNames = { host: t('主机例外', 'Host override'), cluster: t('集群例外', 'Cluster override'), global: t('全局默认', 'Global default'), none: t('无可用配置', 'No configuration') };
    return h('section', { className: 'pk-ssh-connections', 'aria-label': t('SSH 全局与例外', 'SSH defaults and overrides') }, h('style', null, CSS + '.pk-ssh-preflight{border-top:1px solid #e7edf5;margin-top:16px;padding-top:4px}.pk-ssh-preflight-actions{display:flex;gap:8px;flex-wrap:wrap}.pk-ssh-candidate{padding:12px;border:1px solid #f1d59e;border-radius:7px;background:#fffaf0;margin-top:12px}.pk-ssh-candidate code{overflow-wrap:anywhere}.pk-ssh-pin-ack{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.7;margin:12px 0}.pk-ssh-verified{padding:10px 12px;border:1px solid #a3d7af;border-radius:6px;background:#f1fbf3;color:#26723c;font-size:12px}'),
      h('div', { className: 'c89-section-heading' }, h('h4', null, t('SSH 连接设置', 'SSH connection settings')), h('span', { className: 'pk-ssh-draft-badge' }, status.dirty ? t('未保存的连接草稿', 'Unsaved connection draft') : t('已保存的连接设置', 'Saved connection settings'))),
      h('p', { className: 'pk-ssh-rule-note' }, t('所有编辑仅为草稿，使用插件中心“保存”或“保存并退出”后生效；保存会撤销全部 SSH 授权并中止在途连接。', 'Edits are drafts until Plugin center Save or Save and exit. Saving revokes all SSH approvals and cancels in-flight connections.')),
      status.error && h('p', { className: 'pk-ssh-error', role: 'alert' }, t('连接设置操作未完成：', 'Connection settings incomplete: ') + status.error),
      !status.loaded ? h('p', null, status.loading ? t('正在读取连接设置…', 'Loading connection settings…') : t('无法读取连接设置。', 'Connection settings unavailable.')) : h('fieldset', { className: 'pk-ssh-draft', disabled: status.saving },
        h('div', { className: 'c89-setting pk-ssh-global' }, h('div', { className: 'c89-setting-row' }, h('strong', { className: 'pk-ssh-global-title' }, t('全局默认凭据', 'Global default credentials')),
          h('label', null, h('input', { type: 'checkbox', checked: Boolean(draft.global), onChange: event => store.update({ global: event.target.checked ? newConnection() : null }) }), t(' 配置全局凭据', ' Configure global credentials'))),
          h('p', { className: 'pk-ssh-rule-note' }, t('未命中例外时使用此配置。空表单保留已有秘密，只有明确替换或清除才修改；已保存秘密不回显。', 'Used when no override matches. Blank fields keep existing secrets; only explicit Replace or Clear changes them. Saved secrets are never returned.')),
          connectionEditor(draft.global, saved.global, global => store.update({ global }))),
        h('div', { className: 'c89-exception-heading' }, h('strong', null, t('例外规则', 'Exception rules'),
          h('span', { className: 'c89-disclaimer c89-rule-help' }, h('button', { type: 'button', className: 'c89-disclaimer-icon', 'aria-label': t('规则优先级', 'Rule priority'), 'aria-describedby': 'pk-ssh-rule-priority', 'aria-expanded': priorityOpen, onClick: () => setPriorityOpen(value => !value) },
            h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, 'aria-hidden': true }, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 11v6M12 7v1' }))),
            h('span', { className: `pk-ssh-priority-popup ${priorityOpen ? 'pk-open' : ''}`, id: 'pk-ssh-rule-priority', role: 'tooltip' }, priority))),
          h('button', { type: 'button', className: 'c89-add-rule', disabled: draft.clusters.length >= 500, onClick: () => store.update({ clusters: [...draft.clusters, { clusterId: '', connection: newConnection() }] }) }, t('+ 添加例外', '+ Add exception'))),
        client && h('div', { className: 'pk-ssh-inventory' }, inventoryError ? h('span', { role: 'alert' }, t('无法读取集群与主机清单，连接草稿已保留。可重试或使用高级映射配置。', 'Cluster and host inventory unavailable; connection drafts are retained. Retry or use advanced mapping configuration.')) : h('span', null, inventoryBusy ? t('正在读取集群与主机清单…', 'Loading cluster and host inventory…') : t('对象来自当前可见清单，不会自动配置或连接主机。', 'Targets come from the current visible inventory. No hosts are configured or connected automatically.')),
          h('button', { type: 'button', className: 'c89-text-button', disabled: inventoryBusy, onClick: () => loadInventory() }, t('刷新目标清单', 'Refresh target inventory'))),
        notice && h('p', { className: 'pk-ssh-notice', role: 'status' }, notice === 'capacity' ? t('目标或例外已达到容量上限，未改变草稿。', 'The target or override capacity limit has been reached. The draft is unchanged.') : notice === 'removeTarget' ? t('主机目标及其专属例外已从草稿移除，其他目标和凭据组保留。保存后生效。', 'The host target and its override were removed from the draft. Other targets and credential groups remain. Save to apply.') : notice === 'inherit' ? t('例外移除仅修改草稿。主机目标、指纹和设备映射保留，保存后按主机 > 集群 > 全局重新继承。', 'Removing an override only changes the draft. Host targets, pins and device mappings remain; saving resolves host > cluster > global again.') : notice === 'target' ? t('主机目标已在草稿中变更：旧指纹和设备映射清空，专属例外回到继承。须重新独立核验指纹后保存。', 'Host target changed in the draft: its old pin and devices are cleared and its override returns to inheritance. Independently verify its new pin before saving.') : t('范围或对象已在草稿中变更；原主机例外（如有）回到继承，已保存秘密不会迁移。请重选对象并明确保留新对象已有凭据或填写新凭据。', 'Scope or target changed in the draft; the previous host override, if any, returns to inheritance. Saved secrets are not transferred. Choose a target and explicitly keep its own credential or supply a new one.')),
        !rules.length && h('div', { className: 'c89-empty-rules' }, t('尚无例外。已配置主机继承全局默认。', 'No overrides. Configured hosts inherit the global default.')),
        ...rules.map((rule, index) => {
          const objects = rule.scope === 'cluster' ? inventory.clusters : hosts;
          const used = new Set(rules.filter(other => other !== rule && other.scope === rule.scope).map(other => other.targetId).filter(Boolean));
          const previous = rule.scope === 'cluster' ? saved.clusters.find(row => row.clusterId === rule.targetId)?.connection : saved.hosts.find(row => row.hostId === rule.targetId)?.connection;
          return h('div', { className: 'c89-rule pk-ssh-exception', key: `${rule.scope}-${rule.index}`, 'data-ssh-scope': rule.scope },
            h('div', { className: 'c89-rule-top' }, h('span', null, t(`例外 ${index + 1}`, `Exception ${index + 1}`)), trash(t(`删除例外 ${index + 1}`, `Delete exception ${index + 1}`), () => removeRule(rule))),
            h('div', { className: 'c89-rule-fields pk-ssh-rule-fields' },
              h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('范围', 'Scope')), h('select', { 'aria-label': t(`例外 ${index + 1} 范围`, `Exception ${index + 1} scope`), value: rule.scope, onChange: event => switchScope(rule, event.target.value) }, h('option', { value: 'cluster', disabled: rule.scope !== 'cluster' && draft.clusters.length >= 500 }, t('集群', 'Cluster')), h('option', { value: 'host', disabled: rule.scope !== 'host' && draft.hosts.length >= 500 }, t('特定主机', 'Specific host')))),
              h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t(rule.scope === 'cluster' ? '集群' : '主机', rule.scope === 'cluster' ? 'Cluster' : 'Host')), h('select', { 'aria-label': t(`例外 ${index + 1} 对象`, `Exception ${index + 1} target`), value: rule.targetId, onChange: event => selectRuleTarget(rule, event.target.value) },
                h('option', { value: '' }, rule.scope === 'cluster' ? t('选择集群', 'Select cluster') : t('选择主机', 'Select host')),
                rule.targetId && !objects.some(row => row.id === rule.targetId) && h('option', { value: rule.targetId }, t('已配置映射：', 'Configured mapping: ') + rule.targetId),
                ...objects.map(row => h('option', { key: row.id, value: row.id, disabled: used.has(row.id) }, `${row.name} (${row.id})`))))),
            h('details', { className: 'pk-ssh-map-edit' }, h('summary', null, t('高级映射配置', 'Advanced mapping configuration')), rule.scope === 'cluster' ? field(t('对象映射标识', 'Target mapping ID'), rule.targetId, targetId => selectRuleTarget(rule, targetId)) : h('p', { className: 'pk-ssh-rule-note' }, t('自定义主机映射请先在下方独立目标设置中登记，再从此处对象列表选择。', 'Register custom host mappings in the separate target settings below, then select them from this target list.'))),
            rule.scope === 'host' && !draft.hosts[rule.index].hostKeySha256 && h('p', { className: 'pk-ssh-notice' }, t('此主机尚缺可信指纹，请在下方独立目标设置中完成核验。不会自动连接。', 'This host needs a trusted pin. Complete verification in the separate target settings below. No connection is started.')),
            connectionEditor(rule.connection, previous, connection => updateCredential(rule, connection)));
        }),
        h('div', { className: 'c89-exception-heading' }, h('strong', null, t('主机目标设置', 'Host target settings')), h('button', { type: 'button', className: 'c89-add-rule', disabled: draft.hosts.length >= 500, onClick: () => store.update({ hosts: [...draft.hosts, blankTarget(null)] }) }, t('添加主机配置', 'Add host profile'))),
        h('p', { className: 'pk-ssh-rule-note' }, t('目标仅定义可连接的主机和设备，不改变凭据优先级。地址、端口、指纹和设备映射须逐主机明确配置。', 'Targets define allowed hosts and devices, separately from credential precedence. Configure each host’s address, port, pin and device mappings explicitly.')),
        !draft.hosts.length && h('div', { className: 'c89-empty-rules' }, t('尚无主机目标；全局凭据或例外本身不会添加连接目标。', 'No host targets. Defaults and overrides alone do not add connection targets.')),
        ...draft.hosts.map((row, index) => {
          const previous = saved.hosts.find(item => item.hostId === row.hostId), display = hosts.find(item => item.id === row.hostId);
          function devicePatch(n, patch) { patchTarget(index, { devices: row.devices.map((device, i) => i === n ? { ...device, ...patch } : device) }); }
          return h('details', { className: 'pk-ssh-target', key: index },
            h('summary', null, h('span', { className: 'pk-ssh-target-name' }, display ? `${display.name} (${row.hostId})` : row.hostId || t(`主机目标 ${index + 1}`, `Host target ${index + 1}`)), h('span', { className: 'pk-ssh-draft-badge' }, row.hostKeySha256 ? t('已配置指纹', 'Pin configured') : t('待核验指纹', 'Pin required'))),
            h('div', { className: 'pk-ssh-target-body' }, h('div', { className: 'c89-rule-top' }, h('span', null, t('独立目标配置', 'Independent target configuration')), trash(t(`删除主机目标 ${index + 1}`, `Delete host target ${index + 1}`), () => { store.update({ hosts: draft.hosts.filter((_, n) => n !== index) }); setNotice('removeTarget'); })),
              h('label', { className: 'pk-ssh-connection-field' }, h('span', null, t('选择主机', 'Select host')), h('select', { 'aria-label': t('选择主机', 'Select host'), value: row.hostId, onChange: event => {
                const selected = inventory.hosts.find(item => item.id === event.target.value);
                if (selected && selected.id !== row.hostId) { patchTarget(index, { hostId: selected.id, clusterId: selected.clusterId, address: selected.address, hostKeySha256: '', devices: [], connection: null }); setNotice('target'); }
              } }, h('option', { value: '' }, t('请选择主机', 'Select a host')), row.hostId && !inventory.hosts.some(item => item.id === row.hostId) && h('option', { value: row.hostId }, t('已配置映射：', 'Configured mapping: ') + row.hostId), ...inventory.hosts.map(item => h('option', { value: item.id, key: item.id, disabled: draft.hosts.some((other, n) => n !== index && other.hostId === item.id) }, `${item.name} (${item.id})`)))),
              clusterSelector(row.clusterId, clusterId => patchTarget(index, { clusterId })),
              h('details', { className: 'pk-ssh-map-edit' }, h('summary', null, t('高级映射配置', 'Advanced mapping configuration')), field(t('主机映射标识', 'Host mapping ID'), row.hostId, hostId => patchTarget(index, { hostId })), field(t('集群映射标识', 'Cluster mapping ID'), row.clusterId, clusterId => patchTarget(index, { clusterId }))),
              h('div', { className: 'pk-ssh-target-grid' }, field(t('IP 地址', 'IP address'), row.address, address => patchTarget(index, { address })), field(t('端口', 'Port'), row.port, value => patchTarget(index, { port: Number(value) }), { type: 'number', min: 1, max: 65535 }),
                h('div', { className: 'pk-ssh-pin' }, field(t('已独立核验的主机密钥 SHA-256（64 位十六进制）', 'Independently verified host key SHA-256 (64 hex characters)'), row.hostKeySha256, hostKeySha256 => patchTarget(index, { hostKeySha256 })))),
              h('p', { className: 'pk-ssh-rule-note' }, t('已保存的有效凭据来源：', 'Saved effective credential source: ') + sourceNames[previous?.effective.source || 'none'] + (previous && !previous.effective.ready ? t('（凭据未就绪）', ' (credential unready)') : '')),
              h('p', { className: 'pk-ssh-rule-note' }, row.connection ? t('此主机有专属例外。请在上方例外卡片修改；删除例外不会删除目标。', 'This host has an override. Edit it in the exception cards above; deleting the override preserves the target.') : t('此主机没有专属例外，将按集群例外或全局默认继承。', 'This host has no host override and inherits its cluster override or global default.')),
              h(HostPreflight, { store, index, client, enabled: preflightEnabled, locale }),
              h('h5', null, t('可信设备映射', 'Trusted device mappings')),
              ...row.devices.map((device, n) => h('div', { className: 'pk-ssh-device', key: n }, h('div', { className: 'pk-ssh-device-fields' }, field(t('设备映射标识', 'Device mapping ID'), device.deviceId, deviceId => devicePatch(n, { deviceId })), field(t('设备路径', 'Device path'), device.path, path => devicePatch(n, { path })), field(t('可信序列号', 'Trusted serial number'), device.serial || '', serial => devicePatch(n, serial ? { serial } : { serial: undefined })), trash(t(`删除设备映射 ${n + 1}`, `Delete device mapping ${n + 1}`), () => patchTarget(index, { devices: row.devices.filter((_, i) => i !== n) }))))),
              h('button', { type: 'button', className: 'c89-add-rule', onClick: () => patchTarget(index, { devices: [...row.devices, { deviceId: '', path: '', serial: '' }] }) }, t('添加设备映射', 'Add device mapping'))));
        })));
  };
}

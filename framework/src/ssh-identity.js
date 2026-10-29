export function createSshIdentitySettings(React) {
  const h = React.createElement, { useState, useEffect, useRef } = React;
  return function IdentitySettings({ client, hosts, enabled, locale }) {
    const t = (zh, en) => locale === 'en-US' ? en : zh;
    const [hostId, setHost] = useState(''), [review, setReview] = useState(null), [grant, setGrant] = useState(null);
    const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState(null), [recent, setRecent] = useState([]);
    const alive = useRef(false), generation = useRef(0), locked = useRef(false), attempted = useRef(null);
    const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const current = token => alive.current && token === generation.current;
    const fail = value => setError(/^SSH_[A-Z_]{1,85}$/.test(value?.message) ? value.message : 'SSH_IDENTITY_REQUEST_FAILED');
    const validResult = value => value && uuid(value.requestId) && ['running', 'success', 'failed'].includes(value.status) && typeof value.hostId === 'string';
    useEffect(() => {
      alive.current = true;
      return () => { alive.current = false; generation.current++; };
    }, [client]);
    useEffect(() => { generation.current++; setReview(null); setGrant(null); setAck(false); }, [enabled]);
    async function action(kind, previous) {
      if (locked.current || !['result', 'history'].includes(kind) && !enabled) return;
      if (kind === 'approve' && (!review || !ack || Date.parse(review.expiresAt) <= Date.now())) return;
      if (kind === 'execute' && (!grant || attempted.current || grant.hostId !== hostId || Date.parse(grant.expiresAt) <= Date.now())) return;
      locked.current = true; setBusy(true); setError(''); const token = generation.current;
      try {
        if (kind === 'history') {
          const value = await client('/ssh-channel/identity');
          if (!current(token)) return;
          if (!Array.isArray(value?.items) || value.items.length > 30 || !value.items.every(validResult)) throw new Error('SSH_IDENTITY_RESPONSE_INVALID');
          setRecent(value.items);
        } else if (kind === 'review') {
          setReview(null); setGrant(null); setAck(false); setResult(null); attempted.current = null;
          const value = await client('/ssh-channel/identity', 'POST', { action: 'review', hostId });
          if (!current(token)) return;
          if (value?.kind !== 'builtin-host-identity' || value.operation !== 'host.identity' || value.command !== '/usr/bin/uname -srm' || value.hostId !== hostId || !digest(value.digest) || !digest(value.challenge) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new Error('SSH_IDENTITY_REVIEW_INVALID');
          setReview(value);
        } else if (kind === 'approve') {
          const value = await client('/ssh-channel/identity', 'POST', { action: 'approve', challenge: review.challenge, digest: review.digest, acknowledged: true });
          if (!current(token)) return;
          if (!uuid(value?.approvalId) || value.digest !== review.digest || value.hostId !== hostId || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('SSH_IDENTITY_APPROVAL_INVALID');
          setGrant(value); setReview(null); setAck(false);
        } else {
          let value;
          if (kind === 'execute') {
            const requestId = globalThis.crypto?.randomUUID?.(); if (!uuid(requestId)) throw new Error('SSH_IDENTITY_RANDOM_UNAVAILABLE');
            attempted.current = requestId;
            value = await client('/ssh-channel/identity', 'POST', { action: 'execute', hostId, digest: grant.digest, approvalId: grant.approvalId, requestId });
          } else {
            const requestId = previous || attempted.current; if (!uuid(requestId)) throw new Error('SSH_IDENTITY_REQUEST_INVALID');
            value = await client('/ssh-channel/identity?requestId=' + encodeURIComponent(requestId));
          }
          if (!current(token)) return;
          if (!validResult(value)) throw new Error('SSH_IDENTITY_RESPONSE_INVALID');
          setResult(value); setRecent(rows => [value, ...rows.filter(row => row.requestId !== value.requestId)].slice(0, 30));
        }
      } catch (failure) { if (current(token)) fail(failure); }
      finally { locked.current = false; if (alive.current) setBusy(false); }
    }
    return h('section', { className: 'pk-ssh-identity' }, h('h4', null, t('内置主机身份诊断', 'Built-in host identity diagnostic')),
      h('p', null, t('需要 Tower ROOT 身份。仅针对选中的已保存主机执行一次只读身份查询，不批准 SMART 采集或计划任务。', 'Requires a Tower ROOT account. Run one read-only identity query on the selected saved host; it does not authorize SMART collection or schedules.')),
      h('label', null, t('目标主机', 'Target host'), ' ', h('select', { value: hostId, disabled: busy, onChange: event => { generation.current++; setHost(event.target.value); setReview(null); setGrant(null); setAck(false); setResult(null); attempted.current = null; } },
        h('option', { value: '' }, t('请选择一台主机', 'Select one host')), ...(hosts || []).slice(0, 500).map(row => h('option', { key: row.hostId, value: row.hostId }, row.hostId)))),
      h('button', { type: 'button', disabled: busy || !enabled || !hostId, onClick: () => action('review') }, t('审核身份命令', 'Review identity command')),
      review && h('div', { className: 'pk-ssh-identity-review', role: 'group', 'aria-label': t('身份命令审核', 'Identity command review') },
        h('p', null, `${review.hostId} · ${review.target?.address || ''}:${review.target?.port || ''}`), h('pre', null, review.command),
        h('p', null, `SHA-256: ${review.digest}`), h('p', null, t('两分钟内有效；只批准这一台主机，不自动执行。', 'Valid for two minutes; approves only this host and does not execute automatically.')),
        h('label', null, h('input', { type: 'checkbox', checked: ack, disabled: busy, onChange: event => setAck(event.target.checked) }), t(' 我已核对目标和只读命令', ' I reviewed the target and read-only command')),
        h('button', { type: 'button', disabled: busy || !ack || !enabled, onClick: () => action('approve') }, t('批准一次身份查询', 'Approve one identity query'))),
      grant && h('button', { type: 'button', disabled: busy || !enabled || Boolean(attempted.current), onClick: () => action('execute') }, t('执行一次身份查询', 'Execute identity query once')),
      attempted.current && h('button', { type: 'button', disabled: busy, onClick: () => action('result') }, t('查询原执行结果（不重试）', 'Read original result (no retry)')),
      error && h('p', { role: 'alert' }, error),
      h('button', { type: 'button', disabled: busy, onClick: () => action('history') }, t('读取本人诊断记录', 'Read my diagnostic records')),
      result && h('div', { role: 'status' }, result.status === 'success' && result.identity ? `${result.identity.system} ${result.identity.release} ${result.identity.architecture}` : `${result.status} · ${result.code || (result.outcomeUnknown ? 'SSH_IDENTITY_OUTCOME_UNKNOWN' : '')}`),
      recent.length > 0 && h('details', null, h('summary', null, t('本人诊断记录', 'My diagnostic records')), ...recent.map(row => h('p', { key: row.requestId }, `${row.hostId} · ${row.status} · ${row.startedAt}`, ' ',
        h('button', { type: 'button', disabled: busy, onClick: () => action('result', row.requestId) }, t('查询结果', 'Read result'))))));
  };
}

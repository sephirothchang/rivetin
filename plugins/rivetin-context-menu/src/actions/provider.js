import { buildActionTree } from './catalog.js';
import { FORM_ACTIONS, actionFields, initialValues, fieldValues } from './forms.js';
import { buildActionRequest } from './requests.js';
import { createConfirmedExecution } from './execution.js';
import { resolveHostBoundary } from '../host-boundary.js';
import { readActionData } from './action-data.js';
import { renderSnapshotList } from './snapshot-list.js';

const rootSelector = '[data-rivetin-action-form]';
const css = `${rootSelector}{position:fixed;inset:0;z-index:2147483100;background:#14264066;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#142640}
${rootSelector} section{width:600px;max-width:100%;max-height:calc(100vh - 48px);overflow:auto;background:white;border:1px solid #dfe6ef;border-radius:9px;padding:24px;margin:0;box-shadow:0 12px 40px #14264033;box-sizing:border-box}
${rootSelector} h2{font-size:18px;margin:0 0 14px;font-weight:600}${rootSelector} p{overflow-wrap:anywhere;margin:10px 0}
${rootSelector} label{display:grid;grid-template-columns:170px minmax(0,1fr);align-items:center;gap:12px;margin:14px 0}
${rootSelector} input,${rootSelector} select{box-sizing:border-box;min-width:0;width:100%;border:1px solid #ccd8e7;border-radius:5px;padding:8px;font:inherit;color:inherit;background:white}
${rootSelector} input[type=checkbox]{width:18px;justify-self:start}${rootSelector} button{font:inherit;border:1px solid #ccd8e7;border-radius:5px;padding:7px 14px;cursor:pointer;background:white;color:#263d57}
${rootSelector} .rva-confirm{background:#0784f5;color:white;border-color:#0784f5}${rootSelector} .rva-danger{background:#d82d3b;color:white;border-color:#d82d3b}${rootSelector} button:disabled{opacity:.55;cursor:default}
${rootSelector} .rva-actions{display:flex;justify-content:flex-end;gap:10px;border-top:1px solid #e8edf4;padding-top:16px;margin-top:18px}${rootSelector} [role=status]{padding:10px;background:#f1f6fc;border-radius:5px}
${rootSelector} :focus-visible{outline:2px solid #0784f5;outline-offset:2px}
@media(max-width:500px){${rootSelector} label{grid-template-columns:1fr;gap:5px}}
`;
const clone = value => JSON.parse(JSON.stringify(value));
const exact = (a, b) => a?.type === 'vm' && b?.id === a.id;
const basicActions = new Set(['vm.general.edit', ...['start', 'shutdown', 'poweroff', 'restart', 'forceRestart', 'suspend', 'resume'].map(id => `vm.power.${id}`)]);
const needsChoices = id => !basicActions.has(id);
export function createProductionActionProvider({ win, bridge, history, getLocale = () => 'zh-CN', isEnabled = () => true, environmentNotice = '' }) {
  if (typeof bridge?.read !== 'function' || typeof bridge?.execute !== 'function') return null;
  const doc = win.document, supported = new Set([...FORM_ACTIONS, 'vm.snapshots.list']);
  const t = (zh, en) => getLocale() === 'en-US' ? en : zh;
  let session = null, disposed = false, opening = 0, pendingOpen = null;
  async function read(resource, { signal } = {}) {
    const result = await bridge.read(resource, { signal });
    const snapshot = clone(result?.snapshot || null), capabilities = clone(result?.capabilities || {});
    for (const group of buildActionTree({ resource, snapshot, capabilities })) for (const entry of group.items) {
      if (!supported.has(entry.id)) capabilities[entry.id] = { allowed: false, reason: { 'zh-CN': '当前研究提供器没有注册此操作，已阻止执行。', 'en-US': 'The research provider has no registration for this operation. Execution was blocked.' } };
      else if (needsChoices(entry.id) && typeof bridge.choices !== 'function') capabilities[entry.id] = { allowed: false, reason: { 'zh-CN': '当前研究提供器未提供必需的选项读取方法，无法校验目标，已阻止执行。', 'en-US': 'The research provider lacks the required choices reader. Target validation is unavailable, so execution was blocked.' } };
    }
    return { snapshot, capabilities };
  }
  function close() {
    opening++;
    if (pendingOpen) { pendingOpen.controller.abort(); pendingOpen.cleanup(); pendingOpen = null; }
    if (!session) return;
    const value = session; session = null; value.execution.stop();
    win.clearInterval(value.guard);
    value.root.remove(); value.style.remove(); doc.removeEventListener('keydown', value.key, true);
    if (value.previous?.isConnected) value.previous.focus();
  }
  async function open(request, { signal } = {}) {
    if (disposed || signal?.aborted || !isEnabled(request.resource) || !supported.has(request.actionId) || !exact(request.resource, request.snapshot)) return { status: 'unsupported' };
    const container = resolveHostBoundary(win), href = win.location.href;
    if (!container) return { status: 'unsupported' };
    close();
    const token = opening;
    if (needsChoices(request.actionId)) {
      const controller = new win.AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const pending = { controller, cleanup: () => signal?.removeEventListener('abort', abort) }; pendingOpen = pending;
      let data;
      try { data = await readActionData(bridge, request.resource, request.actionId, { signal: controller.signal }); }
      catch (error) { if (controller.signal.aborted || token !== opening) return { status: 'cancelled' }; throw error; }
      finally { pending.cleanup(); if (pendingOpen === pending) pendingOpen = null; }
      if (disposed || token !== opening || signal?.aborted || win.location.href !== href || resolveHostBoundary(win) !== container || !isEnabled(request.resource)) return { status: 'cancelled' };
      const action = buildActionTree({ resource: request.resource, snapshot: data.snapshot, capabilities: data.capabilities, locale: getLocale() }).flatMap(group => group.items).find(entry => entry.id === request.actionId);
      if (!action?.enabled) return { status: 'unsupported' };
      request = { ...request, snapshot: data.snapshot, choices: data.choices, action };
    }
    const readOnly = request.actionId === 'vm.snapshots.list';
    const resource = Object.freeze({ type: 'vm', id: request.resource.id, name: String(request.snapshot.name || request.resource.name || request.resource.id) });
    const root = doc.createElement('div'); root.setAttribute('data-rivetin-action-form', '');
    // Cancel removes the form before the event finishes bubbling. Keep that
    // detached-target click from becoming a native outside click afterwards.
    root.addEventListener('click', event => event.stopPropagation());
    const panel = doc.createElement('section'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    const title = doc.createElement('h2'); title.id = 'rivetin-action-title'; title.textContent = request.action.label; panel.setAttribute('aria-labelledby', title.id);
    const target = doc.createElement('p'); target.textContent = `${resource.name} · ${resource.id}`;
    const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    status.textContent = readOnly ? t('当前虚拟机的快照列表。此页面不提交变更。', 'Snapshots belonging to this VM. This view does not submit changes.') : environmentNotice ? t('提交前将重新校验对象和权限。', 'The resource and authorization are checked again before submission.') : t('确认后将对所示对象执行实际操作。', 'Confirming performs a real operation on this resource.');
    panel.append(title, target);
    if (environmentNotice) { const notice = doc.createElement('p'); notice.textContent = environmentNotice; panel.append(notice); }
    panel.append(status);
    const style = doc.createElement('style'); style.textContent = css;
    let fields = actionFields(request.actionId, request.snapshot, getLocale(), {}, request.choices);
    const values = initialValues(fields), controls = [], extraControls = [];
    const fieldGroup = doc.createElement('div'); panel.append(fieldGroup);
    const actions = doc.createElement('div'); actions.className = 'rva-actions';
    const cancel = doc.createElement('button'); cancel.type = 'button'; cancel.textContent = t('取消', 'Cancel');
    const confirm = doc.createElement('button'); confirm.type = 'button'; confirm.className = request.action.danger === 'danger' ? 'rva-danger' : 'rva-confirm'; confirm.textContent = t('确认执行', 'Confirm operation');
    const value = { root, style, execution: null, previous: doc.activeElement, key: null, busy: false, terminal: false, confirmation: '', guard: null, href: win.location.href };
    const viewLive = () => session === value && root.isConnected && isEnabled(resource) && win.location.href === value.href && resolveHostBoundary(win) === container;
    function parsed() {
      if (readOnly) throw new Error('READ_ONLY_VIEW');
      const output = fieldValues(fields, values);
      buildActionRequest({ actionId: request.actionId, resource, snapshot: request.snapshot, choices: request.choices, values: output });
      if (request.action.danger === 'danger' && value.confirmation !== resource.name) throw new Error('CONFIRMATION_REQUIRED');
      return output;
    }
    function update() { try { parsed(); confirm.disabled = value.busy || value.terminal; } catch { confirm.disabled = true; } }
    function renderFields(changedKey) {
      if (changedKey) {
        // Do not carry a former device's editable values into a newly selected
        // device, nor submit fields belonging to the other disk creation mode.
        for (const field of fields.filter(field => field.dependsOn === changedKey)) delete values[field.id];
        fields = actionFields(request.actionId, request.snapshot, getLocale(), values, request.choices);
        for (const [key, initial] of Object.entries(initialValues(fields))) if (values[key] === undefined) values[key] = initial;
      }
      fieldGroup.replaceChildren(); controls.length = 0;
      for (const field of fields) {
      const label = doc.createElement('label'), caption = doc.createElement('span'); caption.textContent = field.label;
      const input = doc.createElement(field.type === 'select' ? 'select' : 'input'); input.setAttribute('aria-label', field.label); input.dataset.field = field.id;
      if (field.type === 'select') {
        const blank = doc.createElement('option'); blank.value = ''; blank.textContent = t('请选择', 'Choose…'); input.append(blank);
        for (const choice of field.options) { const option = doc.createElement('option'); option.value = choice.value; option.textContent = choice.label; input.append(option); }
      } else { input.type = field.type; if (field.min !== undefined) input.min = field.min; if (field.max !== undefined) input.max = field.max; if (field.maxLength) input.maxLength = field.maxLength; }
      if (field.type === 'checkbox') input.checked = values[field.id] === true; else input.value = values[field.id] ?? '';
      input.required = field.required; input.addEventListener('change', changed); input.addEventListener('input', changed);
      function changed() {
        if (!viewLive() || value.busy || value.terminal || input.disabled || !controls.includes(input) || !fieldGroup.contains(input)) return;
        values[field.id] = field.type === 'checkbox' ? input.checked : input.value;
        if (field.refresh) {
          renderFields(field.id); fieldGroup.querySelector(`[data-field="${field.id}"]`)?.focus();
        }
        update();
      }
      label.append(caption, input); fieldGroup.append(label); controls.push(input);
      }
    }
    renderFields();
    if (readOnly) fieldGroup.append(renderSnapshotList(doc, { id: request.snapshot.id, snapshots: request.choices.snapshots }, getLocale()));
    if (request.action.danger === 'danger') {
      const warning = doc.createElement('p'); warning.textContent = t('此操作可能中断服务或丢失数据。请输入对象名称确认。', 'This operation may interrupt service or lose data. Type the resource name to confirm.');
      const input = doc.createElement('input'); input.type = 'text'; input.setAttribute('aria-label', t('对象名称确认', 'Resource name confirmation'));
      input.addEventListener('input', () => { if (!viewLive() || value.busy || value.terminal || input.disabled || !panel.contains(input)) return; value.confirmation = input.value; update(); }); panel.append(warning, input); extraControls.push(input);
    }
    value.execution = createConfirmedExecution({ bridge, win,
      ...(needsChoices(request.actionId) ? { preflight: (captured, options) => readActionData(bridge, captured.resource, captured.actionId, options) } : {}),
      validate({ resource: latestResource, actionId, snapshot, capabilities, choices, values: latestValues }) {
      const action = buildActionTree({ resource: latestResource, snapshot, capabilities, locale: getLocale() }).flatMap(group => group.items).find(entry => entry.id === actionId);
      if (!viewLive() || !isEnabled(latestResource) || !action?.enabled) throw new Error('ACTION_UNAVAILABLE');
      buildActionRequest({ actionId, resource: latestResource, snapshot, choices: needsChoices(actionId) ? choices : undefined, values: latestValues });
      return action;
    } });
    cancel.addEventListener('click', () => { if (session === value) close(); });
    confirm.addEventListener('click', async () => {
      if (session !== value || value.busy || value.terminal) return;
      if (!viewLive()) { close(); return; }
      let output; try { output = parsed(); } catch { return; }
      value.busy = true; confirm.disabled = true; [...controls, ...extraControls].forEach(input => { input.disabled = true; }); cancel.textContent = t('关闭', 'Close');
      status.textContent = t('正在重新校验并执行，请勿重复提交。关闭窗口不会撤销已提交的任务。', 'Rechecking and executing. Do not resubmit. Closing this window does not undo an accepted task.');
      let result;
      try { result = await value.execution.confirm({ resource, actionId: request.actionId, values: output, requestId: win.crypto.randomUUID() }); }
      catch { result = { status: 'unknown' }; }
      if (session !== value) return;
      value.busy = false; value.terminal = true;
      const messages = {
        succeeded: t('操作已完成。', 'The operation completed.'),
        failed: t('操作失败，请查看操作日志中的错误代码。', 'The operation failed. Check the operation log for the error code.'),
        cancelled: t('操作已取消，未提交变更。', 'The operation was cancelled before submission.'),
        unknown: t('操作结果尚未确认。请检查任务或操作日志，不要重复提交。', 'The operation outcome is unconfirmed. Check tasks or the operation log before taking further action.'),
      };
      status.textContent = messages[result?.status] || messages.unknown;
      if (/^[A-Z][A-Z0-9_]{0,63}$/.test(result?.code || '')) status.textContent += ` (${result.code})`;
      if (/^[a-f0-9]{64}$/.test(result?.operationId || '')) { const operation = doc.createElement('p'); operation.textContent = `${t('操作记录', 'Operation record')}: ${result.operationId}`; panel.insertBefore(operation, actions); }
      if (/^[A-Za-z0-9_-]{1,128}$/.test(result?.taskId || '')) { const task = doc.createElement('p'); task.textContent = `${t('任务', 'Task')}: ${result.taskId}`; panel.insertBefore(task, actions); }
      cancel.focus();
    });
    value.key = event => {
      if (session !== value) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') {
        const focusable = [...panel.querySelectorAll('input:not(:disabled),select:not(:disabled),button:not(:disabled)')];
        if (event.shiftKey && doc.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1)?.focus(); }
        else if (!event.shiftKey && doc.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0]?.focus(); }
      }
    };
    if (readOnly) { cancel.textContent = t('关闭', 'Close'); actions.append(cancel); } else actions.append(cancel, confirm);
    panel.append(actions); root.append(panel); session = value;
    doc.head.append(style); container.append(root); doc.addEventListener('keydown', value.key, true);
    value.guard = win.setInterval(() => { if (session === value && !viewLive()) close(); }, 250);
    update(); (controls[0] || extraControls[0] || cancel).focus();
    return { status: 'opened' };
  }
  win.addEventListener('hashchange', close); win.addEventListener('popstate', close);
  const unsubscribe = typeof history?.listen === 'function' ? history.listen(close) : null;
  return { read, open, close, stop() {
    if (disposed) return; disposed = true; close();
    win.removeEventListener('hashchange', close); win.removeEventListener('popstate', close);
    if (typeof unsubscribe === 'function') unsubscribe();
  } };
}

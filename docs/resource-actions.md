# Resource action provider

This server-side Rivetin provider exposes a fixed CloudTower 4.9.0 action allowlist. It is not a general REST proxy or a binding to native Tower dialogs. Clients cannot supply API paths, URLs, authentication headers, commands, filters or arbitrary mutation fields. The module has local contract tests; these tests do not establish live VM power-operation acceptance.

## Integration contract

```js
const provider = createResourceActions(absoluteDataDirectory, {
  request,               // request(path, body, authenticatedActor)
  pluginStatus,          // async (pluginId, actor) => status
  towerBuildProvider,    // async ({fresh: true}) => '4.9.0'
  audit,                 // optional async (sanitizedEvent, authenticatedActor)
});
```

`pluginStatus` must confirm `frameworkEnabled`, `installed`, `enabled` and `compatible` are all `true`. Its `manifest.permissions` must contain both `ui.context-menu` and `resource.actions`. Missing or unknown state denies access. Every call rechecks this gate and the exact Tower-reported version; there is no version-range inference or fallback to another API. Submission rechecks it after durable intent/audit work and immediately before calling Tower. A change during that interval records a failed `RESOURCE_ACTION_PLUGIN_UNAVAILABLE` result without submitting. This narrows the disable/submission race; it cannot cancel a request already accepted by Tower or guarantee atomicity with Tower's independent authorization/state transitions.

The actor must come from the framework's live Tower authentication. The provider requires its Tower identity and original `Authorization` or `Cookie` transport headers. Neither an arbitrary client actor nor a decoded token is an authorization source. The current implementation only enables mutations for the server-confirmed `ROOT` role; other authenticated roles receive an unknown action permission and cannot execute. This is deliberately narrower than all possible Tower roles. An administrator display name or `admin: true` is insufficient. Each native API submission still uses the original caller's credentials, so Tower performs final authorization.

The framework's HTTP integration must retain its administrator and origin gates, independently authenticate every request, and inject the installed plugin ID. The server module does not accept client-supplied role, actor or authentication fields as trusted evidence.

Methods:

- `read({pluginId, resource, actor}) → {snapshot, capabilities}`
- `execute({pluginId, resource, actionId, values, requestId, actor}) → {status, operationId, taskId?, code?}`
- `task({pluginId, operationId, actor}) → {status, operationId, taskId?, code?}`
- `openConsole({pluginId, resource, actor})` currently rejects with `RESOURCE_ACTION_UNSUPPORTED`.

`resource` is exactly `{type, id, name?}`. `name` is optional display-only input and is ignored in favor of freshly read Tower data. Supported read types are `vm`, `host`, `cluster`, `disk` and `vmVolume`. Unknown fields and types are rejected. A physical disk ID or VM parent ID cannot stand in for a different resource type.

VM snapshots expose only `id`, `type`, `name`, `description`, `status`, `protected`, `internal`, `in_recycle_bin`, `vm_tools_status`, `entityAsyncStatus` and `hasActiveTask`. Unknown power or VM Tools values normalize to `UNKNOWN`; they cannot authorize operations requiring a known value. Other supported resource types expose only `id`, `type` and `name`. Raw responses, IP addresses, credentials, disk serials and native console access material are not returned.

The VM read uses `where: {id}` and `first: 2`, rejects missing, mismatched or nonunique objects, and then checks tasks with `where: {resource_id: id, status_in: ['EXECUTING', 'PENDING', 'PAUSED']}` and `first: 2`. A failed or malformed task check cannot authorize a mutation. A task counts as busy only when its ID, exact resource relationship and active status are verified. Unsupported task control and migration metadata are not synthesized.

## Implemented actions

The 67-entry VM menu receives explicit capability results: eight actions have an implementation and the remaining 59 are unsupported. Unknown action IDs are also rejected. An implementation may still be unavailable because of caller permissions, VM state, plugin state or Tower version.

| Action ID | Values | Fixed public API | Required VM state |
|---|---|---|---|
| `vm.general.edit` | `{name?, description?}`, at least one field | `/v2/api/update-vm-basic-info` | Running, stopped or suspended |
| `vm.power.start` | `{}` | `/v2/api/start-vm` | Stopped |
| `vm.power.shutdown` | `{}` | `/v2/api/shutdown-vm` | Running and VM Tools running |
| `vm.power.poweroff` | `{}` | `/v2/api/poweroff-vm` | Running or suspended |
| `vm.power.restart` | `{}` | `/v2/api/restart-vm` | Running and VM Tools running |
| `vm.power.forceRestart` | `{}` | `/v2/api/force-restart-vm` | Running |
| `vm.power.suspend` | `{}` | `/v2/api/suspend-vm` | Running |
| `vm.power.resume` | `{}` | `/v2/api/resume-vm` | Suspended |

All actions reject protected, internal, recycled, updating or active-task VMs. Unknown states fail closed. Names are nonempty, trimmed strings of at most 256 characters without control characters. Descriptions are at most 4096 characters; empty descriptions and ordinary line breaks are permitted. Other fields are rejected. Power actions accept no placement, host or other optional mutation parameters. `VmStartParams.data` is optional in the reviewed schema, so the provider omits it and does not invent a destination host.

Each mutation body contains only `where: {id: exactVmId}` and, for general editing, the explicitly supplied `data` fields. Destructive deletion, recycling, disk/network configuration, snapshots, migration, cloning and the other unimplemented catalog actions are not forwarded.

## Asynchronous tasks and idempotency

The browser supplies a fresh lowercase UUID v4 `requestId` for each separately confirmed intent. It must retain that ID when checking an uncertain response, rather than creating a replacement intent. `operationId` is a server-derived 64-character hexadecimal identifier scoped to the actor, plugin and request ID. Reusing a request ID with changed resource, action or parameters is a conflict.

The module uses its own cross-process lock and durable journal under `<data>/resource-actions/`. An `unknown` marker is synchronized to disk before the single native mutation request. Concurrent requests and provider/process restarts return the existing journal result without replaying the mutation. Journals contain identity, action, parameter fingerprints and the fixed ordered names of edited fields, not parameter values or authentication material. The field-name list is restricted to `name` and `description`; power actions require an empty list. A maximum of 1000 journal records prevents unbounded growth; reaching that limit refuses new operations. There is no automatic journal deletion, because deleting an idempotency record could permit replay. Retention or archival requires a separately designed administrative procedure.

Native mutation responses must be exactly one `WithTask<Vm>` with the requested `data.id` and an explicit `task_id`. A valid task ID yields `running`; `task_id: null` requires a fresh resource read and verification of changed fields or expected power state before `succeeded` is returned. The temporary native `data` body does not prove completion.

Task polling uses `/v2/api/get-tasks`, `where: {id: recordedTaskId}` and `first: 2`, under the current caller's credentials. It also rechecks current object readability and journal ownership. Task `resource_id` must match the original VM. Verified `PENDING`, `EXECUTING` and `PAUSED` remain running. An unavailable, missing or mismatched task is reported as unknown rather than confirmed running; a later exact lookup can recover without resubmission. The schema's exact success spelling `SUCCESSED` requires another fresh exact-object read before succeeded is returned. General edits recompute the saved parameter fingerprint from the exact requested fields in fixed order; power actions require the expected stable power state. Missing, changed or unverified values yield `unknown` with `RESOURCE_ACTION_READBACK_UNVERIFIED`, even when the native task succeeded. Such a recorded task can be checked again without resubmitting the mutation. `FAILED` yields a fixed sanitized failure. The client should refresh the object after completion; concurrent administrator edits may independently change its state. Task lookup does not resubmit a mutation. A missing or mismatched task cannot become success. Disabling a plugin prevents subsequent provider calls; it does not stop a native task that Tower has already accepted.

Timeouts, uncertain network failures, server 5xx responses, malformed responses and unverified synchronous readback remain `unknown`. Definite native 4xx rejections other than 408 are recorded as failed. Neither category automatically resubmits. An unknown submission without a task ID stays unknown; the module does not guess a task from names, list order or time proximity. The operator must reconcile with Tower before starting a new intent.

Preflight/validation errors throw fixed error codes with HTTP status metadata: 400 for malformed or unsupported requests, 401 for missing caller authentication, 403 for permission failures, 404 for missing objects/operations, 409 for conflicting intent or state, and 503 for unavailable reads or journals. Submitted operation outcomes use the structured result above. Original Tower response bodies and error messages are not returned or journaled.

Auditing records the action, plugin, sanitized actor, result and fixed code. An audit failure before submission blocks the mutation. Failure of a later audit mirror cannot authorize replay or erase the durable operation record. The optional second audit argument carries the original actor only for an internal authenticated audit transport and must never be serialized.

## Public API evidence and limitations

The reviewed CloudTower 4.9.0 OpenAPI schema declares:

- `GetVmsRequestBody`, `GetHostsRequestBody`, `GetClustersRequestBody`, `GetDisksRequestBody` and `GetVmVolumesRequestBody`: `where` filters and `first`; their documented responses are direct arrays.
- `VmUpdateParams`: required `where` and `data`, including string `name` and `description` fields.
- `VmOperateParams`: required `where`; `VmStartParams`: required `where`, optional `data`.
- `WithTask_Vm_`: `data` plus nullable `task_id`.
- `GetTasksRequestBody` and `TaskWhereInput`: exact ID and resource/status filters; task status values include `SUCCESSED`.

There is no `/get-virtual-disks` operation in that schema. This provider uses the documented `/get-vm-volumes` resource for `vmVolume`; it does not rename or alias arbitrary disk endpoints.

`/get-vm-vnc-info` exists, but the presence of that endpoint does not establish a safe browser console-opening contract. Native console tokens and URLs are therefore not requested or exposed. Console remains explicitly unsupported pending a verified transport and UI integration.

Local tests cover exact scope and caller transport, parameter and state rejection, asynchronous task ownership, fixed error statuses, single submission across concurrency/restarts, unknown-result handling and journal/audit redaction. They do not execute VM power, disk, network or destructive actions in a real environment. The surrounding framework remains responsible for its UI confirmation and authentication gates; process or browser sandbox isolation is not provided by this module.

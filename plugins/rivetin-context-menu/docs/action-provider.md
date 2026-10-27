# 对象操作提供器接入说明

本文描述子插件 `0.2.6` 的生产接入点。共享资源操作桥已完成实现和只读链路核验；该候选仅限定 4.9.0。虚拟机菜单与表单取消已有部分真实只读结果，内部折叠修复仍待复验，不代表完整功能验收。开发演示中的模拟提供器不进入生产包。

## 接口与职责

工厂通过 `options.resourceActions(pluginId)` 获取共享服务桥，再由 `src/actions/provider.js` 包装为菜单提供器。没有服务桥时，虚拟机分组菜单显示“操作适配器尚未接入”，所有业务动作保持禁用。以下 `read/open` 是菜单内部接口，`open` 不属于共享服务桥。

```js
{
  async read(resource, { signal }) {
    // resource = { type: 'vm', id, name }，没有 DOM、认证材料或私有状态
    return { snapshot, capabilities };
  },
  async open({ resource, actionId, action, snapshot }, { signal }) {
    // 仅打开匹配对象的表单或明确确认流程，不能在进入表单时自动提交变更。
    return { status: 'opened' }; // 或 cancelled / unsupported
  }
}
```

`read()` 返回的 `snapshot.id` 必须严格等于请求的对象 ID。`status` 使用已确认的 VM 电源状态；未知状态不能靠 DOM 文本猜测。对象快照还应提供已确认的任务、保护、内部对象和回收状态。字段缺失不构成允许执行的证据；表单提交阶段仍须补齐各动作必需的事实。

`capabilities` 以目录中的动作 ID 为键，值为 `{ allowed: true | false | null, reason? }`。`reason` 支持字符串或 `zh-CN` / `en-US` 文案。只有可信解析结果明确允许才启用；不能把一个管理员角色名称或服务器拥有某个 REST 路由当作完整权限结论。

迁移控制额外需要 `snapshot.migration`：由可信适配器归一化的 `verified: true`、绑定的 `vmId`、独立 `taskId`、`taskStatus: 'EXECUTING'`、`kind: 'CROSS_CLUSTER'`、阶段 `TRANSFERRING` 或 `AWAITING_CUTOVER`，以及明确的 `controls.abort` / `controls.cutover`。切换只允许等待切换阶段。该结构是插件所需的归一化证据，不能原样假定为 CloudTower API 字段；映射未经核验时不提供。`ownsVmUpdate` 仅用于确认该任务确实拥有当前更新状态。客体设置还需运行中的 VM Tools，移出文件夹需要确切的文件夹归属。

提供器必须遵守 AbortSignal。来源节点被复用为其他类型或 ID、路由变化、来源移除、禁用插件、关闭菜单和八秒读取/打开超时时，菜单取消当前等待并拒绝迟到结果。提供器若忽略取消而另行打开界面，菜单无法撤销该外部副作用。

## 表单和提交边界

目录中的 `operation` 是经过资料核对的操作元数据，并非请求生成器。`operation: null` 的动作没有可用业务适配，不得按文案猜接口。VM 父 ID 不能作为磁盘、网卡、USB 或快照 ID；目标选择必须从重新读取且归属于该对象的子资源中完成。

生产表单必须独立实现以下环节：

1. 按准确对象 ID 重新读取状态和授权；获取且校验目标资源、子资源归属及必要的状态。
2. 显示具体操作、准确对象和影响。用户取消不发送变更请求；必须确认的动作保留确认过程。
3. 提交前重新校验对象、状态、参数和权限，由服务器做最终鉴权。拒绝无界过滤器及跨对象参数。
4. 记录不含凭据的操作结果与关联标识；异步任务跟踪实际终态，再重读对象。超时结果未知时不得自动重发变更请求。
5. 控制台使用受支持的返回契约，禁止猜测 URL、复用私有认证状态或记录短期访问材料。

当前 `demo/action-provider.js` 的 CPU、内存、磁盘、网卡、快照和迁移字段只是交互预览，未实现完整真实业务校验。其他动作的通用确认预览也不表示已接通相应业务功能。

## 共享框架服务桥

共享服务桥由框架提供，具体实现见 `framework/src/data-providers.js` 与 `framework/server/resource-actions.js`，本插件不自行增加共享路由：

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `read` | `{type, id, name}`，其中 name 仅供显示且可省略；第二参数 `{signal}` | `{snapshot, capabilities}`，可带 choices |
| `execute` | `{resource, actionId, values, requestId}`；第二参数 `{signal}` | 操作结果 |
| `task` | `operationId`；第二参数 `{signal}` | 操作结果 |
| `openConsole` | `resource`；第二参数 `{signal}` | 当前明确返回不支持，不能猜控制台入口 |

操作结果含 `status`（`running` / `succeeded` / `failed` / `unknown`）、`operationId`，可带 `taskId` / `code`。

`requestId` 使用 UUIDv4；`operationId` 是框架返回的 64 位小写十六进制标识，不能与目录中的公开 SDK 操作名称混用。`task()` 查询的是共享层操作记录，不是直接把该标识当作 Tower 任务 ID。

当前共享后端只接通 `vm.general.edit`（`name?` / `description?`，空描述表示清空）和 7 项 `vm.power.*`（`values: {}`，开机暂不指定主机）。子插件实现的其余表单和参数构造器仍是接入准备，不会覆盖后端的拒绝结果。细粒度角色权限尚未证实时，能力保持未知而非允许。

调用要求已安装且启用的兼容插件同时声明 `ui.context-menu` 和 `resource.actions`。UI、共享后端及 Tower 最终鉴权各自保留验证，不能用静态表单代替授权。

后续仍需逐项接通必要子资源读取、更多动作的服务端参数/权限/版本适配和控制台。原生对话框只有在核验公开调用契约后才接入；公开 REST 存在不证明原生对话框服务可调用。

首批建议接通顺序为：电源与控制台 → 基本信息及 CPU/内存 → 磁盘和网卡 → 快照 → 迁移与克隆。其余动作继续按侧栏盘点补齐，不以此顺序缩小用户要求的资源范围。

## 验证要求

本地测试覆盖无侧栏操作、精确 ID、权限与状态拒绝、异步取消、节点复用、参数与任务处理、正式 HTTP 链及卸载清理。主聊天已核验真实 4.9.0 的只读 API／身份权限和关键 DOM，因此候选只列此精确版本以进入独占验收。真实菜单／表单、宿主裁剪与事件边界仍须逐项验证；其他版本缺少对应证据时不得扩大版本声明。

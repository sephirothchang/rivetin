# 磁盘 SMART 共享数据接口

框架提供受控采集结果的持久存储和按调用者授权的数据读取。子插件不直接建立 SSH 连接，读取页面不会启动采集。数据源为 `host-smartctl`，接口版本为 `schemaVersion: 1`。

## 授权与绑定

消费插件必须已经安装、启用、兼容当前 CloudTower，声明 `inventory.read`、`disk.smart.read`、`ssh.channel.use`，并注册结构化 `disk.smart.read` 命令。实际执行还要求 SSH 通道开启、明确配置目标并由管理员二次审核。

管理员使用 `POST /api/rivetin/v1/inventory/disk-bindings` 显式绑定 Tower 物理盘、SSH 连接配置和设备别名：

```json
{"action":"bind","diskId":"example-disk","profileHostId":"example-host","deviceId":"example-device"}
```

绑定时用当前调用者读取精确 Tower 物理盘，核对 SSH 设备的序列号和路径，不按名称猜测。保存或解除绑定撤销现有 SSH 授权。解除绑定使用 `{"action":"unbind","diskId":"example-disk"}`；历史保留，但不再通过未绑定对象读取。GET 同一路径只向管理员返回无凭据摘要。

## 读取

| GET 路径 | 参数 | 返回 |
|---|---|---|
| `/api/rivetin/v1/data/disk-smart/inventory` | `pluginId`、`diskId` | `{schemaVersion:1,disk:{diskId,model}}`，仅型号库存，不要求采集绑定 |
| `/api/rivetin/v1/data/disk-smart/identity` | `pluginId`、`diskId` | `{schemaVersion,identity}` |
| `/api/rivetin/v1/data/disk-smart/latest` | 上述参数及 `generation` | 最新采样或无样本状态 |
| `/api/rivetin/v1/data/disk-smart/history` | 上述参数及可选 `limit`、`cursor` | `{schemaVersion,source,identity,items,nextCursor,snapshotAt}` |

每次读取均用当前调用者的 Tower 认证重新查询精确磁盘 ID，不用后台管理员会话或旧结果代替。权限拒绝、对象消失和磁盘代际变化不返回旧数据，响应禁止缓存。

框架 0.1.2 的 `diskSmart.readInventory({diskId,signal})` 只读取得上述库存型号，不创建绑定、代际密钥、采样或历史，也不建立 SSH 连接。未绑定磁盘仍可在权限允许时读取型号；该入口不会让 `resolveDisk`、真实采集或历史绕过原有绑定要求。消费插件若用该型号展示虚拟盘示例，必须明确标为模拟数据，不计入真实采样或真实批次成功。

公开身份包含 `diskId`、`hostId`、`generation`、`deviceId`、`path` 和 `model`。代际是私有持久密钥计算的 64 位十六进制 HMAC，`deviceId` 等于代际，`path` 固定为空。设备路径、序列号、WWN、SSH 地址和认证材料不进入消费接口。

采样包含版本、来源、身份、`status`、`collectedAt` 和可选 `smart`、`code`、`gapCode`。状态为 `ok`、`stale`、`unavailable` 或 `unsupported`。失败尝试保留准确时间和固定码，不携带健康指标；仅从未采样的 `SMART_NO_SAMPLE` 使用 `collectedAt: null`，不生成历史行。

## 立即采集

`POST /api/rivetin/v1/data/disk-smart/collect` 接受 `{pluginId,diskId,generation,requestId}`，其中 `requestId` 为每次明确点击生成的 UUID。只有管理员、当前绑定及代际有效、原有 SSH 命令和目标已经审核批准时，才接受任务。路径、命令、凭据或其他盘不能由请求传入；框架只执行该盘匹配的唯一已批准 SMART 命令，不展开运行整个每日计划。

响应为 `{schemaVersion:1,operationId,status,code?}`，`status` 为 `running`、`succeeded`、`failed` 或 `unknown`。进行中的任务返回 HTTP 202。随后只读轮询 `GET /api/rivetin/v1/data/disk-smart/collection?pluginId=...&diskId=...&generation=...&operationId=...`，每次重新校验当前调用者和绑定。仅本次正确采样实际保存后返回 `succeeded`，随后重新读取 latest/history；传输完成、不支持的虚拟盘或此前的旧成功记录均不能代替本次成功。

请求标记绑定操作者、来源、插件、磁盘及代际并持久化；重启、中断或结果未知不自动重发，重复 UUID 只回读同一任务。每盘最多一个、全局最多两个任务。请求标记上限 10,000 条、文件最多 8 MiB，达到上限拒绝新任务，不自动删除记录。页面停止等待不代表远端已取消，界面超时只显示结果未知；重新点击前应先确认在途任务状态。

## 全局手动采集（框架 0.1.2）

`POST /api/rivetin/v1/data/disk-smart/collect-all` 只接受 `{pluginId,requestId}`。`requestId` 是一次明确点击生成的 UUID v4；前端不能提交主机、路径、命令或目标列表。框架从已绑定磁盘和该插件当前已批准的唯一 SMART 命令中固定本批次目标，并以最多两个并发、总计 5 秒的预算重新检查调用者对每盘的读取权限。任一权限检查失败或超时，整体拒绝，不返回目标清单、不登记新任务，也不执行命令；通过后完成持久登记并返回，不在请求内等待采集执行。

提供器方法为 `diskSmart.collectAll({requestId,signal})` 与 `diskSmart.collectionAll({operationId,signal})`。后者只读访问 `GET /api/rivetin/v1/data/disk-smart/collection-all?pluginId=...&operationId=...`。两个接口均要求管理员及有效的插件权限；轮询对每盘重新检查调用者的 Tower 读取权限，权限不足时整体拒绝，不返回部分目标清单。

响应如下，`items` 为本批次的完整列表，最多 100 项，不截断：

```json
{
  "schemaVersion": 1,
  "operationId": "8993de42-713b-42e9-ab8d-6803bdc11d50",
  "status": "running",
  "summary": {"total":1,"queued":1,"running":0,"succeeded":0,"failed":0,"unknown":0,"skipped":0},
  "items": [{"diskId":"example-disk","generation":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"queued"}]
}
```

顶层状态为 `running`、`succeeded`、`failed` 或 `unknown`；逐盘状态还包括 `queued` 和 `skipped`，可携带固定 `SMART_`／`SSH_` 错误码。计数与完整列表一致；仅非空批次全部成功才返回 `succeeded`，部分失败或跳过不能报告整体成功。响应不包含 SSH 地址、设备路径、序列号、命令或认证资料。

没有绑定磁盘返回 `SMART_BATCH_NO_TARGETS`（409）；完全没有批准目标返回 `SMART_BATCH_NO_APPROVED_TARGETS`（403）；超过 100 个目标返回 `SMART_BATCH_TARGET_LIMIT`（409），不会默默忽略超出部分。未匹配到批准命令的部分目标以跳过结果展示。批次只使用提交时固定的绑定与批准快照，排队期间重新绑定或更换批准后不得跟随新目标执行。

全局同时最多一个批次，批内串行复用单盘采集与 SSH 通道原有互斥、超时和权限门禁，不修改每日计划。批次从接受开始最多等待 5 分钟，超时后的未执行项标记跳过；连接冲突或失败不自动重试。服务停止、重启或结果不明时记录 `unknown`，不重发已登记命令。重复请求标记只回读原批次，不能作为重试开关。浏览器取消或停止轮询不代表服务端任务已经取消。

批次记录最多 10,000 条、8 MiB，达到上限拒绝新任务，不自动删除历史。逐盘结果仍由既有单盘历史与采样提交规则管理。全局按钮不会绕过人工命令审核，也不代表所有已发现主机均可自动采集。

## 历史与运维

按插件、Tower 磁盘、主机和物理代际隔离历史，同一 UTC 日一条。当日更晚的成功采样更新该日记录，以便手动采集显示最新信息；旧时间、重复操作不会使数据回退。已有成功不会被当日失败覆盖；失败后恢复时保留固定 `gapCode`，不虚构此前失败时刻。劣化比较只用同代际、更早的有效成功样本。

查询窗口 365 天，单页最多 30 条。签名游标绑定对象、代际和数据版本，10 分钟有效；版本变化返回 `SMART_HISTORY_CURSOR_STALE`（409），须重读首页。换盘返回 `SMART_GENERATION_CHANGED`（409），未绑定返回 `SMART_DISK_UNBOUND`（404），权限变化返回 401/403。

容量上限为每逻辑盘 730 条、10,000 个盘、20,000 个代际、总计 2 GiB。读取过滤过期记录，同代际再写入时压缩；不再写入的旧代际不自动全局回收，仍计入容量。达到上限拒绝新写入，由管理员安排受控归档。

采样提交前复核当前绑定和 SSH 授权；撤销后不提交新的成功结果。历史及私有密钥随框架数据一起备份，缺失现有密钥时安全拒绝，不能自动生成新密钥来恢复旧绑定。

本地集成覆盖 HTTP、正式客户端、采集代理和持久历史，但注入库存与 SSH 传输仍为测试替身，不能据此声称读取了真实硬盘。真实部署和主机采集兼容性分别验收。

# 统一 SSH 通道

`rivetin-ssh-channel` 是框架默认附带安装的受控能力插件，生命周期和功能开关均默认关闭。需要框架开启、通道插件启用、采集配置保存为开启，且消费插件独立审核批准，才允许按计划采集。安装、添加主机或审批本身不会立即连接主机。它不是 Web 终端，不接受任意 shell、脚本、参数或可执行文件。

> 当前源码边界（2026-10-28）：Web 连接编辑器已使用 v2 草稿协议，服务端连接存储/API 仍为 v1，两者尚未集成。以下连接草稿及保存行为描述 v1 服务协议与原有验收基线，不能据此声称当前工作树的 Web 读写已通过联调；也不能将源码问题反推为固定历史部署制品的故障。

## 主机与凭据

管理员可在 SSH 功能页使用独立连接草稿，也可通过便携 CLI 的 `channel import-host --host-profile-file <sensitive-file>` 导入连接资料。CLI 使用既有 Tower SSH 身份、HTTPS 信任与管理员校验，不调用客户端外部 SSH。服务端独立凭据库使用 AES-256-GCM，POSIX 环境中密钥与密文文件权限为 `0600`；Windows 本地测试不把 POSIX mode 当作 NTFS ACL 保证。备份含该存储，应作为敏感资料保管；加密不意味着拥有同等服务器文件访问权限的管理员不能解密。

整组连接凭据按主机 > 集群 > 全局选择，不跨层拼接账户、认证类型和秘密。配置较高层但清除其秘密会使其未就绪，不静默回退到较低层。每台主机的地址、端口、host key 指纹及设备映射仍须独立明确登记。全局和集群凭据不会自动发现、添加、信任或连接目标。

`GET/PUT /api/rivetin/v1/ssh-channel/connections` 仅供经认证管理员使用，写入还检查 Origin。连接编辑不经过普通 `/config`，不写入 localStorage。GET 只返回账户、认证类型、有效来源及 `hasPassword` / `hasPrivateKey` 等摘要，不返回已保存秘密；新输入只在草稿内存和受认证的 PUT 中出现。密码与私钥的每个操作为 `{action:"keep"}`、`{action:"clear"}` 或 `{action:"replace",value:"<EXAMPLE_SECRET>"}`，仅 replace 可带 value，且必须提供非空新值。空表单默认 keep。保存成功、丢弃和释放 store 后清除草稿引用；保存失败保留草稿。所有保存和退出遵循插件中心的明确保存、取消、丢弃并退出、保存并退出流程。

PUT 使用 `{version:1,operationId,global,clusters,hosts}` 整份草稿，按服务端最后成功保存生效。`global` 是凭据组或 null；`clusters` 的每项为 `{clusterId,connection}`；`hosts` 为目标资料加 `connection`（null 表示继承）。每组含 username、authType（password/private-key）及 password/privateKey 操作。主机目标必须有 hostId、clusterId、address、port、hostKeySha256、devices。最多 500 个主机及 500 个集群例外，请求和解密后文档均限 1 MiB。operationId 为每次草稿保存生成的 UUID，用于丢失响应后的 GET 回读确认；不自动重复 PUT，相同 operationId 和不同内容会拒绝。连接设置保存前撤销全部 SSH 审批并取消在途任务，再以一个独立加密文档原子保存。首次 Web 保存把当前 CLI 主机保留为主机例外，旧密文原件保留但不作为新文档损坏时的自动回退；后续 CLI 写入同一权威文档。

敏感文件需由管理员在受控位置准备，不提交到仓库。字段为 `hostId`、`clusterId`（管理员管理的稳定映射别名）、IP `address`、`port`、`username`、`hostKeySha256`（经独立可信渠道核验的 SSH 公钥 SHA-256，64 位小写十六进制），以及 `password` 或内存 `privateKey` 二选一。`devices` 保存 `deviceId`、严格设备路径、可信序列号。不会自动信任首次连接、读取客户端密钥或扫描主机。

配置／删除命令：

```text
rivetin channel status [existing Tower connection options]
rivetin channel import-host --host-profile-file <sensitive-file> [existing Tower connection options]
rivetin channel remove-host --host-id <configured-alias> [existing Tower connection options]
```

主机映射变化先撤销所有 SSH 审核与权限，成功导入不意味着授权执行。页面通过管理员只读 `GET /api/rivetin/v1/ssh-channel/inventory` 展示 CloudTower 集群和主机名称供选择，不自动导入全部资源。改选不同主机只填入当前集群和管理地址，清空旧 host key 指纹及设备映射。既有别名保留，不因清单失败而丢弃草稿；名称或设备路径不能替代可信物理身份。

## 指纹与连接预检

框架 0.1.1 提供管理员专用 `POST /api/rivetin/v1/ssh-channel/preflight`，要求有效身份、允许的 Origin、框架开启及 SSH 通道插件启用。认证预检不依赖采集功能开关，也不授予命令执行权限。

- `action: "discover"` 携带 `hostId/address/port`，仅获取候选公钥后断开，不发送账户或凭据。目标必须是当前管理员可读取的 Tower 主机及其当前管理 IP。
- `action: "confirm"` 携带同一目标、返回的 `challenge` 和 `acknowledged: true`。管理员须先通过主机控制台等独立可信渠道核对指纹，再确认；服务端返回待保存的 SHA-256 草稿，不自动写入凭据库。挑战绑定操作者和目标，两分钟有效、一次使用。
- `action: "verify"` 仅携带 `hostId`，使用已保存的凭据与可信指纹进行认证，成功后立即断开，不打开命令会话、终端或转发。未保存的连接草稿不能用于验证。

每次预检总预算五秒，全局最多两个、同一操作者最多一个。连接保存、通道生命周期变化及紧急禁用使挑战失效并取消在途预检。候选指纹不构成信任，连接成功也不代表 sudo、SMART 命令或磁盘身份已验证。

连接预检、命令执行和设备健康分别展示。认证预检成功只证明当次认证；执行记录为 `failed` 且错误码为 `SSH_REMOTE_COMMAND_FAILED` 时，表示认证已完成、远程命令非零退出。其他连接失败或超时不能推断认证成功，命令完成也不等于设备健康。SMART 读取失败保持数据不可用、健康未知；虚拟设备未提供或未透传 SMART 信息仅是可能原因，不能据此判定磁盘损坏或确诊不支持。

## 注册、审计与授权

消费插件在自己的描述文件中声明 `permissions: ["ssh.channel.use"]` 与类型化 `ssh` 元数据。注册只能选择框架审查过的目录，不能上传服务器脚本。初始只读目录：

| 操作 | 服务端固定命令 | 约束 |
|---|---|---|
| `host.identity` | `/usr/bin/uname -srm` | 仅查询主机内核和架构 |
| `disk.smart.read` | `sudo -n -- /usr/sbin/smartctl --json=c --all <disk>` | 参数来自目标主机的可信设备映射或已验证当前库存；必须有序列号，响应身份不符则采集失败，不启动自检或修改 SMART 设置 |

注册页按插件 ID 分组，再按主机／磁盘命令类别展示。`<disk>` 是参数范式，不能直接执行；具体计划由框架按照该主机的已授权磁盘策略逐盘编译。注册页将范式、参数来源要求与当前解析来源、预期／已解析计划数量、排除的主机和具体命令分别显示；审核对话框展开全部具体计划，原有二次确认继续生效。不同主机上的相同 `/dev/sdb` 路径是不同目标，不能只按路径合并；不会将整个注册固定为某一个设备路径。

这些展示字段由框架可信 operation catalog 派生，插件 manifest 的严格八字段注册格式不变，不接受插件提供 shell 范式、正则、glob 或新增可执行参数。`category`、`template`、`argumentSource`、`expansion`、`expectedCount`、`resolvedCount`、`resolutionSource` 和 `excludedHosts` 是只读诊断信息；批准仍绑定完整声明、目标、凭据库和撤销版本。展示字段不会替代 `targets`／`preview` 或扩大执行资格。

`argumentSource: fresh-host-inventory` 表示磁盘范式的参数来源要求；当前来源另由 `resolutionSource` 标明。v2 从同一目标主机的当前可信库存和 all/custom 策略解析；legacy v1 仍使用既有设备映射，不将其标成已核验的当前库存，也不为展示自动迁移。每台主机的明确 v2 `custom: []` 只排除该主机的磁盘目标，不阻断其他主机的合法目标；该状态只能由服务端已验证的 v2 解析器派生，客户端不能在连接资料中伪造。未知库存、未配置设备、失效身份、非法路径以及 all 模式下的无可用盘仍失败关闭；所有主机均明确排除时也没有可供批准的执行计划。

管理员在 SSH 通道页审计完整命令、目的、目标、周期和风险。审核返回两分钟、一次性且绑定操作者的挑战；勾选并二次确认后才持久授权。摘要绑定安装包、完整声明、解析目标、凭据库及撤销版本。更新、回滚、配置变化、禁用、重置、卸载、主机映射变化与紧急禁用会使旧审核和批准失效，恢复开关不自动恢复授权。

消费插件可声明以下类型化范围，避免把真实环境标识写入发布包：

```json
{
  "permissions": ["ssh.channel.use"],
  "ssh": {
    "version": 1,
    "commands": [{
      "id": "daily-smart",
      "operation": "disk.smart.read",
      "purpose": {"zh-CN": "每日采集已配置磁盘的 SMART 数据", "en-US": "Collect SMART for configured disks daily"},
      "hostScope": "configured",
      "deviceScope": "configured",
      "intervalSeconds": 86400
    }]
  }
}
```

`configured` 仅展开管理员已配置的可信主机及设备，不发现 Tower 资源、不接受任意地址或设备路径。也可用 `hostIds`、`deviceIds` 指定管理员映射别名，各自与 Scope 字段互斥。审核显示完整展开清单；新增、删除或修改映射必须重新审核。每命令最多 100 个目标，未配置或超限时拒绝授权，不影响其他有效注册。

删除、格式化、重启、网络修改、任意脚本和 SMART 自检／设置等操作拒绝注册。页面中的高风险示例仅作风险说明，不可执行。禁止策略是允许目录加类型校验，不是关键词黑名单。

## 调度、取消与数据

`intervalSeconds: 0` 不调度；非零仅接受 300～604800 秒，86400 表示每天一次。既有 v1 计划由服务端持久保存，审批后从未来时刻开始，重启不补跑积压任务。这不代表 v2 设备策略、合法后台 Tower 库存身份及每日采集全链路已经完成；其集成与真实验收仍待完成。当前单副本进程最多两个批次、两个连接，每主机一个；每连接 30 秒、stdout/stderr 合计最多 1 MiB，批次总预算五分钟。失败不自动重试。

执行超时和权限撤销使用不同取消状态。只有由 broker 超时标记产生、无 stdout 的失败记录，可在授权仍有效时通过结果钩子写无指标失败；守卫仍复核框架/插件开关、当前 digest、approval ID、撤销 epoch 和 stop 状态。超时后若又撤销、禁用或停止，同样拒绝历史提交。成功记录从不忽略执行取消。历史 sink 必须在独立锁的最终提交前检查 signal 并 await assertActive，不能调用需要 broker 锁的方法。

紧急禁用不依赖业务生命周期锁或 SSH 配置可读性，离线 CLI 与 API 都更新持久撤销状态。调度每秒检查状态并取消在途连接；关闭本地连接不能证明远端进程已终止，因此本阶段仅允许已审查的短只读命令，不执行长任务或变更命令。

结果按消费插件隔离保留最多 30 条并限制总字节，管理日志只记元数据和固定错误码，不记输出、stderr 或凭据。SMART 的采集成功只代表读取完成，不代表磁盘健康；健康位掩码交由解析器判断。

框架 0.1.1 已完成受控真实验证：候选指纹与独立核验值一致，保留已有全局凭据后认证成功，一次 `host.identity` 命令执行成功。SMART 单盘页面请求执行一次后失败；另获批准追加同命令一次作诊断，确认 smartctl 7.1 返回有效设备信息 JSON 及退出码 4，未取得健康或属性数据，两次均无自动重试。结果保持采集失败、健康未知，设备模拟层支持不足仍只是推断。对应 86400 秒计划及到期时间保留，未加速时钟或额外执行每日任务。有效 SMART 样本及真实磁盘指标仍需后续验证，不能将失败记录或模拟数据称为有效采样。跨多个 Pod 的分布式调度、第三方插件沙箱与发布者签名不在本版本能力内。


<a id="connections-v2"></a>

## Connections v2 (introduced in 0.2.1; current framework 0.2.2)

Framework 0.2.2 completed a controlled upgrade and read-only UI acceptance with existing persisted v1 connections unchanged. The public v2 projection does not mean the stored data was migrated. Explicit v2 migration, fresh real-host authorization and actual v2 command execution remain pending real-environment testing.

This source implements a real shared HTTP/service/vault path. Local tests inject Tower and SSH transports; they do not establish live platform acceptance. The API prefix remains `/api/rivetin/v1`; the connection document version is 2.

- `GET /ssh-channel/connections` returns version 2, revision, operationId, credential-presence summaries, hosts with `devicePolicy`, and migration state. Reading an existing v1 vault returns a read-only projection (`migration.required=true`); it does not write, migrate, connect, or widen old `devices` (including empty lists).
- `PUT /ssh-channel/connections` accepts exactly version, operationId (UUID v4), expectedRevision, global, clusters, hosts and selectionProofs. Credentials retain keep/replace/clear semantics. Responses contain version, operationId, committedRevision, replayed and connections. CAS conflicts do not revoke approval or change configuration. Durable actor-bound operation records are checked before CAS; replay returns the original committedRevision and the current summary without another write. Records are bounded to 10,000 and never evicted to permit replay.
- `GET /ssh-channel/policy-capabilities` reports actual connected adapters. GPU/USB/PCIe inventory and execution remain unsupported. Scheduled execution is disabled with `SSH_BACKGROUND_INVENTORY_AUTH_UNAVAILABLE`: no administrator token is stored or reused as a background identity. Manual execution requires the current verified ROOT caller.
- `GET /ssh-channel/device-inventory?hostId=<CANONICAL_HOST_ID>&category=disk` obtains a complete bounded host disk set under that caller. It uses a 1,001-row sentinel (maximum 1,000), rejects duplicates/ambiguous identity and returns no partial authoritative set. Model-only disks without serial/path are unselectable. Selection proofs last 60 seconds, bind actor, host, endpoint, credentials, connection revision and complete inventory identity, and are revalidated against fresh inventory when saved. They are not persisted in configuration or logs.

`devicePolicy` has version 1 and disk/gpu/usb/pcie classes, each `{mode: "all"|"custom", ids: []}`. All requires an empty ID list; custom stores canonical Tower IDs, with an empty list allowing no devices. All is a candidate range: approval binds the resolved complete set, identities, paths, endpoint and pin. Replacement, removal, addition or changed paths invalidate execution. A custom identity never silently follows a replacement. Execution has a 100-target limit. Fresh reads are uncached; unavailable or incomplete inventory fails closed.

The v2 vault uses a separate `connections.v2.json`, AES-256-GCM and AAD `rivetin-ssh-connections-v2`; it keeps the existing key. The v1 path becomes a version-2 tombstone so old writers fail instead of falling back to legacy host files. A durable mutation barrier precedes revocation; encrypted configuration and HMAC operation receipts are committed before the barrier clears. Any uncertain stage blocks execution. An explicit offline recovery can confirm a committed write or abort a demonstrably uncommitted operation without replaying it. This is not a database transaction or a guarantee against every storage failure.

Migration and rollback are explicit offline data-CLI operations described in [CLI instructions](../cli/README.md#offline-connection-format-maintenance). Legacy references are retained encrypted and unresolved until an explicit scope change/reselection establishes canonical identity; merely saving unrelated credentials does not erase them. A nonempty unresolved scope remains non-executable. Rollback restores original ciphertext bytes only before any successful v2 edit; otherwise it returns `SSH_CONNECTION_DOWNGRADE_UNREPRESENTABLE` and preserves current data. Approvals/schedules are never restored from old backups.

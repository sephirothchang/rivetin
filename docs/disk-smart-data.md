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
| `/api/rivetin/v1/data/disk-smart/identity` | `pluginId`、`diskId` | `{schemaVersion,identity}` |
| `/api/rivetin/v1/data/disk-smart/latest` | 上述参数及 `generation` | 最新采样或无样本状态 |
| `/api/rivetin/v1/data/disk-smart/history` | 上述参数及可选 `limit`、`cursor` | `{schemaVersion,source,identity,items,nextCursor,snapshotAt}` |

每次读取均用当前调用者的 Tower 认证重新查询精确磁盘 ID，不用后台管理员会话或旧结果代替。权限拒绝、对象消失和磁盘代际变化不返回旧数据，响应禁止缓存。

公开身份包含 `diskId`、`hostId`、`generation`、`deviceId`、`path` 和 `model`。代际是私有持久密钥计算的 64 位十六进制 HMAC，`deviceId` 等于代际，`path` 固定为空。设备路径、序列号、WWN、SSH 地址和认证材料不进入消费接口。

采样包含版本、来源、身份、`status`、`collectedAt` 和可选 `smart`、`code`、`gapCode`。状态为 `ok`、`stale`、`unavailable` 或 `unsupported`。失败尝试保留准确时间和固定码，不携带健康指标；仅从未采样的 `SMART_NO_SAMPLE` 使用 `collectedAt: null`，不生成历史行。

## 历史与运维

按插件、Tower 磁盘、主机和物理代际隔离历史，同一 UTC 日一条。已有成功不会被当日失败覆盖；失败后恢复时保留固定 `gapCode`，不虚构此前失败时刻。劣化比较只用同代际、更早的有效成功样本。

查询窗口 365 天，单页最多 30 条。签名游标绑定对象、代际和数据版本，10 分钟有效；版本变化返回 `SMART_HISTORY_CURSOR_STALE`（409），须重读首页。换盘返回 `SMART_GENERATION_CHANGED`（409），未绑定返回 `SMART_DISK_UNBOUND`（404），权限变化返回 401/403。

容量上限为每逻辑盘 730 条、10,000 个盘、20,000 个代际、总计 2 GiB。读取过滤过期记录，同代际再写入时压缩；不再写入的旧代际不自动全局回收，仍计入容量。达到上限拒绝新写入，由管理员安排受控归档。

采样提交前复核当前绑定和 SSH 授权；撤销后不提交新的成功结果。历史及私有密钥随框架数据一起备份，缺失现有密钥时安全拒绝，不能自动生成新密钥来恢复旧绑定。

本地集成覆盖 HTTP、正式客户端、采集代理和持久历史，但注入库存与 SSH 传输仍为测试替身，不能据此声称读取了真实硬盘。真实部署和主机采集兼容性分别验收。

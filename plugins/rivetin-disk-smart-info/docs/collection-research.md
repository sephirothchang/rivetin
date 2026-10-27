# Pod 获取主机 SMART 的采集路径研究

核验日期：2026-10-28。本文是只读资料研究和后端接入建议，未部署采集器、未登录主机、未验证实际 Pod 出站网络或内部 Fisheye 接口。

## 结论

CloudTower 不是完全没有硬盘健康数据：公开 API 有健康／故障摘要与剩余寿命，官方指标库还列出 SMART 检测状态、剩余寿命和温度。但这些不能代替完整 SMART 属性表。当前没有证据证明公开 CloudTower API 可命令节点返回完整 SMART JSON，也没有已验证的 Fisheye SMART 读取接口。

建议顺序：先复用已有公开摘要／指标并核验采样时间；同时只读调查当前集群是否有受支持的内部 SMART 读取服务；若没有，则评估由框架后端通过受限 SSH 读取节点上现有 smartctl 的 JSON。后端需独立提供每日持久调度与历史存储，前端包不能承担。

## 已核验的公开证据

### CloudTower 4.9.0 OpenAPI

从官方 [SDK 对应表](https://code-site.smartx.com/en/sdks/support_release/) 定位 [4.9.0 OpenAPI JSON](https://code-site.smartx.com/en/specs/4.9.0-swagger.json)，实际下载并解析：

- `info.version`: `4.9.0`，577 个路径、1906 个 schema。
- 文档字节数 5,560,650，SHA-256 `8f7e6015b4b9fd39e7ac9b037b711df4165d92a7aa210189019366b9fbf11d89`。
- `POST /v2/api/get-disks` 的 `Disk` 模型包含 `id`、`host`、`local_id`、`path`、`serial`、`model`、`healthy`、`health_status`、`remaining_life_percent` 和 `failure_information`；没有完整 ATA 属性表或 NVMe 健康日志。
- `NestedDiskFailureInformation.smart_check` 是可空布尔值；它不是原始属性集合。
- `POST /v2/api/get-disk-metrics` 与 `/get-scvm-disk-metrics` 接收 `range`、`disks`、字符串数组 `metrics`；该 schema 没有承诺支持任意 SMART 属性名。响应是异步任务包装的指标，不能把提交成功当作采样完成。
- 对路径及 schema 检索 SMART／Fisheye／SSH／command，未找到完整 SMART 采集或通用主机命令公开入口。这个结论只覆盖所查公开规范，不能证明私有 GraphQL／RPC／Fisheye 服务不存在。

官方 [Python SDK 2.23.0](https://github.com/smartxworks/cloudtower-python-sdk/releases/tag/v2.23.0) 对应 Tower 4.9.0，tag 解析到提交 `729876d924c8aeae38243ff237a229964f83d736`。本地 cloudtower-api 技能对应 4.8.0；本次另核对 4.9 规范，避免仅据旧资料下结论。下载的原始规范只保留在本插件忽略的 `qa/`，不纳入制品。

### 已有监控指标

本地技能及在线 [SmartX 官方指标库](https://github.com/smartxworks/cloudtower-skills/blob/master/skills/metrics-lookup/references/metrics_host.md) 提供以下定义：

| 指标 | 定义 | 文档适用版本 |
|---|---|---|
| `host_disk_remaining_life_percent` | 磁盘剩余寿命百分比 | 未标注 |
| `host_disk_smart_test_failed` | 磁盘 SMART 检测是否正常 | 未标注 |
| `host_disk_temperature_celsius` | 磁盘摄氏温度 | 未标注 |
| `host_hardware_raid_pd_lifespan` | 硬件 RAID 物理盘剩余寿命百分比 | 未标注 |
| `host_hardware_raid_pd_smart_error` | 硬件 RAID 物理盘 SMART 自测结果异常 | 未标注 |

这证明有可调查的既有采集通道，不证明目标版本实际暴露这些时序、具体布尔值语义或任意 SMART raw 属性。现场需核对集群绑定的监控服务、指标存在性、标签与盘身份、时间戳和保留周期。即使已有时序，也不能将某天最后一个旧值伪装为当天新采样。RAID 的物理盘编号与 Tower 逻辑磁盘映射需另验证。

### 节点已有健康检查

SmartX 的 [硬盘健康检测与运维文章](https://www.smartx.com/blog/2023/06/hci-disk-health/) 说明节点使用 SMART 和 disk-health 机制，并给出 `zbs-node show_disk_status` 的故障诊断示例。该资料支持“节点侧已有相关检查”的判断，不能外推为存在完整 SMART 网络 API。文章发布于 2023 年，其检查频率不能当作当前版本保证。

官方 [Fisheye 说明](https://www.smartx.com/blog/2022/02/use-faqs/) 将其定位为集群应急管理平台。尚未找到可确认版本、鉴权和返回模型的公开 SMART Fisheye API；没有猜测或探测内部 URL。现阶段不以模拟浏览器点击 Fisheye 页面作为每日后台采集方案。

## 方案比较

| 路径 | 可获得的内容 | 关键依赖 | 判断 |
|---|---|---|---|
| Tower 公开库存 API | 盘身份、健康／故障摘要、剩余寿命 | 真实对象权限、字段完整性与更新时间 | 可作为身份和摘要来源，不能满足完整属性需求 |
| 既有监控 API／指标库 | 文档列出的寿命／SMART 状态／温度及可能已有时序 | 当前集群实际支持、准确标签映射、查询授权 | 优先验证与复用；不能假定有完整 raw 属性 |
| Fisheye／节点既有内部服务 | 未知；可能与节点原有采集有关 | 可识别的受支持接口、版本、鉴权、缓存时间 | 待只读核验，暂不固化 endpoint |
| Pod 后端 → 受限 SSH → 目标节点 smartctl | 目标设备支持时可读取完整 JSON | 网络、主机身份与凭据、现有工具、最小权限、透传 | 可评估的备用路径，尚未实测 |
| 在 Tower Pod 中直接运行 smartctl | 通常只涉及 Pod 所在节点可访问的设备 | 目标设备必须位于该节点且明确暴露 | 不应认为能读取远程集群物理盘 |
| 各主机新增 agent／DaemonSet | 可形成专门采集通道 | 新部署及主机权限、维护成本、兼容性 | 超出当前范围，不是默认选择 |

Pod 对设备的直接访问具有节点局部性；给 Tower Pod 增加 `/dev` hostPath 不会使其获得远端节点设备。参见 [Kubernetes hostPath](https://kubernetes.io/docs/concepts/storage/volumes/#hostpath)。研究时核对的 `framework/deploy/pluginkit.yaml`（改名前历史路径）中，插件服务普通用户运行、禁提权、去除 capabilities、未挂载集群主机设备。网络客户端方案无需为此提升为特权 Pod。

## SSH 备用方案的可实现边界

下述均为设计，未配置 SSH、密钥、sudoers 或真实后台任务：

1. 框架服务从受信任库存将 `diskId` 解析到 `hostId`、实际存储节点及设备身份；目标是设备所在节点，不能混淆 ELF 主机、VMware ESXi 与 SCVM。
2. 后端连接已登记的主机管理端点。SSH 凭据在受控服务端秘密中管理，不写入插件功能配置、浏览器、日志或包。不能默认复用 Tower 数据库中的管理凭据。
3. 固定服务器主机密钥，维护受控 known_hosts；不禁用主机校验。选用已有批准的有限账户，必要时设计仅允许固定采集程序的 forced command／sudo 限制，不开放任意 shell 或前端命令参数。配置变更须另获准确授权。依据：[OpenSSH authorized_keys](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT)、[主机密钥校验](https://man.openbsd.org/ssh_config#StrictHostKeyChecking)。
4. 先确认节点现有 smartctl 版本与 JSON 能力。候选只读读取使用 `-a` 与 `-j=v`；设备由服务端白名单确定，驱动类型按实际控制器确认。是否加待机跳过策略须验证版本和透传行为，避免无意唤醒设备。不会启动自检、启用 SMART、修改盘配置或执行磁盘读写测试。依据：[smartctl 手册](https://github.com/smartmontools/smartmontools/blob/main/src/smartctl.8.in)。
5. 远端命令读取前后核验物理盘身份，与库存关联。设备路径可变化；序列号／WWN 仅留在受控服务端，用不透明设备代号划分历史。虚拟磁盘若未透传真实 SMART，应返回 unsupported，不能将模拟控制器信息当作底层盘健康。
6. 每节点有限并发和队列，整体超时、输出大小限制、退出位解析；认证失败不循环重试。采样完成后脱敏并原子写入历史，按物理身份和采样日去重。
7. 服务端调度检查框架启用及插件安装／启用状态；停用后停止新任务、取消可取消任务。历史与配置分离，默认保留，不随重置／卸载删除。

`smartctl` 可读不等于 SSH 采集已可用。还需验证 Pod 是否包含批准的 SSH 客户端／运行库、Pod 到节点出站网络、目标节点账户与设备权限、控制器透传及 JSON 字段。上述前提目前均未实机验证。

## 建议的下一次只读验证窗口

由主协调方统一安排，先完成这些判定再选择后端实现：

1. 核对目标 Tower／集群／宿主机类型和版本，读取一块盘的最小库存字段，确认盘对象与实际存储节点关系。
2. 查询现有 SMART 相关指标的可用性、标签、时间戳及历史；优先复用已存在的指标通道。
3. 从现有服务说明、已安装代码或原生页面实际请求中只读查找 SMART 读取路径；只核验已经识别的接口，不盲猜内部命令接口。
4. 若没有可复用服务，再验证一台目标节点现有工具版本、固定只读读取所需权限，以及实际 Pod 的网络可达性。该步骤由主协调方明确分配后执行，不在资料研究阶段自行开始。
5. 保存脱敏后的 ATA／NVMe／SCSI 样本及设备映射证据，验证前端提供器、过期状态和换盘隔离，再实现持久调度。

验收应分别记录“主机读取成功”“从 Pod 读取成功”“每日重启后仍能调度”“历史授权查询成功”，不能由其中任意一项替代全部结论。

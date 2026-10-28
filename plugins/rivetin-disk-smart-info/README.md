# 磁盘健康展示 / Disk SMART information

`rivetin-disk-smart-info` 0.1.6 固定候选：物理盘详情的 Smart 信息子页、本地化指标、历史快照对比和黄／红／深红风险展示。采用 Rivetin API 1 的前端包和统一配置生命周期。独立社区项目，非 SmartX 官方产品，按 [MIT](LICENSE) 提供。

## 0.1.6 命令范式与全部授权盘

配置页和用途声明明确显示 `sudo -n -- /usr/sbin/smartctl --json=c --all <disk>` 范式、磁盘类别、目标主机库存参数来源要求及逐盘展开语义。某个 `/dev/sdb` 只是一条展开后的计划；注册声明不锁定这一块盘。v2 新主机默认 all 覆盖该主机全部授权盘，custom 仅明确选择的盘，空集不扩成 all。旧 v1 仍是原配置可信映射，不能冒称新鲜全库存解析，也不自动迁移或扩权。

全局按钮仍只提交一次服务端批次；路径由框架逐主机核验库存、物理身份、policy 和人工审批后白名单编译。模板/正则/通配符不是可执行输入，未新增命令、权限或后台身份。声明范式、当前 N 条计划及批准范围由共享框架分别展示；本插件不修改 registry 或自行建立 SSH。详细合同、回归边界与当前共享限制见[命令声明与逐盘计划](docs/command-declaration.md)。

0.1.3／0.1.4／0.1.5 固定包原样保留；0.1.6 修改展示与用途说明，前端字节已变化，执行声明中除 purpose 外的字段不变。真实主机样本与每日采集标为待真实环境测试，纯缺条件不禁止发布，也不等于已通过实机测试。

0.1.6 与框架 0.2.2 已完成真实环境的停用态只读 UI 核对：安装版本与兼容声明、磁盘类命令范式、实际 legacy 来源与单条解析计划、批准 0 和不可授权状态均按实际展示。此结果没有核验全部主机磁盘，也没有执行采集。插件停用时设置页只显示“已禁用”，设置正文、启用态侧栏及真实健康仍待验证；历史远程命令失败保持健康未知。该 UI 结论与健康采集待测分别记录。

## 0.1.5 读取错误恢复提示

本版保留后端已有的四个固定读取错误：可信绑定变化、盘读取权限撤销、CloudTower 会话失效及插件停用。读取这些错误时，旧指标与历史展示清空，立即采集禁用，并显示对应中英文恢复提示。登录状态指 CloudTower 当前会话；主机 SSH 认证仍以通道独立检查为准，SMART 读取失败不表示坏盘或认证失败。任意服务端错误文本不会展示。

八个 provider 方法、公开 generation/deviceId/path、历史隔离、配置和采集请求格式不变。all/custom 由框架负责解析；本候选不增加 v2 后端、自动绑定、审批或每日执行能力，也不代表已经与新后端完成真实联调。后台缺少合法库存身份时保持拒绝执行。既有 0.1.3/0.1.4 固定包保留，本版前端字节已变化，许可证不变。

`verify:package` 同时核对固定 0.1.3/0.1.4/0.1.5 摘要，确认历史字节关系、当前用途之外的执行声明不变，并运行新包工厂的模板/错误展示及清理检查。输出为 `qa/rivetin-verify-package-0.1.6.json`。打包拒绝覆盖已有同版文件；重复构建不能覆盖已固定候选。

## 0.1.4 兼容声明与限制

历史 0.1.4 仅更新兼容元数据。该固定包内前端和许可证与固定 0.1.3 包逐字节相同，不新增采集、设备策略或后台身份能力，配置及历史格式也不变。详细变化见 [变更记录](CHANGELOG.md)。旧包不能原地补写新声明；框架 0.2 的强门禁仍拒绝旧 schema 的执行资格，需由协调方审查新的独立版本包。

`verify:package` 需要本地保留固定的 `release/rivetin-disk-smart-info-0.1.3.rivetin.json` 作为字节基线，摘要为 `b54df579f28d619890dd76ef12cd4e5605517b2d7a595763ec204802d29bf240`。没有该归档时校验明确失败；不能重新打包一个旧版本替代基线，也不会自动下载其他文件。

`smtx: "none"` 表示不把 SMTX 产品版本作为插件的全局准入条件，不表示所有 SMTX 产品或磁盘均已通过真实采集验证。当前代码消费框架通用 SMART 提供器，不使用特定 SMTX_OS 6.3.0 接口；具体主机的 smartctl、sudo、设备透传、身份和人工审核仍由统一通道逐项检查。设计依据见 [框架兼容性规范](../../docs/rivetin-compatibility.md)。

provider 消费接口保持不变。框架 0.2.1 本地冻结候选已实现 device-policy v2 后端，本插件通过实际共享 HTTP/service/provider 的本地测试核对 all 自动关联、custom 空集、换盘历史隔离及审批失效；Tower 库存与 SSH 输出仍为注入替身。此前 0.1.4 交付时的 v2 未接通状态保留在历史证据中。当前服务仍只支持手动执行，不恢复每日计划；缺少合法后台库存身份时继续拒绝后台执行。这些测试不代表真实 SMART 采集成功或新组合实机验收。

## Rivetin 命名与配置

插件目录、包名、ID、注册入口和制品前缀统一为 `rivetin-disk-smart-info`；描述文件为 `rivetin.json`，包格式为 `rivetin-package-v1`，前端格式为 `rivetin-global-v1`，工厂注册为 `window.RivetinPlugins['rivetin-disk-smart-info']`。当前版本为 0.1.6，compatibility 使用 schema 2、frameworkApi 1，要求框架版本 `>=0.2.0` 且 `<0.3.0`，`compatibility.towerBuilds` 仅包含 `4.9.0`，按主协调确认的准确目标进入受控验收。依据是公开 4.9 API 字段核对、真实集群／主机侧栏 DOM 的只读匹配复核，以及既有本地适配回归。此声明仅限定验收构建，非生产保证；先前版本的 SSH 认证和只读命令已由主协调实测，但未取得有效 SMART 健康属性；本候选的真实全局批次、虚拟示例及跨日调度仍未验收，SSH 默认关闭且没有自动授权。真实挂载与生命周期验收由主协调安排。旧 0.1.0／0.1.1／0.1.2／0.1.3／0.1.4／0.1.5 包原样保留。

插件使用 `/api/rivetin/v1/config` 与新 ID 接入共享配置客户端，只使用 Rivetin ID、配置路径和包格式。旧品牌的 ID、包格式和前端格式不再接收；不读取或映射旧配置，不做旧 API 回退，也不实施配置迁移。插件不复制配置、不双写，配置路径由共享存储接口确定。当前约定为 Rivetin-only，与改名初期的兼容草案不同。

旧 `pluginkit-disk-smart-info-0.1.0.pluginkit.json`、旧 QA 截图和运行资料随目录迁移原样保留在被忽略的本地目录，只用于追溯，不夹带进新包。`LICENSE` 中原有 `PluginKit contributors` 版权声明依法保留，不以品牌替换覆盖既有版权。设置 schema 保持版本 1；当前按已确认的统一 SSH 采集／数据提供器 v1 契约实现本地消费与每日声明。共享后端和真实环境验收另行记录，不将声明或模拟视为采集成功。

## 当前交付与边界

| 能力 | 状态 |
|---|---|
| 集群／主机物理盘侧栏、中文／英文、风险颜色与文字依据 | 本地 DOM fixture 与模拟提供器实现 |
| ATA、NVMe、SCSI 选定 SMART 字段解析、大整数精度、上次采样差值 | 本地实现与自动化测试 |
| 安装默认禁用、启停、升级／回滚、重置、卸载保留配置 | 复用框架，本地生命周期测试 |
| CloudTower 真实版本与侧栏结构适配 | 按 4.9 集群／主机只读观察补充严格 DOM 结构；先前候选已由主协调核验真实挂载与停止恢复；0.1.6 与框架 0.2.2 的停用态插件中心和注册说明只读 UI 已验，启用态侧栏及采集仍待真实环境测试 |
| 从主机获取真实 SMART | 统一提供器、HTTP 和服务的本地回环消费已验证，实际命令未取得有效健康属性，真实数据兼容性尚未验收 |
| 每日一次持久采集、历史存储和对象权限 | 声明 daily-smart / 86400 秒；框架负责执行、存储和授权，本地已验证显式采集后的历史消费 |

不能将演示、包校验或本地生命周期测试当作真实 CloudTower 验收。库存中的健康字段不等于完整 SMART。虚拟盘、RAID 未透传或不支持 SMART 时显示“不支持／未知”，不能显示健康。浏览器关闭后，本插件不会执行采集。

## 开发与本地演示

使用 Node.js 22；构建与 DOM 测试复用框架已锁定的 webpack、React 和 jsdom，不加全局依赖或提升依赖。先按仓库说明安装框架依赖，再在本目录执行：

```powershell
npm test
npm run build
npm run package
npm run verify:package
npm run demo
```

演示仅监听本地开发回环地址 `http://127.0.0.1:43181`，数据全部人工构造，配置保存在进程内存。提供 NVMe／ATA／不支持设备，集群／主机范围、中英文、数据过期／读取失败／最新采集失败但有历史、65 日分页和历史选择、草稿保存／丢弃与插件启停场景。停止演示后配置不保留；这不是生产配置服务。

产物：`release/rivetin-disk-smart-info-0.1.6.rivetin.json`。包只包含 `web/plugin.js` 和 `LICENSE`，不含演示、测试、调查资料或后端可执行入口。React 由 Rivetin factory 参数提供。

真实安装由协调方通过插件中心上传／安装／明确启用，卸载通过框架管理操作执行，配置默认保留。升级遵循相同配置 schema，新增迁移需框架支持。当前 `enabled` 设置仅控制子页显示，使用框架保存、丢弃与退出确认；它不是后台采样开关。后台任务必须依据框架全局开关及插件安装／启用状态停启。

## 数据提供器 v1（已确认，真实环境未验收）

factory 接收框架注入的 `options.diskSmartInfo = { provider, findDetail? }`。本插件不建立 SSH、不自行 fetch 数据 API，不接收地址、凭据、序列号、WWN 或命令。HTTP 封装、每次请求的 Tower 盘读取授权、可信库存到 SSH 设备的绑定、持久历史与采集调度由主框架实现。所有读取支持 AbortSignal，每次页面读取或翻页有 8 秒截止时间。

`provider.resolveDisk({diskId,signal})` 返回 `{diskId,hostId,deviceId,generation,path:'',model}`。diskId 是 Tower 盘 ID，hostId 是核验后的 Tower 主机 ID；二者均为 1–128 字符的字母、数字、短横线或下划线。generation 为服务端生成的 64 位小写十六进制不透明代号，deviceId 与 generation 相等；更换物理盘会改变 generation。path 必须为空，真实路径不传给本插件。侧栏 DOM 自身仍核对所选库存行和标题，数据关联依据可信盘身份，不用路径猜测身份。映射未配置返回 SMART_DISK_UNBOUND。

`provider.readLatest({identity,signal})` 返回快照；`provider.readHistory({identity,limit:30,cursor:null,signal})` 返回 `{schemaVersion:1,source,identity,items,nextCursor}`，后续页使用原样的不透明 nextCursor。本插件不解析游标或拼接数据 URL。

快照形状为 `{schemaVersion:1,source,identity,status,collectedAt,code?,smart?}`，source 为正式 host-smartctl 或明确的本地 mock。status 接受 ok、stale、unavailable、unsupported。失败可保留准确的采集尝试时间和固定错误码，健康未知、没有指标；无样本返回 unavailable / SMART_NO_SAMPLE / collectedAt:null。页面失败信息来自本地固定文案，绝不展示任意错误文本或 stdout/stderr。

有绑定但尚无采样时，latest 返回上述 null 占位，history 为空；无绑定则 resolveDisk 抛 SMART_DISK_UNBOUND（404）。无样本占位不形成历史行，历史中的失败日必须有真实采集尝试时间。

同一 UTC 日先失败、后成功的快照可以附带可选 `gapCode`，仅接受 SMART_COLLECTION_FAILED、SMART_UNAVAILABLE、SMART_UNSUPPORTED、SMART_INVALID_DATA、SMART_DEVICE_CHANGED、SMART_IDENTITY_MISMATCH、SMART_EXECUTION_TIMEOUT、SMART_EXECUTION_CANCELLED、SMART_OUTPUT_INVALID。页面显示“当日曾采集失败，后恢复”及本地化原因；只展示提供的成功采样时间，不编造此前失败时刻。恢复后的成功快照仍可作较早有效基线；无样本码 SMART_NO_SAMPLE 不作为 gapCode。

smart 为主框架白名单脱敏后的 smartctl JSON 字段子集；不含原始序列号、WWN、路径、raw.string 或任意厂商文本。单快照上限 512 KiB，ATA 最多 256 条。`src/smart.js` 解释健康位、选定字段和风险规则，不把“读取成功”解释为“健康”。计数支持只有 `*_s` 的精确十进制字符串：NVMe、ATA raw.value_s、通电小时／次数、SCSI 缺陷及不可纠正错误。无精确字符串的超安全整数显示未知，不舍入计算。

历史按同一 generation 和 UTC 日保存，每日最多一条，服务端最多保留 365 日；采集操作幂等，失败后成功可替换，当天成功后不被失败覆盖。旧 generation 历史保留但不自动拼接。浏览器每次最多读 30 条、手动“读取更早记录”，内存最多 365 条；可选择任一天查看指标，失败日也可查看时间与状态。只与同代且严格早于所选样本的最近有效成功采样比较；失败、缺失和最新样本自身均不是基线。如果基线尚未加载，显示无基线，可以继续翻页。浏览器不存历史到 localStorage 或配置集合。

换盘或身份变化 SMART_GENERATION_CHANGED 会清空旧展示，需重新读取；SMART_HISTORY_CURSOR_STALE 保留已读页并禁止继续拼页，提示重读首页。权限、绑定和未知读取错误清空展示；只有网络失败或 HTTP 408、429、5xx 可以保留刚取得的当前值，并明确历史不可用、未计算劣化。来源、generation、UTC 日唯一性、页大小、顺序和总量均校验，不混用跨盘记录。超过 36 小时的成功快照标为过期，超过本地时间 5 分钟的未来采样拒绝；这是展示策略，不能作为后端采集 SLA。

## 立即采集（0.1.2 受控候选）

“重新读取”只读已有采样，“立即采集”请求框架对当前可信绑定磁盘执行一次已审核的只读采集。未绑定时按钮禁用并显示诊断；未配置、未审核或权限不足时显示本地固定文案，不展示原始异常。框架尚无该能力时安全禁用。真实SSH联调的命令和计划须先提交用户审核，本插件不批准命令、不传地址、命令或设备路径。

提供器增加 `collect({identity,requestId,signal})` 和 `collection({identity,operationId,signal})`，返回 `{schemaVersion:1,operationId,status,code?}`。requestId每次显式点击生成一个随机UUID，单次操作只提交一次POST；operationId为稳定UUID，状态为running、succeeded、failed或unknown。查询始终携带原diskId/generation，不能只凭operationId读状态。

前端默认每1500毫秒查询一次，最多30次且总等待不超过45秒。超时、网络异常或unknown不代表远端取消，也不自动重发POST；用户可只读刷新并核实状态。没有收到POST确认时，页面内部可记录未知结果且没有operationId，不编造任务ID或发起无目标查询。只有新的明确点击才生成新requestId。

读取和采集互斥，运行时按钮禁用。切盘、关闭侧栏、原生标签切换或停用时取消页面等待，不声称撤销远端任务。框架仅在采样已持久化后报告succeeded；页面随后重新读取当前盘latest/history，严格复核原identity/generation/source，变化时清空展示。所有数据、任务授权和单盘范围由共享后端重新检查；浏览器不自行建立SSH或实现后端。

本地演示增加未审核、失败、结果未知和持续运行场景，均明确为模拟。共享HTTP回归通过真实框架客户端／提供器／服务，仅模拟Tower查询与SSH执行，不能称真实主机采集通过。

## 配置页全局手动采集（0.1.3 本地候选）

插件配置页增加“全局立即采集”，物理盘 Smart 信息侧栏保留单盘“立即采集”。全局按钮直接发起一次操作，使用服务端已保存的可信设备绑定、对象权限和人工审批，不使用未保存草稿，也不需要先保存本插件的显示设置。关闭显示子页不等于停止后台采集。

全局操作消费已确认的提供器 `collectAll({requestId,signal})` 与 `collectionAll({operationId,signal})`。目标枚举、授权复核和与每日／单盘采集的锁由框架负责；前端不枚举库存后逐盘提交，不接收命令或真实设备路径。当前框架未提供上述能力时按钮禁用。依赖框架 0.1.2 的正式批次接口；本地共享 HTTP 联调与真实主机验收分别记录，不能把模拟执行描述为已取得真实主机数据。

本地实现每次明确点击仅提交一次批次请求，默认每 1500 毫秒查询一次，最多 30 次且总等待不超过 45 秒。页面展示有界统计及逐盘状态；只有非空批次全部成功才显示完成，失败、未知、未执行和零目标均不会显示全部成功。超时不重发请求；离开配置页或停用插件会停止页面等待，不承诺取消后台任务。结果列表仅显示提供器验证过的盘 ID、状态和本地化固定原因。

此次开发同时修正单盘采集失败后的刷新：收到有效 operationId 的 failed 终态后，只 GET 刷新当前盘 latest/history，保留健康未知和真实失败时间；POST 前置审核拒绝且未确认任务、结果 unknown 均不自动刷新或重发采集。旧 0.1.2 包保持原样，不包含本节新增内容。

## 虚拟磁盘模拟示例

型号以 `VMware` 或 `Virtual_disk` 开头时（不区分大小写，也接受 `Virtual disk`），自动展示本地构造的 ATA／NVMe 示例。覆盖 `VMware_Virtual_SATA_Hard_Drive`、`VMware Virtual NVMe Disk`、`Virtual_disk` 等形式，只匹配前缀，不把名称中间包含相关文本的物理盘当作虚拟盘。

先通过框架 `readInventory({diskId,signal})` 读取 `{schemaVersion:1,disk:{diskId,model}}`，服务端每次核验当前调用者的 Tower 盘读取权限；该入口不要求 SSH 绑定，不返回序列号、设备路径或 generation。虚拟分支不调用 resolveDisk、readLatest、readHistory 或采集接口，也不生成假的采集身份。

页面醒目标注“虚拟磁盘模拟示例”，真实健康状态未知。数值、风险颜色和生成时间均为示例，不是该盘实际 SMART、寿命或采集时间；不与真实历史合并、不计算实际劣化、不保存为真实样本。按钮为“刷新示例”，重新核验型号后本地生成，单盘立即采集禁用。型号变为物理盘或对象权限被撤销时清除示例，不保留旧结果。

示例不计入全局批次采集成功；全局采集仍使用已绑定、已批准的真实目标，不因显示示例擅自更改后台计划、审批或候选范围。真实 SMART 命令失败显示数据不可用、健康未知，不据此判定 SSH 认证失败或坏盘；VMware 虚拟盘缺少 SMART 仅是失败的可能原因，不能推广为所有物理盘的判断。

## 挂载与生命周期

默认适配器只识别集群／主机的 `view="disks"` 和 `sidebar={type:"disk",id}`，要求唯一 `.drawer-content-inner`、唯一 `.detail-tabs`，核对库存行 `data-row-key` 与侧栏标题路径。对只读观察到的 CloudTower 4.9 集群和主机结构，要求 `.detail-tabs` 直属唯一 `.detail-sidebar-header`，header 的同父元素依次且仅为 header、`.tab-border-bottom`、唯一 `.tab-content`（忽略本插件自身插入的 panel）；不依赖任何生成类名。保留演示结构的 tabs 紧邻 `.detail-tab-content`／`.detail-content` 路径；这是 DOM fixture 支持，不涉及旧 ID 或旧 API 兼容。结构有歧义或不同即安全退出。

真实只读结构观察并不等于插件在真实环境中完成挂载、原生内容恢复或启停验收；正式 `towerBuilds` 已按上述依据和主协调决定仅允许 `4.9.0` 进入受控验收。脱敏结构 fixture 在 `tests/fixtures/cloudtower-4.9-disk-sidebar.html`，只含人工对象名和路径。主框架在只读核验后可注入 `findDetail(win)`，返回 `{diskId,path,root,tabs,content}`，保持相同销毁和身份校验边界。

切换对象、卸载侧栏、禁用功能或停止插件时，撤销请求、移除插件 DOM／样式／监听器／observer／定时器，恢复原生内容显隐。旧请求迟到不覆盖新盘。不修改官方前端文件，不读取 React 私有状态。默认挂载是可回退的 DOM 增强，框架没有插件沙箱。

## 风险与劣化解释

| 情况 | 展示 |
|---|---|
| NVMe 已用寿命 ≥80%／≥90%／≥100% | 黄／红／深红，是本插件展示策略，不是厂商故障预测 |
| 设备健康失败、严重警告位非零、当前属性越过设备阈值 | 深红 |
| 设备报告曾越过阈值 | 红 |
| 已识别 ATA 重映射／待处理／不可纠正、SCSI 缺陷／不可纠正、NVMe 介质错误计数非零 | 红；相较上次继续增加为深红 |
| ATA 接口 CRC 错误非零 | 黄；用于连接可靠性排查，不等于介质损坏 |
| 寿命消耗增加、备用空间下降、ATA 归一化值下降 | 至少黄，显示变化与劣化量；不降低更高风险 |
| 温度、错误日志条目、非正常关机、读写量、通电计数 | 仅展示变化，不通用推断寿命或故障 |
| 未识别厂商属性 | 使用服务端固定 Attribute_ID 名称与编号、数值，不凭 raw 大小推断健康 |

绝对变化可正可负，百分数变化标为百分点；计数下降提示可能重置，不当作可靠性改善；无基线显示“—”。背景色配合文字，不仅依赖颜色。温度未加入通用阈值，以免忽略厂商差异。未识别寿命字段不擅自换算剩余寿命。

字段语义参考上游 [smartctl 手册源文件](https://github.com/smartmontools/smartmontools/blob/main/src/smartctl.8.in)（JSON 精度、退出状态、ATA 厂商值）及 [NVMe JSON 输出实现](https://github.com/smartmontools/smartmontools/blob/main/src/nvmeprint.cpp)，核对日期 2026-10-28。实现为独立字段解析，未复制上游程序源码。

## 后台每日采集的集成要求

采集通道的公开 API／指标／Fisheye／SSH 对比与实测边界见 [采集路径研究](docs/collection-research.md)。

描述文件声明 permissions: inventory.read、ssh.channel.use、disk.smart.read，且仅声明 daily-smart / disk.smart.read / hostScope=configured / deviceScope=configured / intervalSeconds=86400。默认 SSH 关闭，需管理员配置可信设备与单独审计批准；安装、打开页面、重新读取或修改显示设置均不立即采集；只有明确点击“立即采集”才请求单盘任务。框架按全局、SSH 通道、消费插件与审批状态控制后台任务；停用／卸载阻止新增，历史与配置分离，重置／卸载不删除历史。身份绑定、主机读取、UTC 日去重、持久保留及每次对象权限验证均由共享后端负责。

`tests/framework-provider.test.js` 通过真实 createDataProviders、createClient、createService、createApi 的回环 HTTP 验证消费链路；包含主框架官方测试 fixture，以及使用本插件描述文件的隔离 fixture。只模拟 Tower 库存响应和 SSH 执行，不连接外部网络。覆盖绑定／无样本、审批后采集和失败恢复、35 日历史分页与劣化、逐请求调用者认证、latest 后撤权、换盘、过期游标、取消后的迟到响应，以及插件工厂通过实际 API 读取数据后的 DOM 渲染与清理。这些测试不依赖已构建的制品；包内工厂执行另由 verify:package 检查。

上述本地验证仍不能证明真实主机网络、sudo、smartctl 或跨日持续调度可用。实际浏览器截图使用明确标记的模拟演示；实际共享 API 到插件 DOM 的验证使用 jsdom，不应混称真实 CloudTower 验收。

`tests/v2-provider.test.js` 复用框架实际 v2 HTTP/service/vault/provider/broker 夹具，单独覆盖 all 自动关联与采集消费、同路径换盘后的新代际/旧历史保留且不继承基线、custom 空集不使用旧关联、custom 选择不自动吸收替换盘、all 范围变化失效审批和读取撤权。无需修改八个 provider 方法或重打固定 0.1.5 包；这些是本地消费回归，未连接真实设备。

项目入口：[仓库](https://github.com/sephirothchang/rivetin)、[本插件](https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-disk-smart-info)、[框架生命周期说明](../../framework/README.md)、[共享配置契约](../../docs/rivetin-configuration.md)、[统一 SSH 通道](../../docs/ssh-channel.md)。仓库目前为私有，以上入口需要访问权限；本地插件包不代表已发布公开下载或 Release。

侧栏受控真实验收步骤保留在 [0.1.5 验收说明](docs/acceptance-0.1.5.md)，0.1.6 的模板/多盘增量见 [命令声明与逐盘计划](docs/command-declaration.md)。真实环境验收、发布与官网同步由协调方在固定候选及排他窗口下安排。

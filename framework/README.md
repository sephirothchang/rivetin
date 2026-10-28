# Rivetin

共享能力：[磁盘 SMART 数据接口](../docs/disk-smart-data.md)、[对象操作接口](../docs/resource-actions.md)、[SSH 通道](../docs/ssh-channel.md)。子插件通过框架注入的提供器访问，不接触认证材料或自行连接主机。

Rivetin 提供 CloudTower 中统一的插件中心、配置、生命周期和应急开关。功能插件位于仓库 `plugins/`，框架不导入具体插件功能。当前仅支持经过信任与审核的前端插件，**故障隔离按需求保留为 TODO**。

## 0.2 兼容性与组件状态

兼容性契约见 [版本声明与可信来源](../docs/rivetin-compatibility.md)。框架声明自己的 CloudTower 已测试版本；子插件必须使用机器可校验的 compatibility schema 2，明确框架最低版本、最高版本边界和 CloudTower 精确版本列表。SMTX OS 条件可省略或填写 `none`，有条件时校验全部受管目标产品集群。安装、升级、回滚、启用及资产加载均执行门禁；旧声明不能获得执行资格，旧安装包不原地修改。

服务启动时及每 20 秒检查一次兼容性。已确认不兼容的已启用插件持久化为禁用并撤销 SSH 审批；恢复兼容不会自动重新启用。版本未知或证据过期时暂停执行，不能当作已证明不兼容。SMTX 全局读取只借用当前合法 ROOT 请求，不保存管理员会话；没有合法后台身份时不会延长快照有效期。

插件中心的“组件状态”位于操作日志之后，显示框架、插件声明、组件依赖、代码和安装包完整性，以及 API 自检情况。接口登记、API 的只读自检与端到端业务验证是不同证据；无法观测的 Island、网关或未探测接口保持未知，不能显示为正常。服务包的 `integrity.json` 校验已知文件字节，属于本地测量基线，不是发布者签名或恶意篡改防护的独立信任根。

管理员接口（均返回 JSON，不缓存）：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/rivetin/v1/components/status` | GET | 读取组件状态；`?fresh=true` 显式刷新 |
| `/api/rivetin/v1/components/repair` | POST | 备份后停用全部插件，修复框架自身版本元数据 |
| `/api/rivetin/v1/components/reset` | POST | 备份后停用全部插件，重置进程内衍生缓存 |
| `/api/rivetin/v1/components/support` | GET | 下载统一脱敏支持包的 Base64 信封 |

维护请求为 `{ "operationId": "<UUID-v4>", "acknowledged": true }`，要求管理员身份与允许的同源 Origin。操作 ID 持久化去重；未知结果不自动重做。修复和重置保留插件包、插件配置、加密凭据及历史，**不会自动恢复插件或 SSH 审批**。Web 维护不重建 Deployment、Ingress、代码文件或 Island 注册；这些故障仍需 CLI。限定范围外仍需检查时返回 `partial` 与固定原因。备份最多 50 份，达到限额会拒绝新维护操作，不自动删除备份。

支持包为单个 `.rivetin-support.json.gz` 文件，包含框架与所有插件的公开状态、兼容性声明、配置 revision/schemaVersion 和最多最近 1,000 条匿名化日志元数据。它不包含原始配置、密码、私钥、Cookie、令牌、SSH 公钥指纹、地址、序列号、主机名或采集原文；不能用其替代受控的原始排障证据。解压 JSON 上限 2 MiB、压缩文件上限 1 MiB；浏览器在下载前核对大小、gzip 标记和 SHA-256，服务不会自动上传支持包。日志损坏或输入超限会明确拒绝导出，不冒充完整支持包。

## 本地验证

在仓库根目录执行 `npm run setup`、`npm test`、`npm run build`、`npm run package`，再执行 `npm run demo -- rivetin-ipmi-redirection`。演示监听回环地址，演示管理员不是生产认证，绝不将演示服务器对外部署。

## 首次安装与恢复

框架首次通过 [便携式 CLI](../cli/README.md) 安装。客户端内嵌 SSH、HTTPS 和安装资源，将独立后端部署与 Island 注册合并为同一流程；提供安装、更新、卸载和恢复命令，只接受精确验证过的 Tower 构建。Rivetin 0.1 基础版本已在 CloudTower 4.9.0 开发测试环境完成 Windows amd64 CLI 与真实浏览器验收；新增共享能力仍须按对应接口分别验证，不能将一次验收推广至所有版本和插件。平台边界见 [验证范围](../docs/portable-cli-validation.md)。

安装器创建独立 Deployment、Service、Ingress 和专用数据目录，流程不包含修改官方前端文件或重启官方 Tower 服务的命令。框架安装及更新后保持禁用；子插件的 `.rivetin.json` 包通过插件中心上传并安装，需明确启用。`deploy/install.sh` 保留为旧的服务器侧手工部署脚本，不包含完整 Island 注册流程，也不能替代新的版本门禁。

已核对 Tower 4.9 永久区域的筛选规则：普通常驻 Island 不得填写 `metadata.version`，否则该区域不会返回它。框架发布版本保存在 `metadata.info.version`，注册键固定为 `rivetin`。

通过 API 紧急禁用：`POST /api/rivetin/v1/disable`，无需请求体，必须提供有效 Tower 身份和允许的 Origin。正常管理使用 `POST /enable` 恢复。

Web 或 API 不可用时，优先使用便携式 CLI 的 `disable`：它仅需 SSH，直接写入已识别布局的禁用标记，不依赖健康的 Tower API 或 Kubernetes 控制面。参数与信任校验见 [CLI 文档](../cli/README.md)。如果服务 Pod 仍可用，也可在 CloudTower VM 执行既有数据 CLI：

```bash
kubectl -n cloudtower-system exec deployment/rivetin -- node cli.mjs disable --data /var/lib/rivetin
```

服务进程失效时，可用同版本运行时直接执行 `cli.mjs disable --data <绝对数据目录>`。CLI 不依赖 HTTP、Tower 登录或插件配置；禁用标记持久化，重启不会自动恢复。已卡住的浏览器需刷新后停止加载插件。框架入口保持可用，禁用的是所有子插件。

## 管理契约

- 上传只校验和持久化，不执行插件代码；包摘要不可变。安装、更新、回滚均默认禁用；更新必须提高版本。只有管理员可进行写操作。
- 更新保留配置并备份。0.1 拒绝配置 schema 版本变化，避免执行未经验证的迁移；相同 schema 的前端更新和回滚已实现。
- 已安装插件只将更高版本的已上传安装包列为可更新条目；当前版及旧版不重复显示。旧包仍保留供回滚使用，隐藏条目不会删除安装包、配置或历史。
- 重置先备份原配置字节再恢复默认；损坏配置也可以明确重置。卸载移除活动注册，保留配置和包，允许重装。
- 新安装器更新前保存资源、数据和 Island 备份及恢复记录，只管理带有自身所有权标记的资源。框架自身更新通过 CLI 进行；子插件可手动上传或通过 Rivetin 官网版本清单联网检查与下载，均经包校验和升级确认。框架 Web 自更新尚未实现，不能把子插件上传包作为框架服务程序执行。
- 功能配置独立文件、同一插件最后成功保存为准；只有个人界面偏好存浏览器。统一配置契约见 [配置 API](../docs/rivetin-configuration.md)。
- 正式 Island 订阅宿主共享 `@tower/i18n` 的当前语言与 languageChanged 事件；演示/独立入口读取宿主 locale、全局 language.value 或文档 lang。框架不写入或另存语言偏好。
- Rivetin 服务让 Tower 验证当前登录身份及管理员角色，不本地信任解码后的 token。Authorization 只转交同一 Tower，认证头、Cookie 和设置值不进入审计日志。
- 前端资产是公开代码；只服务已启用插件的 `web/*.js/css`，不公开配置、会话和数据目录。0.1 没有签名发布者信任体系，SHA-256 只校验完整性。

## 审计

所有管理操作本地记录开始、成功或失败，可通过插件中心“操作日志”查询。日志保留操作者、时间、动作、插件 ID、结果和错误码，不记录设置正文。读取最新 1 MiB，分页单次最多 100 条；持久日志文件当前不自动清理，应在后续运维策略中确定轮转与保留期。

Tower 原生对接尝试使用官方 SDK 列出的 `POST /v2/api/create-user-audit-log`，包含中英文 message、当前真实 user_id 和 `resource_type: rivetin`。公开列出路径不代表普通管理员获准写入；`user_id` 表示日志归属用户，不改变认证调用者。本地保存成功与原生镜像状态分别记录；失败不删除本地日志或伪报原生成功。异步任务响应在核对完成前不当作已成功。CLI 身份不伪造 Tower 用户。

测试 Tower 4.9 RC 的真实接口验收返回“仅允许系统用户”，普通 root 也不能写入。只读核验该构建的服务端实现后，确认 REST 控制器调用 `createUserAuditLogV2`，解析器额外要求认证调用者精确匹配内部系统身份；普通角色权限及请求体中的用户 ID 不能替代此条件。目前未找到面向第三方的公开系统身份发放或审计摄入流程，不将内部实现当作受支持的集成方式。当前不会借用系统用户、改权限或直接写数据库；遇到此限制后停止重复镜像。

日志表格的时间、操作者、操作、对象和结果保持单行，长字段省略并提供全文提示。内容默认显示简短说明，展开“记录详情”后查看完整的已知诊断、错误码和记录编号；窄窗口仅在表格区域横向滚动。插件中心仍可查询独立持久的 Rivetin 操作日志，原生审计接通需要官方确认的集成机制。

## 子插件联网更新

“插件管理”打开时由后端检测官网固定路径 `https://rivetin.dev/catalog/v4/plugins.json`，不调用 GitHub REST API，也不需要仓库令牌。可达性结果缓存 30 秒，打开期间每 30 秒重新探测；经校验成功的清单缓存 60 秒并合并并发读取，探测失败时不会用旧成功结果冒充可达。检测中或更新源不可达时，检查更新按钮禁用并提供悬停说明。自动升级失败只在升级方式弹窗显示，不在底部重复告警。升级入口保留手动上传方式；自动下载校验 SHA-256、标识、版本以及所有市场元数据。摘要只校验完整性，不等于发布者签名信任。 0.2 使用独立的 schema 4 目录，条目必须声明 compatibility schema 2；旧版本继续使用原 schema 3 目录，两者不互相回退，已发布同版本包不得覆盖。

“插件市场”与插件管理平级，只列清单中标记 `published` 且有真实制品的版本。管理员确认后安装，默认禁用，不自动授予 SSH 权限。目录格式和发布条件见 [市场清单](../catalog/README.md)。当前开发条目仍为草稿，不会伪装成已发布插件。

兼容声明的 `compatibility.towerBuilds` 为 CloudTower 实际报告的版本／构建标识精确列表，框架 API 及可选框架版本上下界也必须满足。后端使用 CloudTower 自身的 `deploys(first: 1) { version }` 查询，每 30 秒重新核对；版本未知或不兼容时，安装、启用、升级、回滚及资产加载都拒绝，已运行前端暂停。这里的 `4.9.0` 不代表已识别某个具体 RC 镜像。CLI 首装仍按自己的已验证镜像清单执行更严格的部署门禁。旧包只有文字兼容说明时可备份、查看，不能自动获得安装或启用许可。

升级中心和系统配置中的 CloudTower 升级页面在实例启用扩展时显示兼容性提醒，提供打开插件中心的入口；不接管官方升级按钮或流程。

## 统一 SSH 通道

首次 CLI 安装／更新自动补充内置 `rivetin-ssh-channel`，生命周期和采集配置均默认关闭。已卸载的状态保留，不因重启重新安装。它的后端是框架维护的受控能力，不加载子插件服务端脚本。参见 [SSH 通道契约](../docs/ssh-channel.md)。

官网清单采用 v3，安装包固定使用官网同源版本目录；客户端下载不发送认证凭据，不跟随外域或其他路径重定向。只有已发布且通过兼容性检查的条目提供安装入口；本地候选包不等于公开发布。主项目维护目录和包审核，官网维护方完成静态发布及 HTTPS 字节回读后，才确认目录的发布状态。维护流程见 [市场目录](../catalog/README.md)。

## API

所有路径前缀 `/api/rivetin/v1`：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/config` | GET / PUT | 聚合读取、按 pluginId 保存独立配置 |
| `/runtime` | GET | 框架开关、版本与审计接入状态 |
| `/disable`、`/enable` | POST | 紧急禁用、明确恢复 |
| `/packages` | POST | 上传已校验的 Rivetin JSON 包 |
| `/updates` | POST | `check` 检查子插件版本；`download` 校验并暂存指定升级包 |
| `/updates/status` | GET | 管理员读取实际更新源连通性，短时缓存 |
| `/marketplace` | GET / POST | 已发布插件、兼容性与确认后安装 |
| `/ssh-channel` | GET / POST | 管理员审计命令；review / approve / revoke，不提供任意命令执行 |
| `/ssh-channel/results` | GET | 按 pluginId 读取有界采集结果，仅管理员 |
| `/ssh-channel/hosts` | POST | CLI 管理加密主机连接资料；变化撤销已有审批，不连接主机 |
| `/ssh-channel/preflight` | POST | 获取候选指纹、确认待保存指纹、使用已保存凭据进行无命令认证预检 |
| `/data/disk-smart/collect-all` | POST | 管理员提交全局手动采集批次，仅使用既有绑定和人工批准目标 |
| `/data/disk-smart/collection-all` | GET | 按当前调用者权限读取完整、有界批次进度，不触发重试 |
| `/plugins` | GET / POST | 清单与 install/update/rollback/enable/disable/reset/uninstall |
| `/logs` | GET | 最近操作日志，可按插件过滤与分页 |

框架 0.1.2 新增全局 SMART 手动批次，协议与限额见 [共享数据接口](../docs/disk-smart-data.md#全局手动采集框架-012)。该能力已完成本地 HTTP、正式客户端和测试传输的集成验证，尚未进行真实全局采集；既有单盘真实测试不代表全局批次已通过实机验证。SSH 认证预检只证明当次连接和认证，远程 SMART 命令成功与磁盘健康由各自结果判断。

## 尚未实现的边界

故障隔离、框架 Web 自更新、自动配置 schema 迁移、后端可执行子插件、签名与发布者管理尚未实现。不能将此版本视为任意第三方代码的安全运行平台。真实 BMC 登录能力由具体插件单独说明。

采用仓库 MIT 许可证，非 SmartX 官方产品。

## 项目命名

项目名称与注册 scope 统一为 Rivetin / `rivetin`。插件、制品、API 与存储路径以 [Rivetin 命名与配置路径](../docs/rivetin-naming.md) 为权威说明。Federation 仅暴露 `./Rivetin`；正式 window scope 为 `rivetin`，本地演示为 `rivetinFrameworkDemo`。

前端仅调用 `/api/rivetin/v1`，不探测其他 API、不重写插件身份、不因未知写结果重试。个人偏好仅使用当前浏览器中的 `rivetin.personal.v1`。旧名称和路径没有运行时别名或自动迁移；受控重装须先备份，由管理员明确恢复功能配置，不自动删除历史资料。

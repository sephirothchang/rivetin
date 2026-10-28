# Rivetin 便携式 CLI 0.1

该命令行工具将 Rivetin 后端部署和 CloudTower Island 注册整合为同一安装流程，并提供框架与子插件管理、配置归档、紧急禁用和失败恢复。发布客户端使用编译在程序中的 SSH、HTTPS、证书校验、版本适配器及安装资源，不需要客户端另装 Node.js、Python、SSH、kubectl 或其他运行时，也不修改 PATH、注册表或系统配置。

当前为开发验证版本。Rivetin-only 制品已在 CloudTower 4.9.0 测试实例完成一次受控框架升级、状态回读、子插件更新与只读界面验收；本次未重新执行全新安装、卸载、快照恢复或其他客户端平台的实机流程。早期完整生命周期验收属于历史制品，不自动继承为当前制品的验证结论。当前结果见 [0.1 验证范围](../docs/0.1-validation.md)，历史证据边界见 [安装器验证记录](../docs/portable-cli-validation.md)。

## 客户端与平台

| 操作系统 | 架构 | 可执行文件 |
|---|---|---|
| Windows | amd64 / arm64 | `rivetin-windows-amd64.exe` / `rivetin-windows-arm64.exe` |
| Linux | amd64 / arm64 | `rivetin-linux-amd64` / `rivetin-linux-arm64` |
| macOS | amd64 / arm64 | `rivetin-darwin-amd64` / `rivetin-darwin-arm64` |

下载对应文件即可从操作系统终端运行；Linux/macOS 如下载未保留执行权限，需要为该文件设置执行权限。无需全局安装，移动或移除可执行文件不会修改客户端软件环境。发布目录还应携带 `LICENSE`、`THIRD_PARTY_NOTICES.txt` 和 `SHA256SUMS`；`licenses` 子命令可在离线状态查看内嵌许可证。

## 使用

```text
rivetin help
rivetin version
rivetin licenses
```

下面使用占位地址和参数，执行前必须替换。SSH 指纹应通过可信渠道核实。默认使用系统 PKI 校验证书链和主机名，`--ca-file` 可补充私有 CA，且不修改系统信任库。SSH 主机与 `--tower` HTTPS 地址中的主机名必须一致，避免将后端部署与 Island 注册分别发送到不同目标；即使两个不同名称指向同一设备，也应统一为相同名称后执行。工具不提供无条件忽略 TLS 校验、跳过版本门禁或在参数中传入密码的开关。

对于缺少 SAN、无法通过标准主机名校验的旧版设备证书，可显式使用 `--tls-cert-sha256 <VERIFIED_DER_SHA256>`。它以精确的叶证书 DER SHA-256 和有效期校验替代 CA／主机名信任，不会修改系统证书或信任库。该指纹必须先通过独立可信渠道获得，例如已经核验主机密钥的 SSH 通道；不得直接采信尚未验证的 HTTPS 连接返回的指纹。证书变更后旧指纹会拒绝连接，必须重新核实。该参数与 `--ca-file` 互斥。

```text
rivetin detect --ssh tower.example.invalid:22 --ssh-user <SSH_USER> --ssh-hostkey SHA256:<VERIFIED_HOST_KEY>
rivetin install --ssh tower.example.invalid:22 --ssh-user <SSH_USER> --ssh-hostkey SHA256:<VERIFIED_HOST_KEY> --tower https://tower.example.invalid --user <TOWER_ADMIN> --ca-file <CA_CERT_FILE>
```

默认在交互终端中以不回显方式输入密码；不读取客户端已有 SSH 配置或代理，也不写入凭据文件。当前支持 SSH 密码认证和免密 sudo，不提供 SSH 私钥认证。受控自动化可显式指定 `--credentials-stdin`，通过继承的标准输入管道传入单个 JSON 对象，格式为 `{"sshPassword":"<SSH_PASSWORD>","towerPassword":"<TOWER_PASSWORD>"}`，并在传完后关闭标准输入。协议上限为 16 KiB，仅接受这两个字段，拒绝重复字段、尾随内容、无效编码和控制字符。`detect`、`status`、`plan`、`disable`、`reset-config` 只要求 `sshPassword`；其他当前命令使用 Tower API，要求两项凭据。该模式拒绝直接从交互终端读取，避免明文回显；调用者也不得将凭据放入 shell 命令、命令行参数、环境变量或日志。CLI 不持久化收到的凭据。CLI 支持 `--lang zh-CN` 或 `--lang en-US`，帮助与常见失败提示按所选语言显示，并保留错误码和可用的恢复编号；不会直接回显可能包含敏感内容的底层错误。Web 中的语言继续跟随 CloudTower 全局设置。

| 命令 | 行为 |
|---|---|
| `detect` / `status` / `plan` | 只读显示探测到的 Tower 构建与运行时、是否受支持、安装器管理状态及待恢复记录；未知构建也可诊断，当前 `plan` 不执行部署 |
| `install` | 校验版本与管理员身份，备份后部署后端、初始化为禁用、注册 Island，并回读验证 |
| `update` | 更新安装器管理的框架，保留功能配置与备份；更新后框架全局停用，需通过 `enable` 或 Web 明确恢复 |
| `uninstall` | 移除安装器管理的 Rivetin Island、Deployment、Service 和 Ingress；保留配置、代码版本与恢复备份 |
| `enable` | 通过认证 API 明确恢复框架运行，并核对运行状态；不会自动启用原本被单独禁用的子插件 |
| `disable` | 仅通过 SSH 写入已识别数据布局的持久禁用标记；不依赖 Tower Web/API 或 Kubernetes 可用性 |
| `reset-config` | 框架完全卸载后，归档整个数据目录，供下一次全新安装使用；不删除代码版本或旧备份 |
| `recover` | 按恢复编号处理未完成操作；框架恢复会回滚 Island 和后端资源并保持停用 |

`install`、`update`、`uninstall`、`enable`、`recover` 及所有 `plugin` 子命令均需 SSH 和 Tower HTTPS 管理员连接参数。`reset-config` 只需 SSH，但仍要求已测试构建及可用的 Kubernetes 只读检查；它不具有紧急禁用的离线救援语义。紧急禁用只需 SSH：

```text
rivetin disable --ssh tower.example.invalid:22 --ssh-user <SSH_USER> --ssh-hostkey SHA256:<VERIFIED_HOST_KEY>
rivetin recover --ssh tower.example.invalid:22 --ssh-user <SSH_USER> --ssh-hostkey SHA256:<VERIFIED_HOST_KEY> --tower https://tower.example.invalid --user <TOWER_ADMIN> --operation <RECOVERY_ID> --ca-file <CA_CERT_FILE>
```

禁用标记不会因重启自动清除。已失去响应的浏览器页面可能需要刷新后才停止加载子插件；故障隔离尚为 TODO，不能承诺能终止已占满浏览器主线程的代码。

## 子插件操作

CLI 子插件命令调用统一的 Rivetin API。以下列出操作参数；执行时还必须提供前节中的 SSH、Tower HTTPS 管理员和信任校验参数，并将示例包文件替换为实际制品。

```text
rivetin plugin list
rivetin plugin install --package ./plugin-package.rivetin.json
rivetin plugin update --package ./new-plugin-package.rivetin.json
rivetin plugin enable --plugin-id rivetin-example
rivetin plugin disable --plugin-id rivetin-example
rivetin plugin uninstall --plugin-id rivetin-example
```

安装和升级从包内读取插件 ID，`--plugin-id` 可选；如果指定，则必须与包内 ID 一致。其他修改操作必须指定 ID；`list` 可通过该参数筛选输出。包文件必须为可读取的常规文件，最大 16 MiB。CLI 校验包格式、路径、逐文件 SHA-256、插件 ID 和版本，上传后核对返回摘要，再执行操作并回读安装状态；服务端还会执行完整的描述文件和配置规则校验。

安装或升级成功后子插件保持禁用，需要显式启用；框架全局开关和单插件开关分别管理。子插件卸载保留配置和安装包。CLI 的 `plugin update` 使用 `--package` 指定的本地制品，不自动联网下载更新；Web 中的联网检查与升级是独立入口。当前 CLI 子插件动作不包括配置重置或版本回滚，这些能力继续通过插件中心操作。

## 版本、所有权与恢复边界

当前只允许 [profiles.json](profiles.json) 中精确匹配的组合：Tower 服务镜像 `registry.smtx.io/cloudtower/tower:v4.9.0-rc-20260517114030`、Node.js `v20.12.1` 及对应组件布局。该记录来自此前手工部署验收，不代表任意 4.9.x 均兼容，也不构成厂商认证。新版本需要独立适配器和验证记录后才能扩展允许清单。

Tower 侧使用该平台已有的 Python 3、kubectl、Node.js 镜像与免密 sudo。客户端不会为服务器自动安装这些基础组件。部署写入前复核构建；未知构建、组件差异或同名非安装器资源会拒绝。镜像标签匹配是当前探测依据，尚未以不可变镜像 digest 建立完整产品供应链验证。

安装器使用专用 `/var/cache/appcache/rivetin` 目录，后端资源固定为 `cloudtower-system` 中的 `rivetin` Deployment、Service、Ingress，所有权标记为 `rivetin-cli-v1`。安装和更新不会接管未知手工部署；同名资源缺少准确所有权标记时拒绝写入，不提供自动迁移命令。不要通过手工补标签绕过检查。

Rivetin 只使用 `/api/rivetin/v1`、`RIVETIN_*` 环境变量、`rivetin-*` 插件 ID、`rivetin-package-v1` 包格式、`rivetin-global-v1` 前端格式及 `rivetin` Island scope。新插件包后缀为 `.rivetin.json`。CLI 不探测旧 API、不映射旧 ID、不读取或清理其他项目的数据和恢复记录。每个 API 写操作只发送一次；未知结果保留原有恢复边界。

安装或更新前保存资源、数据和 Island 备份及恢复记录。框架部署从准备阶段开始累计五分钟验证预算，Pod 就绪等待和外部运行状态回读共享这段剩余时间。Pod rollout 上限为 270 秒，远程子进程上限为 280 秒；执行中的 SSH 写操作继续使用外层上下文，不在验证预算到期时强行中断，避免将明确结果变成未知结果。操作完成后，若验证预算已耗尽，则进入恢复流程。

外部 `/runtime` 仅对 HTTP 502、503、504 按 2、5、10 秒、之后每次 15 秒的间隔重试，最多 24 次且受剩余预算限制；认证失败、证书问题或 HTTP 200 但状态／版本不符合预期时立即失败。诊断输出状态码、初始化与启用状态、版本及受控错误码，不输出响应正文。验证通过要求框架已初始化、全局停用、版本匹配，并已核对 Island 入口摘要与挂载区域。

可确认的部署失败或验证超时会自动尝试恢复旧 Island 和资源，恢复使用独立上下文，Pod rollout 仍为 90 秒。恢复不会以旧数据备份覆盖管理员当前功能配置，框架恢复后保持停用。网络中断导致远程结果未知、准备阶段未完成或恢复失败时保留恢复记录，不盲目重复写入；先用 `status` 查询 pending，再按具体操作类型处理。普通安装／更新／卸载可使用 `recover --operation`。

## 清空配置并全新安装

普通 `uninstall` 保留数据。确需从零开始时，先卸载需要移除的子插件，再卸载框架，确认没有 Rivetin Deployment、Service、Ingress 或残留 Pod 后，显式运行 `reset-config`。该命令要求有效的安装器 owner 且无 pending，只把整个 `data` 原子改名到 `backups/<operation>/cleared-data`，不递归删除。归档包含功能配置、子插件注册与安装包、日志及框架状态；文件清单记录大小和 SHA-256，并保留操作状态。代码版本、旧备份及 owner 均保持原样，命令不建立新配置；之后的 `install` 才初始化默认数据。

原本不存在 `data` 时，`reset-config` 幂等完成。符号链接、未知构建、残留资源或占用中的安装器记录会阻止清理。若改名已完成但后续同步或写状态失败，保留完整归档和 pending，并返回 `RESET_CONFIG_OUTCOME_UNKNOWN`。此时应先核对归档、清单和状态，进行受控恢复；当前通用 `recover` 不支持 `reset-config`，不要把未知结果当成清理失败而直接重试。

## 从源码构建

以下仅为开发机需求，发布客户端不需要这些工具：Node.js 22、npm、Go 1.27.x 与现有框架打包流程使用的 `tar`。依赖使用项目独立锁文件；Go 缓存可通过当前进程的 `GOPATH`、`GOCACHE` 指向项目忽略目录，不需要全局安装。

先在仓库根目录执行既有构建：

```text
npm run setup
npm test
npm run build
npm run package
```

首次检出不包含忽略的 `cli/payload/`。先在仓库根目录为当前开发进程设置项目缓存，测试与构建均沿用同一设置；PowerShell 示例：

```powershell
$env:GOPATH = Join-Path (Get-Location).Path 'cli/.local/go-cache'
$env:GOCACHE = Join-Path (Get-Location).Path 'cli/.local/go-build'
```

然后进入 `cli/`，使用选定 Go 编译器执行 `go mod download`。下载完成后回到仓库根目录执行（`<GO_EXECUTABLE>` 使用选定编译器的绝对路径）：

```text
node cli/scripts/prepare.mjs --go <GO_EXECUTABLE>
```

嵌入输入生成后，才能在 `cli/` 下执行 `go mod verify`、`go test ./...` 和 `python -m unittest -v test_remote.py`。这些命令中的 `go` 指相同的选定编译器，不需要将其加入全局 PATH。Tower 侧 Python 测试的范围见 [验证记录](../docs/portable-cli-validation.md)。

从仓库根目录构建六个目标（未显式设置缓存时，脚本使用 `cli/.local/` 下的忽略目录）：

```powershell
./cli/scripts/build.ps1 -Go '<GO_EXECUTABLE>'
```

在 Linux/macOS 开发机使用 `GO_BIN=<GO_EXECUTABLE> sh cli/scripts/build.sh`。构建脚本先在所选缓存中下载并校验锁定模块，再生成完整许可证与嵌入输入，使用 `CGO_ENABLED=0`、`-trimpath`，输出至忽略的 `cli/release/`。Node.js、Go、`tar` 和开发机摘要工具均不随客户端运行流程调用。首次 Go 模块下载可能需要网络；客户端安装资源已经嵌入，安装过程不从网络下载额外客户端组件。

## SSH 通道连接管理

框架安装／更新会补充默认关闭的 SSH 通道，不自动连接集群主机。客户端仍使用自身 HTTPS／SSH 组件，不要求安装额外程序。通过既有 Tower 连接参数运行：

```text
rivetin channel status [Tower connection options]
rivetin channel import-host --host-profile-file <sensitive-host-json> [Tower connection options]
rivetin channel remove-host --host-id <configured-host-alias> [Tower connection options]
```

敏感主机文件只在内存读取后通过已验证的 Tower HTTPS 管理接口传输，不回显内容；密码和私钥不得放在命令行。导入／删除撤销 SSH 审批，不启动连接。命令、目标和运行计划仍须在 Web 中逐插件审核并二次确认；没有 CLI 任意 exec 或 shell 子命令。格式与执行边界见 [SSH 通道](../docs/ssh-channel.md)。

## 许可与第三方组件

项目采用仓库 [MIT](../LICENSE) 许可证。CLI 的 [第三方声明](THIRD_PARTY_NOTICES.txt) 保留 Go 运行时、标准库及锁定模块的上游版权、许可证与专利授权原文；框架内嵌资源的运行依赖声明也随发布物分发。修改 Go 工具链或模块版本后必须重新生成并核对，不能用项目 MIT 覆盖上游条款。

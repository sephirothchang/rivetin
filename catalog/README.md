# Rivetin 子插件市场目录

`plugins.json` 是主项目保留的 v3 市场目录，使用 `schemaVersion: 3`，对应官网 `https://rivetin.dev/catalog/plugins.json`。新契约使用独立的 `v4/plugins.json`，对应 `https://rivetin.dev/catalog/v4/plugins.json`，不原地转换 v3。两者均通过同源版本路径下载插件包，不调用 GitHub REST API，也不需要仓库访问令牌。官网由独立的 `rivetin-website` 仓库构建和发布；主项目负责插件版本准入、包审核、兼容声明和目录内容。

## 目录和下载契约

每个插件 ID 最多出现一次，最多 500 项；清单不超过 512 KiB。顶层只包含 `schemaVersion` 和 `plugins`。条目包含：

| 字段 | 约束 |
|---|---|
| `id`、`version` | 合法的 `rivetin-` 插件 ID 和三段数字版本 |
| `frameworkApi` | 当前为 `1` |
| `status` | `draft` 或 `published` |
| `downloadPath` | 已发布包必须使用 `/downloads/plugins/<id>/<version>/<id>-<version>.rivetin.json`，草稿为 `null` |
| `sha256` | 完整原始包字节的 64 位小写 SHA-256，草稿为 `null` |
| `name`、`description` | 从包描述文件取得的 `zh-CN`、`en-US` 名称和说明 |
| `author`、`license`、`permissions` | 与最终包一致，当前采用 MIT |
| `compatibility` | 与包一致的机器可校验声明；已发布条目的 `towerBuilds` 不得为空 |

包名、版本、摘要、展示元数据、权限和兼容声明均从已审核的最终包取得，不手工拼造资产 ID。下载仅允许官网精确 HTTPS 路径；外域、额外路径、查询参数、片段和不受信任的重定向被拒绝。固定版本路径不可覆盖，旧包应保留，确保缓存中的旧清单仍然可以下载对应版本。

框架只列出 `published` 条目；草稿没有安装入口。下载后再次校验包摘要、逐文件摘要、插件 ID、版本、元数据、权限和当前环境兼容性。市场条目不授予 SSH 执行权限，也不改变人工审核和安装后停用的生命周期规则。

## 兼容性声明

`compatibility` 包含框架 API、Tower 构建及框架版本声明。自框架 0.2.4 起，schema 2 必须声明 `frameworkMinVersion`，仅检查包含最低边界的版本条件；旧 `frameworkMaxVersionExclusive` 只校验格式，不再限制运行。0.2.2／0.2.3 及旧读取器仍按原上下界规则解析，因此当前生产 v4 清单及固定包保留旧字段原始字节。省略旧上限字段的新 schema 2 声明要求最低框架版本至少为 0.2.4；向现有目录混入这种记录可能使旧读取器拒读整份目录，生产切换须先明确读取基线。完整规则见[兼容性声明与读取版本](../docs/rivetin-compatibility.md#旧字段与读取版本)。

`towerBuilds` 必须精确匹配可信后端报告的版本，不接受通配符，不根据产品名称或说明猜测兼容性。框架 API、Tower 和 SMTX 的独立条件保持；粗粒度的产品版本不能代替 CLI 对精确镜像构建与组件布局的安装检查。

## 发布流程

主项目统一维护目录。子插件开发方交付测试结果、功能边界、兼容范围和不可变包，由维护方审核后执行：

1. 用 `scripts/catalog-update.mjs draft` 登记明确的本地包，保留 `draft` 状态。
2. 用 `stage` 在被忽略的目录生成候选清单、固定版本下载目录和本地 `stage.json`。此时不将主项目目录标为已发布。
3. 官网维护方只引入候选清单及登记的包，校验包和路径后构建、发布。`stage.json`、回读证明、原始响应和本地协作资料不得发布。
4. 从官网实际获取清单和每个包，保存原始实体字节及状态、路径、大小、SHA-256、核验时间组成的最小回读证明。
5. 用 `verify` 将回读内容与候选逐字节比较，通过后才更新主项目中的已发布条目。提交前执行公开内容扫描并人工审查。

```sh
node scripts/catalog-update.mjs draft --package plugins/rivetin-example/release/rivetin-example-0.1.0.rivetin.json
node scripts/catalog-update.mjs stage --package plugins/rivetin-example/release/rivetin-example-0.1.0.rivetin.json --stage-output .local/site-drops/example
node scripts/catalog-update.mjs verify --stage-output .local/site-drops/example --proof-directory .local/site-readback/example
```

上述命令使用示例插件，执行时需替换为实际已审核包。`draft` 和 `verify` 支持 `--check`，只核对是否需要变更，不写目录。离线回读证明是发布流程的证据，不构成对网络来源的密码学证明；维护方仍需实际完成 HTTPS 回读与审核。

框架合并并发清单请求，仅缓存校验成功的清单 60 秒；可达性探测缓存 30 秒，到期重新探测，失败不会用旧成功结果冒充可达。官网还可能具有 CDN 缓存，更新后应验明实际返回字节，不保证推送即刻在所有客户端可见。

## 插件包格式

子插件制品为 `.rivetin.json`，格式标识 `rivetin-package-v1`，包含 `format`、`manifest` 和 `files`。`manifest` 声明身份、展示信息、兼容性、前端入口、权限、配置和可选 SSH 注册；`files` 使用 `path`、`sha256`、Base64 `data` 承载前端资源及许可证。包不携带服务器可执行代码、安装脚本、凭据或运行配置。文件路径白名单、体积和摘要规则由 `framework/server/manifest.js` 校验。

## 格式迁移

官网源使用 v3 的固定同源 `downloadPath`，不使用 v2 的 GitHub Release `assetId`。旧 GitHub 清单不会被静默解释为官网目录；框架需升级到支持官网源的版本。升级不改写既有插件配置，不重新授予 SSH 审批。

## 独立 v4 清单

v4 顶层精确为 `{schemaVersion:4,plugins:[...]}`，条目字段和下载路径沿用上述契约；所有条目的 `compatibility` 必须使用 schema 2，强制 `frameworkApi:1`、有效的框架版本半开范围及非空精确 Tower 版本列表。SMTX 可以省略、使用字符串 `none`，或使用明确产品／全范围／版本对象，规则见 [兼容性规范](../docs/rivetin-compatibility.md)。旧包继续由 v3 管理；工具不会把旧声明自动补成 schema 2，也不会将新 schema 2 包降级写入 v3。

工具默认仍维护 v3，必须显式指定 `--catalog catalog/v4/plugins.json` 才能维护 v4。选定目录须已存在，工具不创建或覆盖另一版本的 canonical 清单。

```sh
node scripts/catalog-update.mjs draft --catalog catalog/v4/plugins.json --package plugins/rivetin-example/release/rivetin-example-0.2.0.rivetin.json
node scripts/catalog-update.mjs stage --catalog catalog/v4/plugins.json --package plugins/rivetin-example/release/rivetin-example-0.2.0.rivetin.json --stage-output .local/site-drops/v4-example
node scripts/catalog-update.mjs verify --catalog catalog/v4/plugins.json --stage-output .local/site-drops/v4-example --proof-directory .local/site-readback/v4-example
```

仅发布空的或未变更的 v4 清单时，`stage` 可以不传 `--package`。v3 仍要求提供包。v4 drop 只包含 `stage.json`、`catalog/v4/plugins.json` 及本次变化的包；已在选定清单以相同版本和摘要发布的输入包不会重复复制。省略包的提案不能据此新增或修改 published 条目。

v4 的 `stage.json` 精确包含八个字段：`schemaVersion:1`、ISO `preparedAt`、`catalogPath:catalog/v4/plugins.json`、`baseCatalogSHA256`、`indexPath:/catalog/v4/plugins.json`、`indexSHA256`、`packages`、`candidateOnly:true`。packages 可为空；非空时每项精确为 `{id,version,downloadPath,sha256,bytes}`。这些只是待发布提案，不代表官网已经上线。

官网回读仍使用七字段证明 `{schemaVersion:1,site,path,status,sha256,bytes,verifiedAt}`，清单实体和证明文件名仍是 `catalog.plugins.json`、`catalog.receipt.json`。v4 清单的证明路径必须为 `/catalog/v4/plugins.json`；包的固定下载路径不变。每个变化包都需要独立原始实体和证明，verify 逐字节核验后才更新选定 canonical。`draft --check` 和 `verify --check` 继续只检查，不写入。

每次操作还会核对本地已知的 `catalog/plugins.json` 和 `catalog/v4/plugins.json`：同一插件 ID 和版本若存在不同已发布 SHA-256，或输入包与该已知摘要冲突，会拒绝操作。该检查不等于官网全局发布账本，也不验证已不在当前两个清单中的历史版本；官网仍需独立维护不可变发布记录。工具不联网核实证明来源，也不提供跨两个 canonical 文件的原子发布事务，发布方须串行维护并保存真实 HTTPS 回读证据。

## v4 发行元数据交接

`scripts/catalog-release.mjs` 为官网发行元数据提供独立入口，保留上述 `draft/stage/verify` 和严格 v3/v4 清单格式。它不修改框架运行时，也不让原 `stage.json` 携带正式发行号。

生成原 v4 drop 后，用 `release-stage` 在该目录独占创建 `release-stage.json`。首次发行明确指定 `--first-release`；后续发行用 `--base-release` 指向已审核的上一份原始 `release.json`。工具校验上一份元数据与当前 canonical 清单的绑定，并记录其原始字节摘要。新请求只有八个字段：`schemaVersion`、私有 UUIDv4 `requestId`、`stageSHA256`、`catalogPath`、`indexSHA256`、`indexBytes`、`baseReleaseSHA256`、`candidateOnly`。它不分配 ML 号，不发布或更新 canonical；已有请求不会覆盖或自动重建。

```sh
node scripts/catalog-release.mjs release-stage --stage-output .local/site-drops/v4-example --first-release
node scripts/catalog-release.mjs release-stage --stage-output .local/site-drops/v4-next --base-release .local/site-readback/previous/catalog.release.json
```

官网发布方维护发行号、不可变快照和账本，交回原始 `publication-output.json` 及提交态账本。协调方必须独立审核并冻结 output 的 SHA-256，再显式传给 `verify-release`；从回读证明中自行复制一个摘要不构成该信任来源。output 精确绑定请求、原 stage、新清单、元数据、不可变副本、账本和变化包。`local-committed` 只表示官网发布方本地提交，不能当成 HTTPS 上线或验证完成。

每个发行都需要四份 HTTPS 原始实体及七字段回读证明：

| 实体 | 证明 | 精确路径 |
| --- | --- | --- |
| `catalog.plugins.json` | `catalog.receipt.json` | `/catalog/v4/plugins.json` |
| `catalog.release.json` | `catalog.release.receipt.json` | `/catalog/v4/release.json` |
| `catalog.snapshot.plugins.json` | `catalog.snapshot.receipt.json` | `/catalog/v4/releases/<publicationId>/plugins.json` |
| `catalog.snapshot.release.json` | `catalog.snapshot.release.receipt.json` | `/catalog/v4/releases/<publicationId>/release.json` |

当前清单与不可变清单必须逐字节相同，当前元数据与不可变元数据也必须逐字节相同。元数据精确绑定 `ML-V4-YYMMDD.rev`、上海日期、UTC 毫秒时间、清单路径/大小/摘要和快照路径；不从下载内容重新序列化一份“预期字节”。账本只作为发布源证据，限制为编码 JSON 2 MiB 且不超过 5000 项，达到任一上限即拒绝。它不需要公开 HTTP 下载，工具也不修改它或为其标记 verified。

```sh
node scripts/catalog-release.mjs verify-release --stage-output .local/site-drops/v4-example --proof-directory .local/site-readback/v4-example --publication-output .local/publication-output.json --publication-output-sha256 <COORDINATOR_FROZEN_SHA256> --ledger .local/committed-ledger.json --check
```

证明时间须不早于 stage 和发行时间两者的较晚者，距离检查时间不超过 24 小时，且不能超前本地时钟五分钟；变化包沿用原实体/证明命名规则并遵守相同时间边界。四份实体、证明、账本和所有变化包全部通过后，工具调用原 `verify` 的包校验、跨清单摘要检查及 canonical 比较后写入流程。`--check` 不写，canonical 需要变化时返回 1；正式写入须显式省略 `--check` 并遵守维护方授权。离线工具校验的是交回证据，不能证明 HTTPS 请求实际发生；真实回读、单一写入窗口和发布后状态仍由发布方核验。请求 UUID、stage、output 和原始证明只保留在忽略目录，不随网站公开。

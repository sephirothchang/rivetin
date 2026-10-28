# Rivetin 子插件市场目录

`plugins.json` 是主项目维护的市场目录，使用 `schemaVersion: 3`。客户端固定通过官网 `https://rivetin.dev/catalog/plugins.json` 获取清单，通过同源的版本路径下载插件包，不调用 GitHub REST API，也不需要仓库访问令牌。官网由独立的 `rivetin-website` 仓库构建和发布；主项目负责插件版本准入、包审核、兼容声明和目录内容。

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

`compatibility` 使用 `frameworkApi`、`tower`、`towerBuilds`，以及可选的 `frameworkMinVersion` 和 `frameworkMaxVersionExclusive`。最低框架版本包含边界，最高版本不包含边界。`towerBuilds` 必须精确匹配可信后端报告的版本，不接受通配符，不根据产品名称或说明猜测兼容性。粗粒度的产品版本不能代替 CLI 对精确镜像构建与组件布局的安装检查。

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

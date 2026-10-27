# PluginKit 0.1

PluginKit 提供 CloudTower 中统一的插件中心、配置、生命周期和应急开关。功能插件位于仓库 `plugins/`，框架不导入具体插件功能。当前仅支持经过信任与审核的前端插件，**故障隔离按需求保留为 TODO**。

## 本地验证

在仓库根目录执行 `npm run setup`、`npm test`、`npm run build`、`npm run package`，再执行 `npm run demo -- pluginkit-ipmi-redirection`。演示监听回环地址，演示管理员不是生产认证，绝不将演示服务器对外部署。

## 首次安装与恢复

框架首次通过 [便携式 CLI](../cli/README.md) 安装。客户端内嵌 SSH、HTTPS 和安装资源，将独立后端部署与 Island 注册合并为同一流程；提供安装、受控迁移、更新、卸载和恢复命令。只接受精确验证过的 Tower 构建，普通安装或更新不自动接管已有手工部署。Windows amd64 客户端已完成该构建上的迁移、卸载重装、框架更新、CLI 与 Web 子插件升级及紧急禁用验收；详细记录和其他平台边界见 [验证范围](../docs/portable-cli-validation.md)。

受支持的旧手工部署可以显式运行 `migrate`：先严格核对已知后端源码指纹、资源布局和 Island 身份，保存资源、数据、旧代码及 Island 备份，再增加资源顶层所有权注解和安装器 owner 标记。迁移不修改资源 spec、Pod 模板、功能配置或启停状态，不要求重启后端；未知部署不会接管。部分失败时仅撤销本次增加的所有权元数据，无法确认时保留恢复记录。迁移边界及恢复步骤见 [CLI 文档](../cli/README.md)。

安装器创建独立 Deployment、Service、Ingress 和专用数据目录，流程不包含修改官方前端文件或重启官方 Tower 服务的命令。框架安装及更新后保持禁用；子插件的 `.pluginkit.json` 包通过插件中心上传并安装，需明确启用。`deploy/install.sh` 保留为旧的服务器侧手工部署脚本，不包含完整 Island 注册流程，也不能替代新的版本门禁。

已核对 Tower 4.9 永久区域的筛选规则：普通常驻 Island 不得填写 `metadata.version`，否则该区域不会返回它。框架发布版本保存在 `metadata.info.version`，注册键固定为 `pluginkit`。

通过 API 紧急禁用：`POST /api/pluginkit/v1/disable`，无需请求体，必须提供有效 Tower 身份和允许的 Origin。正常管理使用 `POST /enable` 恢复。

Web 或 API 不可用时，优先使用便携式 CLI 的 `disable`：它仅需 SSH，直接写入已识别布局的禁用标记，不依赖健康的 Tower API 或 Kubernetes 控制面。参数与信任校验见 [CLI 文档](../cli/README.md)。如果服务 Pod 仍可用，也可在 CloudTower VM 执行既有数据 CLI：

```bash
kubectl -n cloudtower-system exec deployment/pluginkit -- node cli.mjs disable --data /var/lib/pluginkit
```

服务进程失效时，可用同版本运行时直接执行 `cli.mjs disable --data <绝对数据目录>`。CLI 不依赖 HTTP、Tower 登录或插件配置；禁用标记持久化，重启不会自动恢复。已卡住的浏览器需刷新后停止加载插件。框架入口保持可用，禁用的是所有子插件。

## 管理契约

- 上传只校验和持久化，不执行插件代码；包摘要不可变。安装、更新、回滚均默认禁用；更新必须提高版本。只有管理员可进行写操作。
- 更新保留配置并备份。0.1 拒绝配置 schema 版本变化，避免执行未经验证的迁移；相同 schema 的前端更新和回滚已实现。
- 已安装插件只将更高版本的已上传安装包列为可更新条目；当前版及旧版不重复显示。旧包仍保留供回滚使用，隐藏条目不会删除安装包、配置或历史。
- 重置先备份原配置字节再恢复默认；损坏配置也可以明确重置。卸载移除活动注册，保留配置和包，允许重装。
- 新安装器更新前保存资源、数据和 Island 备份及恢复记录，只管理带有自身所有权标记的资源。框架自身更新通过 CLI 进行；子插件可手动上传或通过 GitHub 版本清单联网检查与下载，均经包校验和升级确认。框架 Web 自更新尚未实现，不能把子插件上传包作为框架服务程序执行。
- 功能配置独立文件、同一插件最后成功保存为准；只有个人界面偏好存浏览器。统一配置契约见 [配置 API](../docs/pluginkit-configuration.md)。
- 正式 Island 订阅宿主共享 `@tower/i18n` 的当前语言与 languageChanged 事件；演示/独立入口读取宿主 locale、全局 language.value 或文档 lang。框架不写入或另存语言偏好。
- PluginKit 服务让 Tower 验证当前登录身份及管理员角色，不本地信任解码后的 token。Authorization 只转交同一 Tower，认证头、Cookie 和设置值不进入审计日志。
- 前端资产是公开代码；只服务已启用插件的 `web/*.js/css`，不公开配置、会话和数据目录。0.1 没有签名发布者信任体系，SHA-256 只校验完整性。

## 审计

所有管理操作本地记录开始、成功或失败，可通过插件中心“操作日志”查询。日志保留操作者、时间、动作、插件 ID、结果和错误码，不记录设置正文。读取最新 1 MiB，分页单次最多 100 条；持久日志文件当前不自动清理，应在后续运维策略中确定轮转与保留期。

Tower 原生对接使用公开 `POST /v2/api/create-user-audit-log`，包含中英文 message、当前真实 user_id 和 `resource_type: pluginkit`。本地保存成功与原生镜像状态分别记录；失败不删除本地日志或伪报原生成功。异步任务响应在核对完成前不当作已成功。CLI 身份不伪造 Tower 用户。

测试 Tower 4.9 RC 的真实接口验收返回“仅允许系统用户”，普通 root 也不能写入。当前不会借用系统用户、改权限或直接写数据库；遇到此限制后停止重复镜像。日志内容与记录详情保留错误码、已知原因说明及原生副本失败状态，不在页面顶部常驻提示。插件中心仍可查询 PluginKit 操作日志，原生审计接通需要官方支持的系统身份集成。

## 子插件联网更新

“检查更新”由后端读取固定仓库中的 `catalog/plugins.json`，仅在用户操作时联网。升级入口提供自动联网与手动上传两种方式；自动下载必须校验发布清单中的 SHA-256、插件 ID 和版本，下载完成后仍进入统一升级确认流程。包校验只保证完整性，不等于发布者签名信任。

仓库为私有时，需由受控的服务端秘密注入 `PLUGINKIT_GITHUB_TOKEN`；没有访问权限会显示明确失败并保留手动上传。令牌不会提供给浏览器，也不会随重定向发送至 GitHub 资产下载域。当前版本清单的制品标识为空，不能据此承诺已发布可下载的升级包。该配置注入需要独立部署操作，本轮不自动设置真实环境凭据。

## API

所有路径前缀 `/api/pluginkit/v1`：

| 路径 | 方法 | 用途 |
|---|---|---|
| `/config` | GET / PUT | 聚合读取、按 pluginId 保存独立配置 |
| `/runtime` | GET | 框架开关、版本与审计接入状态 |
| `/disable`、`/enable` | POST | 紧急禁用、明确恢复 |
| `/packages` | POST | 上传已校验的 PluginKit JSON 包 |
| `/updates` | POST | `check` 检查子插件版本；`download` 校验并暂存指定升级包 |
| `/plugins` | GET / POST | 清单与 install/update/rollback/enable/disable/reset/uninstall |
| `/logs` | GET | 最近操作日志，可按插件过滤与分页 |

## 尚未实现的边界

故障隔离、框架 Web 自更新、自动配置 schema 迁移、后端可执行子插件、签名与发布者管理尚未实现。不能将此版本视为任意第三方代码的安全运行平台。真实 BMC 登录能力由具体插件单独说明。

采用仓库 MIT 许可证，非 SmartX 官方产品。

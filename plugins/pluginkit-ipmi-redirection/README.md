# pluginkit-ipmi-redirection

本项目是 PluginKit 的首个功能子插件，由框架的常驻 Island 加载，增强主机概览中的 IPMI 地址。0.1 已在获准的 CloudTower 4.9 RC 测试环境部署，尚未连接真实 BMC 或启用真实自动登录。 许可证为 [MIT](LICENSE)，源码位于 [smartx-extensions 仓库的插件子目录](https://github.com/sephirothchang/smartx-extensions/tree/main/plugins/pluginkit-ipmi-redirection)。

0.1.1 为界面修订版：移除主机协议状态说明，将规则优先级收纳至“例外规则”标题旁的信息提示；保持插件 ID、权限、配置 schema 与默认配置不变，可通过现有升级流程保留配置升级。版本清单中的发布资产仍为空时，不提供自动下载包。

## 本地运行

使用 Node.js 22、npm 和系统 `tar`。依赖及版本由 `package-lock.json` 锁定。

```powershell
# 在 smartx-extensions 仓库根目录执行
npm run setup
npm run build
npm run package
npm run demo -- pluginkit-ipmi-redirection
```

- 开发示例地址（启动演示后使用）：模拟 Tower 为 `http://127.0.0.1:43170/`。
- 开发示例地址（启动演示后使用）：模拟 BMC 网关为 `http://127.0.0.1:43171/`。
- 两个监听器仅绑定 `127.0.0.1`；关闭运行命令即可停止。

演示页中的 IP 是展示数据。点击时只打开本地网关，**不会访问所展示的真实 IP**。

## 已实现

- 全局常驻区域：`PERMANENT_CLUSTER_MANAGER_MODAL`。
- 正式运行由框架加载 `window.PluginKitPlugins['pluginkit-ipmi-redirection']` 子插件工厂，不覆盖原有 `hostIsland`；旧独立 Island 导出仅保留兼容。
- 只增强主机概览的 IPMI 字段；保留复制按钮，支持切换主机、React 重绘、禁用和卸载清理。
- 主菜单“设置 / 标签管理”之后添加“插件配置”；右下角“插件设置”打开同一个面板。
- 可以隐藏右下角按钮，继续从主菜单打开配置。识别到菜单结构不兼容时临时保留悬浮入口。
- 只有按钮显隐等个人偏好保存到当前站点的浏览器，键为 `pluginkit.personal.v1`。旧浏览器配置只用于读取按钮显隐，不自动导入或回写全局功能配置，旧键保留供人工核对。
- 功能开关、打开方式、登录方式、全局默认厂商及例外使用服务端共享配置，必须点击“保存”后生效。读取到的每个新集群自动生成一条例外草稿；已删除或修改的已知规则不反复生成。
- 增加保存按钮；未保存时点击完成、关闭、遮罩或 Esc，会提供“取消 / 丢弃并退出 / 保存并退出”。保存失败保留草稿。
- BMC 规则优先级：**特定主机 → 所属集群 → 全局默认**。对象从资产选择器选择，同范围同对象不能重复配置；空规则不生效。
- 全局默认使用通用 BMC，新增例外默认按集群添加；保留既有明确选择。
- 收录 SmartX SMTX OS HCL 的全部 29 家厂商、158 条型号记录；在设置中展开“厂商接口与兼容机型”可筛选查阅，不影响规则配置。
- 为 Dell、联想、HPE、H3C、Huawei、超聚变、浪潮、Supermicro、GIGABYTE、宝德配置服务端 Redfish 会话与设备信息读取；完成模拟契约测试，未验证真实硬件。其他 19 家保留登录页跳转和型号参考。
- MegaRAC 服务端请求/响应适配和本地跨来源会话模拟；其他厂商的网页自动登录仍未接入。API 会话不等于网页免密。

完整型号与来源见 [CSV](data/hcl-models.csv) 和 [BMC 接口接入说明](docs/bmc-interfaces.md)。HCL 是服务器兼容清单，不能作为所有型号、BMC 固件的协议兼容承诺。

本插件通过 PluginKit 框架加载；正式子插件包为 `release/pluginkit-ipmi-redirection-0.1.1.pluginkit.json`，通过插件中心上传、安装和启用。旧 Island 包仅保留兼容验证，不应与框架同时注册，以免重复入口。

PluginKit 统一 API 为 `/api/pluginkit/v1/config`：GET 获取按插件 ID 隔离的配置集合；PUT 携带 `pluginId` 和 `settings`，只更新指定插件。同一插件以服务端最后成功保存的版本为准，不覆盖其他插件的配置。演示服务持久化到 `.runtime/pluginkit/plugins/pluginkit-ipmi-redirection/config.json`，不在静态资源目录中，重启后保留。演示使用固定模拟管理员，仅限回环地址；正式服务由 Tower 验证身份，详见框架说明。 接口与接入要求见 [共享配置 API](../../docs/pluginkit-configuration.md)。

## 演示验证

1. 点击 IPMI 地址：默认打开本地模拟登录页。
2. 从两个入口任意一个打开配置；在“全局偏好”隐藏悬浮按钮，从主菜单再次打开。
3. 检查自动生成的集群例外；修改厂商后分别验证取消、丢弃并退出和保存并退出。配置默认 Dell、集群例外联想、某主机例外 AMI，保存后观察实际协议。
4. 选择“厂商自动登录 · 模拟”并保存。只有最终匹配 AMI 的主机进入本地模拟自动登录；未适配厂商继续普通跳转。
5. 模拟网关在自身来源下建立会话，检查 Cookie 和 CSRF，显示“模拟会话已建立”。它使用明确标记的模拟凭据，不读取真实 SSH/MongoDB/BMC 凭据。

## 构建与打包

```powershell
npm run build
npm run package
```

正式构建位于 `dist/production/build/`。演示 Island 和模拟网页位于 `dist/demo/`，与正式构建独立。正式包中没有演示网关 URL、模拟凭据、真实凭据或服务端登录适配器；默认只提供 HTTPS 地址跳转，自动登录选项不可用。

本地制品：`release/pluginkit-ipmi-redirection-0.1.1.tar.gz`。名称和清单、包名一致；此前旧名称制品不再使用。

```text
sea-map.json
build.tar.gz
  └─ build/
     ├─ remoteEntry.js
     └─ 其他 JS / source map / LICENSE 文件
```

安装由 [PluginKit 框架](../../framework/README.md) 统一管理。当前只在获准的 Tower 4.9 RC 测试环境验收，不能称为厂商支持或所有版本兼容；详见 [0.1 验证范围](../../docs/0.1-validation.md)。

## 代码入口

| 文件 | 职责 |
|---|---|
| `src/definition.js` | 正式子插件工厂、配置页和功能激活/清理 |
| `src/island.js` | 旧独立 Island 兼容入口 |
| `src/plugin-hub.js` | 原型兼容包装，统一界面已提取到框架 |
| `src/dom-enhancer.js` | IPMI 字段增强、状态变化与清理 |
| `src/menu-bridge.js` | 主菜单 DOM 适配 |
| `src/preferences.js` | 浏览器偏好白名单、迁移兼容、跨标签同步 |
| `src/config-store.js` | 功能配置草稿、共享 API、显式保存与个人偏好组合 |
| `src/configuration.js` | 功能配置 schema、集群规则生成和校验 |
| `src/identity.js` | 插件 ID 与许可证信息 |
| `server/config-repository.js` | 旧原型迁移回归夹具；运行时使用框架独立文件仓储 |
| `src/bmc-profiles.js` | 厂商定义、配置校验与优先级 |
| `src/bmc-settings.js` | BMC 全局与例外编辑器 |
| `src/inventory.js` | 使用共享 Apollo Client 的只读资产查询 |
| `server/megarac-adapter.js` | 服务端 MegaRAC 协议适配，显式注入传输层 |
| `server/bmc-api.js` | 服务端厂商 API 入口与读取后退出的生命周期 |
| `server/redfish-adapter.js` | Redfish 资源发现、会话、设备摘要和退出 |
| `src/vendor-registry.js` | 29 家厂商与 AMI/通用协议选项、官方资料和支持边界 |
| `data/hcl-catalog.json` | 可追溯的完整 HCL 型号快照 |
| `scripts/import-hcl.js` | 离线重现或显式刷新公开 HCL 数据 |
| `demo/gateway.js` | 仅本地的模拟会话网关 |

当前配置面板只包含实际实现的 IPMI 插件。后续插件可在统一面板中增加自己的设置页；目前没有实现通用插件市场、任意第三方模块发现或安装功能。

## 验证与边界

- `npm test` 覆盖 DOM 目标识别、复制按钮保留、切换主机、撤销增强、菜单重建、浏览器偏好、BMC 规则优先级、输入过滤、登录超时、强制改密停止、一次性票据和会话检查。
- 已使用浏览器验证本地 Module Federation 加载、普通跳转、模拟自动登录及配置入口。
- 共享配置的跨浏览器读取与同插件最后保存生效使用本地持久化和模拟独立客户端验证；演示不模拟真实 Tower 账户鉴权，正式接入仍须实现会话验证、管理员写权限、审计和持久卷。
- 真实 Tower 页面只读核对了菜单 DOM，未注入此插件。资产 GraphQL 查询已用模拟 Apollo Client 验证契约，未在真实 Tower 上运行本项目的查询。
- DOM 适配依赖当前界面结构。不能保证其他 Tower 版本、主题、全部语言或所有角色权限下兼容。
- 实际 BMC 的 Cookie/页面代理、绝对资源路径、跳转、证书、WebSocket/KVM、固件差异和真实权限接入尚未验证。
- 生产自动登录还需要独立凭据代理与会话网关，不能仅把服务端登录结果重定向给浏览器。详见 [设计说明](docs/architecture.md)。

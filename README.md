# Rivetin

SmartX 功能增强插件与扩展集合。各插件作为独立子项目维护，统一存放在本仓库中。

项目品牌为 **Rivetin**，官网为 https://rivetin.dev；[GitHub 仓库](https://github.com/sephirothchang/rivetin)。项目统一命名与配置路径见[命名规范](docs/rivetin-naming.md)。

## 仓库结构

```text
smartx-extensions/
├── README.md
├── LICENSE
├── docs/                     # 共享开发规范与配置 API
├── cli/                      # 三平台自包含 CLI、版本适配与安装恢复
├── catalog/                  # GitHub 子插件版本及发布包清单
├── framework/                # Rivetin 框架、管理服务、CLI 与部署
└── plugins/
    ├── README.md
    ├── rivetin-ipmi-redirection/
    ├── rivetin-ssh-channel/
    ├── rivetin-disk-smart-info/
    └── rivetin-context-menu/
```

## 插件目录

| 插件 | 功能 | 状态 |
|---|---|---|
| [Rivetin](framework/README.md) | 插件中心、生命周期、独立配置、紧急禁用、操作日志 | 0.1；故障隔离 TODO |
| [rivetin-ipmi-redirection](plugins/rivetin-ipmi-redirection/README.md) | 主机 IPMI 跳转、BMC 协议配置 | 0.1；真实 BMC 自动登录未完成 |
| [rivetin-ssh-channel](plugins/rivetin-ssh-channel/README.md) | 全局及例外凭据、只读命令审计、独立授权和调度 | 0.1.1；连接设置界面已实机验证，真实主机采集待验收 |
| [rivetin-disk-smart-info](plugins/rivetin-disk-smart-info/README.md) | 物理盘 SMART 页面、采集数据与每日历史 | 0.1.1；共享接口和页面已受控验证，真实采样待验收 |
| [rivetin-context-menu](plugins/rivetin-context-menu/README.md) | 按资源提供分组菜单与受控操作表单 | 0.2.6；菜单与表单的实机只读验收通过，实际资源写入待验收 |

## 本地开发

使用已构建 CLI 的用户请阅读 [便携式安装器](cli/README.md)。客户端不需要以下源码构建工具。

使用 Node.js 22、npm 和系统 `tar`。每个插件保留独立的依赖和锁文件，根目录不安装或提升插件依赖。

```powershell
npm run setup
npm test
npm run build
npm run package
npm run demo -- rivetin-ipmi-redirection
```

只处理指定插件时，可在命令末尾传入插件 ID，例如 `npm run build -- rivetin-ipmi-redirection`，也可以进入子目录使用插件自己的命令。

共享配置使用 Rivetin 统一 API，详见 [配置与保存规范](docs/rivetin-configuration.md)。框架使用独立后端，由 Tower 验证登录身份及管理员角色。安装、应急恢复及版本边界见 [Rivetin](framework/README.md)。

便携式 CLI 使用独立 Go 模块和显式嵌入资源，源码构建及平台验证边界见 [CLI 文档](cli/README.md) 和 [安装器验证范围](docs/portable-cli-validation.md)。公开文档与示例的检查及整改见 [公开内容检查](docs/public-content-review.md)。

## 开发约定

- 每个插件放在 `plugins/<plugin-name>/`，目录名使用小写字母和短横线。
- 各插件独立管理代码、依赖、配置示例和测试。
- 每个插件提供自己的 `README.md`，说明功能、适用版本、安装配置和使用方法。
- 插件可独立发布，版本标签采用 `<plugin-name>/v<version>`，例如 `example-plugin/v1.0.0`。
- 通用资料在确有需要时集中维护，避免重复。

本项目由社区独立开发，非 SmartX 官方产品。代码采用 [MIT](LICENSE) 许可证，按“现状”提供。仓库当前保持私有，0.1 为开发测试环境版本；验收记录见 [0.1 验证范围](docs/0.1-validation.md)。

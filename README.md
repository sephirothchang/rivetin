<p align="center">
  <img src="https://rivetin.dev/assets/mark.svg" alt="Rivetin 标识" width="64" height="64">
</p>

<h1 align="center">Rivetin</h1>

<p align="center">
  Small extensions. A better CloudTower.
  <br>
  让实用的扩展，在同一个 CloudTower 管理空间中协同工作。
</p>

<p align="center">
  <a href="https://rivetin.dev/"><strong>官网 Website</strong></a>
  &nbsp; · &nbsp;
  <a href="https://rivetin.dev/guide.html"><strong>使用文档 Docs</strong></a>
  &nbsp; · &nbsp;
  <a href="https://rivetin.dev/catalog/v4/plugins.json"><strong>插件清单 Catalog v4</strong></a>
  &nbsp; · &nbsp;
  <a href="https://rivetin.dev/catalog/plugins.json"><strong>历史清单 v3</strong></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-536d82?style=flat-square" alt="许可证：MIT">
  <img src="https://img.shields.io/badge/CloudTower-4.9.0-536d82?style=flat-square" alt="声明的 CloudTower 版本：4.9.0">
  <img src="https://img.shields.io/badge/Framework_API-1-536d82?style=flat-square" alt="框架 API：1">
</p>

---

## 简介

Rivetin 是一个面向 CloudTower 的独立扩展平台。框架提供统一的插件中心、生命周期管理、独立配置、紧急禁用和操作日志；插件在共享契约下独立开发与维护。

本仓库包含框架、便携式 CLI 与插件源码。项目由社区独立开发，**并非 SmartX 官方产品，也未获得 SmartX 背书**。

## 插件与扩展

框架 0.2 的新版兼容包以[公开 v4 清单](https://rivetin.dev/catalog/v4/plugins.json)为准；[v3 历史清单](https://rivetin.dev/catalog/plugins.json)独立保留框架 0.1 的历史包和草稿。源码开发版本、已发布包和真实部署状态分别核验；下载路径与 SHA-256 以对应清单为准。

| 插件 | 清单版本 | 状态 | 能力 |
| :--- | :--- | :--- | :--- |
| [IPMI Redirection](plugins/rivetin-ipmi-redirection/README.md) | `0.1.4`（v4） | 已发布，适用框架 `>=0.2.0 <0.3.0` | 主机 IPMI 地址 HTTPS 跳转和厂商协议配置 |
| [SSH Channel](plugins/rivetin-ssh-channel/README.md) | `0.1.1`（v3） | 框架 0.1 历史发布包 | 共享的受控 SSH 采集、命令审阅与授权 |
| [Disk SMART](plugins/rivetin-disk-smart-info/README.md) | `0.1.3`（v3） | 框架 0.1 历史发布包 | 物理盘 SMART 信息、采样比较与历史 |
| [Context Menu](plugins/rivetin-context-menu/README.md) | `0.4.2` | 清单草稿 | CloudTower 原生操作入口；清单条目未发布 |

Network Topology 仍为本地演示，Policy Converter 仍为离线预览；二者尚未发布，也没有已接受的 CloudTower 构建声明。扩展能力、状态与下载入口可在[官网扩展库](https://rivetin.dev/#extensions)查看。

## 兼容性与当前状态

- 已发布插件声明 **CloudTower 4.9.0** 与 **框架 API 1**，仍须核对具体构建和框架版本范围。IPMI `0.1.4` 使用 schema 2，范围为 **Rivetin >=0.2.0 <0.3.0**；历史 IPMI `0.1.2` 保留在 v3。v3 Disk SMART 的最低版本声明不代表通过框架 0.2 门禁；SSH 采集还须针对目标主机单独验证。
- 框架 **0.1.5** 已在 CloudTower 4.9.0 开发测试环境完成受控升级与日志界面验收。声明的版本号不能代表所有构建或生产环境均已验证。
- 框架 **0.2.0** 已完成受控 CLI 实机升级、独立后验与中文组件状态页面核对；源码已同步，安装器尚无公开下载。验证与未完成事项见 [0.2 验证范围](docs/0.2-validation.md)。未发布的插件候选不等于可从市场安装的版本。
- 框架 0.2 使用更严格的兼容性声明：0.1 插件包的最低版本字段不代表自动兼容 0.2。旧声明不能通过新门禁，须由插件发布新的明确兼容版本。
- IPMI **0.1.4** 已在框架 **0.2.0** 和一个准确的 CloudTower 4.9.0 开发测试 profile 中完成受控部署、内置浏览器安全用例、配置恢复及生命周期验收；不包含 BMC 网页自动登录、KVM、实际剪贴板操作或不同管理员验收。 在框架 **0.2.2** 新组合中，另完成了单个主机上下文、配置原值与 HTTPS 链接呈现的只读检查，以及完整文件、配置和资源身份的前后保护核对；该新增范围不包含保存、生命周期操作或实际非法请求提交。
- 框架 **0.2.2** 已在 CloudTower 4.9.0 开发测试环境完成受控升级、启停后验及中文三种视口的内置浏览器验收。个人设置、框架运行状态、旧兼容声明说明和 SSH 命令的插件分组、类别、范式与实际计划已核对；组件注册、网关和组件 API 检测已接线。其他未接入检测仍保留未知，真实英文界面和故障恢复演练没有据此视为通过。
- SSH **0.1.2** 与 Disk SMART **0.1.6** 已在框架 **0.2.2** 开发测试环境完成受控升级、停用状态下的限定只读界面检查及配置、连接和旧备份保护回读，尚未进入公开市场。新版兼容声明和命令分组、类别、`<disk>` 范式、实际计划来源与数量已核对；停用插件的设置正文、真实主机命令、连接迁移、审批、采集和跨日任务未据此视为通过。现有连接资料不会自动迁移或扩大授权。
- Context Menu **0.5.7** 的首次列表菜单、键盘操作和原生表单初值读取、取消已在真实环境核对，但 A→B→A 返回后的 CPU 编辑入口未打开，实际验收失败，未发布。**0.5.9** 是修复该恢复路径与排队路由事件处理的固定候选，已完成本地回归和限域独立审查，仍待重新部署与真实环境复验。0.5.6 的首次列表右键失败记录也保留。
- 尚未取得有效的真实主机 SMART 健康样本，跨日计划执行仍待验证。BMC 自动登录的真实适配尚未完成。
- 第三方插件代码隔离仍待实现。Tower 原生审计写入受系统用户限制；Rivetin 保留自己的操作日志，不将其描述为已接通原生审计。

安装前请查看[框架说明](framework/README.md)、[安装器验证范围](docs/portable-cli-validation.md)与[实机验证记录](docs/0.1-validation.md)，并核对具体制品和环境。

## 安装与开发

### 使用便携式 CLI

便携式 CLI 提供安装、更新、扩展管理和恢复流程。使用已经取得的经过验证的客户端时，用户设备无需另装 Node.js、Python、SSH 或 `kubectl`。框架安装器目前没有公开下载；安装要求和平台范围见 [CLI 文档](cli/README.md)。

### 从源码开发

插件各自维护依赖与锁文件。仓库级插件任务使用 Node.js 22 或更高版本、npm 与 `tar`：

```sh
npm run setup
npm test
npm run build
npm run package
```

只处理指定插件时，可传入插件 ID，例如 `npm run build -- rivetin-ipmi-redirection`。便携式 CLI 使用独立 Go 模块及构建资源；源码构建要求见 [CLI 文档](cli/README.md)。共享设置和保存行为见[配置规范](docs/rivetin-configuration.md)。

## 仓库结构

```text
rivetin/
├── framework/  # 扩展中心、管理服务与框架
├── cli/        # 便携式 CLI 与安装流程
├── plugins/    # 独立维护的插件
├── catalog/    # 官网市场清单与发布流程
└── docs/       # 共享契约与验证资料
```

## 作者与许可

由 **Sephiroth Chang 与 Rivetin contributors** 开发维护，采用 [MIT 许可证](LICENSE)。

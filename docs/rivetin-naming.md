# Rivetin 命名与配置路径

项目品牌为 **Rivetin**，官网为 https://rivetin.dev。GitHub 仓库为 `sephirothchang/rivetin`；本地检出目录名由开发者选择，不改变品牌、插件 ID 或部署数据路径；工具链根据当前项目位置解析项目内资源。所有新代码统一命名，不提供旧 PluginKit ID、目录、API 或包格式的兼容别名。

| 对象 | 规范 |
|---|---|
| 项目和界面展示 | Rivetin |
| CLI 命令及客户端文件前缀 | `rivetin` |
| 子插件 ID、源码目录及包名 | `rivetin-<功能名称>` |
| 源码描述文件 | `rivetin.json` |
| 插件包及前端格式 | `rivetin-package-v1`、`rivetin-global-v1` |
| 插件包后缀 | `.rivetin.json` |
| 管理与配置 API | `/api/rivetin/v1` |
| 前端工厂与 SDK | `window.RivetinPlugins`、`window.RivetinSDK` |
| 框架 Island scope / 导出 | `rivetin` / `./Rivetin` |
| Kubernetes 资源名和标签 | `rivetin` |
| Tower 安装根目录 | `/var/cache/appcache/rivetin` |
| 容器代码及数据目录 | `/opt/rivetin`、`/var/lib/rivetin` |
| 服务端配置目录 | `<数据根>/plugins/rivetin-<功能名称>/` |
| 环境变量前缀 | `RIVETIN_` |
| 浏览器个人偏好键 | `rivetin.personal.v1` |

每个子插件独立保存配置及生命周期状态。功能配置由服务端共享，必须显式保存；浏览器只保存个人界面偏好。配置正文和业务资源 ID 不参与品牌改名。

框架拒绝旧插件 ID 和旧包格式，不读取旧 API、环境变量或个人偏好键，不搜索旧数据目录，也不自动导入旧部署。历史制品、备份和原始版权声明可以保留原名，但不作为当前运行时的回退输入。

旧品牌部署不能直接视为当前 Rivetin 安装。切换真实环境前，必须单独备份旧部署与数据，明确卸载旧实例、安装新实例及配置录入步骤，并安排验收窗口。源码改名和本地测试不会自动删除、迁移或修改旧环境数据。

本次改名不新增 CloudTower 版本支持。安装、启用和升级仍须通过精确兼容性检查；故障隔离仍为 TODO。

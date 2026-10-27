# Rivetin 子插件市场目录

`plugins.json` 使用 `schemaVersion: 2`，由框架服务端通过固定 GitHub 仓库 API 读取。目录不是可执行代码，也不能授予主机访问、SSH 命令或管理员权限。运行时校验实现位于 `framework/server/updates.js`；最终安装包仍须通过 manifest、摘要、兼容性和生命周期检查。

## 条目格式

每个插件 ID 在目录中最多出现一次，保存当前候选版本。目录最多 500 项，下载与解析另有大小上限。

| 字段 | 约束 |
|---|---|
| `id` | `rivetin-` 前缀，小写字母、数字和短横线，最多 100 字符 |
| `version` | 三段数字版本，不含前导零或预发布后缀 |
| `frameworkApi` | 当前为 `1`，须与 compatibility 一致 |
| `status` | `draft` 或 `published` |
| `assetId` | 已发布 GitHub Release 的真实资产 ID；草稿为 `null` |
| `sha256` | 最终完整插件包的 64 位小写十六进制 SHA-256；草稿为 `null` |
| `name`、`description` | 含 `zh-CN` 与 `en-US`；名称各最多 120 字符，说明各最多 500 字符 |
| `author`、`license` | 作者最多 120 字符；当前许可证为 `MIT` |
| `permissions` | 最多 20 个不重复的权限名称；最终包还须通过框架支持的能力白名单 |
| `compatibility` | 下述机器可判定兼容声明 |

`published` 必须同时具有真实资产 ID、摘要与非空测试版本列表。`draft` 的资产 ID 和摘要必须均为 `null`。本地构建、测试通过或源码推送不等于已发布，不能据此设置为 `published`。当前随仓库提供的 IPMI 条目仍为草稿，没有可下载安装按钮。

## 兼容性声明

包 manifest 与市场条目使用相同字段：

```json
{
  "frameworkApi": 1,
  "tower": "Only explicitly tested Tower versions are supported.",
  "towerBuilds": ["4.9.0"],
  "frameworkMinVersion": "0.1.0",
  "frameworkMaxVersionExclusive": "0.2.0"
}
```

此处版本仅用于说明格式，不替代插件自己的验收记录。`towerBuilds` 保存后端可信探测所使用的 **CloudTower 报告版本或构建标识**，最多 20 个，必须精确匹配。`4.9.0` 不能解释成某个已确认的镜像 RC 构建，也不表示所有内部实现相同。检测来源报告粗粒度版本时，应如实保留其粒度；CLI 对镜像构建的安装兼容检查是另一道独立限制。

不接受通配符、URL、镜像路径、`v` 前缀或按描述文字猜测版本。框架最低版本包含边界，最高版本不包含边界；比较按数字版本进行。最低与最高版本为可选项，填写时必须形成有效范围。

未知 Tower 版本返回 `TOWER_BUILD_UNKNOWN`；缺少或留空测试版本列表返回 `PLUGIN_COMPATIBILITY_UNDECLARED`；版本、框架 API 或框架范围不符返回 `PLUGIN_INCOMPATIBLE`。这些限制必须在服务端安装、启用等执行边界检查，不能只依赖浏览器禁用按钮。

## 发布和下载核验

先在目标 Tower 与框架版本上完成验收，再更新包的机器兼容声明并构建最终包。创建真正的 Release 资产、取得其资产 ID 与摘要后，才可将目录标为 `published`。不要覆盖旧版制品来伪装同一版本；版本变化应遵循项目升级规则。

市场只返回校验通过且 `published` 的条目。下载没有“必须已安装”的前提，因此同一机制可供首次市场安装使用。服务端校验最终包的完整摘要、插件 ID 和版本，还会核对其名称、说明、作者、许可证、权限及兼容声明是否与市场展示一致；不一致返回 `UPDATE_METADATA_MISMATCH`。目录中的兼容信息不是最终权限依据，下载后的包仍须通过当前环境的兼容性检查。

仓库访问凭据只在服务端使用；下载重定向仅允许既定的 GitHub API 和资产域，跨到资产域时移除 API 凭据。读取与重定向次数、下载大小和超时均有限制。

## 从目录 v1 迁移

旧 `schemaVersion: 1` 缺少发布状态和机器兼容元数据，新市场读取器会明确拒绝并返回 `UPDATE_CATALOG_INVALID`，不会把有版本号的本地包自动列为可安装产品。应将条目升级为 v2，未发布项目保留为草稿。

旧插件 manifest 的文字兼容说明仍可被解析，供管理员查看或受控迁移；缺机器字段不会自动获得兼容资格，也不会依据名称、描述或以前的安装状态放行。如何迁移既有安装由框架统一处理，市场读取器不改写已存安装包或配置。

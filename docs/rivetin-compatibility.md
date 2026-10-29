# Rivetin 兼容性声明与产品版本来源

兼容性由后端判定。描述文件、市场说明、浏览器页面和管理员配置均不能自行授予执行资格。框架自身和子插件分别声明兼容范围，执行时需要同时满足；安装器的精确镜像与组件布局门禁仍是独立要求。

## 框架自身声明

`framework/shared/framework-compatibility.js` 导出只读 `FRAMEWORK_COMPATIBILITY`，包含声明 schema 版本、框架 API、当前 `FRAMEWORK_VERSION` 和已测试的 Tower 产品版本列表。当前列表为 `4.9.0`。

`checkFrameworkCompatibility({towerBuild})` 只核对可信后端提供的 Tower 产品报告版本。它不能验证镜像 RC、Node 运行时、安装目录或 Kubernetes 资源所有权；这些仍由便携 CLI 的精确 profile 校验。支持产品版本 `4.9.0` 不表示接受所有包含这个前缀的镜像。

## 子插件 compatibility schema 2

插件继续使用 `manifestVersion:1` 和 `rivetin-package-v1`；只将 `manifest.compatibility` 升为 `schemaVersion:2`：

```json
{
  "schemaVersion": 2,
  "frameworkApi": 1,
  "frameworkMinVersion": "0.2.4",
  "tower": "Only explicitly tested Tower versions are supported.",
  "towerBuilds": ["4.9.0"],
  "smtx": "none"
}
```

上例说明字段格式，不替代每个插件的测试记录。自框架 0.2.4 起，框架版本只检查必填的 `frameworkMinVersion`，按三段数字比较并包含最低边界，不设置最高版本门槛。`frameworkApi` 仍必须为 1；`towerBuilds` 仍必须是非空、不重复的精确已测试版本，最多 20 项。文字 `tower` 仅作说明。通过最低版本条件不证明未来任意框架或所有功能都已经实测。

### 旧字段与读取版本

已有 schema 2 包中的 `frameworkMaxVersionExclusive` 作为废弃元数据保留原始值，仅校验旧字段的三段数字格式；不比较上下界、不参与兼容性判定或更新元数据的语义指纹，也不在组件兼容性详情及支持包投影中展示。框架版本等于或高于该旧值时，只要最低版本及其他原有条件满足，0.2.4 即可判定兼容。已发布包和目录不原地改写，不因这项策略修改包摘要或已有发布身份。

不含该旧字段的新 schema 2 声明要求 `frameworkMinVersion` 至少为 `0.2.4`，如上例；生产工具与包／目录校验拒绝省略字段却宣称更低最低版本，不自动替作者改高声明。原因是 0.2.2／0.2.3 的严格解析器仍强制要求该字段，不能读取新声明。

这个旧解析边界也适用于整个 V4 市场目录：新增一条无上限字段的记录，可能使旧框架拒读整份目录，即使新记录写了最低 0.2.4。继续服务旧框架的目录和新包可以保留已废弃字段作为旧解析器需要的语法信息，新框架始终忽略其上限含义；采用无该字段的生产目录须明确以 0.2.4 为读取基线。当前策略不自动创建新目录、V5、双 feed 或改写既有清单。后续具体发布按实际消费者基线安排。

版本采用三段数字，可在产品版本后附精确的小写发布标识；框架范围仅接受三段数字。不接受通配符、前导零、URL、镜像路径、空白或按说明文字猜测兼容性。

### SMTX 不作为准入条件

`smtx` 可省略或设为字符串 `"none"`。两者均不要求、不读取 SMTX 产品快照，不因无法查询 SMTX 而阻止其他版本条件已经满足的插件。

这不会绕过实际资源权限、具体 API 适配器限制或 SSH 人工审批，也不证明插件的任意功能都可用于所有 SMTX 产品。

### SMTX 有明确版本要求

设置为精确对象：

```json
{
  "product": "SMTX_OS",
  "scope": "all-managed-product-clusters",
  "builds": ["6.3.0"]
}
```

当前仅允许声明产品 `SMTX_OS` 和范围 `all-managed-product-clusters`。`builds` 必须是非空、不重复的已测试精确版本列表。其他产品或局部范围需要新的明确适配，不得自行填写绕过判定。

后端检查全部受管集群，并选择目标产品族的所有集群。每一个目标版本均须满足声明；混合集群中任一目标版本不匹配，结果为不兼容。不存在目标产品集群也不予放行。未知产品、未知版本、断连、权限不足、查询不完整或快照过期均视为未知，执行失败关闭。

非目标产品可以作为已识别的其他产品存在；不能将未知产品自动排除。当前产品读取器对整个来源采用保守策略：任何行不是正常已连接状态，就无法证明当前全局产品快照。

## 旧声明的管理能力

`validateCompatibility` 仍严格解析没有 schemaVersion 或 `schemaVersion:1` 的旧字段，供展示、备份和卸载；不会给它们填充新的版本声明。`checkCompatibility` 仅授权 schema 2，旧声明返回 `PLUGIN_COMPATIBILITY_UNDECLARED`。

旧包摘要和内容不可原地改写。维护方应发布新的不可变版本包声明兼容性；不能把上传成功解释成安装、启用或恢复审批成功。市场目录和最终包的兼容元数据需要同步验证。

## 产品快照与可信边界

`createTowerProductsProvider({request,now,timeoutMs})` 返回 `async (actor,{signal}={})`。`request` 是框架固定 Tower transport，不由客户端传入路径或 URL。

当前仅接受已经由 Tower 认证的 `source:'tower'`、`role:'ROOT'`、`admin:true` 调用者，并将该调用者身份原样转交官方 API。普通 ADMIN 的可见范围不能被视为全局范围：直接返回未知，不发起查询。不保存 Cookie、令牌或长期管理员会话，不查询主机、不执行 SSH，也不回退为其他账户。

来源按顺序执行三个固定只读 API 请求：

1. `POST /v2/api/get-clusters-connection`，请求体 `{}`，读取官方 `aggregate.count`。
2. `POST /v2/api/get-clusters`，请求体 `{first:501}`。
3. 再读取相同无过滤条件的 `aggregate.count`。

两个计数必须一致、与列表长度相同且不超过 500。拒绝重复或异常 ID、未知产品类型、异常版本和非 `CONNECTED` 状态；ID 仅用于内存校验，不进入快照。返回投影只包含产品族和版本，其他原始集群字段被丢弃。

上述字段对应官方 `Cluster.type`、`Cluster.version`、`Cluster.connect_state`、`ClusterConnection.aggregate.count`。已识别的类型是 `SMTX_OS`、`SMTX_ELF`、`SMTX_ZBS`、`BLUESHARK`。这些请求依赖已测试 Tower API 适配器；不能将此契约推广至未验证版本。

计数／列表／计数不是 Tower 事务快照，无法排除请求之间数量不变的对象替换或即时版本变化。它证明的是有界读取的一致性，不是整个未来执行期间的不可变性。副作用边界仍需重新检查环境，并在发现环境变化时停止后续执行。

读取器每次重新查询，不共享调用者身份或缓存成功结果。总预算默认 5 秒、最多配置为 10 秒；超时或取消返回固定未知码，并且晚到响应不会继续后续查询。已经发出的网络请求仍由 Tower transport 自身的有界超时结束。读取器限制请求数、行数和输出投影；原始 HTTP 响应解析前的字节上限需要由注入的 transport 实施，不能将列表上限当成响应体内存上限。

返回 DTO：

```json
{
  "schemaVersion": 1,
  "source": "tower-clusters-root",
  "trusted": true,
  "complete": true,
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "clusters": [{"product":"SMTX_OS","version":"6.3.0"}],
  "reason": null
}
```

失败 DTO 保持相同字段，`trusted:false`、`complete:false`、`clusters:[]`，`reason` 为固定 `SMTX_` 错误码，不含底层报错、认证信息、集群 ID、名称、地址或序列号。

## 判定结果与集成职责

`checkCompatibility(manifest,context)` 的 context 包含可信 `towerBuild`、`frameworkApi`、`frameworkVersion`，以及需要时的 `smtx` 快照；测试可注入数值时间 `now`。快照有效期为 30 秒，达到边界即过期；不接受未来时间或非规范 ISO 时间。省略／none 的 SMTX 条件完全不访问快照。

结果字段为 `{compatible,status,reason,testedBuilds}`：

| status | compatible | 含义 |
|---|---|---|
| `compatible` | true | 当前声明与可信环境证据匹配 |
| `incompatible` | false | 已确认版本不匹配、目标范围为空或声明无法获得执行资格 |
| `unknown` | false | 环境版本未知、证据不足／不完整／不可信／过期 |

主要判定码：`TOWER_BUILD_UNKNOWN`、`FRAMEWORK_TOWER_INCOMPATIBLE`、`FRAMEWORK_VERSION_UNKNOWN`、`PLUGIN_COMPATIBILITY_UNDECLARED`、`PLUGIN_COMPATIBILITY_INVALID`、`PLUGIN_INCOMPATIBLE`、`SMTX_SNAPSHOT_UNAVAILABLE`、`SMTX_SNAPSHOT_INVALID`、`SMTX_SCOPE_UNTRUSTED`、`SMTX_SCOPE_INCOMPLETE`、`SMTX_SNAPSHOT_EXPIRED`、`SMTX_VERSION_UNKNOWN`、`SMTX_SCOPE_EMPTY`、`SMTX_INCOMPATIBLE`。

读取器原因码另外包括 `SMTX_AUTHORITY_REQUIRED`、`SMTX_INVENTORY_LIMIT`、`SMTX_INVENTORY_INVALID`、`SMTX_CLUSTER_UNAVAILABLE`、`SMTX_INVENTORY_UNAVAILABLE`、`SMTX_CHECK_TIMEOUT`、`SMTX_CHECK_CANCELLED`。状态页可展示该安全原因；判定器仍以 unknown 返回，不把暂时无法检查误称为已证明版本冲突。

这些模块是纯判定及读取能力，不自行写配置、禁用插件或撤销审批。生命周期集成须在安装、升级、启用、回滚、资产加载和内部消费执行边界同时应用框架自身与子插件门禁。unknown 也不得执行，但应与已确认不兼容区分，供服务层决定等待检查或持久禁用；恢复不能自动重新授予 SSH 审批。

在没有合法后台身份时，不能靠保存管理员 Cookie 实现定时 SMTX 刷新。required-SMTX 的可信快照过期后应暂停相关执行，直到再次获得合法且完整的读取；不能继续使用最后一次成功证据。故障隔离和签名信任仍是独立边界，兼容通过不等于任意插件代码安全。

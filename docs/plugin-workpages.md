# 拓扑只读提供器与工作页迁移

0.2.5引入的只读数据提供器合同继续保留。2026-10-29已完成一个受控CloudTower4.9.0环境的框架024→025升级、四个既有插件保留及真实中文界面验收；两个新工作页插件尚未安装。准确范围见[验证记录](0.2-validation.md)。

当前0.2.6源码使用[UI contributions v1](plugin-ui-contributions.md)：按钮的双语label/icon/order/visibility和page/action目标由插件声明，框架只提供语义slot、宿主适配、context及生命周期。已有slot新增按钮只更新插件，不为按钮升级框架。026正在本地验证，当前真实环境仍025；源码、固定候选、部署与业务验收分开。

025内部原型workPage:{section,Component}不再用于026入口注册；workPage-only包明确UI_LEGACY_WORKPAGE_UNAVAILABLE，原Settings按旧生命周期保留。ui与workPage同时声明则整组UI拒绝，不补业务ID映射/默认首page/旧深链alias。旧未公开原型包/固定证据保全，两个插件另发min026新包，不原地重写。

页面props仍为active/locale/signal/onDirtyChange/context；context增加schemaVersion=1，section与当前clusterId语义保持。切语不重挂，换context/停用/换包清理；未装不注入。完整descriptor、唯一page-slot映射/深链、独立Settings错误边界及动作并发见上述权威合同。下文只定义数据提供器，不因此开放真实网络写。

## TOPO只读提供器

factory通过`options.networkTopology.provider`获取：

```js
await provider.listClusters({ signal });
await provider.read({ clusterId: context.clusterId, signal });
```

`listClusters`返回`{schemaVersion:1, source:'cloudtower', observedAt, complete:true, clusters:[{id,name}]}`。`read`返回下述快照。插件适配层可以取`clusters`数组供内部模型使用。所有调用支持取消；框架客户端和服务端均校验形状，不暴露原生响应、凭据、管理地址或任意查询能力。

自家HTTP均为GET，前缀`/api/rivetin/v1`：`/data/network-topology/clusters?pluginId=...`和`/data/network-topology/snapshot?pluginId=...&clusterId=...`。服务端要求当前Tower管理员、框架启用、准确插件`rivetin-network-topology`已安装启用且兼容、声明最低版本至少0.2.5及既有`inventory.read`权限；其他有inventory.read的插件不能借用。没有拓扑写接口或通用Tower请求转发。

快照字段：

| 字段 | 格式与含义 |
| --- | --- |
| `schemaVersion/source` | `1`／`cloudtower` |
| `cluster` | 准确`{id,name}`；与请求集群一致 |
| `revision` | 规范化资源快照的SHA-256；不是写入CAS令牌 |
| `observedAt/complete` | 带时区的实际读取完成时间／必需资源有界分页和关系核验是否完成 |
| `hosts` | `[{id,name}]` |
| `switches` | `[{id,name,mtu,purpose,networks:[{id,name,vlan,purpose}]}]` |
| `nics` | `[{id,name,hostId,switchId,link,speedMbps,bond,bondMode,peerId,peerPort}]`，仅物理网口 |
| `vmGroups` | `[{networkId,count}]`；本阶段无可信VM计数时空数组，不补成0 |
| `peers` | `[{id,name}]`；本阶段无LLDP提供器时空数组，NIC peer字段为null，不构造邻居 |

标识、名称、引用和全局去重必须校验；上限为200集群、128主机、128VDS、512虚拟网络、1024NIC、512VM计数组、256邻居。分页有确定顺序、总请求/数量/时间上限；重复、断引用、跨集群、超限或分页未能完整结束不返回伪完整结果。快照不保证跨原生多次读请求的数据库事务一致性，不能作为真实网络变更预检。

用途仅映射可信原生type枚举：VM→workload、MIGRATION→migration、MANAGEMENT→management、STORAGE/STORAGE_ACCESS→storage；原生internal=true优先标system，其他用途为null，不由名称推断。未知MTU、速率单位、bond成员/活跃口、VLAN覆盖或LLDP均为null/unknown。本阶段没有足够单位证据的NIC speed不写入speedMbps，link在未建立状态语义时为unknown。仅同VDS或同名端口不构成bond或冗余证明。

本地关联草稿由TOPO模块独立限定完整性、新鲜度、可信用途和保护范围，不能修改实际快照、保存到配置或触发真实应用。数据不完整、未知或读取失败不回退Demo。

## 版本与验证边界

新包的最低框架版本必须至少0.2.5。仍服务旧reader的V4目录可以保留废弃max作为旧语法载体；新框架忽略其上限。复用现有inventory.read，不引入会被旧解析器拒绝的新permission枚举或manifest字段；可选工作页仅在前端factory返回，不进入manifest。新包/新目录仍须用实际旧0.2.2/0.2.3解析器核整份清单，不将上述设计判断代替解析证据。原固定包与市场清单不原地改写。

本地组件、fixture、宿主DOM采样、原生资源形状、新固定包、实际部署及业务验收分别记录。后续框架升级保护必须包含已有身份回执与审计，不能再假设身份文件不存在。真实网络/策略写入、事务和自动回滚不属于本契约。

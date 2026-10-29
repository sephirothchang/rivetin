# UI contributions v1（框架0.2.6）

框架提供语义插槽、宿主适配、窄上下文、页面承载、生命周期及离开守卫；插件声明自身按钮与功能。同一个已支持slot新增按钮只更新插件包；新增宿主slot或Tower结构变化才补框架适配。本文是0.2.6实际实现的消费合同，框架受控部署、原四插件保留与未安装新贡献时的真实界面验收已通过；源码Git、官网发布和两个新插件的真实页面验收分别记录，准确范围见文末及[验证记录](0.2-validation.md)。它不扩展为通用后端插件引擎，也不放宽现有提供器权限。

## 定义与界限

factory原有id/store/Settings/activate不变，可返回可选ui；manifest不增加UI字段或UI权限，新包须声明compatibility schema2及frameworkMinVersion至少0.2.6。

```js
return {
  id, store, Settings, activate,
  ui: {
    schemaVersion: 1,
    pages: [{ id: 'tool', Component: ToolPage }],
    actions: [],
    contributions: [{
      id: 'open-tool', slot: 'everoute.navigation.tools',
      label: { 'zh-CN': '示例工具', 'en-US': 'Example tool' },
      icon: 'tool', order: 100,
      visibility: { requiresContext: [] },
      target: { type: 'page', id: 'tool' }
    }]
  }
};
```

ui恰含schemaVersion/pages/actions/contributions。每插件最多8页、16动作、16入口，全局最多128入口。local id使用小写字母开头的1..48位小写字母、数字或短横线，每类内唯一；框架绑定pluginId/packageId，不接受插件冒称其他所有者。未知字段、重复ID、超限、悬空引用使整组UI无效，不半注册。

pages每项恰为{id,Component}，Component必须函数，使用框架同一React实例。actions每项恰为{id,run}，run必须函数。contributions只接受id/slot/label/icon/order/visibility/target，其中id/slot/label/target必填。

label必须提供zh-CN/en-US，每项1..80字符、非空纯文本，无控制字符，不作HTML。icon省略或使用none/tool/convert/edit/network/arrow-right通用名，不接受URL/任意SVG/CSS；不选图标同样有效。order省略默认0，整数-1000..1000。visibility省略默认显示，或{requiresContext:[]}、{requiresContext:['clusterId']}；不执行函数、选择器、异步查询或表达式。显示入口不是业务执行授权。

target恰为{type:'page'|'action',id:'本插件已声明localId'}，不能跨插件引用或传原生API/URL/DOM。每page至少被一个page贡献引用，所有引用必须同一slot；孤立page、跨slot指向同page均整组无效。多个同slot入口可指向同page，只保留一个会话；页壳标题取manifest本地化名称，页面身份始终为pageId，不取某个入口label。需要不同承载面时声明不同pageId，可复用同一Component。

## 插槽、排序及上下文

| slot | 入口位置与page承载面 | context |
|---|---|---|
| everoute.navigation.tools | Everoute服务组之后、设置组之前；page显示右main，保留左导航 | {schemaVersion:1,section:'everoute',clusterId:null} |
| cluster-network-topology.toolbar.actions | 当前集群拓扑工具栏；page只替换canvas，保留集群树/标题/页签 | {schemaVersion:1,section:'cluster-network-topology',clusterId:'当前路由ID'} |

宿主适配器只知道slot与结构，不知道业务插件ID/按钮文案。插件不提供原生选择器或插入DOM；宿主不存在、上下文缺失或匹配不唯一时不挂入、不隐藏原内容，也不任意换位置。

同slot稳定按order升序、pluginId、contribution.id代码点排序，语言/加载顺序不改变结果；同label允许共存，不能互相覆盖。全局上限先按slot名称再按上述键取前128并报告UI_CONTRIBUTION_LIMIT。截断入口不单独销毁已合法打开的dirty页面；安全状态/准确包/宿主上下文仍决定存活。

框架仅在自身和插件启用、已安装兼容、准确包及配置成功加载后登记。未安装不注入按钮/占位/工作页。包替换、停用或安全失效立即撤销入口并取消该包所有会话，不被dirty阻止；清理只删除框架自有节点，恢复原生属性/选中态/相关焦点，不改写原生子树。

## 页面与动作

页面props为{active:true,locale,signal,context,onDirtyChange}。context是框架生成的窄冻结对象；集群取当前路由，不能以清单首项替代。只支持zh-CN/en-US，其他语言固定回退zh-CN；不保存独立偏好。切语更新入口和props，不重挂、重置草稿/布局/context或signal。上下文改变才取消旧会话、建立新generation，旧回调不能污染新页。

框架管理rivetinPage=<pluginId>:<pageId>，保留其余path/query。深链必须对应当前准确包的有效page、唯一slot、至少一个visibility满足的page贡献及唯一宿主；否则UI_PAGE_TARGET_UNAVAILABLE，保留原生内容，不找首page/slot或执行action。同page别名点击仅聚焦，不重挂。不同page/原生离开/浏览器返回使用统一guard：取消保原会话和signal，丢弃才卸载并恢复native；beforeunload用于刷新保护。业务已接受事务不能当本地草稿删除。

动作仅由用户点击调用run({context,locale,signal})，不传DOM、history、原生Apollo、认证头或浏览器事件，不自动导航/关闭当前dirty页。需要页面就声明target.page。相同(packageId,pluginId,actionId,section,clusterId)共享在途键，所有入口别名禁用，重复不排队；停用/换包/换context取消，迟到Promise结果丢弃。业务请求仍走自身准确提供器/权限与确认合同，UI锁不替代后端幂等。

新UI合同不让插件自行定位宿主或获取认证，沿用可信前端插件执行模型；这不是JavaScript安全沙箱，不能宣称阻止全局脚本或提供强资源隔离。旧四个已发布Settings插件的既有factory/生命周期接口保持。

## 原型迁移与独立错误边界

0.2.5工作页为未公开的内部原型；其已部署框架、固定制品与记录不改写。尚未安装的两个原型插件另发min026新包，不覆盖旧包，不按业务ID添加兼容映射。

| definition | UI状态 | 原有Settings/store/activate |
|---|---|---|
| ui/workPage均无 | none | 按原合同继续 |
| 只有旧workPage | unavailable / UI_LEGACY_WORKPAGE_UNAVAILABLE | 保留，明确提示升级UI格式 |
| ui与workPage同时有 | invalid / UI_CONTRIBUTIONS_INVALID | 保留，不选优先者、不双注册 |
| ui最低声明不足026 | unavailable / UI_FRAMEWORK_MINIMUM_REQUIRED | 保留，其余原门禁照常 |
| ui schema/关联无效 | invalid / UI_CONTRIBUTIONS_INVALID | 保留，整组UI拒绝 |
| ui有效且运行门槛满足 | registered | 按原合同继续 |

基础factory及核心定义先验证；UI使用独立错误边界，不得让validateUi异常卸掉整个插件或其他Settings。管理页显示每插件准确UI不可用原因。旧pluginId-only深链不补alias/默认页，明确不可用；核心factory/Settings自身错误仍按原合同处理，不能被本条掩盖。

实现入口为framework/shared/ui-contributions.js（validateUiContributions/readUiContributions、枚举及上限）、framework/src/ui-contributions.js（通用登记/页面/动作）、framework/src/tower-workpage-host.js（两个语义slot适配）、framework/src/hub.js（React/store及独立错误边界）。原TOPO只读HTTP/权限合同见[数据提供器](plugin-workpages.md)，真实事务/独立回滚仍见[设计](network-transactions.md)，二者不因UI通用化自动变成已实现能力。

2026-10-29验证范围：框架0.2.6已部署并恢复启用，原四插件版本及启用状态保持；框架窗口真实浏览器验证了原Settings保护、最低版本显示且不展示废弃上限、当时未安装新插件时没有注入贡献入口或工作页，以及原生主内容区、拓扑画布/工具栏/页签保留。两个新插件的准确包已在本地生产构建中完成入口、语言与草稿/退出验证。

随后安全策略转换0.1.4完成独立安装、启用及受限中文真实页面验收，包括准确原生入口、草稿离页保护、固定样例转换和实际审查JSON下载；真实策略未下发。该次控制台有44条共享模块告警及一条初始化HTTP504，失败端点及根因未明；其他语言未在本次真实环境单独切换验证。

拓扑0.1.3另完成独立安装启用、当前中文原生入口、真实集群读取、14张资源卡片与关系呈现、本地布局和干净返回重入，以及退出后223文件保护验收。用途分类缺原始字段证据，未生成关联意图；dirty退出和真实切语仍待测，不能继承本地验证结论。该次有45条共享模块告警和两条初始化HTTP504，端点、根因及是否由插件引起均未确认。真实网络事务与独立服务端回滚尚未实现。详见[验证记录](0.2-validation.md)。

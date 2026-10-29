# 安全策略自动转化工具 / Security policy converter

`rivetin-security-policy-converter`，版本 `0.1.4`。提供**离线转换与人工审查**，由插件声明 Everoute 左导航入口与工作页，消费框架0.2.6的通用 UI contributions v1。2026-10-29 已完成固定 C03 包的真实安装、启用及当前中文工具页限定验收；不连接或修改 Everoute 策略。

源码依据用户提供的单文件工具进行功能分析后重新实现，不分发原始 HTML、编译代码、开发者路径或调查材料；原附件没有可核验的独立许可声明，本项目不对其重新授权。新增源码遵循本仓库 MIT。社区独立开发，非 SmartX 官方产品。

## 已实现

- 使用 Rivetin `definition`、`Settings`、共享配置 store 和启停清理；中英文跟随宿主传入的 locale。
- VM 清单 JSON（包括人工标签）与流量 CSV 文件或文本导入、自动/手动列映射。
- 严格 IPv4、TCP/UDP 单目标端口、ICMP；重复流量去重。任一坏行阻止整份结果导出。
- 精确 IP 匹配；重复 IP、不唯一标签、跨集群 VM / 选择器、未经声明的外部 IP 均阻断。没有名称猜测或强制绕过。
- 按标签键值对生成候选，内外部规则分开，列出清单中全部选择器成员。组内互信固定关闭，模式固定 `MONITOR`；内部流量保留源端出站与目标端入站规则。
- 人工确认后导出 `rivetin-policy-review-v1` JSON 新稿。**该文件不是 Everoute API 请求或可直接导入的配置。**
- 修改输入、列映射、已保存标签键后清除结果与确认；面板卸载、插件停用及刷新清除导入数据。异步文件读取不会在清空或停用后恢复旧数据。

## 运行与验证

源码开发使用仓库现有 Node.js 22 与框架工具链；插件没有新增第三方依赖、不安装全局包。不需要 Everoute。

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run package
npm run demo
```

本地演示打开 `http://127.0.0.1:43185`，仅绑定回环。也可解压 `release/*-local-demo.tar.gz`，在解压目录运行 `node demo/server.mjs`。演示包已内置浏览器脚本，不需安装 npm 依赖。演示配置后端只用内存，切换语言是模拟宿主行为；不是实际 CloudTower 接入。关闭终端或 Ctrl+C 停止演示。

点击“载入脱敏演示”→“检查并生成候选策略”：应得到 4 行输入、3 条唯一流量、1 行重复、3 个策略、4 条规则、0 个阻断项。展开精确规则，核对成员并确认后导出。清空外部地址再转换，应阻止导出。模拟停用后重新启用，输入应为空。

2026-10-29 的真实环境验收使用 CloudTower 4.9.0、框架 0.2.6 和固定 0.1.4 C03 包。已验证 Everoute 原生入口及右侧工作页、取消离页保留输入、丢弃退出恢复原页面、重入输入清空；固定脱敏样例实际生成 3 个策略、4 条规则、0 个阻断项。人工确认前导出按钮不可用，确认后实际下载 `rivetin-policy-review-v1`，`canDeploy=false`、全部 `MONITOR`，成员及逐项入站/出站规则与页面一致。安装后及页面操作后的保护核验已由主协调接受；本次没有保存共享配置或操作真实标签、策略、WORK。

实机使用现场中文，工具页没有独立语言开关，因此未实测语言切换；中英文切换保留输入与 dirty 的证据来自同一 C03 的本地生产组合。未修改账户、全局或浏览器语言，也未注入宿主状态。实机控制台记录 44 条共享模块版本警告及初始化时 1 条原生页面 HTTP 504；该请求的具体端点和根因尚未确认，已保留证据，不能据此宣称控制台无错误或归因于本插件。上述工具页流程实际完成，验收不覆盖真实策略下发、观察效果或其他语言的实机行为。

构建使用现有框架的 webpack；演示复用其 React 16 工具链并附带 `dist/demo/THIRD_PARTY_NOTICES.txt`。标准包只包含 `web/plugin.js` 与 `LICENSE`。包格式由当前框架 `validatePackage` 校验。打包使用显式文件白名单，不包含源码、测试、原附件、地图文件、截图、日志或本地协作文件。

自0.1.1起，构建会在忽略的 `dist/build-inputs.json` 记录 Node 版本、插件输入、共享配置/HTTP 客户端、框架锁文件及输出摘要。源码、共享输入、说明文档或产物发生变化后，打包会拒绝旧构建，须重新运行 `npm run build`。固定包、演示包或该版本校验文件已存在时也会拒绝打包，须使用新版本；不会覆盖已冻结的同版制品。当前版本的校验文件是 `release/rivetin-security-policy-converter-0.1.4-SHA256SUMS`，0.1.1及旧版 `RIVETIN-SHA256SUMS` 保留不变。校验通过只证明本地输入与产物对应，不能替代浏览器或真实环境验收。

## 输入与共享配置

清单为 JSON 数组，字段必须为 `id`、`name`、`clusterId`、`ips` 和 `labels`；不能直接导入未规范化的原生 API 响应。`id` 必须唯一，`ips` 为 IPv4 数组，`labels` 为 `{key,value}` 数组。已知 VM 可以没有 IP 或标签，但被流量引用时必须能精确解析身份和单个目标标签。

```json
[
  { "id": "vm-web", "name": "demo-web", "clusterId": "demo-cluster", "ips": ["192.0.2.10"], "labels": [{"key":"application","value":"web"}] },
  { "id": "vm-db", "name": "demo-db", "clusterId": "demo-cluster", "ips": ["192.0.2.20"], "labels": [{"key":"application","value":"database"}] }
]
```

```csv
src_ip,dst_ip,dst_port,protocol
192.0.2.10,192.0.2.20,5432,TCP
198.51.100.5,192.0.2.10,443,TCP
```

填写清单中的 `demo-cluster`，并将确认过的外部地址 `198.51.100.5` 单独填入外部地址栏，输出只使用 `/32`。外部声明不是地址分类器：操作者须确认它确实不属于遗漏的受管 VM。不能用声明绕过清单内 VM 的重复 IP、标签或集群问题。CSV 行号按逻辑记录计数，带换行的引号单元格不等于物理文件行号。

自动识别常用中英文四列，未知列名使用手动映射，禁止把同列用于两个字段。TCP/UDP 仅接受 `1..65535` 的单端口；不猜缺失协议、不扩展端口范围。ICMP 端口留空或 `-`，当前不限制 ICMP type/code。额外 CSV 列可以保留，但不用于名称匹配。

只有 `version`、`labelKey` 是功能配置，按插件 ID 使用框架统一 `/api/rivetin/v1/config`，明确保存后生效。未保存/保存失败由框架保留草稿；工作台始终使用已保存标签键。导入清单、流量、外部声明和审查稿均不进入服务端配置或浏览器存储。演示不验证实际管理员权限、持久化或网络保存。

共享配置约定见 [Rivetin 配置 API](../../docs/rivetin-configuration.md)。本插件只使用 Rivetin API 与 Rivetin ID，不读取、映射、复制或双写旧配置，没有旧前缀回退或迁移入口。

输入文本每份最多 2 MiB 字符；文件导入每份最多 2 MiB 字节。清单最多 5,000 VM，每 VM 最多 32 IP / 32 标签；CSV 最多 20,000 数据行、40 列；最多 1,000 个外部地址、2,000 个候选策略、20,000 条规则。页面每页显示 100 个策略，支持翻页，最多显示 200 个诊断，导出仍包含全部候选。这里只支持小批量本地审查。

## 安装、兼容与卸载边界

0.1.4 的标准包路径为 `release/rivetin-security-policy-converter-0.1.4.rivetin.json`。固定 C03 包已完成上述范围的真实安装、启用和验收；部署验收与 GitHub Release、市场发布分别记录。正式 Island scope / 包名 / 目录名一致；插件不独立注册 Island。0.1.1 固定包及其中 schema 1、空 Tower 构建列表保持原样；0.1.2/0.1.3旧原型包也不改写。

0.1.4 声明 `schemaVersion: 2`、`frameworkApi: 1`、最低框架 `0.2.6`、`towerBuilds: ["4.9.0"]`、`smtx: "none"` 与空权限列表。CloudTower 4.9.0 上已完成上述当前中文工具页限定验收；声明与本地判定本身不替代实测，也不扩大到其他构建或真实策略流程。没有 Everoute 标签/策略写入声明。后续安装、启用及验收仍须绑定准确包与明确范围。

框架 0.2.3 及旧解析器仍按原最低／最高版本字段规则判定；自 0.2.4 起，框架版本条件只判断 `frameworkMinVersion`，包含最低版本边界；旧 `frameworkMaxVersionExclusive` 仅保留为供旧解析器读取的语法字段，不执行上限，也不在兼容详情中显示上限。API 1、Tower 已验收版本、SMTX 声明及权限仍分别检查。此说明不新增本插件的实机验收范围，满足最低框架版本不表示更高版本或真实策略流程已经测试；实际验收限于上述工具页范围，兼容规则见下方权威说明。

新无 max 字段的 schema 2 声明要求最低框架版本至少为 `0.2.4`。0.2.2／0.2.3 的旧解析器仍要求该字段，向 V4 市场目录加入无 max 条目可能导致旧框架拒读整份目录。因此，0.1.4 候选保留 `frameworkMaxVersionExclusive: "0.3.0"` 作为旧读取器的语法载体，0.2.4起的框架忽略其上限；它不表示0.2.6以下可以运行本工作页，也不证明整份生产目录已经通过旧读取器验证。既有包保持原字节，市场发行独立安排。完整规则及目录读取基线见 [Rivetin 兼容性说明](../../docs/rivetin-compatibility.md)。

请先运行独立本地演示；真实安装、启用、部署或版本声明另按明确范围安排。重置只恢复标签键默认值；停用清除工作台内存；卸载按框架保留共享配置。

完整可行性、迁移差异及后续集成需求见 [可行性分析](docs/feasibility.md)。本阶段没有 AI 名称打标签、真实标签写入、Label ID 解析、Everoute 请求构造/下发、WORK 切换或观察统计，不承诺最终策略完整性、真实环境效果或安全隔离。

## 独立工作页

CloudTower“网络与安全”/Everoute 左导航的“服务”和“设置”之间提供“安全策略转换”入口；点击后在右侧主内容区显示完整转换工具，并保留左导航。固定 0.1.4 C03 已完成该原生入口、页面渲染及上述草稿退出流程的真实中文验收；停用/重启恢复等未列入本次操作的行为，不据此新增实机通过结论。

源码 `src/workpage.js` 复用现有导入、列映射、候选审查与人工导出流程，使用独立的页内会话，只读取已保存的标签键。配置草稿不影响当前转换，明确保存新的标签键后旧结果失效。页面卸载或宿主通知停用时清空输入、结果及确认，迟到的文件读取不能恢复数据。它不会自行导航、定位或隐藏宿主 DOM，也不会发出 Everoute 请求。

工作页接受宿主的取消信号，并仅以布尔值报告页内未清空数据，包括尚未完成的文件导入。取消离开应保留当前页面和信号；确认丢弃后才中止并卸载。停用或取消信号会立即清理，旧信号不能重新激活会话。离开工作页不调用共享配置保存，也不将导入内容传给框架。

definition 按 [UI contributions v1](../../docs/plugin-ui-contributions.md) 返回 `ui`，声明 `converter` 页面，以及指向该页的 `open-converter` 入口。入口使用 `everoute.navigation.tools` 语义插槽；双语标签、`convert` 图标、顺序100、空上下文要求与 `target.page` 均由本插件提供。Everoute上下文没有集群ID，不能要求clusterId而隐藏入口。`actions` 为空，点击只经框架守卫打开页面，不触发业务动作或保存。

页面复用框架注入的 React 与当前共享配置 store，忽略不需要的只读 context。框架只负责通用插槽、准确内容区承载、语言/启停通知、离页和原生内容恢复，已有插槽新增入口无需修改框架业务代码。独立本地演示仍使用 Settings 展示转换流程，不模拟已经通过的真实导航。

0.1.4已移除旧 `workPage` 字段，不双注册。框架0.2.6对仅有该原型字段的旧包明确报告 `UI_LEGACY_WORKPAGE_UNAVAILABLE`，保留原Settings能力；同时提供旧字段与ui则整组UI无效。0.1.3 C02固定包和本地验证记录保全，不能视为已经迁移到新合同；旧pluginId-only深链也不自动映射到新页面。

工作页包要求 schema 2、最低框架版本至少为 `0.2.6`，并满足 Tower 等独立条件；继续复用 `permissions: []`，不因页面新增权限枚举。0.1.4 候选采用该声明，0.1.1固定包保持原样。原离线转换、MONITOR 审查稿与禁止直接下发/切换 WORK 的边界保持。

## Rivetin 标识与审查新稿

本地目录、插件 ID、包名、独立 Island scope、全局工厂、描述文件及标准包格式只使用 Rivetin：`rivetin-security-policy-converter`、`window.RivetinPlugins`、`rivetin.json`、`rivetin-global-v1` 和 `rivetin-package-v1`。当前版本 `0.1.4`，声明候选目标CloudTower 4.9.0，真实验收状态另记。历史 QA、制品及其校验文件只作为忽略的本地研究资料保留，不参与当前加载或配置读取；当前制品摘要为带版本的 `release/rivetin-security-policy-converter-0.1.4-SHA256SUMS`。

当前只生成 **`rivetin-policy-review-v1`** 审查新稿，来源 `pluginId` 固定为 `rivetin-security-policy-converter`。该协议是本项目的离线预览格式，没有兼容历史预览稿的要求；导出校验明确拒绝旧格式和旧来源 ID。本插件没有审查稿导入器，不转换历史文件，也不声称已对接任何外部消费者。

## English

Offline Rivetin preview: import normalized VM inventory JSON and traffic CSV, map columns, resolve exact IPv4 identities and review label-pair MONITOR candidates. It blocks ambiguity, invalid input, cross-cluster selectors and undeclared external addresses. All listed selector members are displayed; group trust is disabled. Inputs stay in memory. Only the label key uses the framework shared settings and explicit save flow.

Run the commands above, then open the loopback demo. The sample yields 3 candidate policies and 4 rules. JSON exports are manual review drafts, not Everoute API/import payloads. On 2026-10-29, the fixed 0.1.4 C03 package was installed and enabled with framework 0.2.6 on CloudTower 4.9.0. A bounded live check in Chinese verified the native entry, workpage, cancel/discard guards, empty reentry, sample conversion and actual JSON download with `canDeploy=false` and MONITOR policies matching the UI. Post-UI protection checks were accepted separately. Live language switching was not performed; bilingual state preservation has local production evidence only. The console recorded 44 shared-module warnings and one initial native-page HTTP 504 with an unconfirmed request endpoint and cause. No shared settings were saved. No AI calls, label writes, policy deployment, observation or WORK mode are implemented. The accompanying feasibility document records the remaining integration requirements.

Plugin identity, registry, manifest, package and configuration use Rivetin only. New review drafts use `rivetin-policy-review-v1` and identify their source as `rivetin-security-policy-converter`; export validation rejects legacy formats and source IDs. There is no historical draft importer, legacy configuration mapping or prefix fallback. Historical local QA and artifacts are retained solely as research records.

仓库当前为私有，访问 GitHub 链接需要相应权限；本地制品不表示 GitHub Release 已发布。

[GitHub](https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-security-policy-converter) · [MIT license](LICENSE)

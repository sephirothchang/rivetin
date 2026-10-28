# 安全策略自动转化工具 / Security policy converter

`rivetin-security-policy-converter`，版本 `0.1.1`。将独立安全策略工具的流程拆成 Rivetin 子插件；本版本交付**离线转换与人工审查预览**，没有连接、安装或修改真实 CloudTower / Everoute。

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

构建使用现有框架的 webpack；演示复用其 React 16 工具链并附带 `dist/demo/THIRD_PARTY_NOTICES.txt`。标准包只包含 `web/plugin.js` 与 `LICENSE`。包格式由当前框架 `validatePackage` 校验。打包使用显式文件白名单，不包含源码、测试、原附件、地图文件、截图、日志或本地协作文件。

0.1.1 构建会在忽略的 `dist/build-inputs.json` 记录 Node 版本、插件输入、共享配置/HTTP 客户端、框架锁文件及输出摘要。源码、共享输入、说明文档或产物发生变化后，打包会拒绝旧构建，须重新运行 `npm run build`。固定包、演示包或该版本校验文件已存在时也会拒绝打包，须使用新版本；不会覆盖已冻结的同版制品。当前版本的校验文件是 `release/rivetin-security-policy-converter-0.1.1-SHA256SUMS`，旧版 `RIVETIN-SHA256SUMS` 保留不变。校验通过只证明本地输入与产物对应，不能替代浏览器或真实环境验收。

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

标准包为 `release/rivetin-security-policy-converter-0.1.1.rivetin.json`，格式供框架读取和管理，当前兼容声明仍会阻止真实安装/启用。正式 Island scope / 包名 / 目录名一致；此包不会独立注册 Island。入口在本插件 Settings，不探测或改写 Everoute 原生 DOM。

`frameworkApi: 1` 的接口形状已在本地模拟验证；兼容声明显式使用 `schemaVersion: 1` 和 `towerBuilds: []`，**没有真实验证过的 CloudTower / Everoute 版本**。当前框架允许读取该声明，但执行门禁要求 schema 2、非空已验收 Tower 构建列表及明确框架版本范围；本包保持 `PLUGIN_COMPATIBILITY_UNDECLARED`，不能仅填构建号放行。schema 1 在此表示尚无执行兼容声明，并不表示框架 0.1 兼容承诺。请先运行独立本地演示；真实安装、启用、部署或版本声明由主协调流程另行安排。重置只恢复标签键默认值；停用清除工作台内存；卸载按框架保留共享配置。

完整可行性、迁移差异及后续集成需求见 [可行性分析](docs/feasibility.md)。本阶段没有 AI 名称打标签、真实标签写入、Label ID 解析、Everoute 请求构造/下发、WORK 切换或观察统计，不承诺最终策略完整性、真实环境效果或安全隔离。

## Rivetin 标识与审查新稿

本地目录、插件 ID、包名、独立 Island scope、全局工厂、描述文件及标准包格式只使用 Rivetin：`rivetin-security-policy-converter`、`window.RivetinPlugins`、`rivetin.json`、`rivetin-global-v1` 和 `rivetin-package-v1`。当前版本 `0.1.1`，兼容构建列表仍为空。历史 QA、制品及其校验文件只作为忽略的本地研究资料保留，不参与当前加载或配置读取；当前制品摘要为带版本的 `release/rivetin-security-policy-converter-0.1.1-SHA256SUMS`。

当前只生成 **`rivetin-policy-review-v1`** 审查新稿，来源 `pluginId` 固定为 `rivetin-security-policy-converter`。该协议是本项目的离线预览格式，没有兼容历史预览稿的要求；导出校验明确拒绝旧格式和旧来源 ID。本插件没有审查稿导入器，不转换历史文件，也不声称已对接任何外部消费者。

## English

Offline Rivetin preview: import normalized VM inventory JSON and traffic CSV, map columns, resolve exact IPv4 identities and review label-pair MONITOR candidates. It blocks ambiguity, invalid input, cross-cluster selectors and undeclared external addresses. All listed selector members are displayed; group trust is disabled. Inputs stay in memory. Only the label key uses the framework shared settings and explicit save flow.

Run the commands above, then open the loopback demo. The sample yields 3 candidate policies and 4 rules. JSON exports are manual review drafts, not Everoute API/import payloads. No validated live Tower builds are declared, and live activation must stay gated. No AI calls, label writes, policy deployment, observation or WORK mode are implemented. The accompanying feasibility document records the remaining integration requirements.

Plugin identity, registry, manifest, package and configuration use Rivetin only. New review drafts use `rivetin-policy-review-v1` and identify their source as `rivetin-security-policy-converter`; export validation rejects legacy formats and source IDs. There is no historical draft importer, legacy configuration mapping or prefix fallback. Historical local QA and artifacts are retained solely as research records.

仓库当前为私有，访问 GitHub 链接需要相应权限；本地制品不表示 GitHub Release 已发布。

[GitHub](https://github.com/sephirothchang/rivetin/tree/main/plugins/rivetin-security-policy-converter) · [MIT license](LICENSE)

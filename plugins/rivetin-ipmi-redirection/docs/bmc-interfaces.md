# BMC 公开接口接入说明

核验与资料快照日期：2026-10-27。范围为本地原型，未访问真实 BMC、未上传或修改 CloudTower。

## 清单来源与准确含义

服务器厂商与型号来自 [SmartX SMTX OS 兼容性页面](https://www.smartx.com/smtxos-compatibility/?tab=0) 实际使用的[公开数据接口](https://oocgate.smartx.com/api/hcl/servers?product=SMTXOS&locale=ZH_CN)。本次取得 29 家厂商、158 条型号记录，保留每条原始 ID、型号、别名及厂商，不将同名记录去重。

- 完整可查数据：[JSON](../data/hcl-catalog.json)、[CSV](../data/hcl-models.csv)。
- 数据产品筛选为 `SMTXOS`，语言为 `ZH_CN`；未混入 ZBS 产品清单。
- 原始响应保存在 `research/smartx-servers-raw.json`。SHA256：`486940f1208b3289f68714fd82490e50c720e6407a44afce3e74897b7a860fec`。
- `npm run catalog` 从已保存的响应重现目录；`npm run catalog -- --refresh` 才重新读取公开互联网清单。新增未知厂商或不完整响应会停止导入，需人工核对映射。

HCL 证明的是 SMTX OS 的服务器兼容性，未给出全部机型的 BMC 代际、固件、网页登录协议。目录中的厂商协议是可选择的协议族，不能据此声称该厂商所有 HCL 型号已完成 BMC 兼容认证。

## 本次接口实现

`server/bmc-api.js` 提供 `createBmcApiClient(options)` 和 `inspectBmc(options, credentials)`；前者返回 `probe()`、`login()`，登录后返回只包含 `readInventory()` 和 `logout()` 的会话对象。

| 操作 | 实现 |
|---|---|
| 探测 | GET `/redfish/v1/`，检查 `RedfishVersion`，发现会话集合 |
| 会话创建 | 优先使用根资源 `Links.Sessions`，否则发现 `SessionService.Sessions`；POST JSON `UserName` / `Password` |
| 鉴权 | 读取成功响应的 `X-Auth-Token` 和 `Location`，令牌仅在服务端闭包中使用 |
| 信息读取 | 顺着根资源的 Systems、Managers、Chassis 链接，读取型号、厂商、固件、序列号和健康摘要 |
| 退出 | DELETE 本次创建的单一会话 URI，不枚举或清理其他用户会话 |

实现依据为 [DMTF Redfish DSP0266 1.15.0](https://redfish.dmtf.org/schemas/DSP0266_1.15.0.html) 的会话认证与资源链接约定。兼容同来源的尾斜杠 307/308 规范化；不跟随其他重定向。

`inspectBmc` 在信息读取失败时也尝试退出，并明确报告清理失败。若创建会话的成功响应缺少令牌或有效会话 URI，客户端无法安全确认要删除哪个会话，停止且不重复登录；设备端可能已创建会话，需等待其会话超时。网络中断也可能造成退出状态不确定。

本次没有实现电源控制、重启、改密、用户管理、固件升级、KVM 或虚拟媒体操作。登录和退出本身会创建/删除临时会话，因此本迭代只对模拟传输运行，不把它称为对真实设备的零副作用检查。

## 厂商与型号覆盖矩阵

“Redfish 协议实现”表示本地客户端与公开协议契约已实现，并完成模拟测试，**不代表设备实测或网页自动登录完成**。完整型号参见 CSV 或设置面板内的“厂商接口与兼容机型”。

| 厂商 | HCL 型号记录数 | 本地 API 状态 / 公开依据 |
|---|---:|---|
| 联想 | 21 | [XCC 会话创建](https://pubs.lenovo.com/xcc-restapi/create_a_session_post)，Redfish 协议实现 |
| Dell | 14 | [iDRAC8 认证文档](https://www.dell.com/support/manuals/en-us/poweredge-r730/idrac8_redfishapiguide_2.70.70.70/redfish-authentication-and-authorization?guid=guid-d572792f-afd2-499a-bf12-38a6778b9bbc)，Redfish 协议实现 |
| 浪潮 | 22 | [浪潮英信 Redfish V1.2](https://www.inspur.com/eportal/fileDir/active_download/platformBookZh/6747/浪潮英信服务器%20Redfish用户手册%20V1.2.pdf)，Redfish 协议实现 |
| SuperMicro | 9 | [Redfish User Guide](https://www.supermicro.com/manuals/other/RedfishUserGuide.pdf)，Redfish 协议实现 |
| HPE | 5 | [iLO Redfish 会话认证](https://servermanagementportal.ext.hpe.com/docs/concepts/redfishauthentication)，Redfish 协议实现 |
| Huawei | 5 | [官方 iBMC Cmdlets 会话实现](https://github.com/Huawei/Huawei-iBMC-Cmdlets/blob/master/code/common/Redfish.ps1)，Redfish 协议实现 |
| H3C | 14 | [HDM2 Redfish 参考手册](https://www.h3c.com/en/Support/Resource_Center/EN/Severs/Catalog/Management_Software/Management/Technical_Documents/Developer_Documents/API_References/H3C_HDM2_R-13839/)，Redfish 协议实现 |
| 超聚变 | 8 | [V6 及以后 iBMC API](https://www.xfusion.com/wp-content/uploads/2025/11/Server-V6-or-Later-iBMC-Redfish-API-Description-.pdf)，Redfish 协议实现 |
| 宝德 | 4 | [自强鲲鹏 iBMC Redfish 1.1](https://en.powerleader.com.cn/static/upload/file/20250402/1743581414958895.pdf)，Redfish 协议实现，适用范围需核对 |
| GIGABYTE | 1 | [Redfish V1.11.0](https://download.gigabyte.com/FileList/Manual/server_manual_redfish_v1.11.0.pdf)，Redfish 协议实现 |
| 中科可控 | 6 | 已收录；公开会话协议待核实，当前仅跳转 |
| 紫光恒越 | 2 | 同上 |
| 中兴 | 7 | 同上 |
| 神州数码 | 2 | 同上 |
| 华鲲振宇 | 2 | 同上 |
| 百信恒山 | 2 | 同上 |
| 中科曙光 | 3 | 同上 |
| 广电五舟 | 3 | 同上 |
| KunLun | 2 | 同上 |
| 软通华方 | 1 | 同上 |
| 海康威视 | 4 | 同上 |
| 长江计算 | 2 | 同上 |
| 超云数字 | 4 | 同上 |
| 黄河 | 1 | 同上 |
| 安擎 | 3 | 同上 |
| 长城 | 3 | 同上 |
| 宁畅 | 4 | 同上 |
| 湘江鲲鹏 | 3 | 同上 |
| 至索 | 1 | 同上 |

AMI 是 BMC 软件协议族，不是该 HCL 中的服务器厂商，作为额外选项保留。通用 BMC 则只做 HTTPS 登录页跳转，不自动探测或套用其他厂商凭据。

资料链接复核（2026-10-28）：H3C 上表原参考手册入口在本机访问时跳转到错误页，当前原文访问仍待恢复或找到等效官方手册。宝德已改为厂商 `en` 域名上的同名文档入口，与源码目录一致；搜索可检索该文档，但本机 TLS 连接失败，当前下载可用性尚未验证。上述引用保留资料溯源，不作为当前链接可用的证明；不得为读取文档关闭证书验证。

同日候选复核补充：实际读取了 H3C 官方 [HDM2-1.68.01 版本说明](https://www.h3c.com/cn/d_202402/2055018_30005_0.htm) 的“支持的设备”和配套下载项；该页列出 G6 系列设备，并配套 Redfish 参考手册 V1.10。它能证明这一固件包的文档配套关系，不能替代 API 手册原文或证明本插件适配这些设备。手册下载链接转至软件许可协议页，本次未接受协议、未取得 API 正文；原英文入口仍返回错误页面。宝德原 PDF 再次发生 TLS/读取失败，另一个官方 PR205KS 用户手册候选也未成功取得全文，故保留待核验，不仅凭搜索摘要认定版本、会话接口或支持固件。当前没有新增可宣称已适配的厂商/型号/固件。

## 需要按设备核对的差异

- 联想清单含旧款 `System X3650 M5`，其 [官方 IMM2 文档入口](https://pubs.lenovo.com/imm2/) 与 XCC 属于不同产品；不可因为同属联想就假定 XCC 接口可用。
- Dell 清单横跨 R730、R740、R760、R770/R7725 等多代产品。本原型按实际 Redfish 链接发现资源，不把系统 ID 或 iDRAC 代际固定为一代。
- 超聚变参考文档明确覆盖 V6 及以后，HCL 另有 V5 型号，需要其他适用文档或设备验证。
- Supermicro HCL 含 X10 平台及更新平台；需确认 BMC 固件是否支持 Redfish。
- 宝德公开手册针对鲲鹏 iBMC，不能把 Intel/AMD 系列也自动判定为 iBMC。
- “公开协议待核实”不等于该厂商没有 Redfish，只表示本次没有足够的一手会话协议和适用范围证据。

## 网页自动登录状态

Redfish API 会话通常通过 HTTP 请求头携带令牌，浏览器打开一个链接不会自动携带该请求头，也不会获得其他来源的 Cookie。会话接口完成接入后，仍需逐个 BMC 网页实现会话建立、Cookie/CSRF、页面资源代理和退出生命周期。

- AMI MegaRAC SP-X：保留已有 `/api/session` 表单适配与本地模拟网页会话；未接真实 BMC。
- 其余厂商：10 家配置完成 Redfish 客户端与本地模拟契约验证，19 家仍仅普通跳转、公开会话协议待核实；均未完成真实网页自动登录，界面不会虚报支持。
- [联想 XClarity Administrator 的管理控制器单点登录](https://pubs.lenovo.com/lxca/server_launchimm) 有自身管理关系、产品及固件前提，不是可直接套在 Tower 上的通用跳转参数。
- 超聚变、宝德文档还描述了 Web 会话操作，属于后续网页适配的候选；本次未把这些 OEM Web 操作与标准 Redfish API 会话混用。

## 传输与部署边界

客户端必须由服务端显式注入 `transport(url, options)`，契约为 Fetch 的 RequestInit 和 Response（包含 `redirect: 'manual'`、AbortSignal）。默认不会调用 `fetch`，也没有公网监听器、凭据读取器或真实设备连接开关。通过离线模拟测试，不需要输入真实密码。

后续凭据代理需自行从受授权的资产映射确定 BMC 地址，做目标 IP/端口允许列表和 DNS/IP 固定，验证 TLS 或使用受控证书信任，限制响应大小；不得直接接收浏览器提供的任意上游 URL。本适配器的同来源与路径校验用于约束已选 BMC 返回的链接，不能代替代理层目标授权。

超时上限、返回条目上限和错误码均有界；不会因认证失败尝试其他密码或降级到 Basic。令牌不提供给前端，返回摘要不包含原始 OEM 或账户字段。生产 Island 包只含前端与公开型号资料，服务端适配器须由独立的受控后端提供。

## 本地验证

```powershell
npm run catalog
npm test
npm run build
npm run package
```

测试覆盖：全部 HCL 原始记录完整性、10 个厂商配置的标准会话契约、资源发现、大小写路径及斜杠规范化、跨来源链接拦截、超时、认证失败不重试、只退出自建会话、清理失败显式报告、分页截断，以及默认通用和新增集群例外。所有 BMC 响应由模拟传输提供，不是不同品牌真机固件的互通性测试。

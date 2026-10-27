// Public protocol references describe controller families, not certification of every HCL model.
const documented = (id, brand, label, document, coverageNote) => ({
  id, brand, label, api: 'redfish-session', simulatedAutoLogin: false,
  webLogin: 'direct', document, coverageNote,
});
export const BMC_VENDORS = Object.freeze([
  { id: 'generic', brand: null, label: '通用 BMC · 仅跳转', api: null, webLogin: 'direct', simulatedAutoLogin: false },
  { id: 'ami-megarac', brand: null, label: 'AMI / MegaRAC SP-X', api: 'megarac-web-session', webLogin: 'local-mock', simulatedAutoLogin: true },
  documented('dell-idrac', 'Dell', 'Dell EMC / iDRAC',
    'https://www.dell.com/support/manuals/en-us/poweredge-r730/idrac8_redfishapiguide_2.70.70.70/redfish-authentication-and-authorization?guid=guid-d572792f-afd2-499a-bf12-38a6778b9bbc',
    '参考 iDRAC8 Redfish 文档；其他代际需核对实际控制器与固件，不能将全部 PowerEdge 型号视为 iDRAC9。'),
  documented('lenovo-xclarity', '联想', '联想 / XClarity Controller',
    'https://pubs.lenovo.com/xcc-restapi/create_a_session_post',
    '适用于启用 Redfish 的 XCC。HCL 中 System X3650 M5 属于旧代产品；不能直接套用 XCC 协议。'),
  documented('hpe-ilo', 'HPE', 'HPE / iLO',
    'https://servermanagementportal.ext.hpe.com/docs/concepts/redfishauthentication',
    '需确认 iLO 代际、Redfish 支持、固件及双因素认证策略。'),
  documented('h3c-hdm', 'H3C', 'H3C / HDM',
    'https://www.h3c.com/en/Support/Resource_Center/EN/Severs/Catalog/Management_Software/Management/Technical_Documents/Developer_Documents/API_References/H3C_HDM2_R-13839/',
    '以 HDM2 公开 Redfish 参考手册为依据；不同 HDM 版本需验证。'),
  documented('huawei-ibmc', 'Huawei', 'Huawei / iBMC',
    'https://github.com/Huawei/Huawei-iBMC-Cmdlets',
    '以华为公开 iBMC 客户端为依据，需确认设备 iBMC 版本及 Redfish 支持。'),
  documented('xfusion-ibmc', '超聚变', '超聚变 / iBMC',
    'https://www.xfusion.com/wp-content/uploads/2025/11/Server-V6-or-Later-iBMC-Redfish-API-Description-.pdf',
    '参考文档适用于 V6 及以后服务器；清单中的 V5 型号不在此文档覆盖承诺内。'),
  documented('inspur-bmc', '浪潮', '浪潮 / BMC',
    'https://www.inspur.com/eportal/fileDir/active_download/platformBookZh/6747/浪潮英信服务器%20Redfish用户手册%20V1.2.pdf',
    '参考浪潮英信 Redfish V1.2；其他系列需确认控制器和固件。'),
  documented('supermicro-bmc', 'SuperMicro', 'Supermicro / BMC',
    'https://www.supermicro.com/manuals/other/RedfishUserGuide.pdf',
    '需确认主板代际、BMC 固件及 Redfish 功能；旧型号不自动认定支持。'),
  documented('gigabyte-bmc', 'GIGABYTE', 'GIGABYTE / BMC',
    'https://download.gigabyte.com/FileList/Manual/server_manual_redfish_v1.11.0.pdf',
    '参考 Redfish API Reference V1.11.0；需核对实际固件。'),
  documented('powerleader-bmc', '宝德', '宝德 / BMC',
    'https://en.powerleader.com.cn/static/upload/file/20250402/1743581414958895.pdf',
    '公开文档针对自强鲲鹏服务器 iBMC；不代表宝德所有 Intel/AMD 型号使用相同控制器。'),
  ...[
    ['sugon-cc', '中科可控'], ['unisyue', '紫光恒越'], ['zte', '中兴'], ['digitalchina', '神州数码'],
    ['huakun', '华鲲振宇'], ['baixin', '百信恒山'], ['sugon', '中科曙光'], ['wuzhou', '广电五舟'],
    ['kunlun', 'KunLun'], ['isoftstone', '软通华方'], ['hikvision', '海康威视'], ['yangtze', '长江计算'],
    ['hyperfusion', '超云数字'], ['huanghe', '黄河'], ['anqing', '安擎'], ['greatwall', '长城'],
    ['nettrix', '宁畅'], ['xiangjiang', '湘江鲲鹏'], ['zhisuo', '至索'],
  ].map(([id, brand]) => ({ id: `${id}-bmc`, brand, label: `${brand} / BMC`, api: null,
    webLogin: 'direct', simulatedAutoLogin: false, coverageNote: '已收录 HCL 型号；公开会话协议尚待核实。' })),
].map(value => Object.freeze(value)));

export function getApiProfile(id) {
  return BMC_VENDORS.find(value => value.id === id && value.api === 'redfish-session') || null;
}

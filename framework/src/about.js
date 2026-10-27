import notices from './notices.js';
import { githubIcon } from '../vendor/octicons/mark-github.js';
export function createAbout(React) {
  const h = React.createElement;
  return function About({ locale }) {
    const en = locale === 'en-US';
    return h('div', { className: 'pk-about' }, h('h3', null, en ? 'About PluginKit' : '关于 PluginKit'),
      h('p', null, 'PluginKit 0.1.0 · MIT'),
      h('p', null, en ? 'Developed and maintained by Sephiroth Chang & PluginKit contributors. Individual contributions are recorded in the repository history.' : '开发与维护：Sephiroth Chang & PluginKit contributors。具体贡献者以仓库提交记录为准。'),
      h('a', { className: 'pk-github-link', href: 'https://github.com/sephirothchang/smartx-extensions', target: '_blank', rel: 'noopener noreferrer' },
        githubIcon(h), h('span', null, 'GitHub'),
        h('svg', { className: 'pk-github-heart', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true, focusable: 'false' },
          h('path', { d: 'M12 21 3.5 12.5C-2 7 5 0 10.5 5.5L12 7l1.5-1.5C19 0 26 7 20.5 12.5Z' }))),
      h('section', null, h('h3', null, en ? 'Independence and intellectual property' : '独立性与知识产权声明'),
        h('p', null, en ? 'Names referenced by this project, including but not limited to SmartX, SMTX OS and CloudTower, are trademarks, product names or software names of Beijing Zhiling Haina Technology Co., Ltd. and/or the respective rights holders. All associated rights remain with their owners. These names are used solely to identify the intended integration environment.' : '本项目提及的名称，包括但不限于 SmartX、SMTX OS、CloudTower，为北京志凌海纳科技股份有限公司及／或相关权利人的商标、产品名称或软件名称，相关商标权、软件著作权及其他权利均归各自权利人所有。本项目仅为说明适用环境及兼容关系而使用上述名称。'),
        h('p', null, en ? 'PluginKit is an independently developed community project. It has not been officially authorized, certified, sponsored or endorsed by SmartX, and does not represent SmartX or its positions. No affiliation, partnership or agency relationship is implied. The project license grants no rights to third-party trademarks or proprietary software.' : 'PluginKit 为独立开发的社区项目，未经 SmartX 官方授权、认证、赞助或背书，不代表 SmartX 的立场，亦不表示与其存在隶属、合作或代理关系。本项目的开源许可不授予任何第三方商标或专有软件的使用权。'),
        h('p', null, en ? 'Provided “as is”, without warranties of any kind. Users are responsible for assessing compatibility, backing up their data and assuming the risks of use. Liability is limited as stated in the MIT License, to the extent permitted by applicable law.' : '本项目按“现状”提供，不对任何功能、适用性或持续可用性作出任何形式的保证。使用者应自行评估兼容性、完成必要备份并承担使用风险；责任限制以 MIT 许可证约定及适用法律允许的范围为限。'),
        h('a', { href: 'https://www.smartx.com/legal/', target: '_blank', rel: 'noopener noreferrer' }, en ? 'SmartX legal information ↗' : 'SmartX 法律信息 ↗')),
      h('section', null, h('h3', null, en ? 'Project license' : '项目许可证'), h('details', null, h('summary', null, 'MIT · Copyright © 2026 PluginKit contributors'), h('pre', null, notices.projectLicense))),
      h('section', null, h('h3', null, en ? 'Open-source notices' : '开源组件与版权声明'),
        h('p', null, en ? 'Notices for runtime dependencies are reproduced below. Components shared by CloudTower remain governed by their upstream licenses; this project does not relicense them. Build tools are recorded in the lockfiles.' : '以下保留运行依赖的上游许可证与版权原文。由 CloudTower 提供的共享组件仍适用其上游许可，本项目不对其重新授权；构建工具的版本记录于锁文件。'),
        ...notices.components.map(item => h('details', { key: item.name }, h('summary', null, `${item.name} ${item.version} · ${item.license}`), h('pre', null, item.text)))));
  };
}

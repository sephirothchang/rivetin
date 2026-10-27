# 插件目录

每个插件在本目录下建立独立子目录，统一命名为 `plugins/rivetin-<功能名称>/`。

当前已纳入框架联调的插件：[rivetin-ipmi-redirection](rivetin-ipmi-redirection/README.md)、[rivetin-ssh-channel](rivetin-ssh-channel/README.md)、[rivetin-disk-smart-info](rivetin-disk-smart-info/README.md)、[rivetin-context-menu](rivetin-context-menu/README.md)。具体完成程度以各插件说明及[验证范围](../docs/0.1-validation.md)为准。共享配置与保存约定集中维护于 [Rivetin 配置 API](../docs/rivetin-configuration.md)，后续插件复用该接口，不为每个插件创建同类配置路径。

插件的 `README.md` 应包含：

- 功能说明。
- 适用的 SmartX 产品及版本，已验证的兼容范围。
- 安装、配置、使用和卸载方法。
- 开发、构建和验证命令。

仅提交完成该插件所需的代码和配置示例。凭据使用明显的占位符，不提交实际环境的密码或令牌。

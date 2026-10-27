# 插件目录

每个插件在本目录下建立独立子目录，统一命名为 `plugins/pluginkit-<功能名称>/`。

当前插件：[pluginkit-ipmi-redirection](pluginkit-ipmi-redirection/README.md)。共享配置与保存约定集中维护于 [PluginKit 配置 API](../docs/pluginkit-configuration.md)，后续插件复用该接口，不为每个插件创建同类配置路径。

插件的 `README.md` 应包含：

- 功能说明。
- 适用的 SmartX 产品及版本，已验证的兼容范围。
- 安装、配置、使用和卸载方法。
- 开发、构建和验证命令。

仅提交完成该插件所需的代码和配置示例。凭据使用明显的占位符，不提交实际环境的密码或令牌。

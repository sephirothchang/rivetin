# Rivetin 统一配置 API

所有功能插件共用 `/api/rivetin/v1/config`。插件 ID 为 `rivetin-<功能名称>`。功能配置由服务端持久化，管理账户共享；浏览器仅保存按钮显隐等个人界面偏好。

## 接口与权限

GET 聚合返回 `version: 1`、`revision`、`plugins` 和 `errors`。每个插件有自己的 revision、updatedAt、schemaVersion、settings。损坏的插件记录在 errors 中，其他插件继续可用；全局 revision 是当前可读取配置 revision 之和，仅用于兼容原型，不是跨文件事务版本。

PUT 仍只接受 `{pluginId, settings}`，更新指定插件。请求必须有 Tower 验证通过的管理员身份和允许的 Origin。同一插件最后成功保存为准，不做旧版本冲突拒绝；不同插件独立更新。框架将当前 Tower Authorization 转交同一 Tower 核对身份，不保存 token、Cookie 或设置正文到日志。

## 独立文件

正式服务数据根目录由 `RIVETIN_DATA` 指定；演示使用插件目录的 `.runtime/rivetin/`：

```text
framework/settings.json
framework/disabled.json
plugins/<plugin-id>/config.json
plugins/<plugin-id>/state.json
packages/<sha256>.json
backups/
audit.jsonl
audit-delivery/
```

配置与生命周期状态分离，全部在静态目录之外。服务按描述文件的严格 schema 校验，未知属性拒绝。写入通过跨进程排他锁串行化，再临时文件、同步、原子重命名。CLI 与 API 使用同一实现；锁不自动抢占，遗留锁需要人工核对后处理。紧急禁用使用独立控制锁和标记，不依赖插件配置或生命周期锁。

当前部署单副本。不能将本地文件协议当作分布式数据库事务；多副本需要独立设计。聚合 GET 不承诺多个配置文件的同一时刻快照。

## 草稿、集群默认规则与保存

插件拥有独立 store 和配置页面，复用框架保存、丢弃和退出确认。只有明确保存成功才生效；失败保留草稿。PUT 响应不确定时先 GET 核对，不自动重复写。存在任一插件草稿时，生命周期修改会提示先保存或丢弃。

IPMI 插件读取当前可见集群，为每个新集群生成例外草稿，保存后共享。seededClusterIds 防止删除过的规则反复生成；不可见对象的既有规则保留。插件不把局部清单当作整台 Tower 全量清单。主机例外优先于集群例外，再到全局默认。

## 配置重置与恢复


明确重置会备份原文件字节再恢复默认；卸载保留配置。更新时 schema 版本变化会被拒绝；0.1 不执行任意迁移脚本。代码回滚不自动回滚管理员已保存的配置。

生命周期、审计、紧急禁用及已知边界见 [框架说明](../framework/README.md)。


## 命名约束

API、ID 和物理配置目录均使用 Rivetin 命名，不读取旧目录或旧 ID。详见[命名与路径](rivetin-naming.md)。

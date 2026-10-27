package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/term"
)

const recoveryTimeout = 4 * time.Minute

var diagnosticMessages = map[string][2]string{
	"PLUGIN_INCOMPATIBLE":                           {"该插件不支持当前 CloudTower 或框架版本，操作已停止。", "The plugin does not support the current CloudTower or framework version; the operation stopped."},
	"TOWER_BUILD_UNKNOWN":                           {"无法确认 CloudTower 版本，已阻止安装和启用插件。", "The CloudTower version is unknown; plugin installation and activation were blocked."},
	"PLUGIN_COMPATIBILITY_UNDECLARED":               {"安装包未声明可校验的已验证版本，请使用维护者提供的新版本。", "The package has no machine-readable verified version declaration. Use an updated package from its maintainer."},
	"SSH_PROFILE_INVALID":                           {"主机连接文件无效；请检查受限 JSON 格式、大小与文件类型。内容不会输出。", "The host profile file is invalid. Check the bounded JSON format and file type; its contents are never printed."},
	"SSH_PROFILE_REQUIRED":                          {"请使用 --host-profile-file 指定服务端 SSH 主机配置文件，不要把密码放入命令行。", "Provide --host-profile-file; do not put credentials on the command line."},
	"SSH_CHANNEL_REQUEST_REJECTED":                  {"SSH 通道管理请求被拒绝，请检查管理员权限和主机配置格式。", "The SSH channel management request was rejected. Check administrator access and the host profile format."},
	"SSH_CHANNEL_REQUEST_FAILED":                    {"无法连接 SSH 通道管理接口，请检查框架状态后重试。", "The SSH channel management API could not be reached. Check framework health before retrying."},
	"SSH_CHANNEL_READBACK_INVALID":                  {"尚未确认 SSH 主机配置保存成功，请核对通道页面后再重试。", "The host profile update could not be confirmed. Inspect the channel page before retrying."},
	"SSH_CHANNEL_ACTION_INVALID":                    {"SSH 通道命令仅支持 status、import-host、remove-host；不支持任意命令执行。", "Channel commands support status, import-host and remove-host; arbitrary execution is not supported."},
	"ISLAND_REGISTRY_UNAVAILABLE":                   {"无法读取 Tower Island 注册表。请核对 Tower 服务状态后重试，尚未将其视为未安装。", "The Tower Island registry could not be read. Check Tower before retrying; this is not treated as an absent installation."},
	"ISLAND_REGISTRY_INVALID":                       {"Island 注册表响应不符合已验证格式，已停止操作。请核对 Tower 构建及适配器。", "The Island registry response does not match the validated format. The operation stopped; verify the Tower build and adapter."},
	"ISLAND_MULTIPLE_INSTANCES":                     {"检测到多个 Rivetin Island 注册，已停止操作。请先完整备份并受控核对历史残留，不要重复注册。", "Multiple Rivetin Island registrations were found. Back up and reconcile historical entries before continuing; do not register another copy."},
	"ISLAND_REMOVE_READBACK_FAILED":                 {"尚未确认 Rivetin Island 已移除。请核对注册表及恢复记录，不要继续清空配置。", "Rivetin Island removal could not be confirmed. Inspect the registry and recovery record before clearing configuration."},
	"ISLAND_ARCHIVE_INVALID":                        {"Island 归档或海图格式无效，注册已拒绝。请使用经过核验的原始制品或备份。", "The Island archive or sea map is invalid. Registration was rejected; use a verified original artifact or backup."},
	"ISLAND_NAME_CHANGE_REQUIRES_MIGRATION":         {"现有与目标 Island 的实际注册名不同，已拒绝覆盖。请先备份并受控迁移旧注册，避免产生重复入口。", "The existing and target Island registry names differ. Back up and migrate the old registration explicitly to avoid duplicate entries."},
	"ISLAND_REGISTER_OUTCOME_UNKNOWN":               {"Island 注册请求结果尚未确认，恢复记录已保留。请先通过 status 核对 pending，再使用对应编号受控恢复。", "The Island registration outcome is unconfirmed and its recovery record was retained. Inspect pending with status, then recover using the operation ID."},
	"UNTESTED_TOWER_BUILD":                          {"当前 CloudTower 构建不在已验证的支持清单中，已停止继续部署。请使用匹配版本的安装器或完成该构建的兼容性验证。", "This CloudTower build is not in the validated support list. Deployment has been stopped. Use a matching installer or validate an adapter for this build."},
	"TOWER_COMPONENT_MISSING":                       {"未找到适配器要求的 CloudTower 组件。请核对产品构建和组件布局，不要跳过版本检查。", "A CloudTower component required by this adapter is missing. Verify the product build and component layout; do not bypass compatibility checks."},
	"SSH_CONNECT_FAILED":                            {"无法建立 SSH 连接。请检查目标地址、端口及网络连通性。", "The SSH connection could not be established. Check the target address, port and network connectivity."},
	"SSH_HANDSHAKE_FAILED":                          {"SSH 握手或认证失败。请核对账户、认证信息及受信任的主机指纹。", "The SSH handshake or authentication failed. Verify the account, credentials and trusted host-key fingerprint."},
	"SSH_HOST_KEY_MISMATCH":                         {"服务器主机密钥与指定指纹不一致，连接已拒绝。请通过可信渠道核实密钥变更，不要跳过校验。", "The server host key does not match the specified fingerprint. The connection was rejected. Verify any key change through a trusted channel; do not bypass verification."},
	"SSH_HOST_KEY_PIN_REQUIRED":                     {"必须提供经可信渠道核实的 SSH 主机密钥指纹。", "Provide an SSH host-key fingerprint verified through a trusted channel."},
	"SSH_SESSION_FAILED":                            {"无法建立 SSH 执行通道。请检查连接状态和服务器会话限制。", "An SSH execution channel could not be opened. Check the connection and server session limits."},
	"SSH_ENDPOINT_USER_AND_HOSTKEY_REQUIRED":        {"请完整提供 --ssh 主机:端口、--ssh-user 和 --ssh-hostkey。", "Provide --ssh HOST:PORT, --ssh-user and --ssh-hostkey."},
	"SSH_AND_HTTPS_HOST_MUST_MATCH":                 {"SSH 主机与 Tower HTTPS 地址的主机名必须一致，避免将后端和 Island 安装到不同目标。", "The SSH host and Tower HTTPS hostname must match to prevent deploying the backend and registering the Island on different targets."},
	"TOWER_CONNECTION_OR_CERTIFICATE_FAILED":        {"无法建立受信任的 Tower HTTPS 连接。请检查地址、网络与证书链；私有 CA 可通过 --ca-file 指定。", "A trusted Tower HTTPS connection could not be established. Check the address, network and certificate chain; use --ca-file for a private CA."},
	"CA_FILE_INVALID":                               {"无法读取或解析补充 CA 证书。请提供有效的 PEM 格式证书文件。", "The additional CA certificate could not be read or parsed. Provide a valid PEM certificate file."},
	"TLS_CERT_PIN_INVALID":                          {"证书指纹格式无效。--tls-cert-sha256 必须为叶证书 DER 内容 SHA-256 的 64 位十六进制值。", "The certificate pin is invalid. --tls-cert-sha256 requires the leaf certificate DER SHA-256 as 64 hexadecimal characters."},
	"TLS_CERT_PIN_MISMATCH":                         {"Tower 提供的 TLS 证书与指定指纹不一致，连接已拒绝。请通过独立可信渠道核实证书，不要忽略校验。", "The Tower TLS certificate does not match the specified pin. The connection was rejected. Verify the certificate through an independent trusted channel; do not bypass verification."},
	"TLS_CERT_VALIDITY_INVALID":                     {"被固定的 Tower TLS 证书已过期或尚未生效，连接已拒绝。请核对客户端时间及服务器证书。", "The pinned Tower TLS certificate is expired or not yet valid. The connection was rejected. Check the client clock and server certificate."},
	"TLS_TRUST_MODE_CONFLICT":                       {"--ca-file 与 --tls-cert-sha256 是不同的信任模式，不能同时指定。", "--ca-file and --tls-cert-sha256 select different trust modes and cannot be combined."},
	"HTTPS_TOWER_ORIGIN_REQUIRED":                   {"请通过 --tower 指定不含账户、路径、查询参数或片段的 HTTPS 站点地址。", "Use --tower to specify an HTTPS origin without user information, a path, query parameters or a fragment."},
	"TOWER_LOGIN_FAILED":                            {"Tower 登录失败。请核对管理员账户、密码及该版本的登录方式。", "Tower login failed. Verify the administrator account, password and login method supported by this build."},
	"TOWER_ADMIN_REQUIRED":                          {"当前 Tower 身份未通过管理员权限校验，未执行部署写入。", "The Tower identity did not pass administrator authorization. No deployment write was performed."},
	"TOWER_ADMIN_USERNAME_REQUIRED":                 {"请通过 --user 提供 Tower 管理员账户名称。", "Provide the Tower administrator username with --user."},
	"TOWER_IDENTITY_INVALID":                        {"Tower 返回的身份信息无法验证，操作已停止。", "The identity returned by Tower could not be verified. The operation was stopped."},
	"EXISTING_INSTALLATION_UNMANAGED":               {"发现同名部署或数据，但不属于本安装器管理范围。为避免覆盖，已停止操作；需要单独规划迁移。", "An existing deployment or data directory is not managed by this installer. The operation was stopped to prevent overwriting it; plan a separate migration."},
	"EXISTING_ISLAND_UNMANAGED":                     {"发现已有同名 Island，无法确认其安装器所有权，已停止操作。", "An existing Island with the same name has no verified installer ownership. The operation was stopped."},
	"RESOURCE_OWNERSHIP_MISMATCH":                   {"目标资源的所有权标记与恢复记录不一致。已停止修改，请先核查资源归属。", "Resource ownership does not match the installation or recovery record. Modification was stopped; investigate ownership first."},
	"INSTALLER_RECOVERY_REQUIRED":                   {"存在未完成的安装器操作。请先运行 status 查询恢复记录，再使用 recover 和对应编号处理。", "An installer operation is incomplete. Run status to inspect the recovery record, then use recover with the corresponding operation ID."},
	"INSTALLER_OPERATION_MISMATCH":                  {"恢复编号与当前待处理记录不一致。请先运行 status 核对，勿清除锁文件绕过检查。", "The recovery ID does not match the pending operation. Run status to verify it; do not remove lock files to bypass the check."},
	"RECOVERY_OPERATION_ID_REQUIRED":                {"recover 需要通过 --operation 指定有效的恢复记录编号。", "The recover command requires a valid recovery record ID supplied with --operation."},
	"ALREADY_INSTALLED_USE_UPDATE":                  {"框架已由安装器安装。需要更新时请使用 update。", "The framework is already installed by this installer. Use update to update it."},
	"FRAMEWORK_NOT_INSTALLED":                       {"未找到符合当前操作要求的 Rivetin 安装或数据布局。", "A Rivetin installation or data layout required for this operation was not found."},
	"FRAMEWORK_MIGRATION_REQUIRED":                  {"现有框架数据版本需要迁移，本版本安装器不执行该迁移。请先备份并使用受支持的迁移流程。", "The existing framework data version requires a migration that this installer does not perform. Back up the data and use a supported migration workflow."},
	"REMOTE_BOOTSTRAP_UNAVAILABLE":                  {"无法启动 Tower 端引导器。请检查 SSH 账户的免密 sudo、Python 3 可用性及执行权限。", "The Tower-side bootstrap could not be started. Check passwordless sudo, Python 3 availability and execution permissions for the SSH account."},
	"KUBERNETES_COMMAND_FAILED":                     {"Tower 端 Kubernetes 操作失败。请检查相关组件状态，并结合恢复记录确认是否需要回滚。", "A Tower-side Kubernetes operation failed. Check component health and the recovery record to determine whether rollback is required."},
	"REMOTE_TIMEOUT_OUTCOME_UNKNOWN":                {"等待远程操作超时，执行结果尚未确认。不要直接重试写入；先查询 status，并按恢复记录处理。", "The remote operation timed out and its outcome is unconfirmed. Do not repeat the write immediately; inspect status and follow the recovery record."},
	"REMOTE_PROTOCOL_FAILED_OUTCOME_UNKNOWN":        {"远程响应无法验证，执行结果尚未确认。请先查询恢复记录，不要盲目重试。", "The remote response could not be verified and the outcome is unconfirmed. Inspect the recovery record before retrying."},
	"REMOTE_COMPLETION_UNCONFIRMED_OUTCOME_UNKNOWN": {"远程会话未能确认操作完成。请先检查目标状态及恢复记录，再决定恢复步骤。", "The remote session did not confirm completion. Inspect the target state and recovery record before proceeding."},
	"COMMIT_UNCONFIRMED":                            {"操作提交尚未确认。请保留恢复编号并查询 status，确认实际状态后再执行恢复。", "The operation commit is unconfirmed. Retain the recovery ID and inspect status before deciding whether to recover."},
	"ROLLED_BACK_PLUGINS_DISABLED":                  {"已完成回滚；子插件保持停用，功能配置与恢复备份保留。请排除失败原因后再操作。", "Rollback completed. Plugins remain disabled, and settings and recovery backups were retained. Resolve the failure before proceeding."},
	"ROLLBACK_INCOMPLETE":                           {"自动回滚未完成。请保留恢复编号，核查目标状态后执行 recover；不要删除备份或锁记录。", "Automatic rollback is incomplete. Retain the recovery ID, inspect the target and run recover; do not remove backups or lock records."},
	"ISLAND_REGISTER_FAILED":                        {"Island 注册失败。请检查 Tower 注册服务状态，并核对回滚结果。", "Island registration failed. Check the Tower registry service and verify the rollback result."},
	"ISLAND_BACKUP_FAILED":                          {"无法确认 Island 备份成功，操作已停止。", "The Island backup could not be confirmed. The operation was stopped."},
	"ISLAND_BACKUP_INVALID":                         {"Island 备份内容无效，未将其作为可用恢复包。", "The Island backup is invalid and was not accepted as a usable recovery package."},
	"ISLAND_REMOVE_FAILED":                          {"无法确认 Island 移除成功。请检查目标状态及恢复记录。", "Island removal could not be confirmed. Inspect the target state and recovery record."},
	"ISLAND_READBACK_MISMATCH":                      {"注册后的 Island 资产与安装包不一致，验证失败。", "The registered Island asset does not match the installation package. Readback verification failed."},
	"ISLAND_MOUNT_MISSING":                          {"注册结果中未找到要求的常驻挂载区域。请核对 Tower 版本适配。", "The required permanent mount was not found in the registry response. Check the Tower version adapter."},
	"BACKEND_READBACK_FAILED":                       {"后端健康状态或版本回读未通过验证，不能确认安装成功。", "Backend state or version readback failed verification; installation success cannot be confirmed."},
	"BUNDLE_CHECKSUM_FAILED":                        {"内嵌安装资源校验失败。请重新获取可信的完整可执行文件。", "Embedded installation resources failed integrity verification. Obtain a complete executable from a trusted source."},
	"SERVICE_ARCHIVE_INVALID":                       {"服务归档包含不受支持的路径、文件类型或内容，已拒绝解包。", "The service archive contains unsupported paths, file types or content and was rejected."},
	"SERVICE_ARCHIVE_LIMIT":                         {"服务归档超过规定的文件数量或大小限制，已拒绝解包。", "The service archive exceeds the file-count or size limit and was rejected."},
	"INSTALLED_CODE_CHANGED":                        {"现有安装代码与受验证的发布内容不一致，已停止覆盖。请先核查代码变更。", "Installed code differs from the validated release content. Overwriting was stopped; investigate the changes first."},
	"UNSAFE_INSTALL_PATH":                           {"安装目录包含不受支持的符号链接或路径重定向，已停止操作。", "The installation contains an unsupported symbolic link or redirected path. The operation was stopped."},
	"STORE_BUSY":                                    {"数据存储正由其他操作使用。请等待现有操作完成后重试；不要强制清除锁。", "The data store is in use by another operation. Wait for it to finish before retrying; do not force-remove its lock."},
	"REMOTE_OUTPUT_LIMIT":                           {"远程输出超过安全上限，响应未被接受。请通过受控方式检查目标状态。", "Remote output exceeded the safety limit and was not accepted. Inspect the target through a controlled diagnostic workflow."},
	"REMOTE_OPERATION_FAILED":                       {"远程操作失败。为保护凭据与内部信息，未直接输出底层诊断；请结合恢复记录和目标状态排查。", "The remote operation failed. Low-level diagnostics were omitted to protect credentials and internal information; investigate using the recovery record and target state."},
	"INTERACTIVE_TERMINAL_REQUIRED":                 {"请在交互终端中运行，以便安全输入不回显的密码。", "Run the command in an interactive terminal to enter passwords without echo."},
	"SECRET_INPUT_FAILED":                           {"无法从终端安全读取密码。请检查终端状态后重新运行。", "The password could not be read securely from the terminal. Check the terminal and run the command again."},
	"INVALID_PLUGIN_ACTION":                         {"子插件操作无效。请使用 plugin install、update、enable、disable、uninstall 或 list。", "The plugin action is invalid. Use plugin install, update, enable, disable, uninstall or list."},
	"PLUGIN_ID_REQUIRED":                            {"该子插件操作需要通过 --plugin-id 指定插件标识。", "This plugin action requires a plugin identifier supplied with --plugin-id."},
	"INVALID_PLUGIN_ID":                             {"插件标识无效。请使用不超过 100 字符的小写 rivetin- 功能标识。", "The plugin identifier is invalid. Use a lowercase rivetin- identifier of at most 100 characters."},
	"PLUGIN_PACKAGE_REQUIRED":                       {"安装或升级子插件需要通过 --package 指定 Rivetin 插件包。", "Installing or updating a plugin requires a Rivetin package supplied with --package."},
	"PLUGIN_PACKAGE_UNAVAILABLE":                    {"无法读取插件包。请选择可读取的常规文件。", "The plugin package could not be read. Select a readable regular file."},
	"PLUGIN_PACKAGE_TOO_LARGE":                      {"插件包超过 16 MiB 上限，已停止读取。", "The plugin package exceeds the 16 MiB limit and was not read."},
	"FRAMEWORK_ENABLE_FAILED":                       {"恢复框架运行的请求失败。请检查插件服务状态和管理员权限。", "The framework enable request failed. Check the plugin service and administrator permissions."},
	"FRAMEWORK_ENABLE_READBACK_FAILED":              {"尚未确认框架已恢复运行。请检查插件中心状态后再操作。", "Framework enablement could not be confirmed. Inspect Plugin Center before proceeding."},
	"UNINSTALL_FRAMEWORK_BEFORE_RESET":              {"框架尚未完全卸载，配置退归档已拒绝。请先完成框架卸载并核对资源状态。", "The framework is not fully uninstalled. Configuration archival was rejected. Finish uninstalling the framework and verify its resources first."},
	"PLUGIN_PODS_STILL_PRESENT":                     {"仍存在 Rivetin Pod，配置退归档已拒绝。请等待框架卸载完成并核对残留资源。", "Rivetin Pods are still present. Configuration archival was rejected. Wait for framework uninstallation and inspect remaining resources."},
	"RESET_CONFIG_OUTCOME_UNKNOWN":                  {"配置退归档结果尚未确认。请根据已显示的操作编号，只读核对 backups/<编号>/cleared-data、manifest.json 和 state.json，再受控人工处理；不要使用通用 recover 命令。", "Configuration archival has an unconfirmed outcome. Use the displayed operation ID to inspect backups/<ID>/cleared-data, manifest.json and state.json read-only, then perform controlled manual recovery; do not use the generic recover command."},
	"CREDENTIAL_INPUT_INVALID":                      {"标准输入凭据无效。请提供不超过 16 KiB 的单个 JSON 对象，仅包含 sshPassword 和可选的 towerPassword；需要 Tower 登录的命令必须同时提供两项。", "The credential input is invalid. Provide one JSON object of at most 16 KiB containing only sshPassword and optional towerPassword; commands requiring Tower login need both."},
	"CREDENTIAL_INPUT_REQUIRES_PIPE":                {"--credentials-stdin 仅接受管道或重定向的标准输入。交互输入密码时请省略该参数，使用默认的不回显提示。", "--credentials-stdin requires piped or redirected input. Omit this option for the default non-echoing terminal prompts."},
	"INVALID_LANGUAGE":                              {"不支持该语言参数。请使用 --lang zh-CN 或 --lang en-US。", "The language option is unsupported. Use --lang zh-CN or --lang en-US."},
	"UNKNOWN_COMMAND":                               {"无法识别命令。请运行 help 查看支持的命令。", "The command is not recognized. Run help to view supported commands."},
	"INVALID_ARGUMENTS":                             {"命令参数无效。请运行 help 核对参数名称和必填项。", "The command arguments are invalid. Run help to check option names and required values."},
	"UNEXPECTED_ARGUMENT":                           {"命令包含不支持的位置参数。请运行 help 核对用法。", "The command contains an unsupported positional argument. Run help to check the syntax."},
	"OPERATION_TIMEOUT":                             {"操作超过等待时限。若已经开始远程写入，请先核查恢复记录和目标状态，不要直接重复写入。", "The operation exceeded its time limit. If a remote write started, inspect the recovery record and target state before repeating it."},
	"OPERATION_FAILED":                              {"操作未完成。未直接输出可能包含敏感信息的底层错误，请结合已显示的操作编号及目标状态排查。", "The operation did not complete. Potentially sensitive low-level errors were omitted; investigate using the displayed operation ID and target state."},
}

var diagnosticAliases = map[string]string{
	"ADAPTER_UNAVAILABLE": "TOWER_COMPONENT_MISSING", "PROBE_INVALID": "TOWER_COMPONENT_MISSING", "TOWER_REQUIRED": "HTTPS_TOWER_ORIGIN_REQUIRED", "INVALID_ORIGIN": "HTTPS_TOWER_ORIGIN_REQUIRED",
	"REDIRECT_REJECTED": "TOWER_CONNECTION_OR_CERTIFICATE_FAILED", "TOWER_RESPONSE_LIMIT": "REMOTE_OUTPUT_LIMIT", "PAYLOAD_NOT_BUILT": "BUNDLE_CHECKSUM_FAILED", "BUNDLE_INVALID": "BUNDLE_CHECKSUM_FAILED",
	"BACKUP_INVALID": "ISLAND_BACKUP_INVALID", "ISLAND_BACKUP_LIMIT": "SERVICE_ARCHIVE_LIMIT", "SERVICE_CHECKSUM_FAILED": "BUNDLE_CHECKSUM_FAILED", "ISLAND_REGION_INVALID": "ISLAND_MOUNT_MISSING", "ISLAND_REGION_UNAVAILABLE": "ISLAND_MOUNT_MISSING",
	"INSTALLATION_FILE_LIMIT": "SERVICE_ARCHIVE_LIMIT", "INVALID_OPERATION_ID": "RECOVERY_OPERATION_ID_REQUIRED", "OPERATION_ALREADY_EXISTS": "INSTALLER_RECOVERY_REQUIRED", "INVALID_INSTALLER_MODE": "INVALID_ARGUMENTS", "INVALID_INSTALLER_PHASE": "INSTALLER_RECOVERY_REQUIRED", "UNKNOWN_ACTION": "UNKNOWN_COMMAND",
}

var diagnosticCodePattern = regexp.MustCompile(`\b[A-Z][A-Z0-9_]{2,79}\b`)
var recoveryIDPattern = regexp.MustCompile(`(?:; recover operation ([a-f0-9]{32}) if pending|; recovery required: ([a-f0-9]{32})|; ROLLBACK_INCOMPLETE operation ([a-f0-9]{32})|^COMMIT_UNCONFIRMED; recovery operation ([a-f0-9]{32}))$`)

// Diagnostics use only known codes and validated recovery IDs, never raw remote errors.
func explainError(err error, lang string) string {
	if err == nil {
		return ""
	}
	index := 0
	if lang == "en-US" {
		index = 1
	}
	raw := err.Error()
	seen := map[string]bool{}
	var lines []string
	for _, code := range diagnosticCodePattern.FindAllString(raw, -1) {
		key := code
		if alias, ok := diagnosticAliases[code]; ok {
			key = alias
		}
		message, known := diagnosticMessages[key]
		if !known || seen[code] {
			continue
		}
		seen[code] = true
		lines = append(lines, message[index]+" ["+code+"]")
	}
	if len(lines) == 0 {
		code := "OPERATION_FAILED"
		if errors.Is(err, context.DeadlineExceeded) {
			code = "OPERATION_TIMEOUT"
		}
		lines = append(lines, diagnosticMessages[code][index]+" ["+code+"]")
	}
	if matches := recoveryIDPattern.FindStringSubmatch(raw); matches != nil {
		for _, id := range matches[1:] {
			if id == "" {
				continue
			}
			if index == 1 {
				lines = append(lines, "Recovery record: "+id+". Inspect status before using recover --operation "+id+".")
			} else {
				lines = append(lines, "恢复记录编号："+id+"。请先查询 status，再按需使用 recover --operation "+id+"。")
			}
			break
		}
	}
	return strings.Join(lines, "\n")
}

func requestedLanguage(args []string) (string, error) {
	lang := "zh-CN"
	for i := 0; i < len(args); i++ {
		value := ""
		if args[i] == "--lang" {
			if i+1 >= len(args) {
				return lang, errors.New("INVALID_LANGUAGE")
			}
			i++
			value = args[i]
		} else if strings.HasPrefix(args[i], "--lang=") {
			value = strings.TrimPrefix(args[i], "--lang=")
		} else {
			continue
		}
		if value != "zh-CN" && value != "en-US" {
			return lang, errors.New("INVALID_LANGUAGE")
		}
		lang = value
	}
	return lang, nil
}

func printHelp(out io.Writer, lang string) {
	if lang == "en-US" {
		fmt.Fprintln(out, `Rivetin portable CLI 0.1.0
Usage: rivetin <install|update|uninstall|enable|disable|reset-config|detect|status|plan|recover> [options]
       rivetin plugin <install|update|enable|disable|uninstall|list> [options]
       rivetin channel <status|import-host|remove-host> [options]
       rivetin version | licenses | help

--ssh HOST:PORT          Tower VM SSH endpoint
--ssh-user USER          SSH account with passwordless sudo
--ssh-hostkey SHA256:...  Host-key fingerprint verified through a trusted channel
--tower https://HOST     Tower HTTPS origin; its hostname must match the SSH host
--user USER              Tower administrator; passwords are prompted without echo
--ca-file FILE           Additional PEM CA certificate; no system trust changes
--tls-cert-sha256 HEX    Exact DER leaf certificate pin verified independently; replaces PKI trust
--operation ID           Recovery record ID, for recover only
--lang zh-CN|en-US       Output language; default zh-CN
--credentials-stdin      Read credentials from a bounded JSON object on standard input
--package FILE           Rivetin package for plugin install/update, at most 16 MiB
--plugin-id ID           Plugin identifier; optional for install/update and list
--host-profile-file FILE Sensitive host JSON for channel import-host; never printed
--host-id ID             Host identity for channel remove-host

No client runtime, external SSH, PATH or registry changes are required.
Unknown Tower builds are rejected before deployment writes. Emergency disable needs
SSH only and does not depend on Tower Web/API or Kubernetes availability.
Uninstall retains data, code releases and backups. Updates leave plugins disabled.
reset-config archives settings only after the framework is fully uninstalled.`)
		return
	}
	fmt.Fprintln(out, `Rivetin 便携式 CLI 0.1.0
用法：rivetin <install|update|uninstall|enable|disable|reset-config|detect|status|plan|recover> [参数]
      rivetin plugin <install|update|enable|disable|uninstall|list> [参数]
      rivetin channel <status|import-host|remove-host> [参数]
      rivetin version | licenses | help

--ssh 主机:端口           Tower 虚拟机的 SSH 地址
--ssh-user 用户名         已配置免密 sudo 的 SSH 账户
--ssh-hostkey SHA256:...  通过可信渠道核实的主机密钥指纹
--tower https://主机      Tower HTTPS 站点；主机名必须与 SSH 主机一致
--user 用户名             Tower 管理员；密码仅通过终端不回显输入
--ca-file 文件            补充 PEM 格式 CA 证书，不修改系统信任库
--tls-cert-sha256 HEX     独立核验的 DER 叶证书指纹；使用精确证书固定信任模式
--operation 编号          recover 使用的恢复记录编号
--lang zh-CN|en-US        输出语言，默认 zh-CN
--credentials-stdin      从标准输入读取有大小限制的 JSON 凭据对象
--package 文件           子插件安装／升级包，最大 16 MiB
--plugin-id 标识          插件标识；安装／升级和列表操作可省略
--host-profile-file 文件  channel import-host 使用的敏感主机 JSON 文件，不回显内容
--host-id 标识            channel remove-host 使用的主机标识

无需客户端额外运行时或外部 SSH，不修改 PATH、注册表及系统配置。
未验证的 Tower 构建在部署写入前拒绝。紧急禁用仅需 SSH，不依赖 Tower Web/API
或 Kubernetes 可用性。卸载保留配置、代码版本及备份；更新后插件保持停用。
reset-config 仅在框架已完全卸载后将配置退归档。`)
}

func secret(label string) (string, error) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return "", errors.New("INTERACTIVE_TERMINAL_REQUIRED")
	}
	fmt.Fprint(os.Stderr, label+": ")
	value, err := term.ReadPassword(fd)
	fmt.Fprintln(os.Stderr)
	if err != nil {
		return "", errors.New("SECRET_INPUT_FAILED")
	}
	defer clear(value)
	return string(value), nil
}

const credentialInputLimit = 16 * 1024
const pluginPackageLimit = 16 * 1024 * 1024

var pluginIdentifier = pluginIDPattern
var channelHostID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

func normalizePluginCommand(args []string) ([]string, error) {
	if len(args) > 0 && args[0] == "channel" {
		if len(args) > 1 && (args[1] == "--help" || args[1] == "-h") {
			return args, nil
		}
		if len(args) < 2 || !strings.Contains("|status|import-host|remove-host|", "|"+args[1]+"|") {
			return nil, errors.New("SSH_CHANNEL_ACTION_INVALID")
		}
		return append([]string{"channel." + args[1]}, args[2:]...), nil
	}
	if len(args) == 0 || args[0] != "plugin" {
		return args, nil
	}
	if len(args) > 1 && (args[1] == "--help" || args[1] == "-h") {
		return args, nil
	}
	if len(args) < 2 || !strings.Contains("|install|update|enable|disable|uninstall|list|", "|"+args[1]+"|") {
		return nil, errors.New("INVALID_PLUGIN_ACTION")
	}
	return append([]string{"plugin." + args[1]}, args[2:]...), nil
}

func readPluginPackage(file string) ([]byte, error) {
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("PLUGIN_PACKAGE_UNAVAILABLE")
	}
	if info.Size() > pluginPackageLimit {
		return nil, errors.New("PLUGIN_PACKAGE_TOO_LARGE")
	}
	input, err := os.Open(file)
	if err != nil {
		return nil, errors.New("PLUGIN_PACKAGE_UNAVAILABLE")
	}
	defer input.Close()
	bytes, err := io.ReadAll(io.LimitReader(input, pluginPackageLimit+1))
	if err != nil {
		return nil, errors.New("PLUGIN_PACKAGE_UNAVAILABLE")
	}
	if len(bytes) > pluginPackageLimit {
		return nil, errors.New("PLUGIN_PACKAGE_TOO_LARGE")
	}
	return bytes, nil
}

type inputCredentials struct {
	sshPassword   string
	towerPassword string
}

func readCredentials(input io.Reader, requireTower bool) (inputCredentials, error) {
	invalid := func() (inputCredentials, error) { return inputCredentials{}, errors.New("CREDENTIAL_INPUT_INVALID") }
	raw, err := io.ReadAll(io.LimitReader(input, credentialInputLimit+1))
	if err != nil || len(raw) == 0 || len(raw) > credentialInputLimit || !utf8.Valid(raw) {
		clear(raw)
		return invalid()
	}
	defer clear(raw)
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return invalid()
	}
	var result inputCredentials
	seen := make(map[string]bool, 2)
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] || (key != "sshPassword" && key != "towerPassword") {
			return invalid()
		}
		seen[key] = true
		var decoded any
		if decoder.Decode(&decoded) != nil {
			return invalid()
		}
		value, ok := decoded.(string)
		if !ok || len(value) == 0 || len(value) > 8192 || strings.IndexFunc(value, unicode.IsControl) >= 0 {
			return invalid()
		}
		if key == "sshPassword" {
			result.sshPassword = value
		} else {
			result.towerPassword = value
		}
	}
	last, err := decoder.Token()
	if err != nil || last != json.Delim('}') || result.sshPassword == "" || (requireTower && result.towerPassword == "") {
		return invalid()
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return invalid()
	}
	return result, nil
}

func run(args []string, out io.Writer) error {
	language, languageErr := requestedLanguage(args)
	if languageErr != nil {
		return languageErr
	}
	// Accept the language option before the command as well as after it.
	var prefix []string
	for len(args) > 0 && (args[0] == "--lang" || strings.HasPrefix(args[0], "--lang=")) {
		count := 1
		if args[0] == "--lang" {
			count = 2
		}
		prefix = append(prefix, args[:count]...)
		args = args[count:]
	}
	var normalizeErr error
	args, normalizeErr = normalizePluginCommand(args)
	if normalizeErr != nil {
		return normalizeErr
	}
	if len(args) > 0 && len(prefix) > 0 {
		args = append(append([]string{args[0]}, prefix...), args[1:]...)
	}
	help := len(args) == 0 || args[0] == "help"
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			help = true
		}
	}
	if help {
		printHelp(out, language)
		return nil
	}
	mode := args[0]
	if mode == "version" {
		fmt.Fprintln(out, "rivetin 0.1.0")
		return nil
	}
	if mode == "licenses" {
		raw, err := assets.ReadFile("payload/NOTICES.txt")
		if err != nil {
			return err
		}
		_, err = out.Write(raw)
		return err
	}
	if !strings.Contains("|install|update|uninstall|enable|disable|reset-config|detect|status|plan|recover|plugin.install|plugin.update|plugin.enable|plugin.disable|plugin.uninstall|plugin.list|channel.status|channel.import-host|channel.remove-host|", "|"+mode+"|") {
		return errors.New("UNKNOWN_COMMAND")
	}
	flags := flag.NewFlagSet("rivetin", flag.ContinueOnError)
	// flag errors may contain caller-provided values; diagnostics are emitted separately.
	flags.SetOutput(io.Discard)
	host := flags.String("ssh", "", "SSH endpoint")
	sshUser := flags.String("ssh-user", "", "SSH user")
	pin := flags.String("ssh-hostkey", "", "SSH fingerprint")
	origin := flags.String("tower", "", "Tower origin")
	user := flags.String("user", "", "Tower administrator")
	ca := flags.String("ca-file", "", "Additional CA")
	tlsPin := flags.String("tls-cert-sha256", "", "Independently verified leaf certificate SHA-256")
	operation := flags.String("operation", "", "Recovery ID")
	lang := flags.String("lang", language, "Language")
	credentialsStdin := flags.Bool("credentials-stdin", false, "Read credentials from standard input")
	packageFile := flags.String("package", "", "Rivetin package file")
	pluginID := flags.String("plugin-id", "", "Plugin identifier")
	hostProfileFile := flags.String("host-profile-file", "", "Sensitive SSH host profile JSON file")
	hostID := flags.String("host-id", "", "SSH channel host identifier")
	if err := flags.Parse(args[1:]); err != nil {
		return errors.New("INVALID_ARGUMENTS")
	}
	if flags.NArg() > 0 {
		return errors.New("UNEXPECTED_ARGUMENT")
	}
	if *lang != "zh-CN" && *lang != "en-US" {
		return errors.New("INVALID_LANGUAGE")
	}
	if _, _, err := net.SplitHostPort(*host); err != nil || *sshUser == "" || *pin == "" {
		return errors.New("SSH_ENDPOINT_USER_AND_HOSTKEY_REQUIRED")
	}
	if mode == "recover" && (len(*operation) != 32 || strings.Trim(*operation, "abcdef0123456789") != "") {
		return errors.New("RECOVERY_OPERATION_ID_REQUIRED")
	}
	var pluginPackage []byte
	if strings.HasPrefix(mode, "plugin.") {
		if *pluginID != "" && (len(*pluginID) > 100 || !pluginIdentifier.MatchString(*pluginID)) {
			return errors.New("INVALID_PLUGIN_ID")
		}
		if mode == "plugin.install" || mode == "plugin.update" {
			if *packageFile == "" {
				return errors.New("PLUGIN_PACKAGE_REQUIRED")
			}
			var err error
			pluginPackage, err = readPluginPackage(*packageFile)
			if err != nil {
				return err
			}
		} else {
			if *packageFile != "" {
				return errors.New("INVALID_ARGUMENTS")
			}
			if mode != "plugin.list" && *pluginID == "" {
				return errors.New("PLUGIN_ID_REQUIRED")
			}
		}
	} else if *packageFile != "" || *pluginID != "" {
		return errors.New("INVALID_ARGUMENTS")
	}
	var api *Tower
	var err error
	var channelProfile []byte
	if mode == "channel.import-host" {
		if *hostProfileFile == "" || *hostID != "" {
			return errors.New("SSH_PROFILE_REQUIRED")
		}
		channelProfile, err = readHostProfile(*hostProfileFile)
		if err != nil {
			return err
		}
		defer clear(channelProfile)
	} else if *hostProfileFile != "" {
		return errors.New("INVALID_ARGUMENTS")
	}
	if mode == "channel.remove-host" {
		if !channelHostID.MatchString(*hostID) {
			return errors.New("SSH_HOST_INVALID")
		}
	} else if *hostID != "" {
		return errors.New("INVALID_ARGUMENTS")
	}
	if mode == "install" || mode == "update" || mode == "uninstall" || mode == "recover" || mode == "enable" || strings.HasPrefix(mode, "plugin.") || strings.HasPrefix(mode, "channel.") {
		api, err = newTowerWithPin(*origin, *ca, *tlsPin)
		if err != nil {
			return err
		}
		if *user == "" {
			return errors.New("TOWER_ADMIN_USERNAME_REQUIRED")
		}
		sshHost, _, _ := net.SplitHostPort(*host)
		towerURL, _ := url.Parse(api.base)
		if !strings.EqualFold(sshHost, towerURL.Hostname()) {
			return errors.New("SSH_AND_HTTPS_HOST_MUST_MATCH")
		}
	}
	sshLabel, towerLabel := "SSH 密码", "Tower 管理员密码"
	if *lang == "en-US" {
		sshLabel, towerLabel = "SSH password", "Tower administrator password"
	}
	var supplied inputCredentials
	var password string
	if *credentialsStdin {
		if term.IsTerminal(int(os.Stdin.Fd())) {
			return errors.New("CREDENTIAL_INPUT_REQUIRES_PIPE")
		}
		supplied, err = readCredentials(os.Stdin, api != nil)
		if err != nil {
			return err
		}
		password = supplied.sshPassword
		supplied.sshPassword = ""
	} else {
		password, err = secret(sshLabel)
		if err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	remote, err := dialSSH(ctx, *host, *sshUser, password, *pin)
	password = ""
	if err != nil {
		return err
	}
	defer remote.client.Close()
	// Probe before asking for Tower credentials, authenticating or performing writes.
	if mode != "disable" {
		if _, _, err = probeRemote(ctx, remote); err != nil && !((mode == "detect" || mode == "status" || mode == "plan") && err.Error() == "UNTESTED_TOWER_BUILD") {
			return err
		}
	}
	towerPassword := ""
	if api != nil {
		if *credentialsStdin {
			towerPassword = supplied.towerPassword
			supplied.towerPassword = ""
		} else {
			towerPassword, err = secret(towerLabel)
			if err != nil {
				return err
			}
		}
	}
	engine := Engine{Remote: remote, Tower: api, PluginID: *pluginID, PluginPackage: pluginPackage, ChannelProfile: channelProfile, ChannelHostID: *hostID, Progress: func(line string) {
		if *lang == "zh-CN" {
			line = strings.ReplaceAll(line, "BACKEND_READBACK ", "后端验证：")
			line = strings.ReplaceAll(line, "PROFILE ", "适配版本：")
			line = strings.ReplaceAll(line, "DETECTED ", "检测构建：")
			line = strings.ReplaceAll(line, "SUPPORTED false", "受支持构建：否")
			line = strings.ReplaceAll(line, "SUPPORTED true", "受支持构建：是")
			line = strings.ReplaceAll(line, "OPERATION ", "恢复记录编号：")
			line = strings.ReplaceAll(line, "COMPLETE plugins remain disabled; data and backups retained", "操作完成；插件保持停用，数据与备份已保留")
			line = strings.ReplaceAll(line, "WARNING audit record unavailable", "警告：禁用已生效，但未能写入审计记录")
			line = strings.ReplaceAll(line, "CONFIG_RESET configuration archived; fresh install required", "配置已退归档；下次安装将使用默认配置")
			line = strings.ReplaceAll(line, "FRAMEWORK_ENABLED runtime verified", "框架已启用，状态回读验证通过")
		}
		fmt.Fprintln(out, line)
	}}
	err = engine.Run(ctx, mode, *user, towerPassword, *operation)
	towerPassword = ""
	return err
}
func main() {
	args := os.Args[1:]
	if err := run(args, os.Stdout); err != nil {
		lang, _ := requestedLanguage(args)
		fmt.Fprintln(os.Stderr, "Rivetin:", explainError(err, lang))
		os.Exit(1)
	}
}

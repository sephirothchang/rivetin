package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mainFixtureDirectory(t *testing.T) string {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Join(root, ".runtime")
	if err := os.MkdirAll(base, 0o700); err != nil {
		t.Fatal(err)
	}
	if resolved, err := filepath.EvalSymlinks(base); err != nil || resolved != base {
		t.Fatal("test directory redirected outside workspace")
	}
	directory, err := os.MkdirTemp(base, "main-input-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if filepath.Dir(directory) != base {
			t.Fatal("unsafe test cleanup path")
		}
		if err := os.RemoveAll(directory); err != nil {
			t.Error(err)
		}
	})
	return directory
}

func TestRelease014VersionAndLocalizedHelp(t *testing.T) {

	var version bytes.Buffer
	if err := run([]string{"version"}, &version); err != nil || version.String() != "rivetin 0.1.4\n" {
		t.Fatal("release version mismatch", err, version.String())
	}
	for _, language := range []string{"zh-CN", "en-US"} {
		var help bytes.Buffer
		if err := run([]string{"--lang", language, "--help"}, &help); err != nil || !strings.Contains(help.String(), "0.1.4") {
			t.Fatal("localized help version mismatch", language, err)
		}
	}
}

func TestPluginCommandNormalizationAndHelp(t *testing.T) {
	for _, action := range []string{"install", "update", "enable", "disable", "uninstall", "list"} {
		args, err := normalizePluginCommand([]string{"plugin", action, "--plugin-id", "rivetin-example"})
		if err != nil || len(args) != 3 || args[0] != "plugin."+action || args[1] != "--plugin-id" {
			t.Fatal(action, err, args)
		}
	}
	for _, args := range [][]string{{"plugin"}, {"plugin", "unknown"}} {
		if _, err := normalizePluginCommand(args); err == nil || err.Error() != "INVALID_PLUGIN_ACTION" {
			t.Fatal("invalid plugin action accepted")
		}
	}
	for _, lang := range []string{"zh-CN", "en-US"} {
		var out bytes.Buffer
		if err := run([]string{"--lang", lang, "plugin", "--help"}, &out); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(out.String(), "reset-config") || !strings.Contains(out.String(), "--package") || !strings.Contains(out.String(), "plugin <install") {
			t.Fatal("new commands absent from help")
		}
	}
}

func TestPluginPackageInputIsBoundedAndErrorsDoNotExposePaths(t *testing.T) {
	directory := mainFixtureDirectory(t)
	file := filepath.Join(directory, "example-package.json")
	if err := os.WriteFile(file, []byte("EXAMPLE_PACKAGE"), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readPluginPackage(file)
	if err != nil || string(data) != "EXAMPLE_PACKAGE" {
		t.Fatal("valid package rejected")
	}
	for _, name := range []string{filepath.Join(directory, "EXAMPLE_PRIVATE_PATH"), directory} {
		if _, err := readPluginPackage(name); err == nil || err.Error() != "PLUGIN_PACKAGE_UNAVAILABLE" || strings.Contains(err.Error(), name) {
			t.Fatal("file error was not sanitized")
		}
	}
	large := filepath.Join(directory, "large-package.json")
	input, err := os.OpenFile(large, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if err := input.Truncate(pluginPackageLimit + 1); err != nil {
		input.Close()
		t.Fatal(err)
	}
	input.Close()
	if _, err := readPluginPackage(large); err == nil || err.Error() != "PLUGIN_PACKAGE_TOO_LARGE" {
		t.Fatal("oversized package accepted")
	}
}

func TestNewCommandsValidateParametersBeforeCredentialsOrConnections(t *testing.T) {
	base := []string{"--ssh", "ssh.example.invalid:22", "--ssh-user", "EXAMPLE_USER", "--ssh-hostkey", "SHA256:EXAMPLE_PIN", "--tower", "https://tower.example.invalid", "--user", "EXAMPLE_ADMIN", "--credentials-stdin"}
	for _, mode := range [][]string{{"enable"}, {"plugin", "list"}, {"plugin", "enable", "--plugin-id", "rivetin-example"}} {
		args := append(append([]string{}, mode...), base...)
		if err := run(args, &bytes.Buffer{}); err == nil || err.Error() != "SSH_AND_HTTPS_HOST_MUST_MATCH" {
			t.Fatal("new command skipped API target validation", args, err)
		}
	}
	for _, test := range []struct {
		args []string
		code string
	}{
		{[]string{"plugin", "install"}, "PLUGIN_PACKAGE_REQUIRED"},
		{[]string{"plugin", "enable"}, "PLUGIN_ID_REQUIRED"},
		{[]string{"plugin", "uninstall", "--plugin-id", "../EXAMPLE"}, "INVALID_PLUGIN_ID"},
		{[]string{"plugin", "list", "--package", "EXAMPLE_FILE"}, "INVALID_ARGUMENTS"},
	} {
		args := append(append([]string{}, test.args...), base...)
		if err := run(args, &bytes.Buffer{}); err == nil || err.Error() != test.code {
			t.Fatal(test.code, err)
		}
	}
}

func TestResetConfigUsesSSHOnlyAfterVersionGate(t *testing.T) {
	r := &fakeRemote{probe: fixtureProbe()}
	if err := (Engine{Remote: r}).Run(context.Background(), "reset-config", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,reset-config" {
		t.Fatal(r.calls)
	}
	r = &fakeRemote{probe: fixtureProbe()}
	r.probe.Image = "UNTESTED"
	if err := (Engine{Remote: r}).Run(context.Background(), "reset-config", "", "", ""); err == nil || err.Error() != "UNTESTED_TOWER_BUILD" || strings.Join(r.calls, ",") != "probe" {
		t.Fatal("reset skipped version gate", err, r.calls)
	}
}

func TestResetConfigUnknownOutcomeDoesNotRecommendGenericRecovery(t *testing.T) {
	for _, lang := range []string{"zh-CN", "en-US"} {
		message := explainError(errors.New("RESET_CONFIG_OUTCOME_UNKNOWN"), lang)
		if !strings.Contains(message, "cleared-data") || !strings.Contains(message, "manifest.json") || !strings.Contains(message, "state.json") || strings.Contains(message, "recover --operation") {
			t.Fatal(message)
		}
	}
}

type mainActionTransport struct {
	delegate     http.RoundTripper
	runtime      string
	enableStatus int
	enabled      bool
	pluginListed bool
}

func (m *mainActionTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	status, body := 200, ""
	switch req.URL.Path {
	case "/api/rivetin/v1/enable":
		m.enabled = true
		if m.enableStatus != 0 {
			status = m.enableStatus
		}
		body = `{"enabled":true}`
	case "/api/rivetin/v1/runtime":
		body = m.runtime
	case "/api/rivetin/v1/plugins":
		m.pluginListed = true
		body = `{"items":[]}`
	default:
		return m.delegate.RoundTrip(req)
	}
	if req.Header.Get("Authorization") == "" {
		return nil, errors.New("MISSING_TEST_AUTHENTICATION")
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header), Request: req}, nil
}

func TestFrameworkEnableAuthenticatesAndVerifiesRuntime(t *testing.T) {
	bundle, _, err := payload()
	if err != nil {
		t.Fatal(err)
	}
	mismatch := "0.0.0"
	if bundle.Version == mismatch {
		mismatch = "0.0.1"
	}
	for _, state := range []struct {
		enabled bool
		version string
		valid   bool
	}{{true, bundle.Version, true}, {false, bundle.Version, false}, {true, mismatch, false}} {
		runtime := fmt.Sprintf(`{"initialized":true,"enabled":%t,"version":%q}`, state.enabled, state.version)
		r, _, api := fixture(t)
		transport := &mainActionTransport{delegate: api.http.Transport, runtime: runtime}
		api.http.Transport = transport
		err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "enable", "EXAMPLE_ADMIN", "EXAMPLE_PASSWORD", "")
		if !transport.enabled || strings.Join(r.calls, ",") != "probe" {
			t.Fatal("enable bypassed expected API path", err, r.calls)
		}
		if state.valid {
			if err != nil {
				t.Fatal(err)
			}
		} else if err == nil || err.Error() != "FRAMEWORK_ENABLE_READBACK_FAILED" {
			t.Fatal("invalid enable state accepted", err)
		}
	}
}

func TestEngineDelegatesPluginListAfterAdministratorLogin(t *testing.T) {
	r, _, api := fixture(t)
	transport := &mainActionTransport{delegate: api.http.Transport}
	api.http.Transport = transport
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "plugin.list", "EXAMPLE_ADMIN", "EXAMPLE_PASSWORD", ""); err != nil {
		t.Fatal(err)
	}
	if !transport.pluginListed || strings.Join(r.calls, ",") != "probe" {
		t.Fatal("plugin list did not use authenticated API")
	}
}

func TestCredentialsStdinAcceptsOnlyBoundedSingleObject(t *testing.T) {
	value, err := readCredentials(strings.NewReader(`{"sshPassword":"EXAMPLE_SSH_PASSWORD","towerPassword":"EXAMPLE_TOWER_PASSWORD"}`), true)
	if err != nil || value.sshPassword != "EXAMPLE_SSH_PASSWORD" || value.towerPassword != "EXAMPLE_TOWER_PASSWORD" {
		t.Fatal("valid credentials rejected")
	}
	value, err = readCredentials(strings.NewReader("  {\"sshPassword\":\"EXAMPLE_ONLY_SSH\"} \r\n"), false)
	if err != nil || value.sshPassword != "EXAMPLE_ONLY_SSH" || value.towerPassword != "" {
		t.Fatal("SSH-only credentials rejected")
	}
	invalid := []string{
		``, `{}`, `null`, `[]`, `"EXAMPLE_SECRET"`,
		`{"sshPassword":"EXAMPLE_SECRET","unknown":"EXAMPLE_SECRET"}`,
		`{"sshPassword":"EXAMPLE_SECRET","sshPassword":"EXAMPLE_OTHER"}`,
		`{"SshPassword":"EXAMPLE_SECRET"}`,
		`{"sshPassword":"EXAMPLE_SECRET"}{}`,
		`{"sshPassword":"EXAMPLE_SECRET"} trailing EXAMPLE_SECRET`,
		`{"sshPassword":null}`, `{"sshPassword":123}`, `{"sshPassword":{}}`,
		`{"sshPassword":""}`, `{"sshPassword":"EXAMPLE\nSECRET"}`,
		`{"sshPassword":"EXAMPLE\u0000SECRET"}`,
		`{"sshPassword":"EXAMPLE_SECRET","towerPassword":""}`,
		`{"sshPassword":"EXAMPLE_SECRET","towerPassword":false}`,
		`{"sshPassword":"EXAMPLE_SECRET","towerPassword":"EXAMPLE_TOWER","towerPassword":"EXAMPLE_OTHER"}`,
		`{"sshPassword":"` + strings.Repeat("x", 8193) + `"}`,
		`{"sshPassword":"EXAMPLE_SECRET"}` + strings.Repeat(" ", credentialInputLimit),
		string([]byte{'{', '"', 's', 's', 'h', 'P', 'a', 's', 's', 'w', 'o', 'r', 'd', '"', ':', '"', 0xff, '"', '}'}),
	}
	for index, input := range invalid {
		value, err := readCredentials(strings.NewReader(input), false)
		if err == nil || err.Error() != "CREDENTIAL_INPUT_INVALID" || value != (inputCredentials{}) {
			t.Fatalf("invalid credentials were not safely rejected, case %d", index)
		}
		if strings.Contains(explainError(err, "en-US"), "EXAMPLE_SECRET") {
			t.Fatal("input leaked through diagnostics")
		}
	}
	if _, err := readCredentials(strings.NewReader(`{"sshPassword":"EXAMPLE_SECRET"}`), true); err == nil {
		t.Fatal("Tower command accepted missing Tower password")
	}
}

type failingCredentialReader struct{}

func (failingCredentialReader) Read([]byte) (int, error) { return 0, errors.New("EXAMPLE_SECRET") }

func TestCredentialsStdinBoundsReadsAndSanitizesReaderErrors(t *testing.T) {
	reader := &io.LimitedReader{R: strings.NewReader(strings.Repeat("x", credentialInputLimit*4)), N: credentialInputLimit * 4}
	if _, err := readCredentials(reader, false); err == nil || err.Error() != "CREDENTIAL_INPUT_INVALID" {
		t.Fatal("oversize input accepted")
	}
	if consumed := credentialInputLimit*4 - reader.N; consumed != credentialInputLimit+1 {
		t.Fatalf("read limit not enforced: %d", consumed)
	}
	if _, err := readCredentials(failingCredentialReader{}, false); err == nil || err.Error() != "CREDENTIAL_INPUT_INVALID" {
		t.Fatal("reader error not sanitized")
	}
}

func TestCredentialInputAppearsInLocalizedHelpAndMigrationIsRejected(t *testing.T) {
	for _, lang := range []string{"zh-CN", "en-US"} {
		var out bytes.Buffer
		if err := run([]string{"help", "--lang", lang}, &out); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(out.String(), "|migrate|") || !strings.Contains(out.String(), "--credentials-stdin") {
			t.Fatal("invalid help")
		}
	}
	if err := run([]string{"migrate"}, &bytes.Buffer{}); err == nil || err.Error() != "UNKNOWN_COMMAND" {
		t.Fatal(err)
	}
}

func TestDiagnosticsLocalizedAndRedacted(t *testing.T) {
	for _, code := range []string{"UNTESTED_TOWER_BUILD", "TOWER_COMPONENT_MISSING", "SSH_HOST_KEY_MISMATCH", "TOWER_CONNECTION_OR_CERTIFICATE_FAILED", "TOWER_ADMIN_REQUIRED", "EXISTING_INSTALLATION_UNMANAGED", "INSTALLER_RECOVERY_REQUIRED", "REMOTE_TIMEOUT_OUTCOME_UNKNOWN", "RESOURCE_OWNERSHIP_MISMATCH"} {
		t.Run(code, func(t *testing.T) {
			zh, en := explainError(errors.New(code), "zh-CN"), explainError(errors.New(code), "en-US")
			if zh == en || !strings.Contains(zh, "["+code+"]") || !strings.Contains(en, "["+code+"]") {
				t.Fatal(zh, en)
			}
		})
	}
	for _, err := range []error{
		errors.New("SSH_HANDSHAKE_FAILED: server error with token=EXAMPLE_SECRET and EXAMPLE_INTERNAL_PATH"),
		errors.New("arbitrary diagnostic containing EXAMPLE_SECRET and EXAMPLE_INTERNAL_PATH"),
		errors.New("flag error with EXAMPLE_SECRET"),
	} {
		for _, lang := range []string{"zh-CN", "en-US"} {
			message := explainError(err, lang)
			if strings.Contains(message, "EXAMPLE_SECRET") || strings.Contains(message, "EXAMPLE_INTERNAL_PATH") {
				t.Fatal(message)
			}
		}
	}
	if explainError(nil, "zh-CN") != "" {
		t.Fatal("nil error should have no diagnostic")
	}
	if !strings.Contains(explainError(context.DeadlineExceeded, "en-US"), "OPERATION_TIMEOUT") {
		t.Fatal("timeout not explained")
	}
}

func TestDiagnosticsPreserveControlledRecoveryIDs(t *testing.T) {
	id := strings.Repeat("a", 32)
	for _, raw := range []string{
		"ISLAND_REGISTER_FAILED; recover operation " + id + " if pending",
		"REMOTE_TIMEOUT_OUTCOME_UNKNOWN; recovery required: " + id,
		"ISLAND_REGISTER_FAILED; ROLLBACK_INCOMPLETE operation " + id,
		"COMMIT_UNCONFIRMED; recovery operation " + id,
	} {
		for _, lang := range []string{"zh-CN", "en-US"} {
			message := explainError(errors.New(raw), lang)
			if !strings.Contains(message, id) || !strings.Contains(message, "recover --operation "+id) {
				t.Fatal(message)
			}
		}
	}
	for _, raw := range []string{"SSH_HANDSHAKE_FAILED: operation " + id, "REMOTE_OPERATION_FAILED; recovery required: EXAMPLE_SECRET"} {
		message := explainError(errors.New(raw), "en-US")
		if strings.Contains(message, id) || strings.Contains(message, "EXAMPLE_SECRET") {
			t.Fatal(message)
		}
	}
	message := explainError(errors.New("ISLAND_REGISTER_FAILED; ROLLED_BACK_PLUGINS_DISABLED"), "en-US")
	if !strings.Contains(message, "ISLAND_REGISTER_FAILED") || !strings.Contains(message, "ROLLED_BACK_PLUGINS_DISABLED") {
		t.Fatal(message)
	}
}

func TestHelpLanguageAndArgumentDiagnostics(t *testing.T) {
	for _, args := range [][]string{{"help", "--lang", "en-US"}, {"--lang=en-US", "help"}, {"install", "--help", "--lang", "en-US"}} {
		var out bytes.Buffer
		if err := run(args, &out); err != nil || !strings.Contains(out.String(), "Usage:") {
			t.Fatal(args, err, out.String())
		}
	}
	var zh bytes.Buffer
	if err := run([]string{"help", "--lang", "zh-CN"}, &zh); err != nil || !strings.Contains(zh.String(), "用法") {
		t.Fatal(err, zh.String())
	}
	for _, args := range [][]string{{"help", "--lang", "unsupported"}, {"help", "--lang"}} {
		if err := run(args, &bytes.Buffer{}); err == nil || err.Error() != "INVALID_LANGUAGE" {
			t.Fatal(args, err)
		}
	}
	var out bytes.Buffer
	err := run([]string{"detect", "--EXAMPLE_SECRET"}, &out)
	if err == nil || err.Error() != "INVALID_ARGUMENTS" || strings.Contains(out.String(), "EXAMPLE_SECRET") {
		t.Fatal(err, out.String())
	}
}

func TestSSHAndHTTPSHostMismatchRejectedBeforeSecretInput(t *testing.T) {
	err := run([]string{"install", "--ssh", "ssh.example.invalid:22", "--ssh-user", "EXAMPLE_USER", "--ssh-hostkey", "SHA256:EXAMPLE_PIN", "--tower", "https://tower.example.invalid", "--user", "EXAMPLE_ADMIN"}, &bytes.Buffer{})
	if err == nil || err.Error() != "SSH_AND_HTTPS_HOST_MUST_MATCH" {
		t.Fatal(err)
	}
}

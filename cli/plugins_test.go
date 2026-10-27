package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fixturePluginID = "rivetin-example"

func pluginFixturePackage(version string) []byte {
	code, license := []byte("window.EXAMPLE_ONLY = true;"), []byte("MIT License - EXAMPLE fixture")
	value := map[string]any{"format": "rivetin-package-v1", "manifest": map[string]any{
		"id": fixturePluginID, "version": version, "frontend": map[string]string{"entry": "web/plugin.js", "format": "rivetin-global-v1"},
	}, "files": []pluginPackageFile{
		{Path: "web/plugin.js", SHA256: digest(code), Data: base64.StdEncoding.EncodeToString(code)},
		{Path: "LICENSE", SHA256: digest(license), Data: base64.StdEncoding.EncodeToString(license)},
	}}
	data, _ := json.Marshal(value)
	return data
}

type pluginAPIFixture struct {
	calls          []string
	installed      bool
	enabled        bool
	version        string
	packageID      string
	uploadBad      bool
	readbackBad    bool
	malformed      bool
	failureCode    string
	removeOnDelete bool
}

func pluginAPIServer(t *testing.T, fixture *pluginAPIFixture) *Tower {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.calls = append(fixture.calls, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.Header.Get("Authorization") != "EXAMPLE_TOKEN" || r.Header.Get("Origin") == "" {
			t.Error("authenticated shared API headers missing")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == pluginAPIPrefix+"/packages" && r.Method == "POST" {
			data, _ := io.ReadAll(r.Body)
			var input struct {
				Manifest pluginPackageManifest `json:"manifest"`
			}
			if json.Unmarshal(data, &input) != nil {
				t.Error("invalid posted package")
			}
			fixture.packageID = digest(data)
			fixture.version = input.Manifest.Version
			id := fixture.packageID
			if fixture.uploadBad {
				id = strings.Repeat("a", 64)
			}
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"packageId": id, "manifest": input.Manifest})
			return
		}
		if r.URL.Path != pluginAPIPrefix+"/plugins" {
			t.Error("unexpected API path", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method == "POST" {
			var input map[string]string
			_ = json.NewDecoder(r.Body).Decode(&input)
			if input["pluginId"] != fixturePluginID {
				t.Error("unexpected plugin target")
			}
			if fixture.failureCode != "" {
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": fixture.failureCode})
				return
			}
			switch input["action"] {
			case "install", "update":
				if input["packageId"] != fixture.packageID {
					t.Error("package identity not passed to lifecycle")
				}
				fixture.installed, fixture.enabled = true, false
			case "enable":
				fixture.enabled = true
			case "disable":
				fixture.enabled = false
			case "uninstall":
				fixture.installed, fixture.enabled = false, false
			default:
				t.Error("unexpected action")
			}
			_, _ = w.Write([]byte(`{"success":true}`))
			return
		}
		if fixture.malformed {
			_, _ = w.Write([]byte(`{"items":[{"id":"rivetin-example"}]}`))
			return
		}
		if fixture.removeOnDelete && !fixture.installed {
			_, _ = w.Write([]byte(`{"items":[]}`))
			return
		}
		enabled := fixture.enabled
		if fixture.readbackBad {
			enabled = !enabled
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{map[string]any{
			"id": fixturePluginID, "installed": fixture.installed, "enabled": enabled,
			"version": fixture.version, "packageId": fixture.packageID,
		}}})
	}))
	t.Cleanup(server.Close)
	return &Tower{base: server.URL, http: server.Client(), token: "EXAMPLE_TOKEN"}
}

func TestPluginCLIInstallUpgradeLifecycleReadback(t *testing.T) {
	fixture := &pluginAPIFixture{}
	api := pluginAPIServer(t, fixture)
	var output []string
	progress := func(line string) { output = append(output, line) }
	for _, action := range []struct{ action, version string }{
		{"install", "0.1.0"}, {"enable", ""}, {"disable", ""}, {"update", "0.1.1"}, {"list", ""}, {"uninstall", ""},
	} {
		var data []byte
		if action.version != "" {
			data = pluginFixturePackage(action.version)
		}
		if err := RunPluginAction(context.Background(), api, action.action, fixturePluginID, data, progress); err != nil {
			t.Fatal(action.action, err)
		}
	}
	if fixture.installed || fixture.enabled || fixture.version != "0.1.1" {
		t.Fatal(fixture)
	}
	if len(fixture.calls) != 13 || strings.Contains(strings.Join(output, "\n"), "EXAMPLE_TOKEN") || strings.Contains(strings.Join(output, "\n"), "window.EXAMPLE_ONLY") {
		t.Fatal(fixture.calls, output)
	}
	if !strings.Contains(strings.Join(output, "\n"), "version=0.1.1") {
		t.Fatal(output)
	}
}

func TestPluginCLIRejectsPackageBeforeAnyWrite(t *testing.T) {
	for _, kind := range []string{"json", "format", "id", "version", "path", "digest", "duplicate", "entry", "unknown", "size"} {
		t.Run(kind, func(t *testing.T) {
			fixture := &pluginAPIFixture{}
			api := pluginAPIServer(t, fixture)
			data := pluginFixturePackage("0.1.1")
			var value map[string]any
			_ = json.Unmarshal(data, &value)
			switch kind {
			case "json":
				data = []byte(`{"EXAMPLE_SECRET_CONTENT`)
			case "size":
				data = bytes.Repeat([]byte("x"), maxPluginPackage+1)
			default:
				manifest := value["manifest"].(map[string]any)
				files := value["files"].([]any)
				switch kind {
				case "format":
					value["format"] = "EXAMPLE_UNSUPPORTED"
				case "id":
					manifest["id"] = "../EXAMPLE_INVALID"
				case "version":
					manifest["version"] = "01.2.3"
				case "path":
					files[0].(map[string]any)["path"] = "web/../../EXAMPLE"
				case "digest":
					files[0].(map[string]any)["sha256"] = strings.Repeat("0", 64)
				case "duplicate":
					value["files"] = append(files, files[0])
				case "entry":
					manifest["frontend"].(map[string]any)["entry"] = "web/Plugin.js"
				case "unknown":
					value["EXAMPLE_UNKNOWN"] = true
				}
				data, _ = json.Marshal(value)
			}
			err := RunPluginAction(context.Background(), api, "install", "", data, nil)
			if err == nil || strings.Contains(err.Error(), "EXAMPLE_SECRET_CONTENT") || len(fixture.calls) != 0 {
				t.Fatal(err, fixture.calls)
			}
		})
	}
}

func TestPluginCLIUploadAndStateReadbacksFailClosed(t *testing.T) {
	for _, kind := range []string{"upload", "state", "shape"} {
		t.Run(kind, func(t *testing.T) {
			fixture := &pluginAPIFixture{uploadBad: kind == "upload", readbackBad: kind == "state", malformed: kind == "shape"}
			api := pluginAPIServer(t, fixture)
			err := RunPluginAction(context.Background(), api, "install", "", pluginFixturePackage("0.1.0"), nil)
			if err == nil || !strings.Contains(err.Error(), "READBACK") {
				t.Fatal(err)
			}
			if kind == "upload" && len(fixture.calls) != 1 {
				t.Fatal("lifecycle mutated after a bad upload response", fixture.calls)
			}
		})
	}
}

func TestPluginCLISanitizesServerFailures(t *testing.T) {
	for _, code := range []string{"INVALID_TRANSITION", "EXAMPLE_SECRET_CONTENT", "failure with EXAMPLE_SECRET_CONTENT"} {
		fixture := &pluginAPIFixture{failureCode: code, installed: true}
		api := pluginAPIServer(t, fixture)
		err := RunPluginAction(context.Background(), api, "enable", fixturePluginID, nil, nil)
		if err == nil || strings.Contains(err.Error(), "EXAMPLE_SECRET_CONTENT") {
			t.Fatal(err)
		}
		if code == "INVALID_TRANSITION" && err.Error() != code {
			t.Fatal(err)
		}
	}
}

func TestPluginCLIAuthenticationTargetsAndUnknownActions(t *testing.T) {
	fixture := &pluginAPIFixture{}
	api := pluginAPIServer(t, fixture)
	for _, action := range []string{"enable", "disable", "uninstall", "UNKNOWN"} {
		if err := RunPluginAction(context.Background(), api, action, "", nil, nil); err == nil {
			t.Fatal(action)
		}
	}
	if err := RunPluginAction(context.Background(), nil, "list", "", nil, nil); err == nil {
		t.Fatal("missing authentication accepted")
	}
	if err := RunPluginAction(context.Background(), api, "install", "rivetin-other", pluginFixturePackage("0.1.0"), nil); err == nil || err.Error() != "PLUGIN_ID_MISMATCH" {
		t.Fatal(err)
	}
	if len(fixture.calls) != 0 {
		t.Fatal(fixture.calls)
	}
}

func TestPluginCLIUninstallAcceptsRemovedRegistration(t *testing.T) {
	fixture := &pluginAPIFixture{installed: true, removeOnDelete: true}
	api := pluginAPIServer(t, fixture)
	if err := RunPluginAction(context.Background(), api, "uninstall", fixturePluginID, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func TestPluginCLIListDoesNotExposeUnexpectedVersionContent(t *testing.T) {
	fixture := &pluginAPIFixture{installed: true, version: "EXAMPLE_SECRET_CONTENT"}
	api := pluginAPIServer(t, fixture)
	var output string
	if err := RunPluginAction(context.Background(), api, "list", "", nil, func(s string) { output += s }); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "version=unknown") || strings.Contains(output, "EXAMPLE_SECRET_CONTENT") {
		t.Fatal(output)
	}
	if fmt.Sprint(fixture.calls) != "[GET /api/rivetin/v1/plugins]" {
		t.Fatal(fixture.calls)
	}
}

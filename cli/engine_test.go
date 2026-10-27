package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeRemote struct {
	probe        Probe
	calls        []string
	fail         string
	backup       string
	recoveryMode string
	desired      []byte
}

func fixtureProbe() Probe {
	p := profiles()[0]
	return Probe{Image: p.Image, Node: p.Node, Namespace: p.Namespace, Pod: p.Pod, Container: p.Container}
}
func (r *fakeRemote) Call(_ context.Context, req map[string]any) (map[string]json.RawMessage, error) {
	action := req["action"].(string)
	r.calls = append(r.calls, action)
	if action == r.fail {
		return nil, errors.New("INJECTED_FAILURE")
	}
	if action == "apply" {
		r.desired, _ = base64.StdEncoding.DecodeString(req["manifest"].(string))
	}
	var value any = map[string]any{"phase": action}
	if action == "probe" {
		value = r.probe
	}
	if action == "backup" {
		mode := r.recoveryMode
		if mode == "" {
			mode = "update"
		}
		value = map[string]string{"islandBackup": r.backup, "mode": mode}
	}
	raw, _ := json.Marshal(value)
	var result map[string]json.RawMessage
	_ = json.Unmarshal(raw, &result)
	return result, nil
}

type towerFixture struct {
	old                 []byte
	entry               []byte
	postFail            bool
	wrongEntry          bool
	noMount             bool
	runtimeEnabled      bool
	nonAdmin            bool
	events              []string
	registryInitialized bool
	islandPresent       bool
}

func towerServer(t *testing.T, f *towerFixture) *Tower {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.events = append(f.events, r.Method+" "+r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api" {
			data, _ := io.ReadAll(r.Body)
			if bytes.Contains(data, []byte("mutation")) {
				fmt.Fprintf(w, `{"data":{"login":{"token":"x.%s.x"}}}`, base64.RawURLEncoding.EncodeToString([]byte("EXAMPLE_ID")))
				return
			}
			role := "ADMIN"
			if f.nonAdmin {
				role = "READ_ONLY"
			}
			fmt.Fprintf(w, `{"data":{"user":{"id":"EXAMPLE_ID","username":"EXAMPLE_ADMIN","role":%q}}}`, role)
			return
		}
		if r.Header.Get("Authorization") == "" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Path == "/api/island-registry/sea-maps" && r.Method == "GET" {
			present := f.islandPresent
			if !f.registryInitialized {
				present = f.old != nil
			}
			if present {
				_, _ = w.Write([]byte(`{"seaMaps":[{"name":"rivetin","data":[{"region":"PERMANENT_CLUSTER_MANAGER_MODAL","island":"./Rivetin"}]}]}`))
			} else {
				_, _ = w.Write([]byte(`{"seaMaps":[]}`))
			}
			return
		}
		if strings.Contains(r.URL.Path, "/download/") {
			if f.old == nil {
				w.WriteHeader(404)
			} else {
				_, _ = w.Write(f.old)
			}
			return
		}
		if r.Method == "POST" {
			if f.postFail {
				f.postFail = false
				w.WriteHeader(500)
				return
			}
			if err := r.ParseMultipartForm(8 << 20); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			defer r.MultipartForm.RemoveAll()
			file, _, err := r.FormFile("file")
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			data, _ := io.ReadAll(file)
			if len(data) == 0 {
				t.Error("empty Island")
			}
			f.registryInitialized = true
			f.islandPresent = true
			_, _ = w.Write([]byte(`{}`))
			return
		}
		if r.Method == "DELETE" {
			f.registryInitialized = true
			f.islandPresent = false
			w.WriteHeader(204)
			return
		}
		if strings.HasSuffix(r.URL.Path, "remoteEntry.js") {
			if f.wrongEntry {
				_, _ = w.Write([]byte("WRONG_ENTRY"))
			} else {
				_, _ = w.Write(f.entry)
			}
			return
		}
		if strings.Contains(r.URL.Path, "PERMANENT") {
			if f.noMount {
				_, _ = w.Write([]byte(`{"seaMaps":[]}`))
			} else {
				_, _ = w.Write([]byte(`{"seaMaps":[{"name":"rivetin","data":[{"region":"PERMANENT_CLUSTER_MANAGER_MODAL","island":"./Rivetin"}]}]}`))
			}
			return
		}
		if strings.HasSuffix(r.URL.Path, "/runtime") {
			fmt.Fprintf(w, `{"initialized":true,"enabled":%t,"version":"0.1.0"}`, f.runtimeEnabled)
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(server.Close)
	api, err := newTower(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	api.http.Transport.(*http.Transport).TLSClientConfig.RootCAs = pool
	return api
}
func fixture(t *testing.T) (*fakeRemote, *towerFixture, *Tower) {
	t.Helper()
	_, data, err := payload()
	if err != nil {
		t.Fatal(err)
	}
	r := &fakeRemote{probe: fixtureProbe()}
	f := &towerFixture{entry: data["remoteEntry.js"]}
	return r, f, towerServer(t, f)
}
func TestInstallOneFlow(t *testing.T) {
	r, _, api := fixture(t)
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "EXAMPLE_ADMIN", "EXAMPLE_PASSWORD", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,prepare,apply,commit" {
		t.Fatal(r.calls)
	}
	var manifest map[string]any
	if json.Unmarshal(r.desired, &manifest) != nil {
		t.Fatal("invalid manifest")
	}
	items := manifest["items"].([]any)
	if len(items) != 3 {
		t.Fatal(items)
	}
	encoded := string(r.desired)
	if strings.Contains(encoded, "EXAMPLE_PASSWORD") || strings.Contains(encoded, "serviceAccountToken\":true") {
		t.Fatal("unsafe manifest")
	}
}
func TestUnsupportedBuildNoLoginOrWrites(t *testing.T) {
	r, f, api := fixture(t)
	r.probe.Image = "UNTESTED"
	err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "", "", "")
	if err == nil || err.Error() != "UNTESTED_TOWER_BUILD" || len(f.events) != 0 || strings.Join(r.calls, ",") != "probe" {
		t.Fatal(err, r.calls, f.events)
	}
}
func TestReadOnlyDetectReportsUntestedBuildWithoutLoginOrWrites(t *testing.T) {
	r, f, api := fixture(t)
	r.probe.Image = "registry.example.invalid/tower:UNTESTED_BUILD"
	var lines []string
	err := (Engine{Remote: r, Tower: api, Progress: func(line string) { lines = append(lines, line) }}).Run(context.Background(), "detect", "", "", "")
	if err != nil || len(f.events) != 0 || strings.Join(r.calls, ",") != "probe" {
		t.Fatal(err, r.calls, f.events)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "UNTESTED_BUILD") || !strings.Contains(strings.Join(lines, "\n"), "SUPPORTED false") {
		t.Fatal(lines)
	}
}
func TestUnsupportedNodeNoWrites(t *testing.T) {
	r, _, api := fixture(t)
	r.probe.Node = "v99.0.0"
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "", "", ""); err == nil {
		t.Fatal("accepted")
	}
	if len(r.calls) != 1 {
		t.Fatal(r.calls)
	}
}
func TestNonAdminNoWrites(t *testing.T) {
	r, f, api := fixture(t)
	f.nonAdmin = true
	err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "", "", "")
	if err == nil || err.Error() != "TOWER_ADMIN_REQUIRED" || len(r.calls) != 1 {
		t.Fatal(err, r.calls)
	}
}
func TestUnmanagedInstallRefused(t *testing.T) {
	r, _, api := fixture(t)
	r.probe.Installed = true
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "update", "", "", ""); err == nil || !strings.Contains(err.Error(), "UNMANAGED") {
		t.Fatal(err)
	}
	if len(r.calls) != 1 {
		t.Fatal(r.calls)
	}
}
func TestRegistrationFailureRollsBack(t *testing.T) {
	r, f, api := fixture(t)
	f.postFail = true
	err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "", "", "")
	if err == nil || !strings.Contains(err.Error(), "ROLLED_BACK") {
		t.Fatal(err)
	}
	if r.calls[len(r.calls)-1] != "rollback" {
		t.Fatal(r.calls)
	}
}
func TestReadbackFailuresRollBack(t *testing.T) {
	for _, kind := range []string{"entry", "mount", "runtime"} {
		t.Run(kind, func(t *testing.T) {
			r, f, api := fixture(t)
			f.wrongEntry = kind == "entry"
			f.noMount = kind == "mount"
			f.runtimeEnabled = kind == "runtime"
			err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "", "", "")
			if err == nil || r.calls[len(r.calls)-1] != "rollback" {
				t.Fatal(err, r.calls)
			}
		})
	}
}
func TestUpdateBacksUpAndRestoresIsland(t *testing.T) {
	r, f, api := fixture(t)
	r.probe.Installed = true
	r.probe.Managed = true
	f.old = fixtureIslandArchive(t, `{"name":"rivetin","metadata":{"info":{"version":"0.1.0"}}}`)
	f.wrongEntry = true
	err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "update", "", "", "")
	if err == nil || r.calls[len(r.calls)-1] != "rollback" {
		t.Fatal(err)
	}
	count := 0
	for _, event := range f.events {
		if event == "POST /api/island-registry/sea-maps" {
			count++
		}
	}
	if count != 2 {
		t.Fatal(f.events)
	}
}
func TestUninstallAndRecovery(t *testing.T) {
	r, f, api := fixture(t)
	r.probe.Installed = true
	r.probe.Managed = true
	f.old = fixtureIslandArchive(t, `{"name":"rivetin","metadata":{"info":{"version":"0.1.0"}}}`)
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "uninstall", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,prepare,remove,commit" {
		t.Fatal(r.calls)
	}
	r.calls = nil
	r.backup = base64.StdEncoding.EncodeToString(f.old)
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "recover", "", "", strings.Repeat("a", 32)); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,backup,rollback" {
		t.Fatal(r.calls)
	}
}
func TestEmergencyDisableNeedsNoTowerOrProbe(t *testing.T) {
	r := &fakeRemote{fail: "probe"}
	if err := (Engine{Remote: r}).Run(context.Background(), "disable", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "disable" {
		t.Fatal(r.calls)
	}
}
func TestPendingInstallNoWrites(t *testing.T) {
	r, _, api := fixture(t)
	r.probe.Pending = strings.Repeat("a", 32)
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "install", "", "", ""); err == nil || err.Error() != "INSTALLER_RECOVERY_REQUIRED" {
		t.Fatal(err)
	}
	if len(r.calls) != 1 {
		t.Fatal(r.calls)
	}
}
func TestURLAndTLSDefaults(t *testing.T) {
	for _, u := range []string{"http://tower.example.invalid", "https://user:password@tower.example.invalid", "https://tower.example.invalid/path", "https://tower.example.invalid/?secret=x"} {
		if _, err := newTower(u, ""); err == nil {
			t.Fatal(u)
		}
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	api, _ := newTower(server.URL, "")
	if _, _, err := api.request(context.Background(), "GET", "/", "", nil); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
}
func TestHelpWithoutRuntimeOrNetwork(t *testing.T) {
	var out bytes.Buffer
	if err := run([]string{"help"}, &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "uninstall") {
		t.Fatal(out.String())
	}
	if err := run([]string{"version"}, &out); err != nil {
		t.Fatal(err)
	}
}

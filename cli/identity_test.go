package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRivetinRequestHasNoLegacyFallbackOrWriteRetry(t *testing.T) {
	var calls []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	api := &Tower{base: server.URL, http: server.Client(), token: "EXAMPLE_TOKEN"}
	for _, method := range []string{"GET", "POST"} {
		_, status, err := api.frameworkRequest(context.Background(), method, "/plugins", "application/json", []byte(`{}`))
		if err != nil || status != http.StatusNotFound {
			t.Fatal(status, err)
		}
	}
	if strings.Join(calls, ",") != "GET /api/rivetin/v1/plugins,POST /api/rivetin/v1/plugins" {
		t.Fatal(calls)
	}
}

func TestRivetinOnlyPluginIDAndFormats(t *testing.T) {
	for _, change := range []string{"id", "package", "frontend"} {
		var value map[string]any
		_ = json.Unmarshal(pluginFixturePackage("0.1.0"), &value)
		manifest := value["manifest"].(map[string]any)
		switch change {
		case "id":
			manifest["id"] = "pluginkit-example"
		case "package":
			value["format"] = "pluginkit-package-v1"
		case "frontend":
			manifest["frontend"].(map[string]any)["format"] = "pluginkit-global-v1"
		}
		input, _ := json.Marshal(value)
		if _, err := validatePluginInput(input, ""); err == nil {
			t.Fatalf("accepted obsolete %s", change)
		}
	}
	fixture := &pluginAPIFixture{}
	api := pluginAPIServer(t, fixture)
	if err := RunPluginAction(context.Background(), api, "enable", "pluginkit-example", nil, nil); err == nil || err.Error() != "INVALID_PLUGIN_ID" || len(fixture.calls) != 0 {
		t.Fatal(err, fixture.calls)
	}
}

func TestRivetinIslandIgnoresLegacyRegistrationAndRejectsLegacyArchive(t *testing.T) {
	entries, err := parseOwnedIslands([]byte(`{"seaMaps":[{"name":"pluginkit","metadata":{"version":"0.1.0"},"data":[]}]}`))
	if err != nil || len(entries) != 0 {
		t.Fatal(entries, err)
	}
	if _, err := archiveIsland(fixtureIslandArchive(t, `{"name":"pluginkit","metadata":{"version":"0.1.0"},"data":[]}`)); err == nil {
		t.Fatal("obsolete scope accepted")
	}
}

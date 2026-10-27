package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChannelManagementUsesAuthenticatedBoundedProfileWithoutLoggingSecrets(t *testing.T) {
	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "EXAMPLE_TOKEN" || r.Header.Get("Origin") == "" {
			t.Error("authentication missing")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			_, _ = w.Write([]byte(`{"enabled":false,"transportReady":true,"hosts":[],"registrations":[]}`))
			return
		}
		var input struct {
			Action  string         `json:"action"`
			Profile map[string]any `json:"profile"`
			HostID  string         `json:"hostId"`
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("invalid JSON")
		}
		if input.Action == "put" {
			if input.Profile["password"] != "EXAMPLE_ONLY_NOT_A_PASSWORD" {
				t.Error("profile not passed internally")
			}
			_, _ = w.Write([]byte(`{"hostId":"example-host","saved":true}`))
		} else {
			_, _ = w.Write([]byte(`{"hostId":"example-host","removed":true}`))
		}
	}))
	defer server.Close()
	api := &Tower{base: server.URL, http: server.Client(), token: "EXAMPLE_TOKEN"}
	var output string
	progress := func(s string) { output += s }
	profile := []byte(`{"hostId":"example-host","password":"EXAMPLE_ONLY_NOT_A_PASSWORD"}`)
	for _, action := range []string{"status", "import-host", "remove-host"} {
		if err := RunChannelAction(context.Background(), api, action, "example-host", profile, progress); err != nil {
			t.Fatal(err)
		}
	}
	if requests != 3 || strings.Contains(output, "EXAMPLE_ONLY_NOT_A_PASSWORD") {
		t.Fatal("request count or output privacy")
	}
}

func TestChannelRejectsUnexpectedActionsAndMismatchedReadback(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"hostId":"another-host","saved":true}`))
	}))
	defer server.Close()
	api := &Tower{base: server.URL, http: server.Client(), token: "EXAMPLE_TOKEN"}
	if err := RunChannelAction(context.Background(), api, "import-host", "", []byte(`{"hostId":"example-host"}`), nil); err == nil || err.Error() != "SSH_CHANNEL_READBACK_INVALID" {
		t.Fatal(err)
	}
	for _, action := range []string{"exec", "shell", "approve"} {
		if err := RunChannelAction(context.Background(), api, action, "", nil, nil); err == nil {
			t.Fatalf("accepted %s", action)
		}
	}
	if _, err := normalizePluginCommand([]string{"channel", "exec"}); err == nil {
		t.Fatal("arbitrary execution accepted")
	}
	if args, err := normalizePluginCommand([]string{"channel", "status"}); err != nil || args[0] != "channel.status" {
		t.Fatal(args, err)
	}
}

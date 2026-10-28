package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The Go standard library creates ephemeral CN-only test certificates in memory;
// no private-key fixture or real appliance certificate is stored in the repository.
func TestNodeGatewayPinVerifiesBeforeHTTPAuthentication(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("development Node.js unavailable")
	}
	module, err := filepath.Abs("../framework/server/gateway-https.js")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, scenario := range []string{"valid", "wrong-pin", "expired", "future", "invalid-pin", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			start, end := now.Add(-time.Hour), now.Add(time.Hour)
			if scenario == "expired" {
				start, end = now.Add(-2*time.Hour), now.Add(-time.Hour)
			}
			if scenario == "future" {
				start, end = now.Add(time.Hour), now.Add(2*time.Hour)
			}
			server, pin := pinnedCertificateServer(t, start, end)
			var requests, credentials atomic.Int32
			server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Header.Get("Authorization") == "EXAMPLE_GATEWAY_TOKEN" && r.Header.Get("Cookie") == "EXAMPLE_GATEWAY_COOKIE" {
					credentials.Add(1)
				}
				if scenario == "redirect" {
					w.Header().Set("Location", "https://other.example.invalid/")
					w.WriteHeader(302)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true}`))
			})
			if scenario == "wrong-pin" {
				pin = strings.Repeat("0", 64)
			}
			if scenario == "invalid-pin" {
				pin = "INVALID_PIN"
			}
			input, _ := json.Marshal(map[string]string{"module": module, "url": server.URL + "/api/rivetin/v1/components/status?probe=" + strings.Repeat("a", 32), "pin": pin})
			const script = `
import fs from 'node:fs'; import {pathToFileURL} from 'node:url';
const value=JSON.parse(fs.readFileSync(0,'utf8'));
const {readPinnedGateway}=await import(pathToFileURL(value.module));
try { const r=await readPinnedGateway(new URL(value.url), {headers:{Authorization:'EXAMPLE_GATEWAY_TOKEN',Cookie:'EXAMPLE_GATEWAY_COOKIE'},signal:AbortSignal.timeout(1500)},value.pin); console.log(JSON.stringify({status:r.status})); }
catch(error) { console.log(JSON.stringify({error:error.code})); }
`
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, node, "--input-type=module", "-e", script)
			command.Stdin = bytes.NewReader(input)
			output, err := command.Output()
			if err != nil {
				t.Fatal("Node gateway contract could not complete", err)
			}
			var result struct {
				Status int    `json:"status"`
				Error  string `json:"error"`
			}
			if json.Unmarshal(output, &result) != nil {
				t.Fatal("invalid contract result")
			}
			if scenario == "valid" || scenario == "redirect" {
				expected := 200
				if scenario == "redirect" {
					expected = 302
				}
				if result.Status != expected || requests.Load() != 1 || credentials.Load() != 1 {
					t.Fatalf("verified single request failed: %+v requests=%d credentials=%d", result, requests.Load(), credentials.Load())
				}
			} else {
				expected := "GATEWAY_PIN_MISMATCH"
				if scenario == "invalid-pin" {
					expected = "GATEWAY_TRUST_INVALID"
				}
				if scenario == "expired" || scenario == "future" {
					expected = "GATEWAY_CERT_VALIDITY_INVALID"
				}
				if result.Error != expected || requests.Load() != 0 || credentials.Load() != 0 {
					t.Fatalf("unverified peer received HTTP/auth: %+v requests=%d credentials=%d", result, requests.Load(), credentials.Load())
				}
			}
			t.Logf("%s: requests=%d credentialRequests=%d status=%d error=%s", scenario, requests.Load(), credentials.Load(), result.Status, result.Error)
		})
	}
}

func TestNodeGatewayBodyAndHandshakeHaveBoundedDeadlines(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("development Node.js unavailable")
	}
	module, err := filepath.Abs("../framework/server/gateway-https.js")
	if err != nil {
		t.Fatal(err)
	}
	const script = `
import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const value=JSON.parse(fs.readFileSync(0,'utf8'));const {readPinnedGateway}=await import(pathToFileURL(value.module));
try {await readPinnedGateway(new URL(value.url),{headers:{Authorization:'EXAMPLE_GATEWAY_TOKEN'},signal:AbortSignal.timeout(value.timeout)},value.pin);console.log(JSON.stringify({error:'UNEXPECTED_SUCCESS'}));}
catch(e){console.log(JSON.stringify({error:e.code}));}
`
	for _, scenario := range []string{"oversize-body", "body-timeout", "handshake-abort"} {
		t.Run(scenario, func(t *testing.T) {
			url, pin := "", strings.Repeat("a", 64)
			var requests atomic.Int32
			if scenario == "handshake-abort" {
				listener, err := net.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
				url = "https://" + listener.Addr().String()
				go func() {
					connection, err := listener.Accept()
					if err == nil {
						defer connection.Close()
						time.Sleep(time.Second)
					}
				}()
			} else {
				server, value := pinnedCertificateServer(t, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
				url, pin = server.URL, value
				server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					w.Header().Set("Content-Type", "application/json")
					w.(http.Flusher).Flush()
					if scenario == "oversize-body" {
						_, _ = w.Write([]byte(strings.Repeat("x", 4097)))
						return
					}
					_, _ = w.Write([]byte("{"))
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				})
			}
			input, _ := json.Marshal(map[string]any{"module": module, "url": url + "/api/rivetin/v1/components/status?probe=" + strings.Repeat("a", 32), "pin": pin, "timeout": 200})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, node, "--input-type=module", "-e", script)
			command.Stdin = bytes.NewReader(input)
			started := time.Now()
			output, err := command.Output()
			if err != nil {
				t.Fatal("bounded gateway contract failed", err)
			}
			var result struct {
				Error string `json:"error"`
			}
			if json.Unmarshal(output, &result) != nil {
				t.Fatal("invalid gateway result")
			}
			expected := "DEPLOYMENT_PROBE_TIMEOUT"
			if scenario == "oversize-body" {
				expected = "GATEWAY_RESPONSE_LIMIT"
			}
			if result.Error != expected || time.Since(started) > 3*time.Second {
				t.Fatalf("deadline/limit missing: %+v", result)
			}
			if scenario == "handshake-abort" && requests.Load() != 0 {
				t.Fatal("HTTP sent during incomplete handshake")
			}
			t.Logf("%s: requests=%d error=%s elapsed=%s", scenario, requests.Load(), result.Error, time.Since(started))
		})
	}
}

func TestDeploymentPropagatesOnlyExplicitNormalizedGatewayPin(t *testing.T) {
	pin := strings.Repeat("ab", 32)
	tower, err := newTowerWithPin("https://tower.example.invalid", "", strings.ToUpper(pin))
	if err != nil || tower.certificatePin != pin {
		t.Fatal("explicit pin was not normalized")
	}
	manifest, err := deployment(profiles()[0], tower.base, strings.Repeat("a", 64), tower.certificatePin)
	if err != nil || !bytes.Contains(manifest, []byte(`"RIVETIN_GATEWAY_CERT_SHA256"`)) || !bytes.Contains(manifest, []byte(pin)) {
		t.Fatal("explicit gateway pin missing")
	}
	plain, err := deployment(profiles()[0], tower.base, strings.Repeat("a", 64), "")
	if err != nil || bytes.Contains(plain, []byte("RIVETIN_GATEWAY_CERT_SHA256")) {
		t.Fatal("normal PKI mode acquired an implicit pin")
	}
	for _, invalid := range []string{"INVALID", strings.Repeat("A", 64), strings.Repeat("a", 63)} {
		if _, err := deployment(profiles()[0], tower.base, strings.Repeat("a", 64), invalid); err == nil {
			t.Fatal("invalid gateway pin accepted")
		}
	}
}

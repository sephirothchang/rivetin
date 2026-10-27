package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func pinnedCertificateServer(t *testing.T, notBefore, notAfter time.Time) (*httptest.Server, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "tower.example.invalid"}, NotBefore: notBefore, NotAfter: notAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "EXAMPLE_RESPONSE") }))
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	server.StartTLS()
	t.Cleanup(server.Close)
	digest := sha256.Sum256(der)
	return server, hex.EncodeToString(digest[:])
}

func TestExplicitCertificatePinAcceptsExactLegacyCertificateOnly(t *testing.T) {
	now := time.Now()
	server, pin := pinnedCertificateServer(t, now.Add(-time.Hour), now.Add(time.Hour))
	api, err := newTowerWithPin(server.URL, "", pin)
	if err != nil {
		t.Fatal(err)
	}
	data, status, err := api.request(context.Background(), "GET", "/", "", nil)
	if err != nil || status != 200 || string(data) != "EXAMPLE_RESPONSE" {
		t.Fatal("matching certificate pin rejected")
	}
	config := api.http.Transport.(*http.Transport).TLSClientConfig
	if !config.InsecureSkipVerify || config.VerifyConnection == nil {
		t.Fatal("explicit pin callback missing")
	}
	defaults, err := newTower(server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	if defaults.http.Transport.(*http.Transport).TLSClientConfig.InsecureSkipVerify {
		t.Fatal("default PKI validation disabled")
	}
	if _, _, err := defaults.request(context.Background(), "GET", "/", "", nil); err == nil {
		t.Fatal("default trust accepted an untrusted CN-only certificate")
	}
	wrong := strings.Repeat("0", 64)
	if wrong == pin {
		wrong = strings.Repeat("1", 64)
	}
	bad, err := newTowerWithPin(server.URL, "", wrong)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := bad.request(context.Background(), "GET", "/", "", nil); !errors.Is(err, errTLSCertPinMismatch) {
		t.Fatal("wrong certificate pin was not rejected")
	}
}

func TestCertificatePinRejectsExpiredAndFutureCertificates(t *testing.T) {
	now := time.Now()
	for _, interval := range [][2]time.Time{{now.Add(-2 * time.Hour), now.Add(-time.Hour)}, {now.Add(time.Hour), now.Add(2 * time.Hour)}} {
		server, pin := pinnedCertificateServer(t, interval[0], interval[1])
		api, err := newTowerWithPin(server.URL, "", pin)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := api.request(context.Background(), "GET", "/", "", nil); !errors.Is(err, errTLSCertValidity) {
			t.Fatal("invalid certificate validity interval accepted")
		}
	}
}

func TestCertificatePinOptionsRejectAmbiguityAndMalformedValues(t *testing.T) {
	for _, pin := range []string{"SHA256:EXAMPLE_PIN", strings.Repeat("0", 63), strings.Repeat("g", 64), strings.Repeat("0", 66)} {
		if _, err := newTowerWithPin("https://tower.example.invalid", "", pin); err == nil || err.Error() != "TLS_CERT_PIN_INVALID" {
			t.Fatal("malformed pin accepted")
		}
	}
	if _, err := newTowerWithPin("https://tower.example.invalid", "EXAMPLE_CA_FILE", strings.Repeat("0", 64)); err == nil || err.Error() != "TLS_TRUST_MODE_CONFLICT" {
		t.Fatal("conflicting trust modes accepted")
	}
}

func TestEmbeddedSSHHostVerificationAndProtocol(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{PasswordCallback: func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) { return nil, nil }}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					conn.Close()
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					channel, reqs, err := incoming.Accept()
					if err != nil {
						return
					}
					for req := range reqs {
						if req.Type != "exec" {
							_ = req.Reply(false, nil)
							continue
						}
						var exec struct{ Command string }
						_ = ssh.Unmarshal(req.Payload, &exec)
						if !strings.HasPrefix(exec.Command, "sudo -n python3 -c") {
							t.Error("unexpected command")
						}
						if strings.Contains(exec.Command, "EXAMPLE_SECRET") {
							t.Error("credential in command")
						}
						_ = req.Reply(true, nil)
						var input map[string]any
						if json.NewDecoder(channel).Decode(&input) != nil {
							t.Error("input invalid")
						}
						_, _ = io.WriteString(channel, `{"ok":true,"data":{"enabled":false}}`)
						_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
						channel.Close()
						break
					}
				}
			}()
		}
	}()
	remote, err := dialSSH(context.Background(), listener.Addr().String(), "EXAMPLE_USER", "EXAMPLE_SECRET", ssh.FingerprintSHA256(signer.PublicKey()))
	if err != nil {
		t.Fatal(err)
	}
	result, err := remote.Call(context.Background(), map[string]any{"action": "disable"})
	remote.client.Close()
	if err != nil || string(result["enabled"]) != "false" {
		t.Fatal(err, result)
	}
	if _, err := dialSSH(context.Background(), listener.Addr().String(), "EXAMPLE_USER", "EXAMPLE_SECRET", "SHA256:WRONG_PIN"); err == nil {
		t.Fatal("wrong key accepted")
	}
	listener.Close()
	<-done
}

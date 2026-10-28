package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const maxResponse = 32 << 20

var errTLSCertPinMismatch = errors.New("TLS_CERT_PIN_MISMATCH")
var errTLSCertValidity = errors.New("TLS_CERT_VALIDITY_INVALID")

type Remote interface {
	Call(context.Context, map[string]any) (map[string]json.RawMessage, error)
}
type SSHRemote struct{ client *ssh.Client }
type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > maxResponse {
		return 0, errors.New("REMOTE_OUTPUT_LIMIT")
	}
	return b.Buffer.Write(p)
}

func dialSSH(ctx context.Context, address, user, password, fingerprint string) (*SSHRemote, error) {
	if fingerprint == "" || !strings.HasPrefix(fingerprint, "SHA256:") {
		return nil, errors.New("SSH_HOST_KEY_PIN_REQUIRED")
	}
	config := &ssh.ClientConfig{User: user, Auth: []ssh.AuthMethod{ssh.Password(password)}, Timeout: 15 * time.Second,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			actual := ssh.FingerprintSHA256(key)
			if actual != fingerprint {
				return fmt.Errorf("SSH_HOST_KEY_MISMATCH (%s)", actual)
			}
			return nil
		}}
	conn, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, errors.New("SSH_CONNECT_FAILED")
	}
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	c, ch, req, err := ssh.NewClientConn(conn, address, config)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("SSH_HANDSHAKE_FAILED: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})
	return &SSHRemote{ssh.NewClient(c, ch, req)}, nil
}
func (r *SSHRemote) Call(ctx context.Context, request map[string]any) (map[string]json.RawMessage, error) {
	script, err := assets.ReadFile("remote.py")
	if err != nil {
		return nil, err
	}
	session, err := r.client.NewSession()
	if err != nil {
		return nil, errors.New("SSH_SESSION_FAILED")
	}
	defer session.Close()
	input, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	session.Stdin = bytes.NewReader(input)
	var output, diagnostic cappedBuffer
	session.Stdout = &output
	session.Stderr = &diagnostic
	// The command is constant apart from our compiled-in script. No user input enters a shell.
	command := "sudo -n python3 -c \"import base64;exec(base64.b64decode('" + base64.StdEncoding.EncodeToString(script) + "'))\""
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case <-ctx.Done():
		session.Close()
		return nil, errors.New("REMOTE_TIMEOUT_OUTCOME_UNKNOWN")
	case err = <-done:
	}
	var result struct {
		OK   bool                       `json:"ok"`
		Code string                     `json:"code"`
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(output.Bytes(), &result) != nil {
		if request["action"] == "probe" {
			return nil, errors.New("REMOTE_BOOTSTRAP_UNAVAILABLE")
		}
		return nil, errors.New("REMOTE_PROTOCOL_FAILED_OUTCOME_UNKNOWN")
	}
	if err != nil && result.OK {
		return nil, errors.New("REMOTE_COMPLETION_UNCONFIRMED_OUTCOME_UNKNOWN")
	}
	if !result.OK || err != nil {
		if result.Code != "" && len(result.Code) < 80 && strings.IndexFunc(result.Code, func(r rune) bool { return !(r >= 'A' && r <= 'Z' || r == '_') }) < 0 {
			return nil, errors.New(result.Code)
		}
		return nil, errors.New("REMOTE_OPERATION_FAILED")
	}
	return result.Data, nil
}

type Tower struct {
	base           string
	http           *http.Client
	token          string
	certificatePin string
}

func newTower(raw, caFile string) (*Tower, error) {
	return newTowerWithPin(raw, caFile, "")
}

func newTowerWithPin(raw, caFile, certificatePin string) (*Tower, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("HTTPS_TOWER_ORIGIN_REQUIRED")
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if certificatePin != "" {
		if caFile != "" {
			return nil, errors.New("TLS_TRUST_MODE_CONFLICT")
		}
		expected, err := hex.DecodeString(certificatePin)
		if err != nil || len(certificatePin) != 64 || len(expected) != sha256.Size {
			return nil, errors.New("TLS_CERT_PIN_INVALID")
		}
		// Explicit certificate-pin trust replaces PKI hostname/CA trust for legacy
		// appliance certificates. A verified exact pin and validity interval are mandatory.
		tlsConfig.InsecureSkipVerify = true
		tlsConfig.VerifyConnection = func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errTLSCertPinMismatch
			}
			leaf := state.PeerCertificates[0]
			actual := sha256.Sum256(leaf.Raw)
			if subtle.ConstantTimeCompare(actual[:], expected) != 1 {
				return errTLSCertPinMismatch
			}
			now := time.Now()
			if now.Before(leaf.NotBefore) || now.After(leaf.NotAfter) {
				return errTLSCertValidity
			}
			return nil
		}
	} else {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		if caFile != "" {
			pem, err := os.ReadFile(caFile)
			if err != nil || !roots.AppendCertsFromPEM(pem) {
				return nil, errors.New("CA_FILE_INVALID")
			}
		}
		tlsConfig.RootCAs = roots
	}
	tr := &http.Transport{Proxy: nil, TLSClientConfig: tlsConfig, ResponseHeaderTimeout: 15 * time.Second}
	return &Tower{base: strings.TrimRight(raw, "/"), certificatePin: strings.ToLower(certificatePin), http: &http.Client{Transport: tr, Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("REDIRECT_REJECTED") }}}, nil
}
func (t *Tower) request(ctx context.Context, method, path, contentType string, body []byte) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, method, t.base+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if t.token != "" {
		req.Header.Set("Authorization", t.token)
	}
	req.Header.Set("Origin", t.base)
	response, err := t.http.Do(req)
	if err != nil {
		if errors.Is(err, errTLSCertPinMismatch) {
			return nil, 0, errTLSCertPinMismatch
		}
		if errors.Is(err, errTLSCertValidity) {
			return nil, 0, errTLSCertValidity
		}
		return nil, 0, errors.New("TOWER_CONNECTION_OR_CERTIFICATE_FAILED")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse {
		return nil, response.StatusCode, errors.New("TOWER_RESPONSE_LIMIT")
	}
	return data, response.StatusCode, nil
}

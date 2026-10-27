package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type readbackResponse struct {
	status int
	body   string
	err    error
}

type readbackTransport struct {
	responses []readbackResponse
	calls     int
}

func (r *readbackTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != "GET" || req.URL.Path != "/api/rivetin/v1/runtime" {
		return nil, errors.New("UNEXPECTED_TEST_REQUEST")
	}
	index := r.calls
	r.calls++
	if index >= len(r.responses) {
		index = len(r.responses) - 1
	}
	result := r.responses[index]
	if result.err != nil {
		return nil, result.err
	}
	return &http.Response{StatusCode: result.status, Body: io.NopCloser(strings.NewReader(result.body)), Header: make(http.Header), Request: req}, nil
}

func runtimeReadbackFixture(responses ...readbackResponse) (*Tower, *readbackTransport) {
	transport := &readbackTransport{responses: responses}
	return &Tower{base: "https://tower.example.invalid", http: &http.Client{Transport: transport}}, transport
}

const readbackValid = `{"initialized":true,"enabled":false,"version":"0.1.0"}`

func TestRuntimeReadbackRetriesTransientGatewayThenRequiresValidState(t *testing.T) {
	api, transport := runtimeReadbackFixture(readbackResponse{status: 503, body: "<html>EXAMPLE_PRIVATE_DIAGNOSTIC</html>"}, readbackResponse{status: 502, body: `{"error":"STORE_BUSY"}`}, readbackResponse{status: 504, body: ""}, readbackResponse{status: 200, body: readbackValid})
	var delays []time.Duration
	var lines []string
	err := verifyRuntimeReadback(context.Background(), api, "0.1.0", func(line string) { lines = append(lines, line) }, func(ctx context.Context, delay time.Duration) error { delays = append(delays, delay); return nil })
	if err != nil || transport.calls != 4 || len(delays) != 3 {
		t.Fatal(err, transport.calls, delays)
	}
	if delays[0] != 2*time.Second || delays[1] != 5*time.Second || delays[2] != 10*time.Second {
		t.Fatal(delays)
	}
	joined := strings.Join(lines, "\n")
	if strings.Contains(joined, "EXAMPLE_PRIVATE_DIAGNOSTIC") || !strings.Contains(joined, "attempt=1 httpStatus=503") || !strings.Contains(joined, "attempt=4 httpStatus=200 initialized=true enabled=false version=0.1.0") {
		t.Fatal(joined)
	}
}

func TestRuntimeReadbackSimulatedFiveMinuteBudgetExpiresBeforeRequestLimit(t *testing.T) {
	api, transport := runtimeReadbackFixture(readbackResponse{status: 503, body: `{"error":"EXAMPLE_SECRET_CODE"}`})
	var total time.Duration
	waits := 0
	var lines []string
	err := verifyRuntimeReadback(context.Background(), api, "0.1.0", func(line string) { lines = append(lines, line) }, func(ctx context.Context, delay time.Duration) error {
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > verificationBudget {
			t.Fatal("readback budget is not capped at five minutes")
		}
		waits++
		if waits > 3 && delay != 15*time.Second {
			t.Fatal("steady-state interval is not 15 seconds")
		}
		if total+delay >= verificationBudget {
			total = verificationBudget
			return context.DeadlineExceeded
		}
		total += delay
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) || transport.calls >= 24 || waits != transport.calls || total != verificationBudget {
		t.Fatal(err, transport.calls, waits, total)
	}
	if strings.Contains(strings.Join(lines, "\n"), "EXAMPLE_SECRET_CODE") {
		t.Fatal("unknown JSON error echoed")
	}
}

func TestRuntimeReadbackStillHasHardRequestLimitWithInjectedNoWait(t *testing.T) {
	api, transport := runtimeReadbackFixture(readbackResponse{status: 503, body: ""})
	waits := 0
	err := verifyRuntimeReadback(context.Background(), api, "0.1.0", nil, func(context.Context, time.Duration) error { waits++; return nil })
	if err == nil || err.Error() != "BACKEND_READBACK_FAILED" || transport.calls != 24 || waits != 23 {
		t.Fatal(err, transport.calls, waits)
	}
}

func TestRuntimeReadbackTruncatesDelayToEarlierParentDeadline(t *testing.T) {
	api, transport := runtimeReadbackFixture(readbackResponse{status: 503, body: ""})
	ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
	defer cancel()
	deadline, _ := ctx.Deadline()
	err := verifyRuntimeReadback(ctx, api, "0.1.0", nil, func(readCtx context.Context, delay time.Duration) error {
		actualDeadline, _ := readCtx.Deadline()
		if !actualDeadline.Equal(deadline) || delay <= 0 || delay > 400*time.Millisecond {
			t.Fatal("parent deadline was extended or delay not truncated", actualDeadline, delay)
		}
		return context.DeadlineExceeded
	})
	if !errors.Is(err, context.DeadlineExceeded) || transport.calls != 1 {
		t.Fatal(err, transport.calls)
	}
}

type budgetRemote struct {
	base          *fakeRemote
	prepareAt     time.Time
	outerDeadline time.Time
}

func (r *budgetRemote) Call(ctx context.Context, request map[string]any) (map[string]json.RawMessage, error) {
	if request["action"] == "prepare" {
		r.prepareAt = time.Now()
		r.outerDeadline, _ = ctx.Deadline()
	}
	return r.base.Call(ctx, request)
}

type runtimeReadbackOverlay struct {
	runtime  *readbackTransport
	delegate http.RoundTripper
}

type verificationDeadlineTransport struct {
	delegate http.RoundTripper
	remote   *budgetRemote
	t        *testing.T
	checked  int
}

func (r *verificationDeadlineTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if !r.remote.prepareAt.IsZero() {
		deadline, ok := req.Context().Deadline()
		if !ok || deadline.After(r.remote.prepareAt.Add(verificationBudget)) {
			r.t.Fatal("Island registration or verification escaped the shared deadline", req.Method, req.URL.Path)
		}
		r.checked++
	}
	return r.delegate.RoundTrip(req)
}

func TestIslandRegistrationAndReadbackShareVerificationDeadline(t *testing.T) {
	r, _, api := fixture(t)
	remote := &budgetRemote{base: r}
	transport := &verificationDeadlineTransport{delegate: api.http.Transport, remote: remote, t: t}
	api.http.Transport = transport
	outer, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := (Engine{Remote: remote, Tower: api}).Run(outer, "install", "EXAMPLE_ADMIN", "EXAMPLE_PASSWORD", ""); err != nil {
		t.Fatal(err)
	}
	if transport.checked < 4 {
		t.Fatal("registration and verification requests were not observed", transport.checked)
	}
}

func (r runtimeReadbackOverlay) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL.Path == "/api/rivetin/v1/runtime" {
		return r.runtime.RoundTrip(req)
	}
	return r.delegate.RoundTrip(req)
}

func TestVerificationBudgetStartsBeforePrepareAndTimeoutAutomaticallyRollsBack(t *testing.T) {
	r, _, api := fixture(t)
	remote := &budgetRemote{base: r}
	api.http.Transport = runtimeReadbackOverlay{runtime: &readbackTransport{responses: []readbackResponse{{status: 503, body: ""}}}, delegate: api.http.Transport}
	outer, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	engine := Engine{Remote: remote, Tower: api, ReadbackWait: func(readCtx context.Context, delay time.Duration) error {
		deadline, _ := readCtx.Deadline()
		if deadline.After(remote.prepareAt.Add(verificationBudget)) || time.Until(remote.outerDeadline) < verificationBudget {
			t.Fatal("verification budget started late or replaced remote context")
		}
		return context.DeadlineExceeded
	}}
	err := engine.Run(outer, "install", "EXAMPLE_ADMIN", "EXAMPLE_PASSWORD", "")
	if err == nil || !strings.Contains(err.Error(), "ROLLED_BACK_PLUGINS_DISABLED") || outer.Err() != nil || r.calls[len(r.calls)-1] != "rollback" {
		t.Fatal("readback timeout did not automatically roll back", err, r.calls)
	}
}

func TestRuntimeReadbackRejectsNonGatewayAndInvalidSuccessfulStatesImmediately(t *testing.T) {
	for _, response := range []readbackResponse{
		{status: 401, body: `{"error":"AUTHENTICATION_REQUIRED"}`},
		{status: 403, body: `{"error":"ADMIN_REQUIRED"}`},
		{status: 404, body: `{"error":"NOT_FOUND"}`},
		{status: 500, body: `{"error":"REQUEST_FAILED"}`},
		{status: 503, body: `{"error":"AUTHENTICATION_REQUIRED"}`},
		{status: 200, body: `{"initialized":true,"enabled":true,"version":"0.1.0"}`},
		{status: 200, body: `{"initialized":true,"enabled":false,"version":"0.2.0"}`},
		{status: 200, body: `{"initialized":false,"enabled":false,"version":"0.1.0"}`},
		{status: 200, body: `{"initialized":true,"version":"0.1.0"}`},
		{status: 200, body: `{"initialized":true,"enabled":false,"version":"0.1.0","error":"REQUEST_FAILED"}`},
		{status: 200, body: `{"initialized":true,"enabled":false,"version":"0.1.0\nEXAMPLE_SECRET"}`},
		{status: 200, body: `EXAMPLE_PRIVATE_DIAGNOSTIC`},
		{status: 200, body: `null`},
	} {
		api, transport := runtimeReadbackFixture(response)
		waits := 0
		var lines []string
		err := verifyRuntimeReadback(context.Background(), api, "0.1.0", func(line string) { lines = append(lines, line) }, func(context.Context, time.Duration) error { waits++; return nil })
		if err == nil || transport.calls != 1 || waits != 0 {
			t.Fatal("invalid state retried or accepted", response.status, err, transport.calls, waits)
		}
		if strings.Contains(strings.Join(lines, "\n"), "EXAMPLE_") {
			t.Fatal("response content leaked")
		}
	}
}

func TestRuntimeReadbackDoesNotRetryTLSOrTransportFailures(t *testing.T) {
	for _, failure := range []error{errTLSCertPinMismatch, errTLSCertValidity, errors.New("EXAMPLE_PRIVATE_TRANSPORT_ERROR")} {
		api, transport := runtimeReadbackFixture(readbackResponse{err: failure})
		waits := 0
		var lines []string
		err := verifyRuntimeReadback(context.Background(), api, "0.1.0", func(line string) { lines = append(lines, line) }, func(context.Context, time.Duration) error { waits++; return nil })
		if err == nil || transport.calls != 1 || waits != 0 {
			t.Fatal("TLS or transport failure retried")
		}
		if strings.Contains(strings.Join(lines, "\n"), "EXAMPLE_PRIVATE") {
			t.Fatal("transport diagnostic leaked")
		}
	}
}

func TestRuntimeReadbackContextInterruptsBackoff(t *testing.T) {
	api, transport := runtimeReadbackFixture(readbackResponse{status: 503, body: ""})
	ctx, cancel := context.WithCancel(context.Background())
	err := verifyRuntimeReadback(ctx, api, "0.1.0", nil, func(context.Context, time.Duration) error { cancel(); return ctx.Err() })
	if !errors.Is(err, context.Canceled) || transport.calls != 1 {
		t.Fatal(err, transport.calls)
	}
	start := time.Now()
	alreadyCanceled, cancelAgain := context.WithCancel(context.Background())
	cancelAgain()
	if err := waitReadback(alreadyCanceled, time.Second); !errors.Is(err, context.Canceled) || time.Since(start) > 250*time.Millisecond {
		t.Fatal("backoff ignored cancellation")
	}
}

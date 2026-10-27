package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
)

func fixtureIslandArchive(t *testing.T, manifest string) []byte {
	t.Helper()
	var out bytes.Buffer
	gz := gzip.NewWriter(&out)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "sea-map.json", Mode: 0600, Size: int64(len(manifest)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(manifest)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

type islandRegisterTransport struct {
	t       *testing.T
	archive []byte
	fail    bool
	posted  bool
}

func (r *islandRegisterTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method == "GET" {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(versionedIsland)), Header: make(http.Header)}, nil
	}
	r.posted = true
	if r.fail {
		return nil, errors.New("EXAMPLE_RAW_PRIVATE_ERROR")
	}
	if err := req.ParseMultipartForm(maxResponse); err != nil {
		r.t.Fatal(err)
	}
	defer req.MultipartForm.RemoveAll()
	file, _, err := req.FormFile("file")
	if err != nil {
		r.t.Fatal(err)
	}
	defer file.Close()
	got, err := io.ReadAll(file)
	if err != nil || !bytes.Equal(got, r.archive) {
		r.t.Fatal("register changed archive bytes", err)
	}
	return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(`{}`)), Header: make(http.Header)}, nil
}

func TestIslandRegisterPreservesVersionedArchiveAndUnknownOutcome(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "preserve", true: "unknown"}[fail], func(t *testing.T) {
			archive := fixtureIslandArchive(t, `{"name":"rivetin","metadata":{"version":"0.1.0"}}`)
			tr := &islandRegisterTransport{t: t, archive: archive, fail: fail}
			api := &Tower{base: "https://tower.example.invalid", http: &http.Client{Transport: tr}, token: "EXAMPLE_AUTH"}
			err := (tower49{}).Register(context.Background(), api, archive)
			if !tr.posted {
				t.Fatal("not posted")
			}
			if fail {
				if err == nil || err.Error() != "ISLAND_REGISTER_OUTCOME_UNKNOWN" {
					t.Fatal(err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}
func TestIslandRegisterRejectsActualNameChangeBeforePost(t *testing.T) {
	api, _ := islandAPI(t, islandReply{"GET", allIslands, 200, versionedIsland})
	err := (tower49{}).Register(context.Background(), api, fixtureIslandArchive(t, `{"name":"rivetin","metadata":{"info":{"version":"0.1.0"}}}`))
	if err == nil || err.Error() != "ISLAND_NAME_CHANGE_REQUIRES_MIGRATION" {
		t.Fatal(err)
	}
}
func TestIslandRegisterRejectsInvalidArchiveBeforeRequests(t *testing.T) {
	for _, data := range [][]byte{{31, 139}, fixtureIslandArchive(t, `{"name":"other-island"}`), fixtureIslandArchive(t, `{"name":"rivetin","metadata":{"version":"../unsafe"}}`)} {
		api, _ := islandAPI(t)
		if err := (tower49{}).Register(context.Background(), api, data); err == nil || err.Error() != "ISLAND_ARCHIVE_INVALID" {
			t.Fatal(err)
		}
	}
}

type islandReply struct {
	method, path string
	status       int
	body         string
}
type islandTransport struct {
	t       *testing.T
	replies []islandReply
	calls   int
}

func (r *islandTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r.t.Helper()
	if r.calls >= len(r.replies) {
		r.t.Fatalf("unexpected Island request %s %s", req.Method, req.URL.RequestURI())
	}
	want := r.replies[r.calls]
	r.calls++
	if req.Method != want.method || req.URL.RequestURI() != want.path {
		r.t.Fatalf("request %s %s; want %s %s", req.Method, req.URL.RequestURI(), want.method, want.path)
	}
	return &http.Response{StatusCode: want.status, Body: io.NopCloser(bytes.NewBufferString(want.body)), Header: make(http.Header), Request: req}, nil
}
func islandAPI(t *testing.T, replies ...islandReply) (*Tower, *islandTransport) {
	t.Helper()
	tr := &islandTransport{t: t, replies: replies}
	t.Cleanup(func() {
		if tr.calls != len(tr.replies) {
			t.Errorf("Island requests %d; want %d", tr.calls, len(tr.replies))
		}
	})
	return &Tower{base: "https://tower.example.invalid", http: &http.Client{Transport: tr}, token: "EXAMPLE_AUTH"}, tr
}

const allIslands = "/api/island-registry/sea-maps?refreshCache=true"
const versionedIsland = `{"seaMaps":[{"name":"rivetin","metadata":{"version":"0.1.0"},"data":[{"region":"PERMANENT_CLUSTER_MANAGER_MODAL","island":"./Rivetin"}]}]}`
const plainIsland = `{"seaMaps":[{"name":"rivetin","metadata":{"info":{"version":"0.1.0"}},"data":[{"region":"PERMANENT_CLUSTER_MANAGER_MODAL","island":"./Rivetin"}]}]}`

func TestIslandBackupUsesNativeVersionPathAndPreservesBytes(t *testing.T) {
	for _, tc := range []struct{ name, registry, suffix string }{{"versioned", versionedIsland, "/0.1.0"}, {"info-version", plainIsland, ""}} {
		t.Run(tc.name, func(t *testing.T) {
			archive := []byte{31, 139, 0, 1, 2, 3}
			api, _ := islandAPI(t, islandReply{"GET", allIslands, 200, tc.registry}, islandReply{"GET", "/api/island-registry/sea-maps/download/rivetin" + tc.suffix, 200, string(archive)})
			got, err := (tower49{}).Backup(context.Background(), api)
			if err != nil || !bytes.Equal(got, archive) {
				t.Fatal("backup bytes changed", err)
			}
		})
	}
}
func TestIslandAbsentRequiresSuccessfulValidRegistry(t *testing.T) {
	for _, tc := range []struct {
		name, body, code string
		status           int
	}{
		{"empty", `{"seaMaps":[]}`, "", 200},
		{"siblings", `{"seaMaps":[{"name":"rivetin-example"},{"name":"hostIsland"}]}`, "", 200},
		{"server-error", `{}`, "ISLAND_REGISTRY_UNAVAILABLE", 500},
		{"missing", `{}`, "ISLAND_REGISTRY_INVALID", 200},
		{"null", `{"seaMaps":null}`, "ISLAND_REGISTRY_INVALID", 200},
		{"invalid", `{"seaMaps":[null]}`, "ISLAND_REGISTRY_INVALID", 200},
		{"multiple", `{"seaMaps":[{"name":"rivetin"},{"name":"rivetin","metadata":{"version":"0.1.0"}}]}`, "ISLAND_MULTIPLE_INSTANCES", 200},
		{"unsafe-version", `{"seaMaps":[{"name":"rivetin","metadata":{"version":"../other"}}]}`, "ISLAND_REGISTRY_INVALID", 200},
		{"non-string-version", `{"seaMaps":[{"name":"rivetin","metadata":{"version":1}}]}`, "ISLAND_REGISTRY_INVALID", 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api, _ := islandAPI(t, islandReply{"GET", allIslands, tc.status, tc.body})
			got, err := (tower49{}).Backup(context.Background(), api)
			if tc.code == "" {
				if err != nil || got != nil {
					t.Fatal(err)
				}
			} else if err == nil || err.Error() != tc.code {
				t.Fatal(err)
			}
		})
	}
}
func TestIslandListedDownloadFailureIsNotAbsence(t *testing.T) {
	for _, status := range []int{404, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			api, _ := islandAPI(t, islandReply{"GET", allIslands, 200, versionedIsland}, islandReply{"GET", "/api/island-registry/sea-maps/download/rivetin/0.1.0", status, ""})
			if _, err := (tower49{}).Backup(context.Background(), api); err == nil || err.Error() != "ISLAND_BACKUP_FAILED" {
				t.Fatal(err)
			}
		})
	}
}
func TestIslandRemoveActualNameAndFreshReadback(t *testing.T) {
	for _, tc := range []struct {
		name, readback, code string
		status               int
	}{
		{"success", `{"seaMaps":[]}`, "", 204},
		{"404-removed", `{"seaMaps":[]}`, "", 404},
		{"404-still-present", versionedIsland, "ISLAND_REMOVE_READBACK_FAILED", 404},
		{"success-still-present", versionedIsland, "ISLAND_REMOVE_READBACK_FAILED", 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api, _ := islandAPI(t, islandReply{"GET", allIslands, 200, versionedIsland}, islandReply{"DELETE", "/api/island-registry/sea-maps/rivetin-0.1.0", tc.status, ""}, islandReply{"GET", allIslands, 200, tc.readback})
			err := (tower49{}).Remove(context.Background(), api)
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || err.Error() != tc.code {
				t.Fatal(err)
			}
		})
	}
}
func TestIslandVerifyActualStaticPathAndStrictRegion(t *testing.T) {
	for _, tc := range []struct{ name, region, code string }{{"matching", versionedIsland, ""}, {"other-version", plainIsland, "ISLAND_MOUNT_MISSING"}, {"missing", `{"seaMaps":[]}`, "ISLAND_MOUNT_MISSING"}, {"invalid", `{}`, "ISLAND_REGION_INVALID"}} {
		t.Run(tc.name, func(t *testing.T) {
			api, _ := islandAPI(t, islandReply{"GET", allIslands, 200, versionedIsland}, islandReply{"GET", "/api/island-registry/sea-maps/rivetin-0.1.0/build/remoteEntry.js", 200, "EXPECTED_ENTRY"}, islandReply{"GET", "/api/island-registry/sea-maps/PERMANENT_CLUSTER_MANAGER_MODAL?refreshCache=true", 200, tc.region})
			err := (tower49{}).Verify(context.Background(), api, []byte("EXPECTED_ENTRY"))
			if tc.code == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if err == nil || err.Error() != tc.code {
				t.Fatal(err)
			}
		})
	}
}

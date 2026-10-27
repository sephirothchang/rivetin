package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

type Profile struct {
	ID         string `json:"id"`
	Image      string `json:"image"`
	Node       string `json:"node"`
	Namespace  string `json:"namespace"`
	Pod        string `json:"pod"`
	Container  string `json:"container"`
	Adapter    string `json:"adapter"`
	Validation string `json:"validation"`
}
type Probe struct {
	Image     string `json:"image"`
	Node      string `json:"node"`
	Namespace string `json:"namespace"`
	Pod       string `json:"pod"`
	Container string `json:"container"`
	Installed bool   `json:"installed"`
	Managed   bool   `json:"managed"`
	Pending   string `json:"pending"`
}

func profiles() []Profile {
	data, _ := assets.ReadFile("profiles.json")
	var p []Profile
	_ = json.Unmarshal(data, &p)
	return p
}
func matchProfile(probe Probe) (Profile, error) {
	for _, p := range profiles() {
		if p.Image == probe.Image && p.Node == probe.Node && p.Namespace == probe.Namespace && p.Pod == probe.Pod && p.Container == probe.Container && p.Adapter == "tower49" {
			return p, nil
		}
	}
	return Profile{}, errors.New("UNTESTED_TOWER_BUILD")
}

type Adapter interface {
	Login(context.Context, *Tower, string, string) error
	Backup(context.Context, *Tower) ([]byte, error)
	Register(context.Context, *Tower, []byte) error
	Remove(context.Context, *Tower) error
	Verify(context.Context, *Tower, []byte) error
}
type tower49 struct{}

type islandMount struct {
	Region string `json:"region"`
	Island string `json:"island"`
}
type ownedIsland struct {
	Name    string `json:"name"`
	Version string
	Data    []islandMount
}

var islandVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

func parseOwnedIslands(data []byte) ([]ownedIsland, error) {
	var envelope struct {
		SeaMaps *[]json.RawMessage `json:"seaMaps"`
	}
	if json.Unmarshal(data, &envelope) != nil || envelope.SeaMaps == nil || len(*envelope.SeaMaps) > 1000 {
		return nil, errors.New("ISLAND_REGISTRY_INVALID")
	}
	var result []ownedIsland
	for _, raw := range *envelope.SeaMaps {
		var header struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &header) != nil || header.Name == "" {
			return nil, errors.New("ISLAND_REGISTRY_INVALID")
		}
		if header.Name != "rivetin" {
			continue
		}
		var entry struct {
			Name     string                     `json:"name"`
			Metadata map[string]json.RawMessage `json:"metadata"`
			Data     []islandMount              `json:"data"`
		}
		if json.Unmarshal(raw, &entry) != nil {
			return nil, errors.New("ISLAND_REGISTRY_INVALID")
		}
		version := ""
		if value, ok := entry.Metadata["version"]; ok && json.Unmarshal(value, &version) != nil {
			return nil, errors.New("ISLAND_REGISTRY_INVALID")
		}
		if version != "" && (len(version) > 80 || !islandVersion.MatchString(version)) {
			return nil, errors.New("ISLAND_REGISTRY_INVALID")
		}
		result = append(result, ownedIsland{Name: entry.Name, Version: version, Data: entry.Data})
	}
	return result, nil
}

func (i ownedIsland) actualName() string {
	if i.Version != "" {
		return i.Name + "-" + i.Version
	}
	return i.Name
}
func (t tower49) ownIsland(ctx context.Context, api *Tower) (*ownedIsland, error) {
	data, status, err := api.request(ctx, "GET", "/api/island-registry/sea-maps?refreshCache=true", "", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, errors.New("ISLAND_REGISTRY_UNAVAILABLE")
	}
	items, err := parseOwnedIslands(data)
	if err != nil {
		return nil, err
	}
	if len(items) > 1 {
		return nil, errors.New("ISLAND_MULTIPLE_INSTANCES")
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

func adapter(p Profile) (Adapter, error) {
	if p.Adapter == "tower49" {
		return tower49{}, nil
	}
	return nil, errors.New("ADAPTER_UNAVAILABLE")
}
func (t tower49) Login(ctx context.Context, api *Tower, user, password string) error {
	body, _ := json.Marshal(map[string]any{"query": "mutation($data: LoginInput!) { login(data:$data){ token } }", "variables": map[string]any{"data": map[string]string{"username": user, "password": password, "source": "LOCAL"}}})
	data, status, err := api.request(ctx, "POST", "/api", "application/json", body)
	if err != nil {
		return err
	}
	var result struct {
		Data struct {
			Login struct {
				Token string `json:"token"`
			} `json:"login"`
		} `json:"data"`
		Errors []any `json:"errors"`
	}
	if status != 200 || json.Unmarshal(data, &result) != nil || len(result.Errors) > 0 || result.Data.Login.Token == "" {
		return errors.New("TOWER_LOGIN_FAILED")
	}
	api.token = result.Data.Login.Token
	parts := strings.Split(api.token, ".")
	if len(parts) != 3 {
		return errors.New("TOWER_IDENTITY_INVALID")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errors.New("TOWER_IDENTITY_INVALID")
	}
	id := string(raw)
	_ = json.Unmarshal(raw, &id)
	if len(id) > 128 || id == "" {
		return errors.New("TOWER_IDENTITY_INVALID")
	}
	body, _ = json.Marshal(map[string]any{"query": "query RivetinIdentity($id: ID!) { user(where: { id: $id }) { id username role } }", "variables": map[string]string{"id": id}})
	data, status, err = api.request(ctx, "POST", "/api", "application/json", body)
	if err != nil {
		return err
	}
	var verified struct {
		Data struct {
			User struct {
				ID   string `json:"id"`
				Role string `json:"role"`
			} `json:"user"`
		} `json:"data"`
		Errors []any `json:"errors"`
	}
	if status != 200 || json.Unmarshal(data, &verified) != nil || len(verified.Errors) > 0 || verified.Data.User.ID != id || (verified.Data.User.Role != "ROOT" && verified.Data.User.Role != "ADMIN") {
		api.token = ""
		return errors.New("TOWER_ADMIN_REQUIRED")
	}
	return nil
}
func (t tower49) Backup(ctx context.Context, api *Tower) ([]byte, error) {
	island, err := t.ownIsland(ctx, api)
	if err != nil {
		return nil, err
	}
	if island == nil {
		return nil, nil
	}
	path := "/api/island-registry/sea-maps/download/rivetin"
	if island.Version != "" {
		path += "/" + url.PathEscape(island.Version)
	}
	data, status, err := api.request(ctx, "GET", path, "", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, errors.New("ISLAND_BACKUP_FAILED")
	}
	if len(data) < 2 || data[0] != 31 || data[1] != 139 {
		return nil, errors.New("ISLAND_BACKUP_INVALID")
	}
	return data, nil
}
func (t tower49) Register(ctx context.Context, api *Tower, data []byte) error {
	target, err := archiveIsland(data)
	if err != nil {
		return err
	}
	current, err := t.ownIsland(ctx, api)
	if err != nil {
		return err
	}
	if current != nil && current.actualName() != target.actualName() {
		return errors.New("ISLAND_NAME_CHANGE_REQUIRES_MIGRATION")
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	f, err := w.CreateFormFile("file", "rivetin-island.tar.gz")
	if err != nil {
		return err
	}
	_, _ = f.Write(data)
	_ = w.Close()
	_, status, err := api.request(ctx, "POST", "/api/island-registry/sea-maps", w.FormDataContentType(), body.Bytes())
	if err != nil {
		return errors.New("ISLAND_REGISTER_OUTCOME_UNKNOWN")
	}
	if status < 200 || status > 299 {
		return errors.New("ISLAND_REGISTER_FAILED")
	}
	return nil
}

func archiveIsland(data []byte) (*ownedIsland, error) {
	invalid := errors.New("ISLAND_ARCHIVE_INVALID")
	if len(data) > maxResponse {
		return nil, invalid
	}
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, invalid
	}
	defer gz.Close()
	limited := &io.LimitedReader{R: gz, N: maxResponse + 1}
	reader := tar.NewReader(limited)
	var found *ownedIsland
	for count := 0; count < 64; count++ {
		header, err := reader.Next()
		if err == io.EOF {
			if found == nil || limited.N <= 0 {
				return nil, invalid
			}
			return found, nil
		}
		if err != nil || limited.N <= 0 || header.Size > maxResponse {
			return nil, invalid
		}
		if header.Name != "sea-map.json" && header.Name != "./sea-map.json" {
			continue
		}
		if found != nil || header.Typeflag != tar.TypeReg || header.Size < 1 || header.Size > 64<<10 {
			return nil, invalid
		}
		raw, err := io.ReadAll(reader)
		if err != nil {
			return nil, invalid
		}
		entries, err := parseOwnedIslands(append(append([]byte(`{"seaMaps":[`), raw...), []byte(`]}`)...))
		if err != nil || len(entries) != 1 {
			return nil, invalid
		}
		found = &entries[0]
	}
	return nil, invalid
}
func (t tower49) Remove(ctx context.Context, api *Tower) error {
	island, err := t.ownIsland(ctx, api)
	if err != nil {
		return err
	}
	if island == nil {
		return nil
	}
	_, status, err := api.request(ctx, "DELETE", "/api/island-registry/sea-maps/"+url.PathEscape(island.actualName()), "", nil)
	if err != nil {
		return err
	}
	if status != 404 && (status < 200 || status > 299) {
		return errors.New("ISLAND_REMOVE_FAILED")
	}
	remaining, err := t.ownIsland(ctx, api)
	if err != nil {
		return err
	}
	if remaining != nil {
		return errors.New("ISLAND_REMOVE_READBACK_FAILED")
	}
	return nil
}
func (t tower49) Verify(ctx context.Context, api *Tower, entry []byte) error {
	island, err := t.ownIsland(ctx, api)
	if err != nil {
		return err
	}
	if island == nil {
		return errors.New("ISLAND_READBACK_MISMATCH")
	}
	data, status, err := api.request(ctx, "GET", "/api/island-registry/sea-maps/"+url.PathEscape(island.actualName())+"/build/remoteEntry.js", "", nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK || digest(data) != digest(entry) {
		return errors.New("ISLAND_READBACK_MISMATCH")
	}
	data, status, err = api.request(ctx, "GET", "/api/island-registry/sea-maps/PERMANENT_CLUSTER_MANAGER_MODAL?refreshCache=true", "", nil)
	if err != nil {
		return err
	}
	if status != 200 {
		return errors.New("ISLAND_REGION_UNAVAILABLE")
	}
	registry, err := parseOwnedIslands(data)
	if err != nil {
		return errors.New("ISLAND_REGION_INVALID")
	}
	for _, entry := range registry {
		if entry.Name == "rivetin" && entry.Version == island.Version {
			for _, mount := range entry.Data {
				if mount.Region == "PERMANENT_CLUSTER_MANAGER_MODAL" && mount.Island == "./Rivetin" {
					return nil
				}
			}
		}
	}
	return errors.New("ISLAND_MOUNT_MISSING")
}
func digest(data []byte) string { v := sha256.Sum256(data); return hex.EncodeToString(v[:]) }

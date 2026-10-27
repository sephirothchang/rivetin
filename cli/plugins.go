package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
)

const maxPluginPackage = 16 << 20

var pluginIDPattern = regexp.MustCompile(`^rivetin-[a-z0-9]+(?:-[a-z0-9]+)*$`)
var pluginVersionPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})$`)
var pluginDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var pluginFilePattern = regexp.MustCompile(`^(?:web/[A-Za-z0-9_./-]+\.(?:js|css|json)|LICENSE)$`)
var pluginServerErrors = map[string]bool{
	"PLUGIN_INCOMPATIBLE": true, "TOWER_BUILD_UNKNOWN": true, "PLUGIN_COMPATIBILITY_UNDECLARED": true,
	"SSH_PERMISSION_REQUIRED": true, "SSH_REGISTRATION_INVALID": true, "SSH_OPERATION_REJECTED": true, "SSH_SCHEDULE_INVALID": true, "SSH_TARGET_LIMIT": true,
	"AUTHENTICATION_REQUIRED": true, "ADMIN_OR_ORIGIN_REQUIRED": true, "ADMIN_REQUIRED": true,
	"FRAMEWORK_NOT_INITIALIZED": true, "PLUGIN_NOT_INSTALLED": true, "INVALID_TRANSITION": true,
	"VERSION_ALREADY_INSTALLED": true, "UPDATE_VERSION_MUST_INCREASE": true, "MIGRATION_REQUIRED": true,
	"PLUGIN_ID_MISMATCH": true, "INVALID_PLUGIN_ID": true, "INVALID_ACTION": true,
	"INVALID_PACKAGE": true, "INVALID_MANIFEST": true, "INVALID_PACKAGE_FILE": true,
	"PACKAGE_TOO_LARGE": true, "PACKAGE_INTEGRITY_FAILED": true, "PACKAGE_ENTRY_MISSING": true,
	"INVALID_SCHEMA": true, "INVALID_SETTINGS": true, "CONFIGURATION_INVALID": true,
	"INVALID_REQUEST": true, "BODY_TOO_LARGE": true, "CONTENT_TYPE_REQUIRED": true,
	"STORE_BUSY": true, "DATA_UNAVAILABLE": true, "REQUEST_FAILED": true, "NOT_FOUND": true,
}

type pluginPackageManifest struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Frontend struct {
		Entry  string `json:"entry"`
		Format string `json:"format"`
	} `json:"frontend"`
}

type pluginPackageFile struct {
	Path   string `json:"path"`
	Data   string `json:"data"`
	SHA256 string `json:"sha256"`
}

func validPluginID(id string) bool { return len(id) <= 100 && pluginIDPattern.MatchString(id) }

func validatePluginInput(input []byte, expectedID string) (pluginPackageManifest, error) {
	var manifest pluginPackageManifest
	if len(input) > maxPluginPackage {
		return manifest, errors.New("PACKAGE_TOO_LARGE")
	}
	var bundle struct {
		Format   string              `json:"format"`
		Manifest json.RawMessage     `json:"manifest"`
		Files    []pluginPackageFile `json:"files"`
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&bundle) != nil || decoder.Decode(new(any)) != io.EOF || bundle.Format != "rivetin-package-v1" || json.Unmarshal(bundle.Manifest, &manifest) != nil {
		return manifest, errors.New("INVALID_PACKAGE")
	}
	if !validPluginID(manifest.ID) || !pluginVersionPattern.MatchString(manifest.Version) {
		return manifest, errors.New("INVALID_MANIFEST")
	}
	if manifest.Frontend.Format != "rivetin-global-v1" {
		return manifest, errors.New("INVALID_MANIFEST")
	}
	if expectedID != "" && expectedID != manifest.ID {
		return manifest, errors.New("PLUGIN_ID_MISMATCH")
	}
	if len(bundle.Files) == 0 || len(bundle.Files) > 100 {
		return manifest, errors.New("INVALID_PACKAGE_FILE")
	}
	names := make(map[string]bool)
	entryFound := false
	total := 0
	for _, file := range bundle.Files {
		name := strings.ToLower(file.Path)
		if !pluginFilePattern.MatchString(file.Path) || path.Clean(file.Path) != file.Path || strings.Contains(file.Path, "//") || names[name] || !pluginDigestPattern.MatchString(file.SHA256) {
			return manifest, errors.New("INVALID_PACKAGE_FILE")
		}
		for _, part := range strings.Split(file.Path, "/") {
			if part == "." || part == ".." || part == "" {
				return manifest, errors.New("INVALID_PACKAGE_FILE")
			}
		}
		content, err := base64.StdEncoding.Strict().DecodeString(file.Data)
		if err != nil || digest(content) != file.SHA256 {
			return manifest, errors.New("PACKAGE_INTEGRITY_FAILED")
		}
		total += len(content)
		if total > 10<<20 {
			return manifest, errors.New("PACKAGE_TOO_LARGE")
		}
		names[name] = true
		entryFound = entryFound || file.Path == manifest.Frontend.Entry
	}
	if !strings.HasPrefix(manifest.Frontend.Entry, "web/") || !strings.HasSuffix(manifest.Frontend.Entry, ".js") || !entryFound || !names["license"] {
		return manifest, errors.New("PACKAGE_ENTRY_MISSING")
	}
	return manifest, nil
}

type pluginCLIState struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	PackageID string `json:"packageId"`
	Installed *bool  `json:"installed"`
	Enabled   *bool  `json:"enabled"`
	Error     string `json:"error"`
}

func pluginRequest(ctx context.Context, api *Tower, route, method string, body []byte) ([]byte, error) {
	contentType := ""
	if body != nil {
		contentType = "application/json"
	}
	data, status, err := api.frameworkRequest(ctx, method, route, contentType, body)
	if err != nil {
		return nil, err
	}
	if status < 200 || status > 299 {
		var failure struct {
			Code string `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && pluginServerErrors[failure.Code] {
			return nil, errors.New(failure.Code)
		}
		return nil, errors.New("PLUGIN_REQUEST_FAILED")
	}
	return data, nil
}

func pluginStates(ctx context.Context, api *Tower) ([]pluginCLIState, error) {
	data, err := pluginRequest(ctx, api, "/plugins", "GET", nil)
	if err != nil {
		return nil, err
	}
	var response struct {
		Items *[]pluginCLIState `json:"items"`
	}
	if json.Unmarshal(data, &response) != nil || response.Items == nil {
		return nil, errors.New("PLUGIN_READBACK_INVALID")
	}
	seen := make(map[string]bool)
	for index := range *response.Items {
		item := &(*response.Items)[index]
		if !validPluginID(item.ID) || seen[item.ID] || item.Installed == nil || item.Enabled == nil {
			return nil, errors.New("PLUGIN_READBACK_INVALID")
		}
		seen[item.ID] = true
	}
	return *response.Items, nil
}

// RunPluginAction manages authenticated Rivetin packages without executing their contents.
func RunPluginAction(ctx context.Context, api *Tower, action, pluginID string, packageBytes []byte, progress func(string)) error {
	if api == nil || api.token == "" {
		return errors.New("TOWER_AUTHENTICATION_REQUIRED")
	}
	if action != "install" && action != "update" && action != "enable" && action != "disable" && action != "uninstall" && action != "list" {
		return errors.New("INVALID_PLUGIN_ACTION")
	}
	if pluginID != "" && !validPluginID(pluginID) || pluginID == "" && action != "install" && action != "update" && action != "list" {
		return errors.New("INVALID_PLUGIN_ID")
	}
	say := func(message string) {
		if progress != nil {
			progress(message)
		}
	}
	if action == "list" {
		items, err := pluginStates(ctx, api)
		if err != nil {
			return err
		}
		for _, item := range items {
			if pluginID == "" || item.ID == pluginID {
				version := item.Version
				if !pluginVersionPattern.MatchString(version) {
					version = "unknown"
				}
				say(fmt.Sprintf("PLUGIN %s version=%s installed=%t enabled=%t", item.ID, version, *item.Installed, *item.Enabled))
			}
		}
		return nil
	}
	var expected pluginPackageManifest
	packageID := ""
	if action == "install" || action == "update" {
		var err error
		expected, err = validatePluginInput(packageBytes, pluginID)
		if err != nil {
			return err
		}
		pluginID = expected.ID
		data, err := pluginRequest(ctx, api, "/packages", "POST", packageBytes)
		if err != nil {
			return err
		}
		var uploaded struct {
			PackageID string                `json:"packageId"`
			Manifest  pluginPackageManifest `json:"manifest"`
		}
		if json.Unmarshal(data, &uploaded) != nil || uploaded.PackageID != digest(packageBytes) || uploaded.Manifest.ID != expected.ID || uploaded.Manifest.Version != expected.Version {
			return errors.New("PLUGIN_UPLOAD_READBACK_MISMATCH")
		}
		packageID = uploaded.PackageID
	}
	request := map[string]string{"action": action, "pluginId": pluginID}
	if packageID != "" {
		request["packageId"] = packageID
	}
	body, _ := json.Marshal(request)
	if _, err := pluginRequest(ctx, api, "/plugins", "POST", body); err != nil {
		return err
	}
	items, err := pluginStates(ctx, api)
	if err != nil {
		return err
	}
	var found *pluginCLIState
	for index := range items {
		if items[index].ID == pluginID {
			found = &items[index]
			break
		}
	}
	if action == "uninstall" && found == nil {
		say("PLUGIN_COMPLETE uninstall " + pluginID)
		return nil
	}
	if found == nil || found.Error != "" {
		return errors.New("PLUGIN_READBACK_MISMATCH")
	}
	if action == "install" || action == "update" {
		if !*found.Installed || *found.Enabled || found.Version != expected.Version || found.PackageID != packageID {
			return errors.New("PLUGIN_READBACK_MISMATCH")
		}
	} else if action == "uninstall" {
		if *found.Installed || *found.Enabled {
			return errors.New("PLUGIN_READBACK_MISMATCH")
		}
	} else if !*found.Installed || *found.Enabled != (action == "enable") {
		return errors.New("PLUGIN_READBACK_MISMATCH")
	}
	say("PLUGIN_COMPLETE " + action + " " + pluginID)
	return nil
}

package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"
)

func payloadFixture(t *testing.T, version string) (fstest.MapFS, Bundle) {
	t.Helper()
	files := fstest.MapFS{}
	bundle := Bundle{Version: version, Files: make(map[string]string)}
	for _, name := range requiredPayloadFiles {
		data := []byte("EXAMPLE_PAYLOAD_" + name)
		files["payload/"+name] = &fstest.MapFile{Data: data}
		bundle.Files[name] = digest(data)
	}
	raw, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	files["payload/bundle.json"] = &fstest.MapFile{Data: raw}
	return files, bundle
}

func TestPayloadAcceptsCanonicalReleaseVersionsIncludingPatchUpgrade(t *testing.T) {
	for _, version := range []string{"0.1.0", "0.1.1", "0.1.2", "0.1.3", "0.1.4", "1.2.3"} {
		t.Run(version, func(t *testing.T) {
			files, expected := payloadFixture(t, version)
			bundle, content, err := readPayload(files)
			if err != nil || bundle.Version != version || len(content) != len(requiredPayloadFiles) {
				t.Fatal(bundle, len(content), err)
			}
			for name, checksum := range expected.Files {
				if bundle.Files[name] != checksum || !bytes.Equal(content[name], files["payload/"+name].Data) {
					t.Fatalf("release payload mismatch: %s", name)
				}
			}
		})
	}
}

func TestPayloadRejectsInvalidOrNonCanonicalVersions(t *testing.T) {
	for _, version := range []string{"", "0.1", "v0.1.1", "01.1.1", "0.01.1", "0.1.01", "0.1.1-rc.1", "0.1.1+build", "0.1.1\n", " 0.1.1", "100000000.0.0", "-1.0.0", "0.1.1/../other"} {
		t.Run(version, func(t *testing.T) {
			files, _ := payloadFixture(t, version)
			if _, _, err := readPayload(files); err == nil || err.Error() != "BUNDLE_INVALID" {
				t.Fatal("invalid version accepted", err)
			}
		})
	}
}

func TestPayloadRequiresExactManifestFieldsAndLowercaseDigests(t *testing.T) {
	for _, kind := range []string{"missing-version", "missing-files", "unknown-field", "case-folded-field", "missing-file", "extra-file", "uppercase-digest", "short-digest", "null-files", "array-files", "null-version", "numeric-version"} {
		t.Run(kind, func(t *testing.T) {
			files, _ := payloadFixture(t, "0.1.1")
			var value map[string]any
			if json.Unmarshal(files["payload/bundle.json"].Data, &value) != nil {
				t.Fatal("invalid fixture")
			}
			checksums := value["files"].(map[string]any)
			switch kind {
			case "missing-version":
				delete(value, "version")
			case "missing-files":
				delete(value, "files")
			case "unknown-field":
				value["unexpected"] = true
			case "case-folded-field":
				value["Version"] = value["version"]
				delete(value, "version")
			case "missing-file":
				delete(checksums, "service.tar.gz")
			case "extra-file":
				checksums["../unexpected"] = strings.Repeat("a", 64)
			case "uppercase-digest":
				checksums["service.tar.gz"] = strings.Repeat("A", 64)
			case "short-digest":
				checksums["service.tar.gz"] = "abcd"
			case "null-files":
				value["files"] = nil
			case "array-files":
				value["files"] = []string{}
			case "null-version":
				value["version"] = nil
			case "numeric-version":
				value["version"] = 1
			}
			raw, _ := json.Marshal(value)
			files["payload/bundle.json"].Data = raw
			if _, _, err := readPayload(files); err == nil || err.Error() != "BUNDLE_INVALID" {
				t.Fatal("invalid release manifest accepted", err)
			}
		})
	}
}

func TestPayloadRejectsDuplicateKeysTrailingContentAndOversizedMetadata(t *testing.T) {
	files, _ := payloadFixture(t, "0.1.1")
	raw := string(files["payload/bundle.json"].Data)
	for _, value := range []string{
		strings.Replace(raw, `"version":"0.1.1"`, `"version":"0.1.1","version":"0.1.1"`, 1),
		strings.Replace(raw, `"files":{`, `"files":{"service.tar.gz":"`+strings.Repeat("a", 64)+`",`, 1),
		raw + `{}`,
		raw + "EXTRA",
		"null",
		"[]",
		strings.Repeat(" ", 4097) + raw,
		string([]byte{0xff}) + raw,
	} {
		if _, err := decodeBundle([]byte(value)); err == nil || err.Error() != "BUNDLE_INVALID" {
			t.Fatal("ambiguous release metadata accepted", err)
		}
	}
}

func TestPayloadRequiresAllNonemptyMatchingFiles(t *testing.T) {
	for _, kind := range []string{"missing", "changed", "empty"} {
		t.Run(kind, func(t *testing.T) {
			files, bundle := payloadFixture(t, "0.1.1")
			switch kind {
			case "missing":
				delete(files, "payload/service.tar.gz")
			case "changed":
				files["payload/service.tar.gz"].Data = []byte("CHANGED")
			case "empty":
				files["payload/service.tar.gz"].Data = nil
				bundle.Files["service.tar.gz"] = digest(nil)
				files["payload/bundle.json"].Data, _ = json.Marshal(bundle)
			}
			if _, _, err := readPayload(files); err == nil || err.Error() != "BUNDLE_CHECKSUM_FAILED" {
				t.Fatal("invalid file accepted", err)
			}
		})
	}
	if _, _, err := readPayload(fstest.MapFS{}); err == nil || err.Error() != "PAYLOAD_NOT_BUILT" {
		t.Fatal("missing embedded payload accepted", err)
	}
}

func TestCLIVersionAndHelpUseOneReleaseConstant(t *testing.T) {
	var version bytes.Buffer
	if err := run([]string{"version"}, &version); err != nil || strings.TrimSpace(version.String()) != "rivetin "+cliVersion {
		t.Fatal(version.String(), err)
	}
	for _, lang := range []string{"zh-CN", "en-US"} {
		var help bytes.Buffer
		if err := run([]string{"help", "--lang", lang}, &help); err != nil || !strings.Contains(strings.SplitN(help.String(), "\n", 2)[0], cliVersion) {
			t.Fatal(lang, help.String(), err)
		}
	}
}

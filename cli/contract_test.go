package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Python is a development-only contract checker. Production CLI files never
// execute client-side Python; the compiled SSH adapter sends this code to Tower.
func developmentPython(t *testing.T) string {
	t.Helper()
	for _, name := range []string{"python3", "python"} {
		program, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		err = exec.CommandContext(ctx, program, "-I", "-S", "-c", "import sys;sys.exit(0 if sys.version_info >= (3,8) else 1)").Run()
		cancel()
		if err == nil {
			return program
		}
	}
	t.Skip("Python 3.8+ is unavailable: cross-language development contracts skipped; the portable CLI has no client-side Python dependency")
	return ""
}

func workspaceContractDirectory(t *testing.T) string {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	runtime := filepath.Join(root, ".runtime")
	if err = os.MkdirAll(runtime, 0700); err != nil {
		t.Fatal(err)
	}
	directory, err := os.MkdirTemp(runtime, "contract-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		relative, err := filepath.Rel(runtime, directory)
		if err != nil || relative == "." || strings.HasPrefix(relative, "..") || filepath.IsAbs(relative) {
			t.Error("TEST_PATH_OUTSIDE_WORKSPACE")
			return
		}
		if err = os.RemoveAll(directory); err != nil {
			t.Error(err)
		}
	})
	return directory
}

func TestGoManifestAndEmbeddedServiceMatchRemoteAdapter(t *testing.T) {
	python := developmentPython(t)
	bundle, inputs, err := payload()
	if err != nil {
		t.Fatal(err)
	}
	if bundle.Version != cliVersion {
		t.Fatalf("CLI version %s differs from embedded release %s", cliVersion, bundle.Version)
	}
	script, err := assets.ReadFile("remote.py")
	if err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"https://tower.example.invalid", "https://tower.example.invalid:8443"} {
		t.Run(origin, func(t *testing.T) {
			manifest, err := deployment(profiles()[0], origin, digest(inputs["service.tar.gz"]), "")
			if err != nil {
				t.Fatal(err)
			}
			directory := workspaceContractDirectory(t)
			input, err := json.Marshal(map[string]string{
				"script":    base64.StdEncoding.EncodeToString(script),
				"manifest":  base64.StdEncoding.EncodeToString(manifest),
				"service":   base64.StdEncoding.EncodeToString(inputs["service.tar.gz"]),
				"checksum":  digest(inputs["service.tar.gz"]),
				"version":   bundle.Version,
				"directory": directory,
			})
			if err != nil {
				t.Fatal(err)
			}
			const contract = `
import base64, hashlib, json, pathlib, sys, types
request = json.load(sys.stdin)
module = types.ModuleType('embedded_remote_contract')
exec(compile(base64.b64decode(request['script']), '<embedded-remote.py>', 'exec'), module.__dict__)
# Validation represents the Linux Tower path semantics on every development OS.
module.BASE = pathlib.PurePosixPath('/var/cache/appcache/rivetin')
manifest = json.loads(base64.b64decode(request['manifest']))
module.validate_manifest(manifest, request['checksum'])
invalid = json.loads(json.dumps(manifest))
invalid['items'][0]['spec']['template']['spec']['volumes'][1]['hostPath']['path'] = '/'
try:
 module.validate_manifest(invalid, request['checksum'])
except RuntimeError as error:
 assert str(error) == 'MANIFEST_INVALID'
else:
 raise AssertionError('Modified host mount was accepted')
service = base64.b64decode(request['service'], validate=True)
assert hashlib.sha256(service).hexdigest() == request['checksum']
directory = pathlib.Path(request['directory']).resolve()
expected_parent = (pathlib.Path.cwd() / '.runtime').resolve()
assert directory.parent == expected_parent
target = directory / 'release'
target.mkdir()
contents = module.extract_release(service, target)
assert {'server/main.js', 'cli.mjs', 'package.json', 'LICENSE', 'shared/identity.js', 'shared/version.js',
        'server/resource-actions.js', 'server/smart-provider.js', 'server/smart-collection.js',
        'server/builtins/rivetin-ssh-channel.json', 'server/vendor/ssh2.cjs'}.issubset(contents)
assert json.loads(contents['package.json'])['version'] == request['version']
assert ('FRAMEWORK_VERSION = '+repr(request['version'])).encode() in contents['shared/version.js']
assert all((target / name).read_bytes() == data for name, data in contents.items())
print(json.dumps({'manifest': 'accepted', 'serviceFiles': len(contents)}))
`
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, python, "-I", "-S", "-c", contract)
			command.Stdin = bytes.NewReader(input)
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("Go/remote contract rejected: %v\n%s", err, output)
			}
			var result struct {
				Manifest     string `json:"manifest"`
				ServiceFiles int    `json:"serviceFiles"`
			}
			if json.Unmarshal(output, &result) != nil || result.Manifest != "accepted" || result.ServiceFiles < 4 {
				t.Fatalf("Invalid contract result: %s", output)
			}
			t.Logf("Actual Go manifest accepted, altered host mount rejected; embedded service archive extracted and verified (%d files)", result.ServiceFiles)
		})
	}
}

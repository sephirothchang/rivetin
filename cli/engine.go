package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

type Bundle struct {
	Version string            `json:"version"`
	Files   map[string]string `json:"files"`
}

func payload() (Bundle, map[string][]byte, error) {
	raw, err := assets.ReadFile("payload/bundle.json")
	if err != nil {
		return Bundle{}, nil, errors.New("PAYLOAD_NOT_BUILT")
	}
	var bundle Bundle
	if json.Unmarshal(raw, &bundle) != nil || bundle.Version != "0.1.0" {
		return bundle, nil, errors.New("BUNDLE_INVALID")
	}
	result := map[string][]byte{}
	for _, name := range []string{"service.tar.gz", "island.tar.gz", "remoteEntry.js"} {
		data, err := assets.ReadFile("payload/" + name)
		if err != nil || digest(data) != bundle.Files[name] {
			return bundle, nil, errors.New("BUNDLE_CHECKSUM_FAILED")
		}
		result[name] = data
	}
	return bundle, result, nil
}
func request(ctx context.Context, r Remote, action, operation string, extra map[string]any) (map[string]json.RawMessage, error) {
	body := map[string]any{"action": action}
	if operation != "" {
		body["operation"] = operation
	}
	for k, v := range extra {
		body[k] = v
	}
	return r.Call(ctx, body)
}
func probeRemote(ctx context.Context, r Remote) (Probe, Profile, error) {
	result, err := request(ctx, r, "probe", "", nil)
	if err != nil {
		return Probe{}, Profile{}, err
	}
	raw, _ := json.Marshal(result)
	var found Probe
	if json.Unmarshal(raw, &found) != nil {
		return found, Profile{}, errors.New("PROBE_INVALID")
	}
	p, err := matchProfile(found)
	return found, p, err
}
func operationID() string {
	b := make([]byte, 16)
	_, err := rand.Read(b)
	if err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func deployment(p Profile, origin, checksum string) ([]byte, error) {
	if !strings.HasPrefix(origin, "https://") || strings.ContainsAny(origin, "\n\r\t\"'") {
		return nil, errors.New("INVALID_ORIGIN")
	}
	meta := func() map[string]any {
		return map[string]any{"name": installationName, "namespace": p.Namespace, "annotations": map[string]string{ownershipAnnotation: installationOwner}}
	}
	code := installationRoot + "/releases/" + checksum
	container := map[string]any{"name": "rivetin", "image": p.Image, "imagePullPolicy": "IfNotPresent", "workingDir": "/opt/rivetin", "command": []string{"node", "server/main.js"},
		"env":   []map[string]string{{"name": "RIVETIN_DATA", "value": "/var/lib/rivetin"}, {"name": "RIVETIN_TOWER_URL", "value": "http://cloudtower-cloudtower.cloudtower-system.svc.cluster.local"}, {"name": "RIVETIN_ORIGINS", "value": origin}},
		"ports": []map[string]int{{"containerPort": 8787}}, "resources": map[string]any{"requests": map[string]string{"cpu": "20m", "memory": "48Mi"}, "limits": map[string]string{"cpu": "500m", "memory": "256Mi"}},
		"securityContext": map[string]any{"runAsUser": 1000, "runAsGroup": 1000, "allowPrivilegeEscalation": false, "readOnlyRootFilesystem": true, "capabilities": map[string]any{"drop": []string{"ALL"}}},
		"readinessProbe":  map[string]any{"httpGet": map[string]any{"path": "/healthz", "port": 8787}}, "livenessProbe": map[string]any{"httpGet": map[string]any{"path": "/healthz", "port": 8787}, "initialDelaySeconds": 10},
		"volumeMounts": []map[string]any{{"name": "code", "mountPath": "/opt/rivetin", "readOnly": true}, {"name": "data", "mountPath": "/var/lib/rivetin"}}}
	ingressPath := func(prefix string) map[string]any {
		return map[string]any{"path": prefix, "pathType": "Prefix", "backend": map[string]any{"service": map[string]any{"name": installationName, "port": map[string]int{"number": 8787}}}}
	}
	items := []map[string]any{
		{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": meta(), "spec": map[string]any{"replicas": 1, "strategy": map[string]string{"type": "Recreate"}, "selector": map[string]any{"matchLabels": map[string]string{"app": "rivetin"}}, "template": map[string]any{"metadata": map[string]any{"labels": map[string]string{"app": "rivetin"}, "annotations": map[string]string{"rivetin/code-sha256": checksum}}, "spec": map[string]any{"automountServiceAccountToken": false, "enableServiceLinks": false, "containers": []any{container}, "volumes": []map[string]any{{"name": "code", "hostPath": map[string]string{"path": code, "type": "Directory"}}, {"name": "data", "hostPath": map[string]string{"path": "/var/cache/appcache/rivetin/data", "type": "Directory"}}}}}}},
		{"apiVersion": "v1", "kind": "Service", "metadata": meta(), "spec": map[string]any{"selector": map[string]string{"app": "rivetin"}, "ports": []map[string]int{{"port": 8787, "targetPort": 8787}}}},
		{"apiVersion": "networking.k8s.io/v1", "kind": "Ingress", "metadata": meta(), "spec": map[string]any{"rules": []any{map[string]any{"http": map[string]any{"paths": []any{ingressPath(ingressPrefix)}}}}, "tls": []map[string]string{{"secretName": "cloudtower-tls"}}}},
	}
	annotations := items[2]["metadata"].(map[string]any)["annotations"].(map[string]string)
	annotations["kubernetes.io/ingress.class"] = "nginx"
	annotations["nginx.ingress.kubernetes.io/proxy-body-size"] = "16m"
	annotations["nginx.ingress.kubernetes.io/proxy-read-timeout"] = "15"
	annotations["nginx.ingress.kubernetes.io/force-ssl-redirect"] = "true"
	return json.Marshal(map[string]any{"apiVersion": "v1", "kind": "List", "items": items})
}

type Engine struct {
	Remote         Remote
	Tower          *Tower
	Progress       func(string)
	ReadbackWait   readbackWait
	PluginID       string
	PluginPackage  []byte
	ChannelProfile []byte
	ChannelHostID  string
}

const verificationBudget = 5 * time.Minute

var readbackVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})\.(0|[1-9][0-9]{0,7})$`)

var readbackCodes = map[string]bool{
	"AUTHENTICATION_REQUIRED": true, "ADMIN_REQUIRED": true, "ADMIN_OR_ORIGIN_REQUIRED": true,
	"REQUEST_FAILED": true, "DATA_UNAVAILABLE": true, "STORE_BUSY": true,
	"NOT_FOUND": true, "METHOD_NOT_ALLOWED": true, "FRAMEWORK_NOT_INITIALIZED": true,
	"TOWER_ADMIN_REQUIRED": true, "UNAUTHENTICATED": true, "FORBIDDEN": true,
	"TOWER_CONNECTION_OR_CERTIFICATE_FAILED": true, "TLS_CERT_PIN_MISMATCH": true,
	"TLS_CERT_VALIDITY_INVALID": true, "TOWER_RESPONSE_LIMIT": true,
}

type readbackWait func(context.Context, time.Duration) error

func waitReadback(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func verifyRuntimeReadback(ctx context.Context, api *Tower, expectedVersion string, progress func(string), wait readbackWait) error {
	readCtx, cancel := context.WithTimeout(ctx, verificationBudget)
	defer cancel()
	if wait == nil {
		wait = waitReadback
	}
	delays := [...]time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second}
	for attempt := 1; attempt <= 24; attempt++ {
		if err := readCtx.Err(); err != nil {
			return err
		}
		data, status, err := api.frameworkRequest(readCtx, "GET", "/runtime", "", nil)
		fields := []string{fmt.Sprintf("BACKEND_READBACK attempt=%d httpStatus=%d", attempt, status)}
		var state struct {
			Initialized *bool  `json:"initialized"`
			Enabled     *bool  `json:"enabled"`
			Version     string `json:"version"`
			Error       string `json:"error"`
		}
		validJSON := err == nil && json.Unmarshal(data, &state) == nil
		if validJSON {
			if state.Initialized != nil {
				fields = append(fields, fmt.Sprintf("initialized=%t", *state.Initialized))
			}
			if state.Enabled != nil {
				fields = append(fields, fmt.Sprintf("enabled=%t", *state.Enabled))
			}
			if readbackVersion.MatchString(state.Version) {
				fields = append(fields, "version="+state.Version)
			}
			if state.Error != "" {
				code := "UNRECOGNIZED_RUNTIME_ERROR"
				if readbackCodes[state.Error] {
					code = state.Error
				}
				fields = append(fields, "error="+code)
			}
		} else if err == nil {
			fields = append(fields, "error=INVALID_RUNTIME_JSON")
		} else {
			code := "READBACK_TRANSPORT_FAILED"
			if readbackCodes[err.Error()] {
				code = err.Error()
			}
			fields = append(fields, "error="+code)
		}
		if progress != nil {
			progress(strings.Join(fields, " "))
		}
		if err != nil {
			if readCtx.Err() != nil {
				return readCtx.Err()
			}
			return err
		}
		if status == 200 && validJSON && state.Error == "" && state.Initialized != nil && *state.Initialized && state.Enabled != nil && !*state.Enabled && state.Version == expectedVersion {
			return nil
		}
		if validJSON && (state.Error == "AUTHENTICATION_REQUIRED" || state.Error == "ADMIN_REQUIRED" || state.Error == "ADMIN_OR_ORIGIN_REQUIRED" || state.Error == "TOWER_ADMIN_REQUIRED" || state.Error == "UNAUTHENTICATED" || state.Error == "FORBIDDEN") {
			return errors.New("BACKEND_READBACK_FAILED")
		}
		// A ready Pod can precede Ingress endpoint propagation. Only transient
		// gateway statuses may retry; auth and successful-but-invalid states fail immediately.
		if (status != 502 && status != 503 && status != 504) || attempt == 24 {
			return errors.New("BACKEND_READBACK_FAILED")
		}
		delay := 15 * time.Second
		if attempt <= len(delays) {
			delay = delays[attempt-1]
		}
		deadline, _ := readCtx.Deadline()
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return context.DeadlineExceeded
		}
		if delay > remaining {
			delay = remaining
		}
		if err := wait(readCtx, delay); err != nil {
			return err
		}
	}
	return errors.New("BACKEND_READBACK_FAILED")
}

func (e Engine) say(s string) {
	if e.Progress != nil {
		e.Progress(s)
	}
}
func (e Engine) Run(ctx context.Context, mode, user, password, operation string) error {
	if mode == "disable" {
		result, err := request(ctx, e.Remote, "disable", "", nil)
		if err == nil {
			e.say("COMPLETE plugins remain disabled; data and backups retained")
			if string(result["auditRecorded"]) == "false" {
				e.say("WARNING audit record unavailable")
			}
		}
		return err
	}
	found, p, err := probeRemote(ctx, e.Remote)
	if mode == "detect" || mode == "status" || mode == "plan" {
		if err != nil && err.Error() != "UNTESTED_TOWER_BUILD" {
			return err
		}
		e.say("DETECTED " + found.Image + " " + found.Node)
		e.say(fmt.Sprintf("SUPPORTED %t", err == nil))
		e.say(fmt.Sprintf("installed=%t managed=%t pending=%s", found.Installed, found.Managed, found.Pending))
		return nil
	}
	if err != nil {
		return err
	}
	a, err := adapter(p)
	if err != nil {
		return err
	}
	e.say("PROFILE " + p.ID)
	if mode == "reset-config" {
		operation = operationID()
		e.say("OPERATION " + operation)
		if _, err := request(ctx, e.Remote, "reset-config", operation, nil); err != nil {
			if ctx.Err() != nil || strings.Contains(err.Error(), "OUTCOME_UNKNOWN") {
				return errors.New("RESET_CONFIG_OUTCOME_UNKNOWN")
			}
			return err
		}
		e.say("CONFIG_RESET configuration archived; fresh install required")
		return nil
	}
	bundle, data, err := payload()
	if err != nil {
		return err
	}
	_ = bundle
	if e.Tower == nil {
		return errors.New("TOWER_REQUIRED")
	}
	if err = a.Login(ctx, e.Tower, user, password); err != nil {
		return err
	}
	if strings.HasPrefix(mode, "plugin.") {
		return RunPluginAction(ctx, e.Tower, strings.TrimPrefix(mode, "plugin."), e.PluginID, e.PluginPackage, e.Progress)
	}
	if strings.HasPrefix(mode, "channel.") {
		return RunChannelAction(ctx, e.Tower, strings.TrimPrefix(mode, "channel."), e.ChannelHostID, e.ChannelProfile, e.Progress)
	}
	if mode == "enable" {
		if _, status, err := e.Tower.frameworkRequest(ctx, "POST", "/enable", "", nil); err != nil {
			return err
		} else if status != 200 {
			return errors.New("FRAMEWORK_ENABLE_FAILED")
		}
		data, status, err := e.Tower.frameworkRequest(ctx, "GET", "/runtime", "", nil)
		if err != nil {
			return err
		}
		var state struct {
			Initialized *bool  `json:"initialized"`
			Enabled     *bool  `json:"enabled"`
			Version     string `json:"version"`
			Error       string `json:"error"`
		}
		if status != 200 || json.Unmarshal(data, &state) != nil || state.Initialized == nil || !*state.Initialized || state.Enabled == nil || !*state.Enabled || state.Version != bundle.Version || state.Error != "" {
			return errors.New("FRAMEWORK_ENABLE_READBACK_FAILED")
		}
		e.say("FRAMEWORK_ENABLED runtime verified")
		return nil
	}
	if mode == "recover" {
		backup, err := request(ctx, e.Remote, "backup", operation, nil)
		if err != nil {
			return err
		}
		var recoveryMode string
		_ = json.Unmarshal(backup["mode"], &recoveryMode)
		if recoveryMode != "install" && recoveryMode != "update" && recoveryMode != "uninstall" {
			return errors.New("BACKUP_INVALID")
		}
		var encoded string
		if json.Unmarshal(backup["islandBackup"], &encoded) != nil {
			return errors.New("BACKUP_INVALID")
		}
		old, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return errors.New("BACKUP_INVALID")
		}
		if len(old) > 0 {
			err = a.Register(ctx, e.Tower, old)
		} else {
			err = a.Remove(ctx, e.Tower)
		}
		if err != nil {
			return err
		}
		_, err = request(ctx, e.Remote, "rollback", operation, nil)
		return err
	}
	if mode != "install" && mode != "update" && mode != "uninstall" {
		return errors.New("UNKNOWN_COMMAND")
	}
	if found.Pending != "" {
		return errors.New("INSTALLER_RECOVERY_REQUIRED")
	}
	if found.Installed && !found.Managed {
		return errors.New("EXISTING_INSTALLATION_UNMANAGED")
	}
	if mode == "install" && found.Installed {
		return errors.New("ALREADY_INSTALLED_USE_UPDATE")
	}
	if mode != "install" && !found.Installed {
		return errors.New("FRAMEWORK_NOT_INSTALLED")
	}
	old, err := a.Backup(ctx, e.Tower)
	if err != nil {
		return err
	}
	if !found.Installed && len(old) > 0 {
		return errors.New("EXISTING_ISLAND_UNMANAGED")
	}
	operation = operationID()
	e.say("OPERATION " + operation)
	// Preparation, Pod rollout and external readiness share one verification
	// budget. SSH commands retain the outer context so timeout recovery stays certain.
	verificationCtx, cancelVerification := context.WithTimeout(ctx, verificationBudget)
	defer cancelVerification()
	_, err = request(ctx, e.Remote, "prepare", operation, map[string]any{"mode": mode, "islandBackup": base64.StdEncoding.EncodeToString(old)})
	if err != nil {
		return fmt.Errorf("%w; recover operation %s if pending", err, operation)
	}
	rollback := func(cause error) error {
		// Unknown transport outcomes require explicit recovery after checking the journal.
		if strings.Contains(cause.Error(), "OUTCOME_UNKNOWN") || ctx.Err() != nil {
			return fmt.Errorf("%w; recovery required: %s", cause, operation)
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), recoveryTimeout)
		defer cancel()
		if len(old) > 0 {
			err = a.Register(recoveryCtx, e.Tower, old)
		} else {
			err = a.Remove(recoveryCtx, e.Tower)
		}
		if err == nil {
			_, err = request(recoveryCtx, e.Remote, "rollback", operation, nil)
		}
		if err != nil {
			return fmt.Errorf("%w; ROLLBACK_INCOMPLETE operation %s", cause, operation)
		}
		return fmt.Errorf("%w; ROLLED_BACK_PLUGINS_DISABLED", cause)
	}
	if mode == "uninstall" {
		if err = a.Remove(ctx, e.Tower); err != nil {
			return rollback(err)
		}
		if _, err = request(ctx, e.Remote, "remove", operation, nil); err != nil {
			return rollback(err)
		}
	} else {
		if err := verificationCtx.Err(); err != nil {
			return rollback(err)
		}
		manifest, err := deployment(p, e.Tower.base, digest(data["service.tar.gz"]))
		if err != nil {
			return rollback(err)
		}
		if _, err = request(ctx, e.Remote, "apply", operation, map[string]any{"mode": mode, "service": base64.StdEncoding.EncodeToString(data["service.tar.gz"]), "serviceSHA256": digest(data["service.tar.gz"]), "manifest": base64.StdEncoding.EncodeToString(manifest)}); err != nil {
			return rollback(err)
		}
		if err := verificationCtx.Err(); err != nil {
			return rollback(err)
		}
		if err = a.Register(verificationCtx, e.Tower, data["island.tar.gz"]); err != nil {
			return rollback(err)
		}
		if err = a.Verify(verificationCtx, e.Tower, data["remoteEntry.js"]); err != nil {
			return rollback(err)
		}
		if err := verifyRuntimeReadback(verificationCtx, e.Tower, bundle.Version, e.say, e.ReadbackWait); err != nil {
			return rollback(err)
		}
	}
	_, err = request(ctx, e.Remote, "commit", operation, nil)
	if err != nil {
		return fmt.Errorf("COMMIT_UNCONFIRMED; recovery operation %s", operation)
	}
	e.say("COMPLETE plugins remain disabled; data and backups retained")
	return nil
}

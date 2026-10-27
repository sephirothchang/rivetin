package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
)

func readHostProfile(file string) ([]byte, error) {
	info, err := os.Lstat(file)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 60*1024 {
		return nil, errors.New("SSH_PROFILE_INVALID")
	}
	f, err := os.Open(file)
	if err != nil {
		return nil, errors.New("SSH_PROFILE_INVALID")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 60*1024+1))
	if err != nil || len(raw) > 60*1024 || !json.Valid(raw) {
		clear(raw)
		return nil, errors.New("SSH_PROFILE_INVALID")
	}
	var profile map[string]json.RawMessage
	if json.Unmarshal(raw, &profile) != nil || profile == nil {
		clear(raw)
		return nil, errors.New("SSH_PROFILE_INVALID")
	}
	return raw, nil
}

func RunChannelAction(ctx context.Context, api *Tower, action, hostID string, profile []byte, progress func(string)) error {
	if api == nil || api.token == "" {
		return errors.New("TOWER_AUTHENTICATION_REQUIRED")
	}
	route, method := "/ssh-channel", "GET"
	var body []byte
	if action == "import-host" {
		if len(profile) == 0 || !json.Valid(profile) {
			return errors.New("SSH_PROFILE_INVALID")
		}
		body, _ = json.Marshal(map[string]any{"action": "put", "profile": json.RawMessage(profile)})
		defer clear(body)
		route, method = "/ssh-channel/hosts", "POST"
	} else if action == "remove-host" {
		if len(hostID) == 0 || len(hostID) > 128 || !channelHostID.MatchString(hostID) {
			return errors.New("SSH_HOST_INVALID")
		}
		body, _ = json.Marshal(map[string]string{"action": "remove", "hostId": hostID})
		route, method = "/ssh-channel/hosts", "POST"
	} else if action != "status" {
		return errors.New("SSH_CHANNEL_ACTION_INVALID")
	}
	data, status, err := api.frameworkRequest(ctx, method, route, "application/json", body)
	if err != nil {
		return errors.New("SSH_CHANNEL_REQUEST_FAILED")
	}
	if status != 200 {
		return errors.New("SSH_CHANNEL_REQUEST_REJECTED")
	}
	if !json.Valid(data) {
		return errors.New("SSH_CHANNEL_READBACK_INVALID")
	}
	var result struct {
		Enabled        bool              `json:"enabled"`
		TransportReady bool              `json:"transportReady"`
		Saved          bool              `json:"saved"`
		Removed        bool              `json:"removed"`
		HostID         string            `json:"hostId"`
		Hosts          []json.RawMessage `json:"hosts"`
		Registrations  []json.RawMessage `json:"registrations"`
	}
	if json.Unmarshal(data, &result) != nil || action == "import-host" && !result.Saved || action == "remove-host" && !result.Removed {
		return errors.New("SSH_CHANNEL_READBACK_INVALID")
	}
	if action == "import-host" {
		var expected struct {
			HostID string `json:"hostId"`
		}
		if json.Unmarshal(profile, &expected) != nil || !channelHostID.MatchString(expected.HostID) || result.HostID != expected.HostID {
			return errors.New("SSH_CHANNEL_READBACK_INVALID")
		}
	}
	if action == "remove-host" && result.HostID != hostID {
		return errors.New("SSH_CHANNEL_READBACK_INVALID")
	}
	if progress != nil {
		if action == "status" {
			progress("SSH_CHANNEL_STATUS enabled=" + boolString(result.Enabled) + " transportReady=" + boolString(result.TransportReady))
		} else {
			progress("SSH_CHANNEL_COMPLETE " + action + "; approvals revoked; no host connection was initiated")
		}
	}
	return nil
}

func boolString(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

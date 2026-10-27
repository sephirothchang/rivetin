package main

import "embed"

// Release inputs are generated from explicit source allowlists, never the workspace.
//
//go:embed payload/* remote.py profiles.json
var assets embed.FS

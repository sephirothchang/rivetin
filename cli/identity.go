package main

import "context"

const productName = "Rivetin"
const pluginAPIPrefix = "/api/rivetin/v1"
const installationName = "rivetin"
const installationOwner = "rivetin-cli-v1"
const installationRoot = "/var/cache/appcache/rivetin"
const ownershipAnnotation = "rivetin/managed-by"
const checksumAnnotation = "rivetin/code-sha256"
const ingressPrefix = "/api/rivetin/"

// A request is sent exactly once; an unknown write outcome must not be retried.
func (t *Tower) frameworkRequest(ctx context.Context, method, route, contentType string, body []byte) ([]byte, int, error) {
	return t.request(ctx, method, pluginAPIPrefix+route, contentType, body)
}

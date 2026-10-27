package main

import (
	"context"
	"strings"
	"testing"
)

func TestMigrationUsesExplicitOwnershipActionWithoutDeploying(t *testing.T) {
	r, f, api := fixture(t)
	r.probe.Installed = true
	f.old = []byte{31, 139, 1}
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "migrate", "EXAMPLE_ADMIN", "EXAMPLE_PASSWORD", ""); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,migrate,probe" {
		t.Fatal(r.calls)
	}
	for _, event := range f.events {
		if strings.HasPrefix(event, "DELETE ") || event == "POST /api/island-registry/sea-maps" {
			t.Fatal("migration changed Island", f.events)
		}
	}
}
func TestMigrationRequiresExistingIslandAndInstalledBackend(t *testing.T) {
	r, _, api := fixture(t)
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "migrate", "", "", ""); err == nil || err.Error() != "FRAMEWORK_NOT_INSTALLED" {
		t.Fatal(err)
	}
	r.probe.Installed = true
	r.calls = nil
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "migrate", "", "", ""); err == nil || err.Error() != "MIGRATION_ISLAND_INVALID" {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe" {
		t.Fatal(r.calls)
	}
}
func TestMigrationFailureDoesNotBlindlyRewriteIslandOrResources(t *testing.T) {
	r, f, api := fixture(t)
	r.probe.Installed = true
	r.fail = "migrate"
	f.old = []byte{31, 139, 1}
	err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "migrate", "", "", "")
	if err == nil || !strings.Contains(err.Error(), "recovery operation") {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,migrate" {
		t.Fatal(r.calls)
	}
	for _, event := range f.events {
		if strings.HasPrefix(event, "DELETE ") || event == "POST /api/island-registry/sea-maps" {
			t.Fatal(f.events)
		}
	}
}
func TestMigrationRecoveryOnlyRestoresOwnershipMetadata(t *testing.T) {
	r, f, api := fixture(t)
	r.recoveryMode = "migrate"
	if err := (Engine{Remote: r, Tower: api}).Run(context.Background(), "recover", "", "", strings.Repeat("a", 32)); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.calls, ",") != "probe,backup,rollback" {
		t.Fatal(r.calls)
	}
	for _, event := range f.events {
		if event != "POST /api" {
			t.Fatal("migration recovery made native Island request", f.events)
		}
	}
}

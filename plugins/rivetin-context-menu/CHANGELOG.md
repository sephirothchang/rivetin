# Changelog

## 0.5.9

### fix

- Accept a sidebar reset only from its single exact native hash edge while still in the reset phase. URL-less history notifications cannot establish ownership; queued external and duplicate edges cancel before row selection.
- Preserve the read-only sidebar rebuild and visible failure diagnostic from the rejected 0.5.8 candidate without restoring retired controls or relaxing source/generation checks.

### Validation boundary

Independent review rejected the fixed, undeployed 0.5.8 candidate because its current-URL reset exemption could consume queued external navigation evidence. Source and exact 0.5.8 bundle regressions reproduce continued fresh-A selection after B/reset and B/A/reset events; they do not demonstrate a wrong-object click. Version 0.5.9 is a separate package: 854 source tests with bounded concurrency, exact production-bundle regressions and local browser checks passed. Independent review covered the scoped source, fixed bytes and existing owner evidence; it was not a full security audit or an independent dynamic test run.

On 2026-10-29, the same fixed 0.5.9 package passed targeted live checks on CloudTower 4.9.0 with framework 0.2.2: a fresh global-list context menu, A's native CPU editor open/cancel, B's identity-only navigation, and a newly opened exact A CPU editor after returning to A. Memory/disk/NIC open/cancel and keyboard/Esc/Shift/current 1280×720 bounds also passed. No fields or business settings were submitted. Post-UI protection checks passed and the execution window closed; issue CTX-B-Life-Mid-020 is resolved within this targeted scope.

Live queued-event injection, business saves/task completion, other languages/viewports, independent lifecycle switching and the full host matrix remain unverified. The session recorded 45 host shared-module warnings and zero console errors; an audit-mirror permission denial was retained rather than counted as success. Earlier failures and rejected artifacts remain unchanged. The 166781-byte package SHA-256 remains `bd33fce9ab2c664f8612cb873b4391fb53038c09cfd8bcfb40f9de141556f8ee`; this validation update does not rebuild it.

## 0.5.8

### fix

- Rebuild a retired VM sidebar through its verified read-only list route and exact source row. Wait for every old pane to unmount before selecting the row again; never restore retired DOM eligibility.
- Preserve route generations, source identity, disabled checks and retirement across providers/bundle reloads. Reject unknown or duplicate queries, external navigation, retained panes and moved retired controls.
- Show a dismissible plugin-owned diagnostic when a native handoff fails after the context menu closes. Remove it after 30 seconds or plugin cleanup.

### Validation boundary

The exact 0.5.7 production bundle reproduces the retained-sidebar A/B/A failure locally. In the real framework 0.2.2 environment, 0.5.7 passed the first global-list context menu and four native editor open/cancel checks, then failed to reopen the CPU editor after A/B/A. Those results remain distinct. Version 0.5.8 requires its own local candidate evidence, independent review and coordinated real-environment testing; no business submission is claimed.

## 0.5.7

### fix

- Recognize plain resource rows on the known global VM, host, VM-volume and physical-disk list routes with one optional trailing slash. Preserve existing query interpretation and all object-identity, retirement and disabled-state gates.
- Add regression cases for split header/body tables without resource anchors, query-bearing lists, malformed row IDs and unsupported route variants.

### Validation boundary

The fixed 0.5.6 package passed local review but failed its first live global VM-list context-menu check at `#/vms/`; no editor or business action was executed, and the package was safely disabled. Version 0.5.7 is a new candidate requiring new fixed artifacts, regression review and a new coordinated live window. The previous lifecycle window is closed and cannot be reused.

## 0.5.6

### fix

- Share document-scoped DOM retirement between VM entry providers and resource-row adapters. Include external list action controls, popup roots, menu leaves and their ancestors so moved or relabelled stale nodes cannot regain trust.
- Keep the plugin-owned document retirement state across repeated execution of its bundle on the same page; module re-evaluation cannot restore a retired callback.
- Check retirement before row-menu preparation, submenu hover, leaf execution and cleanup. Preserve fresh verified rows and normal same-object hidden-menu reopening.
- Reject disabled classes consistently for native editors, toolbar openers, Details tabs and cleanup, including inherited `ant-dropdown-disabled` and `ant-btn-disabled`.

### Validation boundary

The 0.5.5 source candidate did not pass independent review: local DOM regressions reproduced stale row callbacks and incomplete disabled-class checks. It was not frozen as a release package. Version 0.5.6 has a fixed local package with independent source and compiled-bundle review, 781 source tests, 21 compiled factory scenarios, the NIC/configuration-poll regression and in-app-browser mock checks. Retained retired DOM remains rejected; recovery with a new document was observed locally. Coordinated live acceptance is pending; local tests do not establish real CloudTower behavior or business task completion.

## 0.5.5

### fix

- Quarantine native panes, identity titles and action controls retained across resource-context navigation. Rebinding a same-name header after A-B-A navigation cannot restore stale handler ownership.
- Keep retired controls blocked when moved into a new pane or accompanied by a matching public resource ID. Fresh verified native pane and control nodes remain eligible.
- Retain DOM retirement across provider recreation, plugin reactivation and simultaneous providers. Quarantine initial panels without an exact public resource identity and provide a specific reopen-details diagnostic.
- Recheck row triggers before click, reject retired ancestors of rebuilt menu titles, and verify ownership and availability before popup cleanup.
- Preserve same-resource refresh notifications and the plugin-owned navigation path while invalidating earlier read proofs.

### compatibility

- Adopt compatibility schema 2, framework API 1, framework versions >=0.2.0 and <0.3.0, and CloudTower 4.9.0. No direct SMTX service dependency is declared.
- The 0.5.4 metadata-only candidate is superseded without altering its frozen bytes. This version includes the native ownership fix and requires independent framework-0.2 live acceptance.

## 0.5.3

### fix

- Recognize CloudTower native hidden submenu classes even when their portal wrapper retains a zero-height layout rectangle. A closed submenu shell no longer blocks preparation or later menus.
- Keep the 0.5.2 hover, configuration-poll and in-flight cancellation protections.

### Validation boundary

Version 0.5.2 live VDS testing established that hover opens and closes the native submenu, but its retained hidden wrapper prevented complete preparation. Version 0.5.3 completed scoped live acceptance on CloudTower 4.9.0 with framework 0.1.5: 11 resource table menus (39 root entries and 2 distributed-switch children) matched native labels and disabled state; 11 VM native dialogs opened and were cancelled; a placement-group menu remained visible across configuration polling. No business task completion, console connection, power change, migration execution or snapshot modification is claimed. Other roles, languages and workload states remain outside this acceptance.

## 0.5.2

### fix

- Keep prepared and visible resource menus open when shared configuration polling returns unchanged effective settings. Actual configuration changes still invalidate their action proof, including a selected action waiting for its native menu to reopen.
- Adapt observed native hover submenus through their public opener events while keeping exact object, path, disabled state and popup ownership checks. Never dispatch these events to a business leaf.

### Validation boundary

Version 0.5.1 live acceptance passed 11 safe VM dialog open/cancel checks and matched menu metadata for ten resource types. Distributed-switch submenu preparation and polling-related menu stability prevented full acceptance. The 0.5.2 correction requires independent live acceptance; no business task execution is claimed.

## 0.5.1

### fix

- Recognize the exact legacy More image icon used by physical-NIC rows, alongside the existing SVG icon adapter. Keep exact row identity, action-cell ownership, unique trigger and conflicting-label checks. Do not match asset URLs or arbitrary images.
- Reject native More controls borrowed from nested table rows and loading or disabled controls. Recheck unique trigger identity, including disabled duplicates, before executing a prepared menu path.
- Preserve the 0.5.0 diagnostic reason codes and cleanup behavior.

### Validation boundary

Version 0.5.0 live acceptance found the legacy NIC icon incompatibility; it did not pass full UI acceptance. The 0.5.1 fix requires a new package and independent live acceptance. No business task completion is claimed.

## 0.5.0

### feat

- Add cascading native row actions for hosts, physical disks, physical NICs, VM groups, VM placement groups, virtual volumes, VM networks, system networks, VM snapshots, snapshot plans and distributed switches.
- Read each object's actual native menu inventory, including nested groups, disabled state and danger styling. Reopen and revalidate the exact row and menu path before handing a chosen action to CloudTower.
- Extend VM shortcuts to 45 native entries: hardware editors, HA, placement, autostart, ownership, guest settings, console, native power entries, clone, migration, snapshots, network tools, group management, recycle and native detail tabs.
- Keep snapshot operations bound to snapshot IDs. Snapshot tables inside a VM drawer no longer inherit the outer VM list type; internal disk and NIC cards retain their parent VM identity.
- Expand resource-type settings to 15 types with Chinese and English labels. Existing saved selections remain unchanged; newly added types can be enabled explicitly.
- Add local demo pages for all newly supported resource types. Demo host controls remain simulated and never connect to a live CloudTower.

### fix

- Replace unfinished-binding fallback text with fixed Chinese and English diagnostic codes and recovery steps. Distinguish stale resource verification, native disabled or missing entries, unproven popups, timeouts and expired console activation without exposing raw exceptions or guessing permission failures.
- Reject unrelated native portals, conflicting ARIA ownership and duplicate or changed menu paths.
- Clean up proven native popups after cancellation or missing entry lookup; release sessions when the host replaces a boundary or removes a plugin menu.
- Fall back to normal positioning when the browser cancels a popover opening.

### Validation boundary

This release adds frontend entry adapters, not resource-write APIs or custom business forms. A native action handoff is distinct from opening a verified dialog and from a completed task. CloudTower owns permissions, fields, confirmation and task outcomes. Local tests and demo validation do not establish live compatibility for every role, VM state, hardware option or language. Version 0.5.0 live acceptance opened and cancelled 11 safe VM dialogs and compared host and physical-disk menus. Physical-NIC recognition failed on a legacy image trigger; full UI acceptance did not pass.

## 0.4.2

- Replace in-menu group navigation with sideways cascading submenus, viewport avoidance, layered keyboard navigation and independent scrolling.
- Retain direct native VM, disk and NIC editors, migration wizard and snapshot-page navigation from 0.4.1.
- Complete controlled CloudTower 4.9.0 deployment and open/cancel acceptance for the tested 0.4.2 entries. This does not establish business-task completion or validation of later releases.

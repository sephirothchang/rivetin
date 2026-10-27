"""Controlled legacy migration contracts, using only local files and fake Kubernetes."""
import base64
import copy
import hashlib
import json
from unittest.mock import patch
import unittest

try:
    from . import test_remote as fixtures
except ImportError:
    import test_remote as fixtures
remote, archive, manifest, KubernetesFixture = fixtures.remote, fixtures.archive, fixtures.manifest, fixtures.KubernetesFixture


class LegacyKubernetes(KubernetesFixture):
    def __init__(self):
        super().__init__()
        self.patch_count = 0
        self.fail_patch = None
        self.block_rollback = False

    def __call__(self, *args, **kwargs):
        if args[0] != 'patch':
            return super().__call__(*args, **kwargs)
        self.calls.append((args, kwargs))
        self.patch_count += 1
        if self.patch_count == self.fail_patch:
            raise RuntimeError('KUBERNETES_COMMAND_FAILED')
        item = self.items[args[1]]
        operations = json.loads(args[args.index('-p') + 1])
        if self.block_rollback and operations[-1]['op'] == 'remove':
            raise RuntimeError('KUBERNETES_COMMAND_FAILED')
        for op in operations[:2]:
            key = op['path'].split('/')[-1]
            if item['metadata'][key] != op['value']:
                raise RuntimeError('KUBERNETES_COMMAND_FAILED')
        if operations[-1]['op'] == 'add':
            item['metadata']['annotations']['pluginkit/managed-by'] = remote.OWNER
        else:
            del item['metadata']['annotations']['pluginkit/managed-by']
        item['metadata']['resourceVersion'] = str(int(item['metadata']['resourceVersion']) + 1)
        return json.dumps(item).encode()


class MigrationTests(unittest.TestCase):
    def setUp(self):
        fixtures.RemoteTests.setUp(self)
        self.kube = LegacyKubernetes()
        patch.object(remote, 'kube', self.kube).start()
        desired = manifest('0.1.0')
        desired['items'][0]['spec']['template']['metadata']['annotations']['pluginkit/code-sha256'] = 'a' * 64
        for index, item in enumerate(desired['items']):
            item['metadata']['annotations'].pop('pluginkit/managed-by')
            applied = copy.deepcopy(item)
            item['metadata'].update(uid='EXAMPLE-UID-' + str(index), resourceVersion='10')
            item['metadata']['annotations']['kubectl.kubernetes.io/last-applied-configuration'] = json.dumps(applied)
            self.kube.items[item['kind'].lower()] = item
        self.before = copy.deepcopy(self.kube.items)
        self.code = self.base / 'releases' / '0.1.0'
        hashes = {}
        for name in remote.LEGACY_SOURCE_SHA256:
            path = self.code / name
            path.parent.mkdir(parents=True, exist_ok=True)
            content = ('EXAMPLE_LEGACY_' + name).encode()
            path.write_bytes(content)
            hashes[name] = hashlib.sha256(content).hexdigest()
        patch.object(remote, 'LEGACY_SOURCE_SHA256', hashes).start()
        framework = self.base / 'data' / 'framework'
        framework.mkdir(parents=True)
        (framework / 'settings.json').write_text('{"version":"0.1.0","apiVersion":1}')
        self.config = self.base / 'data' / 'plugins' / 'pluginkit-example' / 'config.json'
        self.config.parent.mkdir(parents=True)
        self.config.write_bytes(b'{"settings":{"enabled":true},"revision":7}\n')
        self.island = archive([('sea-map.json', json.dumps({'name': 'pluginkit', 'metadata': {'info': {'version': '0.1.0'}},
            'data': [{'region': 'PERMANENT_CLUSTER_MANAGER_MODAL', 'island': './PluginKit', 'order': 100}]}).encode()),
            ('build.tar.gz', b'EXAMPLE_BUILD_ARCHIVE')])

    def migrate(self):
        return remote.handle({'action': 'migrate', 'operation': self.op,
            'islandBackup': base64.b64encode(self.island).decode(), 'origin': 'https://tower.example.invalid'})

    def assert_original_resources(self):
        for kind, item in self.kube.items.items():
            self.assertEqual(item['spec'], self.before[kind]['spec'])
            self.assertEqual(item['metadata']['uid'], self.before[kind]['metadata']['uid'])
            self.assertEqual(item['metadata']['annotations'], self.before[kind]['metadata']['annotations'])

    def test_migration_backs_up_and_changes_only_ownership_metadata(self):
        before = self.config.read_bytes()
        result = self.migrate()
        self.assertTrue(result['managed'])
        self.assertTrue(remote.owner_marker())
        self.assertFalse(remote.pending())
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse((self.base / 'data/framework/disabled.json').exists())
        self.assertEqual(self.kube.patch_count, 3)
        self.assertFalse(self.kube.writes)
        for kind, item in self.kube.items.items():
            self.assertEqual(item['spec'], self.before[kind]['spec'])
            self.assertEqual(item['metadata']['uid'], self.before[kind]['metadata']['uid'])
        backup = self.base / 'backups' / self.op
        for name in ['resources.json', 'data.tar.gz', 'legacy-code.tar.gz', 'island.tar.gz', 'state.json']:
            self.assertTrue((backup / name).is_file())
        self.assertEqual((backup / 'island.tar.gz').read_bytes(), self.island)
        self.assertEqual(json.loads((backup / 'state.json').read_text())['phase'], 'migrated')

    def test_disabled_state_is_preserved(self):
        marker = self.base / 'data/framework/disabled.json'
        marker.write_bytes(b'{"disabledAt":"EXAMPLE_TIME","actor":"EXAMPLE_ADMIN"}\n')
        before = marker.read_bytes()
        self.migrate()
        self.assertEqual(marker.read_bytes(), before)

    def test_known_defaults_are_accepted_but_changed_defaults_rejected(self):
        deployment = self.kube.items['deployment']['spec']
        deployment.update(progressDeadlineSeconds=600, revisionHistoryLimit=10)
        deployment['template']['metadata']['creationTimestamp'] = None
        deployment['template']['spec'].update(dnsPolicy='ClusterFirst', restartPolicy='Always', schedulerName='default-scheduler', securityContext={}, terminationGracePeriodSeconds=30)
        container = deployment['template']['spec']['containers'][0]
        container.update(terminationMessagePath='/dev/termination-log', terminationMessagePolicy='File')
        container['ports'][0]['protocol'] = 'TCP'
        for key in ['livenessProbe', 'readinessProbe']:
            container[key].update(failureThreshold=3, periodSeconds=10, successThreshold=1, timeoutSeconds=1)
            container[key]['httpGet']['scheme'] = 'HTTP'
        service = self.kube.items['service']['spec']
        service.update(clusterIP='192.0.2.10', clusterIPs=['192.0.2.10'], sessionAffinity='None', type='ClusterIP')
        service['ports'][0]['protocol'] = 'TCP'
        remote.validate_legacy_resources(list(self.kube.items.values()), 'https://tower.example.invalid')
        container['terminationMessagePolicy'] = 'FallbackToLogsOnError'
        with self.assertRaisesRegex(RuntimeError, 'LEGACY_RESOURCE_MISMATCH'):
            self.migrate()
        self.assertFalse((self.base / 'backups').exists())
        self.assertEqual(self.kube.patch_count, 0)

    def test_code_hash_or_unknown_file_rejected_before_mutation(self):
        path = self.code / 'server/main.js'
        before = path.read_bytes()
        path.write_bytes(b'EXAMPLE_TAMPERED_CODE')
        with self.assertRaisesRegex(RuntimeError, 'LEGACY_SOURCE_MISMATCH'):
            self.migrate()
        path.write_bytes(before)
        (self.code / 'server/extra.js').write_bytes(b'EXAMPLE_EXTRA_CODE')
        with self.assertRaisesRegex(RuntimeError, 'LEGACY_SOURCE_MISMATCH'):
            self.migrate()
        self.assertEqual(self.kube.patch_count, 0)
        self.assertFalse(remote.pending())

    def test_other_origin_extra_route_and_privilege_refused(self):
        for field in ['origin', 'route', 'privilege']:
            with self.subTest(field=field):
                self.kube.items = copy.deepcopy(self.before)
                if field == 'origin':
                    self.kube.items['deployment']['spec']['template']['spec']['containers'][0]['env'][-1]['value'] = 'https://other.example.invalid'
                elif field == 'route':
                    self.kube.items['ingress']['spec']['rules'][0]['http']['paths'][0]['path'] = '/'
                else:
                    self.kube.items['deployment']['spec']['template']['spec']['hostNetwork'] = True
                with self.assertRaises(RuntimeError):
                    self.migrate()
                self.assertEqual(self.kube.patch_count, 0)
                self.assertFalse(remote.pending())

    def test_wrong_island_missing_sources_and_pending_refused(self):
        old = self.island
        self.island = archive([('sea-map.json', b'{"name":"official-component"}'), ('build.tar.gz', b'EXAMPLE')])
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_ISLAND_INVALID'):
            self.migrate()
        self.island = old
        self.code.rename(self.code.parent / 'EXAMPLE_OLD_CODE')
        with self.assertRaisesRegex(RuntimeError, 'LEGACY_SOURCE_MISMATCH'):
            self.migrate()
        self.assertEqual(self.kube.patch_count, 0)
        lock = self.base / 'installer-lock'
        lock.mkdir()
        (lock / 'operation').write_text('b' * 32)
        with self.assertRaisesRegex(RuntimeError, 'INSTALLER_RECOVERY_REQUIRED'):
            self.migrate()

    def test_partial_patch_failure_rolls_back_without_changing_runtime_or_config(self):
        before = self.config.read_bytes()
        self.kube.fail_patch = 2
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_FAILED_ROLLED_BACK'):
            self.migrate()
        self.assert_original_resources()
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse(remote.owner_marker())
        self.assertFalse(remote.pending())
        self.assertFalse((self.base / 'data/framework/disabled.json').exists())

    def test_recover_partial_migration_uses_only_metadata_not_resource_apply(self):
        before = self.config.read_bytes()
        self.kube.fail_patch = 2
        self.kube.block_rollback = True
        with self.assertRaisesRegex(RuntimeError, 'MIGRATION_RECOVERY_REQUIRED'):
            self.migrate()
        self.assertEqual(remote.pending(), self.op)
        info = remote.handle({'action': 'backup', 'operation': self.op})
        self.assertEqual(info['mode'], 'migrate')
        self.kube.block_rollback = False
        remote.handle({'action': 'rollback', 'operation': self.op})
        self.assert_original_resources()
        self.assertFalse(self.kube.writes)
        self.assertFalse(remote.pending())
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse((self.base / 'data/framework/disabled.json').exists())


if __name__ == '__main__':
    unittest.main()

"""Local-only state-machine tests. Never connects to Tower or invokes kubectl."""
import base64
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('rivetin_remote', str(ROOT / 'remote.py'))
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)

def archive(entries=None):
    output = io.BytesIO()
    entries = entries or [('server/main.js', b'// EXAMPLE_SERVICE'), ('cli.mjs', b'// EXAMPLE_CLI'),
                          ('package.json', b'{"name":"rivetin","version":"0.1.0"}'), ('LICENSE', b'MIT fixture')]
    with tarfile.open(fileobj=output, mode='w') as tar:
        for name, content in entries:
            if isinstance(content, tarfile.TarInfo):
                tar.addfile(content)
            else:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
    return gzip.compress(output.getvalue(), mtime=0)

def manifest(checksum):
    def metadata(kind):
        annotations = {'rivetin/managed-by': remote.OWNER}
        if kind == 'Ingress':
            annotations.update({'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/proxy-body-size': '16m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '15',
                'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true'})
        return {'name': 'rivetin', 'namespace': remote.NS, 'annotations': annotations}
    container = {'name': 'rivetin', 'image': remote.IMAGE, 'imagePullPolicy': 'IfNotPresent',
        'workingDir': '/opt/rivetin', 'command': ['node', 'server/main.js'],
        'env': [{'name': 'RIVETIN_DATA', 'value': '/var/lib/rivetin'},
                {'name': 'RIVETIN_TOWER_URL', 'value': 'http://cloudtower-cloudtower.cloudtower-system.svc.cluster.local'},
                {'name': 'RIVETIN_ORIGINS', 'value': 'https://tower.example.invalid'}],
        'ports': [{'containerPort': 8787}],
        'resources': {'requests': {'cpu': '20m', 'memory': '48Mi'}, 'limits': {'cpu': '500m', 'memory': '256Mi'}},
        'securityContext': {'runAsUser': 1000, 'runAsGroup': 1000, 'allowPrivilegeEscalation': False,
                            'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}},
        'readinessProbe': {'httpGet': {'path': '/healthz', 'port': 8787}},
        'livenessProbe': {'httpGet': {'path': '/healthz', 'port': 8787}, 'initialDelaySeconds': 10},
        'volumeMounts': [{'name': 'code', 'mountPath': '/opt/rivetin', 'readOnly': True},
                         {'name': 'data', 'mountPath': '/var/lib/rivetin'}]}
    pod = {'automountServiceAccountToken': False, 'enableServiceLinks': False, 'containers': [container],
        'volumes': [{'name': 'code', 'hostPath': {'path': str(remote.BASE / 'releases' / checksum), 'type': 'Directory'}},
                    {'name': 'data', 'hostPath': {'path': str(remote.BASE / 'data'), 'type': 'Directory'}}]}
    return {'apiVersion': 'v1', 'kind': 'List', 'items': [
        {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': metadata('Deployment'),
         'spec': {'replicas': 1, 'strategy': {'type': 'Recreate'}, 'selector': {'matchLabels': {'app': 'rivetin'}},
                  'template': {'metadata': {'labels': {'app': 'rivetin'}, 'annotations': {'rivetin/code-sha256': checksum}}, 'spec': pod}}},
        {'apiVersion': 'v1', 'kind': 'Service', 'metadata': metadata('Service'),
         'spec': {'selector': {'app': 'rivetin'}, 'ports': [{'port': 8787, 'targetPort': 8787}]}},
        {'apiVersion': 'networking.k8s.io/v1', 'kind': 'Ingress', 'metadata': metadata('Ingress'),
         'spec': {'rules': [{'http': {'paths': [{'path': '/api/rivetin/', 'pathType': 'Prefix',
            'backend': {'service': {'name': 'rivetin', 'port': {'number': 8787}}}}]}}],
            'tls': [{'secretName': 'cloudtower-tls'}]}}]}

class KubernetesFixture:
    def __init__(self):
        self.items = {}
        self.image = remote.IMAGE
        self.node = 'v20.12.1'
        self.calls = []
        self.fail_rollout = False
        self.pods = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:3] == ('get', 'pod', 'cloudtower-cloudtower-0'):
            return json.dumps({'metadata': {'name': 'cloudtower-cloudtower-0'},
                'spec': {'containers': [{'name': 'server', 'image': self.image}]}}).encode()
        if args[:2] == ('exec', 'cloudtower-cloudtower-0'):
            return self.node.encode()
        if args[:2] == ('get', 'pods'):
            return json.dumps({'items': self.pods}).encode()
        if args[0] == 'get':
            item = self.items.get(args[1])
            return json.dumps(item).encode() if item else b''
        if args[0] == 'apply':
            for item in json.loads(kwargs['data'])['items']:
                self.items[item['kind'].lower()] = item
            return b''
        if args[0] == 'delete':
            self.items.pop(args[1], None)
            return b''
        if args[0] == 'rollout':
            if self.fail_rollout:
                raise RuntimeError('KUBERNETES_COMMAND_FAILED')
            return b''
        if args[:2] == ('exec', 'deployment/rivetin'):
            settings = remote.BASE / 'data' / 'framework' / 'settings.json'
            deployment = self.items['deployment']
            code = Path(deployment['spec']['template']['spec']['volumes'][0]['hostPath']['path'])
            version = json.loads((code / 'package.json').read_text())['version']
            if not settings.exists():
                settings.write_text(json.dumps(dict(apiVersion=1, version=version)))
            else:
                stored = json.loads(settings.read_text())
                if stored['version'] != version:
                    if args[-2:] != ('--upgrade-from', '0.1.0') or stored['version'] != '0.1.0' or version != '0.1.1':
                        raise RuntimeError('FRAMEWORK_MIGRATION_REQUIRED')
                    stored['version'] = version
                    settings.write_text(json.dumps(stored))
            return b''
        raise AssertionError('Unexpected fixture call: %r' % (args,))

    @property
    def writes(self):
        return [args for args, _ in self.calls if args[0] in ['apply', 'delete', 'rollout'] or args[:2] == ('exec', 'deployment/rivetin')]

class RemoteTests(unittest.TestCase):
    def setUp(self):
        runtime = (ROOT / '.runtime').resolve()
        if runtime.parent != ROOT:
            raise AssertionError('TEST_PATH_OUTSIDE_WORKSPACE')
        runtime.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='remote-test-', dir=str(runtime))
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        if self.directory.parent != runtime:
            raise AssertionError('TEST_PATH_OUTSIDE_WORKSPACE')
        self.base = self.directory / 'installation'
        self.kube = KubernetesFixture()
        self.addCleanup(patch.stopall)
        patch.object(remote, 'BASE', self.base).start()
        patch.object(remote, 'kube', self.kube).start()
        patch.object(remote.os, 'chown', create=True).start()
        patch.object(remote.os, 'fchown', create=True).start()
        self.op = 'a' * 32

    def begin(self, mode='install', operation=None):
        return remote.handle({'action': 'prepare', 'operation': operation or self.op,
                              'mode': mode, 'islandBackup': base64.b64encode(b'EXAMPLE_OLD_ISLAND').decode()})

    def apply(self, mode='install', service=None, wanted=None):
        data = service or archive()
        checksum = hashlib.sha256(data).hexdigest()
        return remote.handle({'action': 'apply', 'operation': self.op, 'mode': mode,
            'service': base64.b64encode(data).decode(), 'serviceSHA256': checksum,
            'manifest': base64.b64encode(json.dumps(wanted or manifest(checksum)).encode()).decode()})

    def finish(self):
        return remote.handle({'action': 'commit', 'operation': self.op})

    def installed(self):
        self.begin()
        self.apply()
        self.finish()
        config = self.base / 'data' / 'plugins' / 'rivetin-example' / 'config.json'
        config.parent.mkdir(parents=True)
        config.write_text('{"EXAMPLE_SETTING":"preserve bytes"}')
        return config

    def test_obsolete_ownership_and_manifest_are_not_adopted(self):
        wanted = manifest('a' * 64)
        for item in wanted['items']:
            item['metadata']['name'] = 'pluginkit'
            item['metadata']['annotations']['pluginkit/managed-by'] = 'pluginkit-cli-v1'
            del item['metadata']['annotations']['rivetin/managed-by']
        self.assertFalse(remote.owned(wanted['items']))
        with self.assertRaisesRegex(RuntimeError, 'MANIFEST_INVALID'):
            remote.validate_manifest(wanted, 'a' * 64)
        with self.assertRaisesRegex(RuntimeError, 'UNKNOWN_ACTION'):
            remote.handle({'action': 'migrate', 'operation': self.op})
        self.assertFalse(self.base.exists())
        self.assertFalse(self.kube.writes)

    def test_obsolete_env_and_ingress_paths_are_rejected(self):
        for change in ['env', 'ingress']:
            wanted = manifest('a' * 64)
            if change == 'env':
                for item in wanted['items'][0]['spec']['template']['spec']['containers'][0]['env']:
                    item['name'] = item['name'].replace('RIVETIN_', 'PLUGINKIT_')
            else:
                wanted['items'][2]['spec']['rules'][0]['http']['paths'][0]['path'] = '/api/pluginkit/'
            with self.assertRaisesRegex(RuntimeError, 'MANIFEST_INVALID'):
                remote.validate_manifest(wanted, 'a' * 64)

    def test_service_archive_accepts_shared_runtime_and_new_builtin_only(self):
        for forbidden in ['server/builtins/pluginkit-ssh-channel.json', 'shared/unknown.js', 'shared/version-extra.js', 'shared/nested/version.js']:
            with self.assertRaisesRegex(RuntimeError, 'SERVICE_ARCHIVE_INVALID'):
                remote.extract_release(archive([('server/main.js', b'// EXAMPLE'), (forbidden, b'{}')]), self.directory / 'rejected')
        target = self.directory / 'new-service'
        target.mkdir()
        content = remote.extract_release(archive([('server/main.js', b'// EXAMPLE'), ('shared/identity.js', b'// EXAMPLE'), ('shared/version.js', b'// EXAMPLE_VERSION'),
            ('server/builtins/rivetin-ssh-channel.json', b'{}'), ('server/vendor/ssh2.cjs', b'// EXAMPLE')]), target)
        self.assertEqual(len(content), 5)
        self.assertEqual((target / 'shared/version.js').read_bytes(), b'// EXAMPLE_VERSION')

    def test_probe_is_read_only(self):
        result = remote.handle({'action': 'probe'})
        self.assertEqual(result['image'], remote.IMAGE)
        self.assertFalse(result['installed'])
        self.assertFalse(self.base.exists())
        self.assertFalse(self.kube.writes)

    def test_unknown_build_and_node_reject_before_writes(self):
        for field in ['image', 'node']:
            with self.subTest(field=field):
                old = getattr(self.kube, field)
                setattr(self.kube, field, 'UNTESTED_BUILD')
                with self.assertRaisesRegex(RuntimeError, 'UNTESTED_TOWER_BUILD'):
                    self.begin()
                setattr(self.kube, field, old)
                self.assertFalse(self.base.exists())
                self.assertFalse(self.kube.writes)

    def test_initial_install_commits_disabled_and_keeps_backup(self):
        self.begin()
        self.apply()
        result = self.finish()
        self.assertFalse(result['enabled'])
        self.assertTrue((self.base / 'data/framework/disabled.json').is_file())
        self.assertFalse(remote.pending())
        self.assertEqual(len(self.kube.items), 3)
        self.assertEqual(json.loads((self.base / 'backups' / self.op / 'state.json').read_text())['phase'], 'committed')

    def test_update_preserves_config_and_creates_recoverable_snapshot(self):
        config = self.installed()
        before = config.read_bytes()
        self.op = 'b' * 32
        self.begin('update')
        self.assertTrue((self.base / 'backups' / self.op / 'data.tar.gz').is_file())
        self.apply('update')
        self.finish()
        self.assertEqual(config.read_bytes(), before)
        self.assertTrue((self.base / 'data/framework/disabled.json').exists())
        with tarfile.open(str(self.base / 'backups' / self.op / 'data.tar.gz'), 'r:gz') as saved:
            self.assertNotIn('data/.write.lock', saved.getnames())
            self.assertNotIn('data/framework/.write.lock', saved.getnames())

    def test_snapshot_uses_service_locks_and_releases_only_its_locks(self):
        directory = self.base / 'data/framework'
        directory.mkdir(parents=True)
        with remote.snapshot_locks():
            for lock in [self.base / 'data/.write.lock', directory / '.write.lock']:
                with self.assertRaises(FileExistsError):
                    os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        self.assertFalse((directory / '.write.lock').exists())
        self.assertFalse((self.base / 'data/.write.lock').exists())

    def test_snapshot_busy_framework_lock_retains_other_owner_lock(self):
        directory = self.base / 'data/framework'
        directory.mkdir(parents=True)
        existing = directory / '.write.lock'
        existing.write_text('EXAMPLE_OTHER_WRITER')
        with patch.object(remote.time, 'monotonic', side_effect=[0, 1, 7]):
            with self.assertRaisesRegex(RuntimeError, 'STORE_BUSY'):
                with remote.snapshot_locks():
                    self.fail('Busy lock must prevent snapshot')
        self.assertEqual(existing.read_text(), 'EXAMPLE_OTHER_WRITER')
        self.assertFalse((self.base / 'data/.write.lock').exists())

    def test_framework_schema_change_refused_before_mutation(self):
        self.installed()
        settings = self.base / 'data/framework/settings.json'
        settings.write_text('{"version":"0.1.0","apiVersion":2}')
        self.op = 'b' * 32
        self.kube.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'FRAMEWORK_MIGRATION_REQUIRED'):
            self.begin('update')
        self.assertFalse(remote.pending())
        self.assertFalse(self.kube.writes)

    def test_explicit_patch_upgrade_and_rollback_only_restore_version(self):
        config = self.installed()
        before_config = config.read_bytes()
        settings = self.base / 'data/framework/settings.json'
        settings.write_text(json.dumps(dict(apiVersion=1, version='0.1.0', initializedAt='EXAMPLE_ORIGINAL_TIME', towerBuild='4.9.0')))
        self.op = 'b' * 32
        self.begin('update')
        backup = self.base / 'backups' / self.op
        self.assertEqual(json.loads((backup / 'framework-version-before.json').read_text()), dict(apiVersion=1, version='0.1.0'))
        data = archive([('server/main.js', b'// NEXT'), ('cli.mjs', b'// NEXT_CLI'), ('package.json', b'{"name":"rivetin","version":"0.1.1"}')])
        self.apply('update', service=data)
        self.assertIn(('--upgrade-from', '0.1.0'), [args[-2:] for args, _ in self.kube.calls])
        value = json.loads(settings.read_text())
        self.assertEqual(value['version'], '0.1.1')
        value['EXAMPLE_RETAINED_SETTING'] = True
        settings.write_text(json.dumps(value))
        remote.handle({'action': 'rollback', 'operation': self.op})
        restored = json.loads(settings.read_text())
        self.assertEqual(restored['version'], '0.1.0')
        self.assertTrue(restored['EXAMPLE_RETAINED_SETTING'])
        self.assertEqual(restored['initializedAt'], 'EXAMPLE_ORIGINAL_TIME')
        self.assertEqual(config.read_bytes(), before_config)
        self.assertTrue((settings.parent / 'disabled.json').exists())

    def test_same_patch_version_needs_no_migration_argument_and_downgrade_refused(self):
        self.installed()
        settings = self.base / 'data/framework/settings.json'
        settings.write_text('{"apiVersion":1,"version":"0.1.1"}')
        self.op = 'b' * 32
        self.begin('update')
        self.kube.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'FRAMEWORK_MIGRATION_REQUIRED'):
            self.apply('update')
        self.assertFalse(self.kube.writes)
        # A rejected package retains its stage and recovery record; recovery first.
        remote.handle({'action': 'rollback', 'operation': self.op})
        self.op = 'c' * 32
        self.begin('update')
        data = archive([('server/main.js', b'// NEXT'), ('package.json', b'{"name":"rivetin","version":"0.1.1"}')])
        self.apply('update', service=data)
        self.assertNotIn('--upgrade-from', self.kube.calls[-1][0])
        self.assertEqual(json.loads(settings.read_text())['version'], '0.1.1')

    def test_unknown_framework_version_refused_before_pending_or_kube_write(self):
        self.installed()
        settings = self.base / 'data/framework/settings.json'
        for value in [dict(apiVersion=1, version='0.2.0'), dict(apiVersion=True, version='0.1.0')]:
            settings.write_text(json.dumps(value))
            self.op = 'b' * 32
            self.kube.calls.clear()
            with self.assertRaisesRegex(RuntimeError, 'FRAMEWORK_MIGRATION_REQUIRED'):
                self.begin('update')
            self.assertFalse(remote.pending())
            self.assertFalse(self.kube.writes)

    def test_python_upgrade_exec_contract_runs_real_node_init_and_failed_apply_rolls_back(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('Development-only Node contract unavailable; portable clients never invoke local Node')
        config = self.installed()
        before = config.read_bytes()
        settings = self.base / 'data/framework/settings.json'
        settings.write_text('{"apiVersion":1,"version":"0.1.0","initializedAt":"EXAMPLE_TIME","towerBuild":"4.9.0"}')
        self.op = 'b' * 32
        self.begin('update')
        cli = ROOT.parent / 'framework/cli.mjs'

        def execute(*args, **kw):
            if args[:2] == ('exec', 'deployment/rivetin'):
                self.kube.calls.append((args, kw))
                local_args = list(args[5:])
                self.assertEqual(local_args[:3], ['init', '--data', '/var/lib/rivetin'])
                local_args[2] = str(self.base / 'data')
                result = subprocess.run([node, str(cli)] + local_args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=False)
                self.assertEqual(result.returncode, 0, 'Actual Node init rejected Python adapter contract')
                self.assertTrue(json.loads(result.stdout)['upgraded'])
                raise RuntimeError('EXAMPLE_POST_INIT_TRANSPORT_FAILURE')
            return self.kube(*args, **kw)

        data = archive([('server/main.js', b'// NEXT'), ('package.json', b'{"name":"rivetin","version":"0.1.1"}')])
        with patch.object(remote, 'kube', execute):
            with self.assertRaisesRegex(RuntimeError, 'EXAMPLE_POST_INIT_TRANSPORT_FAILURE'):
                self.apply('update', service=data)
        self.assertEqual(json.loads(settings.read_text())['version'], '0.1.1')
        self.assertEqual(json.loads((self.base / 'backups' / self.op / 'state.json').read_text())['phase'], 'applying')
        remote.handle({'action': 'rollback', 'operation': self.op})
        self.assertEqual(json.loads(settings.read_text()), dict(apiVersion=1, version='0.1.0', initializedAt='EXAMPLE_TIME', towerBuild='4.9.0'))
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse(remote.pending())
        self.assertTrue((settings.parent / 'disabled.json').exists())

    def test_unmanaged_resources_and_owner_marker_refused(self):
        item = manifest('0' * 64)['items'][1]
        item['metadata']['annotations'] = {}
        self.kube.items = {'service': item}
        with self.assertRaisesRegex(RuntimeError, 'EXISTING_INSTALLATION_UNMANAGED'):
            self.begin('update')
        self.assertFalse(self.base.exists())
        self.assertFalse(self.kube.writes)

    def test_wrong_owner_marker_refused(self):
        self.base.mkdir()
        (self.base / 'installer-owner').write_text('NOT_PLUGIN_KIT')
        with self.assertRaisesRegex(RuntimeError, 'EXISTING_INSTALLATION_UNMANAGED'):
            self.begin()
        self.assertFalse((self.base / 'installer-lock').exists())

    def test_invalid_mode_backup_and_operation_fail_before_mutation(self):
        for patch_value in [{'mode': 'delete-everything'}, {'islandBackup': '!INVALID_BASE64!'}, {'operation': '../outside'}]:
            req = {'action': 'prepare', 'operation': self.op, 'mode': 'install', 'islandBackup': ''}
            req.update(patch_value)
            with self.subTest(patch_value=patch_value), self.assertRaises(Exception):
                remote.handle(req)
            self.assertFalse(self.base.exists())

    def test_existing_manual_directory_is_never_adopted(self):
        self.base.mkdir()
        (self.base / 'EXAMPLE_EXISTING_FILE').write_text('preserve')
        with self.assertRaisesRegex(RuntimeError, 'EXISTING_INSTALLATION_UNMANAGED'):
            self.begin()
        self.assertEqual((self.base / 'EXAMPLE_EXISTING_FILE').read_text(), 'preserve')

    def test_pending_operation_blocks_new_prepare(self):
        self.begin()
        with self.assertRaisesRegex(RuntimeError, 'INSTALLER_RECOVERY_REQUIRED'):
            self.begin(operation='b' * 32)
        self.assertEqual(remote.pending(), self.op)

    def test_incomplete_lock_blocks_new_prepare(self):
        (self.base / 'installer-lock').mkdir(parents=True)
        self.assertEqual(remote.pending(), 'incomplete')
        with self.assertRaisesRegex(RuntimeError, 'INSTALLER_RECOVERY_REQUIRED'):
            self.begin()

    def test_commit_requires_completed_backend_or_removal(self):
        self.begin()
        with self.assertRaisesRegex(RuntimeError, 'INVALID_INSTALLER_PHASE'):
            self.finish()
        self.assertEqual(remote.pending(), self.op)

    def test_prepare_failure_recovery_keeps_config(self):
        config = self.installed()
        old = config.read_bytes()
        self.op = 'b' * 32
        self.begin('update')
        backup = remote.handle({'action': 'backup', 'operation': self.op})
        self.assertEqual(base64.b64decode(backup['islandBackup']), b'EXAMPLE_OLD_ISLAND')
        result = remote.handle({'action': 'rollback', 'operation': self.op})
        self.assertEqual(result['phase'], 'rolled-back')
        self.assertEqual(config.read_bytes(), old)
        self.assertEqual(len(self.kube.items), 3)
        self.assertFalse(remote.pending())

    def test_failed_new_install_rollback_removes_only_owned_resources(self):
        self.begin()
        self.apply()
        remote.handle({'action': 'rollback', 'operation': self.op})
        self.assertFalse(self.kube.items)
        self.assertTrue((self.base / 'data/framework/disabled.json').exists())
        self.assertTrue((self.base / 'backups' / self.op).is_dir())
        self.assertEqual({args[1] for args in self.kube.writes if args[0] == 'delete'}, set(remote.KINDS))

    def test_uninstall_retains_config_code_and_backup(self):
        config = self.installed()
        old = config.read_bytes()
        releases = list((self.base / 'releases').iterdir())
        self.op = 'b' * 32
        self.begin('uninstall')
        result = remote.handle({'action': 'remove', 'operation': self.op})
        self.assertTrue(result['dataRetained'])
        self.finish()
        self.assertFalse(self.kube.items)
        self.assertEqual(config.read_bytes(), old)
        self.assertTrue(all(item.is_dir() for item in releases))
        self.assertTrue((self.base / 'backups' / self.op / 'data.tar.gz').exists())

    def test_remove_requires_uninstall_phase(self):
        self.begin()
        with self.assertRaisesRegex(RuntimeError, 'INVALID_INSTALLER_PHASE'):
            remote.handle({'action': 'remove', 'operation': self.op})
        self.assertFalse(self.kube.writes)

    def test_resource_ownership_change_blocks_apply_and_removal(self):
        self.begin()
        item = manifest('0' * 64)['items'][1]
        item['metadata']['annotations'] = {}
        self.kube.items['service'] = item
        with self.assertRaisesRegex(RuntimeError, 'RESOURCE_OWNERSHIP_MISMATCH'):
            self.apply()
        with self.assertRaisesRegex(RuntimeError, 'RESOURCE_OWNERSHIP_MISMATCH'):
            remote.handle({'action': 'rollback', 'operation': self.op})
        self.assertFalse(self.kube.writes)

    def test_manifest_cannot_redirect_mounts_routes_or_privilege(self):
        raw = archive()
        checksum = hashlib.sha256(raw).hexdigest()
        mutations = [
            lambda m: m['items'][0]['spec']['template']['spec']['volumes'][1]['hostPath'].update(path='/'),
            lambda m: m['items'][0]['spec']['template']['spec']['containers'][0]['securityContext'].update(privileged=True),
            lambda m: m['items'][2]['spec']['rules'][0]['http']['paths'][0].update(path='/'),
            lambda m: m['items'][2]['metadata']['annotations'].update({'nginx.ingress.kubernetes.io/configuration-snippet': 'EXAMPLE_SNIPPET'}),
            lambda m: m['items'][1].update(kind='Secret'),
            lambda m: m['items'][0]['metadata'].update(name='cloudtower-cloudtower'),
        ]
        for mutate in mutations:
            wanted = manifest(checksum)
            mutate(wanted)
            with self.subTest(mutate=mutate), self.assertRaisesRegex(RuntimeError, 'MANIFEST_INVALID'):
                remote.validate_manifest(wanted, checksum)
        self.assertFalse(self.kube.writes)

    def test_checksum_failure_never_applies(self):
        self.begin()
        req = {'action': 'apply', 'mode': 'install', 'operation': self.op,
               'service': base64.b64encode(archive()).decode(), 'serviceSHA256': '0' * 64}
        with self.assertRaisesRegex(RuntimeError, 'SERVICE_CHECKSUM_FAILED'):
            remote.handle(req)
        self.assertFalse(self.kube.writes)

    def test_tar_traversal_links_and_duplicate_names_refused(self):
        link = tarfile.TarInfo('server/link.js')
        link.type = tarfile.SYMTYPE
        link.linkname = '/EXAMPLE_OUTSIDE'
        hard = copy.copy(link)
        hard.type = tarfile.LNKTYPE
        cases = [('../outside', b'EXAMPLE'), ('/outside', b'EXAMPLE'), ('server\\outside.js', b'EXAMPLE'),
                 ('server/link.js', link), ('server/link.js', hard)]
        for entry in cases:
            with self.subTest(entry=entry[0]), self.assertRaisesRegex(RuntimeError, 'SERVICE_ARCHIVE_INVALID'):
                remote.extract_release(archive([('server/main.js', b'EXAMPLE'), entry]), self.directory / 'extract')
        with self.assertRaisesRegex(RuntimeError, 'SERVICE_ARCHIVE_INVALID'):
            remote.extract_release(archive([('server/main.js', b'EXAMPLE'), ('server/main.js', b'DUPLICATE')]), self.directory / 'extract')
        self.assertFalse((self.directory / 'extract').exists())

    def test_tar_limits_are_enforced_before_extraction(self):
        cases = [[('server/main.js', b'x' * (4 * 1024 * 1024 + 1))],
                 [('server/main.js', b'EXAMPLE')] + [('server/file-%s%s.js' % (chr(97 + n // 26), chr(97 + n % 26)), b'x') for n in range(100)]]
        for entries in cases:
            with self.assertRaisesRegex(RuntimeError, 'SERVICE_ARCHIVE_LIMIT'):
                remote.extract_release(archive(entries), self.directory / 'extract')
        self.assertFalse((self.directory / 'extract').exists())

    def test_installed_code_tampering_is_not_trusted(self):
        self.installed()
        target = next((self.base / 'releases').iterdir())
        (target / 'server/main.js').write_text('// CHANGED_EXAMPLE')
        self.op = 'b' * 32
        self.begin('update')
        self.kube.calls.clear()
        with self.assertRaisesRegex(RuntimeError, 'INSTALLED_CODE_CHANGED'):
            self.apply('update')
        self.assertFalse(self.kube.writes)

    def test_apply_rollout_leaves_headroom_in_five_minute_verification_budget(self):
        self.begin()
        self.apply()
        rollouts = [(args, options) for args, options in self.kube.calls if args[0] == 'rollout']
        self.assertEqual(len(rollouts), 1)
        args, options = rollouts[0]
        self.assertEqual(args, ('rollout', 'status', 'deployment/rivetin', '--timeout=270s'))
        self.assertEqual(options['timeout'], 280)
        self.assertEqual(remote.APPLY_ROLLOUT_SECONDS, 270)
        self.assertEqual(remote.APPLY_ROLLOUT_PROCESS_SECONDS, 280)
        self.assertGreaterEqual(300 - remote.APPLY_ROLLOUT_SECONDS, 30)
        self.assertGreater(remote.APPLY_ROLLOUT_PROCESS_SECONDS, remote.APPLY_ROLLOUT_SECONDS)
        actions = [args for args, _ in self.kube.calls]
        init = ('exec', 'deployment/rivetin', '--', 'node', 'cli.mjs', 'init', '--data', '/var/lib/rivetin')
        self.assertGreater(actions.index(init), actions.index(args))

    def test_rollback_rollout_retains_independent_ninety_second_limit(self):
        self.installed()
        self.begin('update', operation='b' * 32)
        remote.handle({'action': 'rollback', 'operation': 'b' * 32})
        rollouts = [(args, options) for args, options in self.kube.calls if args[0] == 'rollout']
        self.assertEqual(rollouts[-1][0], ('rollout', 'status', 'deployment/rivetin', '--timeout=90s'))
        self.assertEqual(rollouts[-1][1]['timeout'], 100)

    def uninstalled_with_data(self):
        config = self.installed()
        self.begin('uninstall', operation='b' * 32)
        remote.handle({'action': 'remove', 'operation': 'b' * 32})
        remote.handle({'action': 'commit', 'operation': 'b' * 32})
        return config

    def reset_config(self, operation=None):
        return remote.handle({'action': 'reset-config', 'operation': operation or 'c' * 32})

    def test_reset_config_refuses_any_remaining_framework_resource_or_pod(self):
        config = self.installed()
        old = config.read_bytes()
        items = copy.deepcopy(self.kube.items)
        for kind in ['deployment', 'service', 'ingress']:
            self.kube.items = {kind: items[kind]}
            with self.assertRaisesRegex(RuntimeError, 'UNINSTALL_FRAMEWORK_BEFORE_RESET'):
                self.reset_config()
            self.assertEqual(config.read_bytes(), old)
        self.kube.items = {}
        self.kube.pods = [{'metadata': {'name': 'EXAMPLE_TERMINATING_PLUGIN_POD'}}]
        with self.assertRaisesRegex(RuntimeError, 'PLUGIN_PODS_STILL_PRESENT'):
            self.reset_config()
        self.assertFalse((self.base / 'backups' / ('c' * 32)).exists())

    def test_reset_config_requires_known_build_correct_owner_and_no_pending(self):
        config = self.uninstalled_with_data()
        before = config.read_bytes()
        self.kube.image = 'EXAMPLE_UNTESTED_IMAGE'
        with self.assertRaisesRegex(RuntimeError, 'UNTESTED_TOWER_BUILD'):
            self.reset_config()
        self.kube.image = remote.IMAGE
        marker = self.base / 'installer-owner'
        marker.write_text('EXAMPLE_OTHER_OWNER')
        with self.assertRaisesRegex(RuntimeError, 'INSTALLER_OWNERSHIP_REQUIRED'):
            self.reset_config()
        marker.write_text(remote.OWNER)
        lock = self.base / 'installer-lock'
        lock.mkdir()
        (lock / 'operation').write_text('d' * 32)
        with self.assertRaisesRegex(RuntimeError, 'INSTALLER_RECOVERY_REQUIRED'):
            self.reset_config()
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse((self.base / 'backups' / ('c' * 32)).exists())

    def test_reset_config_archives_only_data_and_keeps_readable_full_snapshot(self):
        config = self.uninstalled_with_data()
        before = config.read_bytes()
        config_relative = config.relative_to(self.base / 'data')
        marker = (self.base / 'installer-owner').read_bytes()
        releases = {str(p.relative_to(self.base / 'releases')): p.read_bytes() for p in (self.base / 'releases').rglob('*') if p.is_file()}
        prior_backups = {str(p.relative_to(self.base / 'backups')): p.read_bytes() for p in (self.base / 'backups').rglob('*') if p.is_file()}
        calls_before = len(self.kube.writes)
        result = self.reset_config()
        self.assertTrue(result['cleared'])
        self.assertTrue(result['retainedInBackup'])
        self.assertFalse((self.base / 'data').exists())
        backup = self.base / 'backups' / ('c' * 32)
        self.assertEqual((backup / 'cleared-data' / config_relative).read_bytes(), before)
        manifest = json.loads((backup / 'manifest.json').read_text())
        entry = next(item for item in manifest['files'] if item['path'] == str(config_relative).replace(os.sep, '/'))
        self.assertEqual(entry['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(entry['bytes'], len(before))
        self.assertEqual(json.loads((backup / 'state.json').read_text())['phase'], 'config-cleared')
        self.assertEqual((self.base / 'installer-owner').read_bytes(), marker)
        for name, value in releases.items():
            self.assertEqual((self.base / 'releases' / name).read_bytes(), value)
        for name, value in prior_backups.items():
            self.assertEqual((self.base / 'backups' / name).read_bytes(), value)
        self.assertEqual(len(self.kube.writes), calls_before)
        self.assertFalse(remote.pending())

    def test_reset_config_missing_data_is_idempotent_without_new_configuration(self):
        self.uninstalled_with_data()
        self.reset_config()
        backups = sorted(p.name for p in (self.base / 'backups').iterdir())
        result = self.reset_config(operation='d' * 32)
        self.assertFalse(result['cleared'])
        self.assertTrue(result['alreadyEmpty'])
        self.assertFalse((self.base / 'data').exists())
        self.assertEqual(sorted(p.name for p in (self.base / 'backups').iterdir()), backups)
        self.assertFalse(remote.pending())

    def test_reset_config_refuses_links_and_invalid_operation_id(self):
        config = self.uninstalled_with_data()
        before = config.read_bytes()
        with self.assertRaisesRegex(RuntimeError, 'INVALID_OPERATION_ID'):
            self.reset_config(operation='../EXAMPLE_OUTSIDE')
        original = remote.Path.is_symlink
        with patch.object(remote.Path, 'is_symlink', lambda path: path == config or original(path)):
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_INSTALL_PATH'):
                self.reset_config()
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse(remote.pending())

    def test_reset_config_rename_failure_retains_data_and_finishes_failed_journal(self):
        config = self.uninstalled_with_data()
        before = config.read_bytes()
        with patch.object(remote.os, 'rename', side_effect=OSError('EXAMPLE_RENAME_FAILURE')):
            with self.assertRaises(OSError):
                self.reset_config()
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse(remote.pending())
        state = json.loads((self.base / 'backups' / ('c' * 32) / 'state.json').read_text())
        self.assertEqual(state['phase'], 'failed-data-retained')

    def test_reset_config_uncertain_postrename_sync_keeps_archive_and_pending(self):
        config = self.uninstalled_with_data()
        relative = config.relative_to(self.base / 'data')
        before = config.read_bytes()
        def sync(directory):
            if directory == self.base:
                raise OSError('EXAMPLE_SYNC_FAILURE')
        with patch.object(remote, 'sync_directory', side_effect=sync):
            with self.assertRaisesRegex(RuntimeError, 'RESET_CONFIG_OUTCOME_UNKNOWN'):
                self.reset_config()
        self.assertEqual(remote.pending(), 'c' * 32)
        self.assertFalse((self.base / 'data').exists())
        self.assertEqual((self.base / 'backups' / ('c' * 32) / 'cleared-data' / relative).read_bytes(), before)

    def test_failed_rollout_retains_journal_until_explicit_recovery(self):
        config = self.installed()
        original = config.read_bytes()
        self.op = 'b' * 32
        self.begin('update')
        self.kube.fail_rollout = True
        with self.assertRaisesRegex(RuntimeError, 'KUBERNETES_COMMAND_FAILED'):
            self.apply('update')
        self.assertEqual(remote.pending(), self.op)
        self.assertEqual(json.loads((self.base / 'backups' / self.op / 'state.json').read_text())['phase'], 'applying')
        self.kube.fail_rollout = False
        remote.handle({'action': 'rollback', 'operation': self.op})
        self.assertEqual(config.read_bytes(), original)
        self.assertFalse(remote.pending())

    def test_emergency_disable_has_no_kubernetes_dependency(self):
        settings = self.base / 'data/framework/settings.json'
        settings.parent.mkdir(parents=True)
        settings.write_text('CORRUPTED_EXAMPLE_CONFIG')
        with patch.object(remote, 'kube', side_effect=AssertionError('KUBERNETES_MUST_NOT_BE_CALLED')):
            self.assertFalse(remote.handle({'action': 'disable'})['enabled'])
        self.assertTrue((settings.parent / 'disabled.json').exists())
        self.assertEqual(settings.read_text(), 'CORRUPTED_EXAMPLE_CONFIG')

    def test_cli_lifecycle_events_use_framework_audit_format_without_settings(self):
        config = self.installed()
        config.write_text('{"EXAMPLE_SECRET_SETTING":"MUST_NOT_APPEAR_IN_AUDIT"}')
        self.op = 'b' * 32
        self.begin('update')
        self.apply('update')
        self.assertTrue(self.finish()['auditRecorded'])
        self.op = 'c' * 32
        self.begin('uninstall')
        remote.handle({'action': 'remove', 'operation': self.op})
        self.assertTrue(self.finish()['auditRecorded'])
        raw = (self.base / 'data/audit.jsonl').read_text()
        self.assertNotIn('MUST_NOT_APPEAR_IN_AUDIT', raw)
        events = [json.loads(line) for line in raw.splitlines()]
        self.assertEqual([event['action'] for event in events], [
            'framework.install.started', 'framework.install',
            'framework.update.started', 'framework.update',
            'framework.uninstall.started', 'framework.uninstall'])
        for event in events:
            self.assertEqual(set(event), {'id', 'time', 'actor', 'action', 'pluginId', 'result', 'code'})
            self.assertEqual(event['actor'], {'id': 'rivetin-cli', 'name': 'Rivetin CLI', 'source': 'cli'})
            self.assertIsNone(event['pluginId'])
            self.assertIsNone(event['code'])

    def test_emergency_disable_records_safe_audit_event(self):
        self.installed()
        result = remote.handle({'action': 'disable'})
        self.assertTrue(result['auditRecorded'])
        event = json.loads((self.base / 'data/audit.jsonl').read_text().splitlines()[-1])
        self.assertEqual(event['action'], 'framework.disable')
        self.assertEqual(event['result'], 'success')
        self.assertEqual(event['actor']['source'], 'cli')

    def test_rollback_records_safe_audit_event(self):
        self.begin()
        self.apply()
        result = remote.handle({'action': 'rollback', 'operation': self.op})
        self.assertTrue(result['auditRecorded'])
        event = json.loads((self.base / 'data/audit.jsonl').read_text().splitlines()[-1])
        self.assertEqual(event['action'], 'framework.rollback')

    def test_audit_failure_does_not_prevent_emergency_disable(self):
        self.installed()
        original_open = remote.os.open
        def deny_audit(file, *args, **kwargs):
            if Path(file).name == 'audit.jsonl':
                raise PermissionError('EXAMPLE_AUDIT_DENIED')
            return original_open(file, *args, **kwargs)
        with patch.object(remote.os, 'open', side_effect=deny_audit):
            result = remote.handle({'action': 'disable'})
        self.assertFalse(result['enabled'])
        self.assertFalse(result['auditRecorded'])
        self.assertTrue((self.base / 'data/framework/disabled.json').exists())

    def test_audit_symlink_is_refused_but_emergency_disable_succeeds(self):
        self.installed()
        audit = self.base / 'data/audit.jsonl'
        before = audit.read_bytes()
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', autospec=True, side_effect=lambda p: p == audit or original(p)):
            result = remote.handle({'action': 'disable'})
        self.assertFalse(result['enabled'])
        self.assertFalse(result['auditRecorded'])
        self.assertEqual(audit.read_bytes(), before)

    def test_audit_existing_owner_is_preserved(self):
        self.installed()
        with patch.object(remote.os, 'fchown', create=True) as chown:
            result = remote.handle({'action': 'disable'})
        self.assertTrue(result['auditRecorded'])
        chown.assert_not_called()

    def test_non_regular_audit_path_does_not_block_disable(self):
        self.installed()
        file = self.base / 'data/audit.jsonl'
        file.unlink()
        file.mkdir()
        result = remote.handle({'action': 'disable'})
        self.assertFalse(result['auditRecorded'])
        self.assertFalse(result['enabled'])
        self.assertTrue(file.is_dir())

    def test_emergency_disable_ignores_broken_plugin_paths(self):
        self.base.mkdir()
        (self.base / 'installer-owner').write_text(remote.OWNER)
        plugin = self.base / 'data/plugins/EXAMPLE_BROKEN_PLUGIN'
        plugin.mkdir(parents=True)
        with patch.object(remote.os, 'walk', side_effect=AssertionError('MUST_NOT_SCAN_PLUGINS')):
            self.assertFalse(remote.handle({'action': 'disable'})['enabled'])

    def test_emergency_disable_does_not_wait_on_regular_write_locks(self):
        directory = self.base / 'data/framework'
        directory.mkdir(parents=True)
        (directory / 'settings.json').write_text('CORRUPTED_EXAMPLE_SETTINGS')
        locks = [directory / '.write.lock', directory.parent / '.write.lock']
        for lock in locks:
            lock.write_text('EXAMPLE_BUSY_WRITER')
        self.assertFalse(remote.handle({'action': 'disable'})['enabled'])
        self.assertTrue(all(lock.read_text() == 'EXAMPLE_BUSY_WRITER' for lock in locks))

    def test_emergency_disable_missing_installation_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'FRAMEWORK_NOT_INSTALLED'):
            remote.handle({'action': 'disable'})
        self.assertFalse(self.base.exists())

    def test_emergency_target_links_are_refused(self):
        self.base.mkdir()
        (self.base / 'installer-owner').write_text(remote.OWNER)
        with patch.object(Path, 'is_symlink', autospec=True, side_effect=lambda p: p == self.base / 'data'):
            with self.assertRaisesRegex(RuntimeError, 'UNSAFE_INSTALL_PATH'):
                remote.handle({'action': 'disable'})

    def test_request_operation_must_match_active_journal(self):
        self.begin()
        with self.assertRaisesRegex(RuntimeError, 'INSTALLER_OPERATION_MISMATCH'):
            remote.handle({'action': 'backup', 'operation': 'b' * 32})
        self.assertEqual(remote.pending(), self.op)

if __name__ == '__main__':
    unittest.main()

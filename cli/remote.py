"""Compiled-in Tower-side adapter. Only this script requires Tower's Python/kubectl.
No client programs are launched. All subprocesses use fixed argv, bounded timeouts.
"""
import base64
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
from urllib.parse import urlsplit

BASE = Path('/var/cache/appcache/rivetin')
NS = 'cloudtower-system'
OWNER = 'rivetin-cli-v1'
RESOURCE_NAME = 'rivetin'
API_PREFIXES = ['/api/rivetin/']
KINDS = ['deployment', 'service', 'ingress']
IMAGE = 'registry.smtx.io/cloudtower/tower:v4.9.0-rc-20260517114030'
# The client owns a shared five-minute verification budget. Leave at least
# thirty seconds after a successful Pod rollout for init and ingress readback.
APPLY_ROLLOUT_SECONDS = 270
APPLY_ROLLOUT_PROCESS_SECONDS = 280
KNOWN_METADATA_VERSIONS = ('0.1.0', '0.1.1', '0.1.2', '0.1.3', '0.1.4', '0.1.5')
METADATA_UPGRADES = {('0.1.0', '0.1.1'), ('0.1.0', '0.1.2'), ('0.1.1', '0.1.2'), ('0.1.0', '0.1.3'), ('0.1.1', '0.1.3'), ('0.1.2', '0.1.3'), ('0.1.0', '0.1.4'), ('0.1.1', '0.1.4'), ('0.1.2', '0.1.4'), ('0.1.3', '0.1.4'), ('0.1.0', '0.1.5'), ('0.1.1', '0.1.5'), ('0.1.2', '0.1.5'), ('0.1.3', '0.1.5'), ('0.1.4', '0.1.5')}

def fail(code):
    raise RuntimeError(code)

def command(args, data=None, timeout=30):
    p = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    if len(p.stdout) > 8 * 1024 * 1024:
        fail('REMOTE_OUTPUT_LIMIT')
    if p.returncode:
        fail('KUBERNETES_COMMAND_FAILED')
    return p.stdout

def kube(*args, **kw):
    return command(['kubectl', '-n', NS] + list(args), **kw)

def resources():
    result = []
    for kind in KINDS:
        raw = kube('get', kind, 'rivetin', '--ignore-not-found', '-o', 'json')
        if raw.strip():
            result.append(json.loads(raw))
    return result

def owned(items):
    kinds = {'Deployment', 'Service', 'Ingress'}
    return all(x.get('kind') in kinds and x.get('metadata', {}).get('name') == 'rivetin' and
               x.get('metadata', {}).get('namespace') == NS and
               x.get('metadata', {}).get('annotations', {}).get('rivetin/managed-by') == OWNER for x in items)

def owner_marker():
    file = BASE / 'installer-owner'
    return file.is_file() and file.read_text().strip() == OWNER

def pending():
    f = BASE / 'installer-lock' / 'operation'
    if f.exists():
        return f.read_text().strip() or 'incomplete'
    return 'incomplete' if f.parent.exists() else ''

def probe():
    pod = json.loads(kube('get', 'pod', 'cloudtower-cloudtower-0', '-o', 'json'))
    server = next((c for c in pod['spec']['containers'] if c['name'] == 'server'), None)
    if server is None:
        fail('TOWER_COMPONENT_MISSING')
    node = kube('exec', 'cloudtower-cloudtower-0', '-c', 'server', '--', 'node', '--version').decode().strip()
    items = resources()
    return dict(image=server['image'], node=node, namespace=NS, pod=pod['metadata']['name'], container='server',
                installed=bool(items), managed=owned(items) and owner_marker(), pending=pending())

def gate():
    found = probe()
    if found['image'] != IMAGE or found['node'] != 'v20.12.1':
        fail('UNTESTED_TOWER_BUILD')
    return found

def atomic(file, value, owner=False):
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', prefix='.installer-', dir=str(file.parent), delete=False) as stream:
            tmp = Path(stream.name)
            os.chmod(str(tmp), 0o600)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        if owner:
            os.chown(str(tmp), 1000, 1000)
        os.replace(str(tmp), str(file))
    finally:
        if tmp is not None and tmp.exists():
            tmp.unlink()

def safe_base(emergency=False):
    # Refuse links anywhere under the dedicated installation, including config files.
    if BASE.is_symlink() or BASE.resolve() != BASE:
        fail('UNSAFE_INSTALL_PATH')
    if emergency:
        # A damaged plugin, backup or config body must not block the kill switch.
        for name in ['data', 'data/framework', 'data/framework/settings.json',
                     'data/framework/disabled.json', 'installer-owner']:
            item = BASE / name
            if item.is_symlink() or item.resolve() != item:
                fail('UNSAFE_INSTALL_PATH')
        return
    if BASE.exists():
        count = 0
        for current, dirs, files in os.walk(str(BASE), followlinks=False):
            count += len(dirs) + len(files)
            if count > 20000:
                fail('INSTALLATION_FILE_LIMIT')
            for item in dirs + files:
                if Path(current, item).is_symlink():
                    fail('UNSAFE_INSTALL_PATH')

def disable():
    directory = BASE / 'data' / 'framework'
    directory.mkdir(parents=True, exist_ok=True)
    os.chown(str(BASE / 'data'), 1000, 1000)
    os.chown(str(directory), 1000, 1000)
    atomic(directory / 'disabled.json', dict(disabledAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), actor='rivetin-cli'), True)
    # Independent of Kubernetes and the plugin lifecycle lock. API resume also
    # rotates this epoch, so a very fast disable/resume cannot revive approvals.
    try:
        atomic(directory / 'ssh-revocation.json', dict(nonce=uuid.uuid4().hex), True)
    except Exception:
        pass  # The emergency disabled marker already committed; never undo it.

def record_audit(action, result='success'):
    """Best-effort safe metadata only. An unavailable audit must never block rescue."""
    file = BASE / 'data' / 'audit.jsonl'
    fd = None
    parent_fd = None
    created = False
    written = False
    try:
        if file.parent.resolve() != file.parent or file.is_symlink() or file.resolve() != file:
            return False
        event = dict(id=str(uuid.uuid4()), time=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            actor=dict(id='rivetin-cli', name='Rivetin CLI', source='cli'), action=action,
            pluginId=None, result=result, code=None)
        data = (json.dumps(event, separators=(',', ':')) + '\n').encode('utf-8')
        if len(data) >= 2048:
            return False
        flags = os.O_WRONLY | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
        options = {}
        target = str(file)
        if os.open in os.supports_dir_fd:
            parent_fd = os.open(str(file.parent), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            target = file.name
            options['dir_fd'] = parent_fd
        try:
            fd = os.open(target, flags | os.O_CREAT | os.O_EXCL, 0o600, **options)
            created = True
        except FileExistsError:
            fd = os.open(target, flags, **options)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            return False
        if created:
            os.fchown(fd, 1000, 1000)
        # One O_APPEND write prevents two writers from interleaving event bodies.
        written = os.write(fd, data) == len(data)
        return written
    except (OSError, ValueError):
        return False
    finally:
        if fd is not None:
            if created and not written:
                try:
                    current = os.stat(str(file), follow_symlinks=False)
                    opened = os.fstat(fd)
                    if current.st_dev == opened.st_dev and current.st_ino == opened.st_ino and current.st_size == 0:
                        file.unlink()
                except OSError:
                    pass
            try:
                os.close(fd)
            except OSError:
                pass
        if parent_fd is not None:
            try:
                os.close(parent_fd)
            except OSError:
                pass

@contextmanager
def snapshot_locks():
    # Match the service's exclusive-create locks; emergency disable never waits here.
    files = []
    try:
        if (BASE / 'data').exists():
            for directory in [BASE / 'data', BASE / 'data' / 'framework']:
                directory.mkdir(parents=True, exist_ok=True)
                lock = directory / '.write.lock'
                deadline = time.monotonic() + 5
                while True:
                    try:
                        fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                        break
                    except FileExistsError:
                        if time.monotonic() >= deadline:
                            fail('STORE_BUSY')
                        time.sleep(0.02)
                files.append((lock, fd))
                os.chown(str(lock), 1000, 1000)
                os.write(fd, json.dumps(dict(pid=os.getpid(), source='rivetin-cli')).encode())
                os.fsync(fd)
        yield
    finally:
        for lock, fd in reversed(files):
            same_file = lock.exists() and os.stat(str(lock)).st_ino == os.fstat(fd).st_ino
            os.close(fd)
            if same_file:
                lock.unlink()

def transaction(op):
    if not re.fullmatch('[a-f0-9]{32}', op or ''):
        fail('INVALID_OPERATION_ID')
    if pending() != op:
        fail('INSTALLER_OPERATION_MISMATCH')
    return BASE / 'backups' / op

def extract_release(data, target):
    allowed = {'cli.mjs', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'}
    contents = {}
    if len(data) > 8 * 1024 * 1024:
        fail('SERVICE_ARCHIVE_LIMIT')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        total = 0
        for index, m in enumerate(archive):
            total += m.size
            if index >= 100 or m.size < 0 or total > 4 * 1024 * 1024:
                fail('SERVICE_ARCHIVE_LIMIT')
            name = m.name.rstrip('/')
            if name.startswith('./'):
                name = name[2:]
            if not name or name.startswith('/') or '..' in name.split('/') or '\\' in name or m.issym() or m.islnk():
                fail('SERVICE_ARCHIVE_INVALID')
            if m.isdir():
                if name not in ['server', 'deploy', 'server/vendor', 'server/builtins', 'shared']:
                    fail('SERVICE_ARCHIVE_INVALID')
                continue
            if not m.isfile() or not (name in allowed or name in ['shared/identity.js', 'shared/version.js', 'server/vendor/ssh2.cjs', 'server/builtins/rivetin-ssh-channel.json'] or re.fullmatch(r'(server/[a-z-]+\.js|deploy/[a-z.-]+)', name)):
                fail('SERVICE_ARCHIVE_INVALID')
            if name in contents:
                fail('SERVICE_ARCHIVE_INVALID')
            contents[name] = archive.extractfile(m).read()
    if 'server/main.js' not in contents:
        fail('SERVICE_ARCHIVE_INVALID')
    for name, content in contents.items():
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(str(dest), 'xb') as f:
            f.write(content)
        os.chmod(str(dest), 0o644)
    return contents

def framework_metadata():
    file = BASE / 'data' / 'framework' / 'settings.json'
    if not file.exists():
        return None
    stored = json.loads(file.read_text())
    if not isinstance(stored, dict) or type(stored.get('apiVersion')) is not int or stored['apiVersion'] != 1 or stored.get('version') not in KNOWN_METADATA_VERSIONS:
        fail('FRAMEWORK_MIGRATION_REQUIRED')
    return dict(apiVersion=1, version=stored['version'])

def saved_framework_metadata(backup):
    file = backup / 'framework-version-before.json'
    if not file.exists():
        return None  # Legacy recovery records never authorize a metadata change.
    stored = json.loads(file.read_text())
    if stored is not None and (not isinstance(stored, dict) or set(stored) != {'apiVersion', 'version'} or type(stored['apiVersion']) is not int or stored['apiVersion'] != 1 or stored['version'] not in KNOWN_METADATA_VERSIONS):
        fail('FRAMEWORK_MIGRATION_REQUIRED')
    return stored

def prepare(req, found):
    op = req['operation']
    if not re.fullmatch('[a-f0-9]{32}', op):
        fail('INVALID_OPERATION_ID')
    if found['pending']:
        fail('INSTALLER_RECOVERY_REQUIRED')
    if req.get('mode') not in ['install', 'update', 'uninstall']:
        fail('INVALID_INSTALLER_MODE')
    old = base64.b64decode(req.get('islandBackup', ''), validate=True)
    if len(old) > 16 * 1024 * 1024:
        fail('ISLAND_BACKUP_LIMIT')
    if found['installed'] and not found['managed']:
        fail('EXISTING_INSTALLATION_UNMANAGED')
    framework_metadata()
    if (BASE.exists() and any(BASE.iterdir()) and not owner_marker()):
        fail('EXISTING_INSTALLATION_UNMANAGED')
    if req['mode'] == 'install' and found['installed']:
        fail('ALREADY_INSTALLED_USE_UPDATE')
    if req['mode'] != 'install' and not found['installed']:
        fail('FRAMEWORK_NOT_INSTALLED')
    backup = BASE / 'backups' / op
    if backup.exists():
        fail('OPERATION_ALREADY_EXISTS')
    before = resources()
    if not owned(before) or bool(before) != found['installed']:
        fail('RESOURCE_OWNERSHIP_MISMATCH')
    BASE.mkdir(parents=True, exist_ok=True)
    lock = BASE / 'installer-lock'
    try:
        lock.mkdir()
    except FileExistsError:
        fail('INSTALLER_RECOVERY_REQUIRED')
    (lock / 'operation').write_text(op)
    os.chmod(str(lock / 'operation'), 0o600)
    backup.mkdir(parents=True)
    os.chmod(str(backup), 0o700)
    atomic(backup / 'resources.json', before)
    atomic(backup / 'state.json', dict(mode=req['mode'], phase='preparing', operation=op))
    (backup / 'island.tar.gz').write_bytes(old)
    with snapshot_locks():
        atomic(backup / 'framework-version-before.json', framework_metadata())
        if (BASE / 'data').exists():
            # Recovery never overwrites active settings with this snapshot.
            with tarfile.open(str(backup / 'data.tar.gz'), 'w:gz') as archive:
                archive.add(str(BASE / 'data'), arcname='data',
                    filter=lambda item: None if item.name in ['data/.write.lock', 'data/framework/.write.lock'] else item)
        (BASE / 'installer-owner').write_text(OWNER)
        disable()
    atomic(backup / 'state.json', dict(mode=req['mode'], phase='prepared', operation=op))
    recorded = record_audit('framework.' + req['mode'] + '.started', 'started')
    return dict(operation=op, phase='prepared', auditRecorded=recorded)

def validate_manifest(manifest, checksum):
    if manifest.get('apiVersion') != 'v1' or manifest.get('kind') != 'List' or len(manifest.get('items', [])) != 3:
        fail('MANIFEST_INVALID')
    items = manifest['items']
    if sorted(item.get('kind', '') for item in items) != ['Deployment', 'Ingress', 'Service'] or not owned(items):
        fail('MANIFEST_INVALID')
    versions = {'Deployment': 'apps/v1', 'Ingress': 'networking.k8s.io/v1', 'Service': 'v1'}
    for item in items:
        if item.get('apiVersion') != versions[item['kind']]:
            fail('MANIFEST_INVALID')
        if set(item) != {'apiVersion', 'kind', 'metadata', 'spec'} or set(item['metadata']) != {'name', 'namespace', 'annotations'}:
            fail('MANIFEST_INVALID')
        annotations = {'rivetin/managed-by': OWNER}
        if item['kind'] == 'Ingress':
            annotations.update({'kubernetes.io/ingress.class': 'nginx',
                'nginx.ingress.kubernetes.io/proxy-body-size': '16m',
                'nginx.ingress.kubernetes.io/proxy-read-timeout': '15',
                'nginx.ingress.kubernetes.io/force-ssl-redirect': 'true'})
        if item['metadata']['annotations'] != annotations:
            fail('MANIFEST_INVALID')
    deployment = next(item for item in items if item['kind'] == 'Deployment')
    spec = deployment.get('spec', {})
    template = spec.get('template', {})
    pod = template.get('spec', {})
    labels = {'app': 'rivetin'}
    if spec.get('replicas') != 1 or spec.get('strategy') != {'type': 'Recreate'} or spec.get('selector') != {'matchLabels': labels} or template.get('metadata', {}).get('labels') != labels:
        fail('MANIFEST_INVALID')
    if template.get('metadata') != {'labels': labels, 'annotations': {'rivetin/code-sha256': checksum}}:
        fail('MANIFEST_INVALID')
    if set(pod) != {'automountServiceAccountToken', 'enableServiceLinks', 'containers', 'volumes'} or pod.get('automountServiceAccountToken') is not False or pod.get('enableServiceLinks') is not False:
        fail('MANIFEST_INVALID')
    containers = pod.get('containers', [])
    if len(containers) != 1:
        fail('MANIFEST_INVALID')
    container = containers[0]
    if set(container) != {'name', 'image', 'imagePullPolicy', 'workingDir', 'command', 'env', 'ports', 'resources', 'securityContext', 'readinessProbe', 'livenessProbe', 'volumeMounts'}:
        fail('MANIFEST_INVALID')
    if container.get('name') != 'rivetin' or container.get('image') != IMAGE or container.get('imagePullPolicy') != 'IfNotPresent' or container.get('workingDir') != '/opt/rivetin' or container.get('command') != ['node', 'server/main.js']:
        fail('MANIFEST_INVALID')
    security = {'runAsUser': 1000, 'runAsGroup': 1000, 'allowPrivilegeEscalation': False,
                'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}}
    if container.get('securityContext') != security:
        fail('MANIFEST_INVALID')
    expected_volumes = [
        {'name': 'code', 'hostPath': {'path': str(BASE / 'releases' / checksum), 'type': 'Directory'}},
        {'name': 'data', 'hostPath': {'path': str(BASE / 'data'), 'type': 'Directory'}}]
    if pod.get('volumes') != expected_volumes or container.get('volumeMounts') != [
            {'name': 'code', 'mountPath': '/opt/rivetin', 'readOnly': True},
            {'name': 'data', 'mountPath': '/var/lib/rivetin'}]:
        fail('MANIFEST_INVALID')
    environment = container.get('env', [])
    if len(environment) != 3 or any(set(item) != {'name', 'value'} for item in environment):
        fail('MANIFEST_INVALID')
    values = {item['name']: item['value'] for item in environment}
    if set(values) != {'RIVETIN_' + key for key in ['DATA', 'TOWER_URL', 'ORIGINS']}:
        fail('MANIFEST_INVALID')
    values = {key: values['RIVETIN_' + key] for key in ['DATA', 'TOWER_URL', 'ORIGINS']}
    if values['DATA'] != '/var/lib/rivetin' or values['TOWER_URL'] != 'http://cloudtower-cloudtower.cloudtower-system.svc.cluster.local':
        fail('MANIFEST_INVALID')
    origin = urlsplit(values['ORIGINS'])
    if origin.scheme != 'https' or not origin.hostname or origin.username or origin.password or origin.path or origin.query or origin.fragment:
        fail('MANIFEST_INVALID')
    expected_probe = {'httpGet': {'path': '/healthz', 'port': 8787}}
    if container.get('readinessProbe') != expected_probe or container.get('livenessProbe') != dict(expected_probe, initialDelaySeconds=10):
        fail('MANIFEST_INVALID')
    if container.get('ports') != [{'containerPort': 8787}] or container.get('resources') != {
            'requests': {'cpu': '20m', 'memory': '48Mi'}, 'limits': {'cpu': '500m', 'memory': '256Mi'}}:
        fail('MANIFEST_INVALID')
    service = next(item for item in items if item['kind'] == 'Service')
    if service.get('spec') != {'selector': labels, 'ports': [{'port': 8787, 'targetPort': 8787}]}:
        fail('MANIFEST_INVALID')
    ingress = next(item for item in items if item['kind'] == 'Ingress')
    def ingress_spec(paths):
        return {'rules': [{'http': {'paths': [{'path': prefix, 'pathType': 'Prefix',
            'backend': {'service': {'name': RESOURCE_NAME, 'port': {'number': 8787}}}} for prefix in paths]}}], 'tls': [{'secretName': 'cloudtower-tls'}]}
    if ingress.get('spec') != ingress_spec(API_PREFIXES):
        fail('MANIFEST_INVALID')

def apply(req, backup):
    state = json.loads((backup / 'state.json').read_text())
    if state['phase'] != 'prepared' or state['mode'] not in ['install', 'update'] or req.get('mode') != state['mode']:
        fail('INVALID_INSTALLER_PHASE')
    if not owned(resources()):
        fail('RESOURCE_OWNERSHIP_MISMATCH')
    raw = base64.b64decode(req['service'], validate=True)
    checksum = hashlib.sha256(raw).hexdigest()
    if checksum != req['serviceSHA256']:
        fail('SERVICE_CHECKSUM_FAILED')
    target = BASE / 'releases' / checksum
    stage = backup / 'release'
    stage.mkdir()
    expected = extract_release(raw, stage)
    package = json.loads(expected.get('package.json', b'{}'))
    target_version = package.get('version')
    if not (backup / 'framework-version-before.json').is_file():
        fail('FRAMEWORK_MIGRATION_REQUIRED')
    before_version = saved_framework_metadata(backup)
    if package.get('name') != 'rivetin' or target_version not in KNOWN_METADATA_VERSIONS:
        fail('FRAMEWORK_MIGRATION_REQUIRED')
    if before_version and before_version['version'] != target_version and (before_version['version'], target_version) not in METADATA_UPGRADES:
        fail('FRAMEWORK_MIGRATION_REQUIRED')
    if target.exists():
        # Compare with the shipped archive, not a mutable on-disk inventory.
        for name, content in expected.items():
            if (target / name).read_bytes() != content:
                fail('INSTALLED_CODE_CHANGED')
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.rename(str(stage), str(target))
    manifest = json.loads(base64.b64decode(req['manifest'], validate=True))
    validate_manifest(manifest, checksum)
    atomic(backup / 'desired.json', manifest)
    atomic(backup / 'state.json', dict(mode=state['mode'], phase='applying', operation=req['operation']))
    kube('apply', '-f', '-', data=json.dumps(manifest).encode())
    kube('rollout', 'status', 'deployment/rivetin', '--timeout=%ss' % APPLY_ROLLOUT_SECONDS,
         timeout=APPLY_ROLLOUT_PROCESS_SECONDS)
    init = ['exec', 'deployment/rivetin', '--', 'node', 'cli.mjs', 'init', '--data', '/var/lib/rivetin']
    if before_version and before_version['version'] != target_version:
        init += ['--upgrade-from', before_version['version']]
    kube(*init)
    atomic(backup / 'state.json', dict(mode=req['mode'], phase='backend-ready', operation=req['operation']))
    return dict(phase='backend-ready')

def remove_owned():
    items = resources()
    if not owned(items):
        fail('RESOURCE_OWNERSHIP_MISMATCH')
    for item in items:
        # Only three fixed names belonging to this installer. Data/releases/backups remain.
        kube('delete', item['kind'].lower(), 'rivetin', '--ignore-not-found', '--wait=true', '--timeout=30s', timeout=40)

def rollback(backup):
    before = json.loads((backup / 'resources.json').read_text())
    previous = saved_framework_metadata(backup)
    if not owned(resources()):
        fail('RESOURCE_OWNERSHIP_MISMATCH')
    # Fail closed throughout restoration; only version metadata may be reverted.
    disable()
    with snapshot_locks():
        current = framework_metadata()
        if previous and current and previous != current:
            if (previous['version'], current['version']) not in METADATA_UPGRADES:
                fail('FRAMEWORK_MIGRATION_REQUIRED')
            file = BASE / 'data' / 'framework' / 'settings.json'
            stored = json.loads(file.read_text())
            atomic(file, dict(stored, version=previous['version']), True)
    if before:
        if not owned(resources()):
            fail('RESOURCE_OWNERSHIP_MISMATCH')
        cleaned = []
        for item in before:
            item.pop('status', None)
            for field in ['uid', 'resourceVersion', 'creationTimestamp', 'managedFields', 'generation']:
                item['metadata'].pop(field, None)
            cleaned.append(item)
        kube('apply', '-f', '-', data=json.dumps(dict(apiVersion='v1', kind='List', items=cleaned)).encode())
        kube('rollout', 'status', 'deployment/rivetin', '--timeout=90s', timeout=100)
    else:
        remove_owned()
    # Always remain disabled after rollback, retaining all settings and recovery backups.
    disable()

def finish(backup, phase):
    state = json.loads((backup / 'state.json').read_text())
    atomic(backup / 'state.json', dict(state, phase=phase))
    (BASE / 'installer-lock' / 'operation').unlink()
    (BASE / 'installer-lock').rmdir()

def sync_directory(directory):
    # Tower runs Linux; directory fsync makes the rename durable there.
    if not hasattr(os, 'O_DIRECTORY'):
        return
    fd = os.open(str(directory), os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def reset_config(req, found):
    op = req.get('operation', '')
    if not re.fullmatch('[a-f0-9]{32}', op):
        fail('INVALID_OPERATION_ID')
    if found['pending']:
        fail('INSTALLER_RECOVERY_REQUIRED')
    if not owner_marker():
        fail('INSTALLER_OWNERSHIP_REQUIRED')
    if found['installed'] or resources():
        fail('UNINSTALL_FRAMEWORK_BEFORE_RESET')
    pods = json.loads(kube('get', 'pods', '-l', 'app=rivetin', '-o', 'json'))
    if pods.get('items'):
        fail('PLUGIN_PODS_STILL_PRESENT')
    data = BASE / 'data'
    if not data.exists():
        return dict(cleared=False, alreadyEmpty=True, retainedInBackup=True)
    if not data.is_dir():
        fail('UNSAFE_INSTALL_PATH')
    backup = BASE / 'backups' / op
    if backup.exists():
        fail('OPERATION_ALREADY_EXISTS')
    lock = BASE / 'installer-lock'
    try:
        lock.mkdir()
    except FileExistsError:
        fail('INSTALLER_RECOVERY_REQUIRED')
    (lock / 'operation').write_text(op)
    os.chmod(str(lock / 'operation'), 0o600)
    backup.mkdir(parents=True)
    os.chmod(str(backup), 0o700)
    atomic(backup / 'state.json', dict(mode='reset-config', phase='preparing', operation=op))
    archived = backup / 'cleared-data'
    try:
        inventory = []
        for directory, dirs, files in os.walk(str(data), followlinks=False):
            for name in dirs + files:
                if Path(directory, name).is_symlink():
                    fail('UNSAFE_INSTALL_PATH')
            for name in files:
                file = Path(directory, name)
                fd = os.open(str(file), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        fail('UNSAFE_INSTALL_PATH')
                    digest = hashlib.sha256()
                    with os.fdopen(fd, 'rb', closefd=False) as stream:
                        for block in iter(lambda: stream.read(1024 * 1024), b''):
                            digest.update(block)
                    inventory.append(dict(path=str(file.relative_to(data)).replace(os.sep, '/'),
                        bytes=info.st_size, sha256=digest.hexdigest()))
                finally:
                    os.close(fd)
        atomic(backup / 'manifest.json', dict(format='rivetin-cleared-data-v1', operation=op,
            source='data', archive='cleared-data', files=sorted(inventory, key=lambda item: item['path'])))
        atomic(backup / 'state.json', dict(mode='reset-config', phase='prepared', operation=op))
        sync_directory(backup)
        # Recheck after preparation so a concurrent manual reinstall fails closed.
        if resources() or json.loads(kube('get', 'pods', '-l', 'app=rivetin', '-o', 'json')).get('items'):
            fail('UNINSTALL_FRAMEWORK_BEFORE_RESET')
        os.rename(str(data), str(archived))
        sync_directory(BASE)
        sync_directory(backup)
        finish(backup, 'config-cleared')
        return dict(cleared=True, alreadyEmpty=False, retainedInBackup=True,
            operation=op, archive='backups/' + op + '/cleared-data', files=len(inventory))
    except Exception:
        if data.is_dir() and not archived.exists():
            finish(backup, 'failed-data-retained')
            raise
        # A completed rename with an unconfirmed journal remains locked for review.
        fail('RESET_CONFIG_OUTCOME_UNKNOWN')

def handle(req):
    action = req.get('action')
    if action == 'probe':
        return probe()
    if action not in ['prepare', 'apply', 'commit', 'rollback', 'backup', 'remove', 'disable', 'reset-config']:
        fail('UNKNOWN_ACTION')
    safe_base(emergency=action == 'disable')
    if action == 'disable':
        settings = BASE / 'data' / 'framework' / 'settings.json'
        if not settings.is_file() and not owner_marker():
            fail('FRAMEWORK_NOT_INSTALLED')
        disable()
        return dict(enabled=False, auditRecorded=record_audit('framework.disable'))
    found = gate()  # Deployment writes enforce the tested build independently.
    if action == 'reset-config':
        return reset_config(req, found)
    if action == 'prepare':
        return prepare(req, found)
    backup = transaction(req.get('operation'))
    if action == 'backup':
        state = json.loads((backup / 'state.json').read_text())
        return dict(islandBackup=base64.b64encode((backup / 'island.tar.gz').read_bytes()).decode(), mode=state['mode'])
    if action == 'apply':
        return apply(req, backup)
    if action == 'remove':
        state = json.loads((backup / 'state.json').read_text())
        if state['mode'] != 'uninstall' or state['phase'] != 'prepared':
            fail('INVALID_INSTALLER_PHASE')
        atomic(backup / 'state.json', dict(state, phase='removing'))
        remove_owned()
        atomic(backup / 'state.json', dict(state, phase='removed'))
        return dict(removed=True, dataRetained=True)
    if action == 'rollback':
        state = json.loads((backup / 'state.json').read_text())
        if state['mode'] not in ['install', 'update', 'uninstall']:
            fail('INVALID_INSTALLER_PHASE')
        rollback(backup)
        finish(backup, 'rolled-back')
        return dict(phase='rolled-back', auditRecorded=record_audit('framework.rollback'))
    state = json.loads((backup / 'state.json').read_text())
    if state['phase'] not in ['backend-ready', 'removed']:
        fail('INVALID_INSTALLER_PHASE')
    finish(backup, 'committed')
    return dict(phase='committed', enabled=False, auditRecorded=record_audit('framework.' + state['mode']))

if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(32 * 1024 * 1024 + 1))
        print(json.dumps(dict(ok=True, data=handle(request))))
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z_]{1,80}', str(error)) else 'REMOTE_OPERATION_FAILED'
        print(json.dumps(dict(ok=False, code=code)))
        sys.exit(1)

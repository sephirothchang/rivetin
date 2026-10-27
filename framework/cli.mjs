import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createService } from './server/service.js';
import { builtinPackages } from './server/builtins.js';

const [command, ...args] = process.argv.slice(2), index = args.indexOf('--data');
if (index < 0 || !args[index + 1]) {
  console.error('Usage: node framework/cli.mjs <init|status|disable|enable|upload|install|update|rollback|reset|uninstall|logs> --data <absolute-data-directory> [plugin-id] [package-id-or-file]'); process.exitCode = 1;
} else {
  const directory = args[index + 1]; args.splice(index, 2);
  try {
    if (!path.isAbsolute(directory)) throw new Error('ABSOLUTE_DATA_PATH_REQUIRED');
    const service = createService(directory, { builtinPackages: await builtinPackages({ required: command === 'init' }) }), actor = { id: 'local-operator', name: 'Local CLI operator', source: 'cli', admin: true };
    let result;
    if (command === 'init') result = await service.initialize(actor);
    else if (command === 'status') result = await service.runtime();
    else if (command === 'disable') result = await service.disable(actor);
    else if (command === 'enable') result = args[0] ? await service.change('enable', args[0], null, actor) : await service.enable(actor);
    else if (command === 'upload') result = await service.upload(await readFile(args[0]), actor);
    else if (command === 'logs') result = await service.logs({ limit: 50, pluginId: args[0] });
    else if (command === 'ssh-hosts') result = await service.sshHosts.list();
    else if (command === 'ssh-host-put') {
      if (args.length) throw new Error('SSH_PROFILE_STDIN_REQUIRED');
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new Error('SSH_PROFILE_TOO_LARGE'); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks);
      try {
        const profile = JSON.parse(bytes.toString('utf8'));
        await service.sshSaveHost(profile, actor);
        result = { saved: true, approvalsRevoked: true };
      } finally { bytes.fill(0); }
    }
    else if (command === 'ssh-host-remove') {
      if (args.length !== 1) throw new Error('SSH_HOST_ID_REQUIRED');
      await service.sshRemoveHost(args[0], actor); result = { removed: true, approvalsRevoked: true };
    }
    else if (command === 'ssh-revoke') result = await service.sshChannel.revoke(args[0], actor);
    else if (['install', 'update', 'rollback', 'reset', 'uninstall', 'plugin-disable'].includes(command)) result = await service.change(command === 'plugin-disable' ? 'disable' : command, args[0], args[1], actor);
    else throw new Error('UNKNOWN_COMMAND');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) { console.error(/^[A-Z_]+$/.test(error.message) ? error.message : 'CLI_OPERATION_FAILED'); process.exitCode = 1; }
}

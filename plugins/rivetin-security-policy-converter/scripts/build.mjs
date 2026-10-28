import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { captureInputs, assertSameInputs, captureOutputs } from './build-inputs.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = createRequire(path.join(root, '../../framework/package.json'));
const inputs = await captureInputs(root);
let notices = 'Local demo dependencies. Production plugin uses React supplied by Rivetin.\n';
for (const name of ['react', 'react-dom', 'scheduler', 'object-assign']) {
  const directory = path.dirname(framework.resolve(`${name}/package.json`));
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  notices += `\n--- ${name} ${metadata.version} ---\n${await readFile(path.join(directory, 'LICENSE'), 'utf8')}\n`;
}
const compiler = framework('webpack')(createRequire(import.meta.url)('../webpack.config.cjs'));
await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(closeError => {
  if (error || closeError) { reject(error || closeError); return; }
  if (stats.hasErrors()) { reject(new Error(stats.toString({ colors: false, preset: 'errors-warnings' }))); return; }
  console.log('Plugin and offline demo compiled successfully.'); resolve();
})));
await mkdir(path.join(root, 'dist/demo'), { recursive: true });
await writeFile(path.join(root, 'dist/demo/THIRD_PARTY_NOTICES.txt'), notices);
assertSameInputs(inputs, await captureInputs(root));
await writeFile(path.join(root, 'dist/build-inputs.json'), JSON.stringify({ format: 'rivetin-local-build-v1', inputs, outputs: await captureOutputs(root) }, null, 2));

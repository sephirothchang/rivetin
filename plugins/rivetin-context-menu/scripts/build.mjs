import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const framework = createRequire(path.join(root, '../../framework/package.json'));
const webpack = framework('webpack');
const configuration = createRequire(import.meta.url)('../webpack.config.cjs');
const compiler = webpack(configuration);
compiler.run((error, stats) => {
  compiler.close(closeError => {
    if (error || closeError) { console.error((error || closeError).message); process.exitCode = 1; return; }
    console.log(stats.toString({ colors: false, preset: 'errors-warnings' }));
    if (stats.hasErrors()) process.exitCode = 1;
  });
});

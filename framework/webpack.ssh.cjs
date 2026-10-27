const path = require('node:path');
const webpack = require('webpack');
module.exports = {
  name: 'ssh-runtime', mode: 'production', target: 'node20',
  entry: './scripts/ssh-runtime.cjs',
  output: { path: path.resolve(__dirname, 'server/vendor'), filename: 'ssh2.cjs', library: { type: 'commonjs2' }, clean: false },
  externalsPresets: { node: true },
  plugins: [new webpack.IgnorePlugin({ checkResource: resource => resource === 'cpu-features' || /(?:^|\/)sshcrypto\.node$/.test(resource) })],
  optimization: { minimize: false }, performance: { hints: false },
};

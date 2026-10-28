const path = require('node:path');
const common = { context: __dirname, mode: 'production', performance: { hints: false },
  optimization: { splitChunks: false, runtimeChunk: false }, devtool: false };
module.exports = [{
  ...common, name: 'network-topology-preview', entry: './src/definition.js',
  output: { path: path.resolve(__dirname, 'dist/rivetin'), filename: 'plugin.js',
    library: { type: 'window', name: ['RivetinPlugins', 'rivetin-network-topology'] }, clean: true }
}, {
  ...common, name: 'network-topology-demo', entry: './demo/bootstrap.js',
  output: { path: path.resolve(__dirname, 'dist/demo'), filename: 'demo.js', clean: true }
}];

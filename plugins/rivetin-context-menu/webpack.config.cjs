const path = require('node:path');
const { createRequire } = require('node:module');
const framework = createRequire(path.resolve(__dirname, '../../framework/package.json'));
const common = { context: __dirname, mode: 'production', performance: { hints: false },
  optimization: { splitChunks: false, runtimeChunk: false } };
module.exports = [{
  ...common, name: 'context-menu-child', entry: './src/definition.js',
  output: { path: path.resolve(__dirname, 'dist/rivetin'), filename: 'plugin.js',
    library: { type: 'window', name: ['RivetinPlugins', 'rivetin-context-menu'] }, clean: true },
  externalsType: 'window', externals: { react: ['RivetinSDK', 'React'] },
}, {
  ...common, name: 'context-menu-demo', entry: './demo/bootstrap.js',
  output: { path: path.resolve(__dirname, 'dist/demo'), filename: 'demo.js', clean: true },
  resolve: { alias: { react: framework.resolve('react'), 'react-dom': framework.resolve('react-dom') } },
}];

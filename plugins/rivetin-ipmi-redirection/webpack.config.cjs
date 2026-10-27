const path = require('node:path');
const { container: { ModuleFederationPlugin } } = require('webpack');
const shared = {
  react: { singleton: true, requiredVersion: '16.14.0' },
  'react-dom': { singleton: true, requiredVersion: '16.14.0' },
};
function remote(demo) {
  return {
    name: demo ? 'demo-island' : 'production-island',
    mode: 'production', entry: {}, devtool: 'source-map',
    output: {
      path: path.resolve(__dirname, demo ? 'dist/demo/island' : 'dist/production/build'),
      publicPath: 'auto', uniqueName: demo ? 'rivetinIpmiRedirectionDemo' : 'rivetin-ipmi-redirection',
      filename: '[name].[contenthash:8].js', chunkFilename: '[name].[contenthash:8].js',
      clean: true,
    },
    plugins: [new ModuleFederationPlugin({
      name: demo ? 'rivetinIpmiRedirectionDemo' : 'rivetin-ipmi-redirection', filename: 'remoteEntry.js',
      library: { type: demo ? 'var' : 'window', name: demo ? 'rivetinIpmiRedirectionDemo' : 'rivetin-ipmi-redirection' },
      exposes: { './RivetinIpmiRedirection': demo ? './demo/island.js' : './src/island.js' }, shared,
    })],
    performance: { hints: false },
  };
}
module.exports = [remote(false), remote(true), {
  name: 'rivetin-child', mode: 'production', entry: './src/definition.js',
  output: { path: path.resolve(__dirname, 'dist/rivetin'), filename: 'plugin.js',
    library: { type: 'window', name: ['RivetinPlugins', 'rivetin-ipmi-redirection'] }, clean: true },
  externalsType: 'window', externals: { react: ['RivetinSDK', 'React'] },
  optimization: { splitChunks: false, runtimeChunk: false }, performance: { hints: false },
}, {
  name: 'local-harness', mode: 'production', entry: './demo/bootstrap.js', devtool: 'source-map',
  output: { path: path.resolve(__dirname, 'dist/demo/host'), filename: 'harness.js', publicPath: 'auto', uniqueName: 'rivetinLocalHarness', clean: true },
  plugins: [new ModuleFederationPlugin({ name: 'rivetinLocalHarness',
    remotes: { rivetinDemo: 'rivetinFrameworkDemo@http://127.0.0.1:43170/framework/remoteEntry.js' }, shared,
  })], performance: { hints: false },
}];

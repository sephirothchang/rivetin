const path = require('node:path');
const { container: { ModuleFederationPlugin } } = require('webpack');
module.exports = [false, true].map(demo => ({
  name: demo ? 'framework-demo' : 'framework-island', mode: 'production', entry: {},
  output: { path: path.resolve(__dirname, demo ? 'dist/demo' : 'dist/production/build'), publicPath: 'auto', filename: '[name].[contenthash:8].js', chunkFilename: '[name].[contenthash:8].js', uniqueName: demo ? 'rivetinFrameworkDemo' : 'rivetin', clean: true },
  plugins: [new ModuleFederationPlugin({ name: demo ? 'rivetinFrameworkDemo' : 'rivetin', filename: 'remoteEntry.js',
    library: { type: 'window', name: demo ? 'rivetinFrameworkDemo' : 'rivetin' }, exposes: { './Rivetin': demo ? './demo/island.js' : './src/island.js' },
    shared: { react: { singleton: true, requiredVersion: '16.14.0' }, 'react-dom': { singleton: true, requiredVersion: '16.14.0' },
      '@tower/i18n': { import: false, singleton: true, requiredVersion: false } } })], performance: { hints: false },
}));

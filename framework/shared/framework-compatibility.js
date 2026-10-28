import { FRAMEWORK_VERSION } from './version.js';

// Runtime product-version compatibility does not replace the CLI image profile.
export const FRAMEWORK_COMPATIBILITY = Object.freeze({
  schemaVersion: 1,
  frameworkApi: 1,
  frameworkVersion: FRAMEWORK_VERSION,
  towerBuilds: Object.freeze(['4.9.0']),
});

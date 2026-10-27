import { createConfigurationStore as createStore, createHttpConfigurationBackend as createBackend } from '../../../framework/src/config-store.js';
import { PLUGIN_ID } from './identity.js';
import { functionalEqual, sanitizeFunctionalSettings, seedClusterExceptions, validateFunctionalSettings } from './configuration.js';
export const configurationDefinition = { id: PLUGIN_ID, defaults: sanitizeFunctionalSettings, equal: functionalEqual, seed: seedClusterExceptions, validate: validateFunctionalSettings };
export const createConfigurationStore = (win, backend) => createStore(win, backend, configurationDefinition);
export const createHttpConfigurationBackend = (win, endpoint) => createBackend(win, configurationDefinition, endpoint);

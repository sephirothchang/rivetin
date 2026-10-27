// Compatibility entry for the original standalone prototype.
import { createFrameworkHub } from '../../../framework/src/hub.js';
import createIpmiPlugin from './definition.js';
import { PLUGIN_ID } from './identity.js';
import React from 'react';
import ReactDOM from 'react-dom';
export function createPluginHub(options = {}) {
  return createFrameworkHub({ React, ReactDOM, ...options, definitions: { [PLUGIN_ID]: createIpmiPlugin }, initialTab: PLUGIN_ID });
}

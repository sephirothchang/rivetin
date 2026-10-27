import React, { useEffect, useState } from 'react';
import { i18next } from '@tower/i18n';
import { createFrameworkHub } from './hub.js';
const Hub = createFrameworkHub();
export default function PluginKitIsland(props) {
  const [locale, setLocale] = useState(i18next.resolvedLanguage || i18next.language);
  useEffect(() => {
    const change = value => setLocale(value);
    i18next.on('languageChanged', change);
    return () => i18next.off('languageChanged', change);
  }, []);
  return React.createElement(Hub, { ...props, locale });
}

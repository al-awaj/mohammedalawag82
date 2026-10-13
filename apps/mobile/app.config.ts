import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Store identity per deployment, without code changes (app.json holds the shared defaults):
 *   APP_NAME            name under the icon                 (default: مناسبات)
 *   APP_ID              iOS bundle id and Android package   (default: com.example.events — must be replaced before store submission)
 *   APP_SCHEME          deep-link scheme                    (default: events)
 *   EAS_PROJECT_ID      Expo project for EAS builds/updates (optional)
 *   EXPO_PUBLIC_API_URL / EXPO_PUBLIC_BRAND_AR are read by the app itself at build time.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const id = process.env.APP_ID || 'com.example.events';
  return {
    ...config,
    name: process.env.APP_NAME || config.name || 'مناسبات',
    slug: config.slug ?? 'events-platform',
    scheme: process.env.APP_SCHEME || 'events',
    ios: { ...config.ios, bundleIdentifier: id },
    android: { ...config.android, package: id },
    extra: { ...config.extra, ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}) },
  };
};

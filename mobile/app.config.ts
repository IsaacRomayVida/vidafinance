import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * app.json holds everything static; this file exists for the one value that
 * cannot be static — where the web export is mounted.
 *
 * Expo bakes `experiments.baseUrl` into the exported HTML as an absolute
 * path, so a build made for `/app` asks for `/app/_expo/...` no matter who
 * serves it. Behind the Suena review portal the app lives at `/funpay/app`,
 * those requests miss, and the page renders blank with a 200 — nothing in
 * the response says anything is wrong.
 *
 * EXPO_PORTAL_BASE is that mount point. Unset it and you get `/app`, which
 * is what the standalone portal and every local build expect; the deploy
 * workflow sets it to the holding prefix.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const base = process.env.EXPO_PORTAL_BASE?.trim() || '/app';
  if (!base.startsWith('/') || base.endsWith('/')) {
    throw new Error(
      `EXPO_PORTAL_BASE must start with "/" and not end with one — got "${base}". ` +
        'A trailing slash produces "//_expo/..." in the exported HTML.'
    );
  }
  return {
    ...(config as ExpoConfig),
    experiments: { ...config.experiments, baseUrl: base },
  };
};

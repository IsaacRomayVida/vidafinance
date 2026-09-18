/**
 * MetaMap identity verification — native-first with a WebView fallback.
 *
 * In a real build (EAS .apk / store) the native MetaMap SDK is linked and
 * drives the full-screen camera flow directly. In Expo Go the native module
 * does not exist — `nativeKycAvailable()` reports false and the onboarding
 * wizard falls back to the web-widget WebView (KycWebView), the same flow
 * the web app runs. Both paths end in the same place: a verificationId +
 * identityId pair written onto employees/{uid}, which the MetaMap webhook
 * later matches to flip metamapStatus to 'verified'.
 */
import { NativeEventEmitter, NativeModules } from 'react-native';

import { METAMAP_CLIENT_ID, METAMAP_FLOW_ID, type KycResult } from '../components/KycWebView';

export type { KycResult };

export function nativeKycAvailable(): boolean {
  try {
    // The package's index.js getter throws when the native module is not
    // linked (Expo Go); presence of the raw module is the real signal.
    return !!NativeModules.MetaMapRNSdk;
  } catch {
    return false;
  }
}

/**
 * Launch the native MetaMap flow. Resolves with the ids on success, with
 * 'canceled' when the borrower backs out. Rejects only when the module is
 * missing — callers should check nativeKycAvailable() first.
 */
export function launchNativeKyc(
  metadata: Record<string, string>
): Promise<KycResult | 'canceled'> {
  return new Promise((resolve, reject) => {
    const module = NativeModules.MetaMapRNSdk;
    if (!module) {
      reject(new Error('MetaMap native module not linked'));
      return;
    }
    const emitter = new NativeEventEmitter(module);
    const subs = [
      emitter.addListener(
        'verificationSuccess',
        (data: { verificationId?: string; identityId?: string }) => {
          subs.forEach((s) => s.remove());
          resolve({
            verificationId: data?.verificationId ?? '',
            identityId: data?.identityId ?? '',
          });
        }
      ),
      emitter.addListener('verificationCanceled', () => {
        subs.forEach((s) => s.remove());
        resolve('canceled');
      }),
    ];
    try {
      (
        module as {
          showFlow: (c: string, f: string, m: Record<string, string>) => void;
        }
      ).showFlow(METAMAP_CLIENT_ID, METAMAP_FLOW_ID, { ...metadata, language: 'es' });
    } catch (err) {
      subs.forEach((s) => s.remove());
      reject(err as Error);
    }
  });
}

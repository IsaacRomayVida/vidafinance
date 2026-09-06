/**
 * MetaMap identity verification inside the app.
 *
 * The web onboarding uses MetaMap's *web* widget (button.js), which means
 * there is a WebView path that needs no native SDK and works in Expo Go: an
 * inline HTML page hosts the widget, and the page relays the SDK's DOM
 * events (metamap:userFinishedSdk / metamap:exitedSdk) to React Native via
 * postMessage. The verificationId captured here is what the MetaMap webhook
 * later matches to flip metamapStatus to 'verified' — the money gate.
 *
 * Camera notes: getUserMedia needs a secure context (the https baseUrl) and
 * the mediaCapture* props below; if the widget still cannot open the camera
 * on some device, the wizard's "verify later" path keeps signup unblocked.
 */
import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';

import { colors } from '../theme';

// Same widget identity the web onboarding passes (public-v2 Onboarding.tsx).
export const METAMAP_CLIENT_ID = '69c5763020d348c911b0a852';
export const METAMAP_FLOW_ID = '69d63c07940df362adbef105';

export interface KycResult {
  verificationId: string;
  identityId: string;
}

export function KycWebView({
  metadata,
  onFinished,
  onExited,
}: {
  metadata: Record<string, string>;
  onFinished: (result: KycResult) => void;
  onExited: () => void;
}) {
  const html = useMemo(() => {
    const meta = JSON.stringify(JSON.stringify(metadata));
    return `<!doctype html><html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<script src="https://web-button.metamap.com/button.js"></script>
<style>
  html,body{margin:0;height:100%;background:${colors.bg};display:flex;align-items:center;justify-content:center;}
  metamap-button{transform:scale(1.1);}
</style>
</head><body>
<metamap-button clientid="${METAMAP_CLIENT_ID}" flowid="${METAMAP_FLOW_ID}"></metamap-button>
<script>
  var btn = document.querySelector('metamap-button');
  btn.setAttribute('metadata', JSON.parse(${meta}) ? ${meta} : '{}');
  function send(type, detail){
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: type, detail: detail || {} }));
  }
  btn.addEventListener('metamap:userFinishedSdk', function (e) {
    send('finished', e.detail);
  });
  btn.addEventListener('metamap:exitedSdk', function () { send('exited'); });
  // Open the flow immediately — the borrower already tapped "verify" in RN.
  setTimeout(function(){ try { btn.shadowRoot ? btn.click() : btn.click(); } catch (e) {} }, 600);
</script>
</body></html>`;
  }, [metadata]);

  return (
    <WebView
      originWhitelist={['*']}
      source={{ html, baseUrl: 'https://funpay.mx' }}
      style={styles.web}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      mediaCapturePermissionGrantType="grant"
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data) as {
            type: string;
            detail?: { verificationId?: string; identityId?: string };
          };
          if (message.type === 'finished') {
            onFinished({
              verificationId: message.detail?.verificationId ?? '',
              identityId: message.detail?.identityId ?? '',
            });
          } else if (message.type === 'exited') {
            onExited();
          }
        } catch {
          // Non-JSON noise from the page: ignore.
        }
      }}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: colors.bg },
});

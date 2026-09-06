import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { es } from './es';

// Spanish-only for v1, deliberately: every borrower-facing server message is
// Spanish, and shipping a half-translated English mode is worse than none.
// The resource layout matches public-v2/src/i18n so an English pass later is
// additive, not a refactor.
void i18n.use(initReactI18next).init({
  resources: { es: { translation: es } },
  lng: 'es',
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
});

export default i18n;

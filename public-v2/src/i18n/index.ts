import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from './es.json';
import en from './en.json';
import { safeGetItem, safeSetItem } from '../lib/safeStorage';

const savedLang = safeGetItem('vida_lang') || 'es';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      es: { translation: es },
      en: { translation: en },
    },
    lng: savedLang,
    fallbackLng: 'es',
    interpolation: { escapeValue: false },
  });

// Keep <html lang=""> in sync with the active language
document.documentElement.lang = savedLang;
i18n.on('languageChanged', (lang) => {
  document.documentElement.lang = lang;
  safeSetItem('vida_lang', lang);
});

export default i18n;

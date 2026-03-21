import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from './es.json';
import en from './en.json';

const savedLang = typeof window !== 'undefined'
  ? localStorage.getItem('vida-lang') || 'es'
  : 'es';

i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    en: { translation: en },
  },
  lng: savedLang,
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
});

i18n.on('languageChanged', (lng) => {
  localStorage.setItem('vida-lang', lng);
});

export default i18n;

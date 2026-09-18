import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';

type Audience = 'empresa' | 'trabajador';

export function ComingSoonForm() {
  const { t, i18n } = useTranslation();
  const [audience, setAudience] = useState<Audience>('empresa');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    setError('');

    try {
      await addDoc(collection(db, 'contact'), {
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        type: audience,
        message: String(data.get('message') ?? ''),
        company: audience === 'empresa' ? String(data.get('company') ?? '') || null : null,
        phone: audience === 'trabajador' ? String(data.get('phone') ?? '') || null : null,
        source: 'coming-soon',
        lang: i18n.language,
        createdAt: serverTimestamp(),
      });
      setSent(true);
    } catch {
      setError(t('cs_form_error'));
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="mk-success" role="status" aria-live="polite">
        <b>{t('cs_form_success_h')}</b>
        <p>{t('cs_form_success_p')}</p>
      </div>
    );
  }

  return (
    <form className="mk-form" onSubmit={handleSubmit}>
      <fieldset className="mk-field" style={{ border: 0, padding: 0, margin: '0 0 16px' }} aria-label={t('cs_form_audience_label')}>
        <legend className="mk-seg-legend">{t('cs_form_audience_label')}</legend>
        <div className="mk-seg" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={audience === 'empresa'}
            className={`mk-seg-btn${audience === 'empresa' ? ' on' : ''}`}
            onClick={() => setAudience('empresa')}
          >
            {t('cs_form_audience_empresa')}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={audience === 'trabajador'}
            className={`mk-seg-btn${audience === 'trabajador' ? ' on' : ''}`}
            onClick={() => setAudience('trabajador')}
          >
            {t('cs_form_audience_trabajador')}
          </button>
        </div>
      </fieldset>

      <div className="mk-field">
        <label htmlFor="cs-name">{t('cs_form_name')}</label>
        <input id="cs-name" className="mk-input" type="text" name="name" autoComplete="name" placeholder={t('cs_form_name_ph')} required minLength={2} maxLength={100} />
      </div>

      <div className="mk-field">
        <label htmlFor="cs-email">{t('cs_form_email')}</label>
        <input id="cs-email" className="mk-input" type="email" name="email" autoComplete="email" inputMode="email" placeholder={t('cs_form_email_ph')} required maxLength={200} />
      </div>

      {audience === 'empresa' ? (
        <div className="mk-field">
          <label htmlFor="cs-company">{t('cs_form_company')}</label>
          <input id="cs-company" className="mk-input" type="text" name="company" autoComplete="organization" placeholder={t('cs_form_company_ph')} maxLength={120} />
        </div>
      ) : (
        <div className="mk-field">
          <label htmlFor="cs-phone">{t('cs_form_phone')}</label>
          <input id="cs-phone" className="mk-input" type="tel" name="phone" autoComplete="tel" inputMode="tel" placeholder={t('cs_form_phone_ph')} maxLength={20} />
        </div>
      )}

      <div className="mk-field">
        <label htmlFor="cs-msg">{t('cs_form_msg')}</label>
        <textarea id="cs-msg" className="mk-input" name="message" placeholder={t('cs_form_msg_ph')} rows={3} maxLength={2000} style={{ minHeight: 96 }} />
      </div>

      {error && (
        <p className="mk-msg bad" role="alert" aria-live="assertive">{error}</p>
      )}

      <button type="submit" className="mk-btn block" disabled={submitting} aria-busy={submitting}>
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">{t('a11y_loading')}</span>
          </>
        ) : (
          t('cs_form_send')
        )}
      </button>
    </form>
  );
}

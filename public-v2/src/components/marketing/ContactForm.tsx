import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';

export function ContactForm() {
  const { t, i18n } = useTranslation();
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);

    try {
      await addDoc(collection(db, 'contact'), {
        name: String(data.get('name') ?? ''),
        email: String(data.get('email') ?? ''),
        type: String(data.get('type') ?? 'general'),
        message: String(data.get('message') ?? ''),
        source: 'contact-page',
        lang: i18n.language,
        createdAt: serverTimestamp(),
      });
      setSent(true);
    } catch {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="mk-success" id="cfSuccess" role="status" aria-live="polite">
        <p>{t('pg_contact_form_sent')}</p>
      </div>
    );
  }

  return (
    <form className="mk-form" onSubmit={handleSubmit} style={{ maxWidth: 520 }}>
      <div className="mk-field">
        <label htmlFor="cf-name">{t('pg_contact_form_name')}</label>
        <input id="cf-name" className="mk-input" type="text" name="name" autoComplete="name" placeholder={t('pg_contact_form_name_ph')} required />
      </div>
      <div className="mk-field">
        <label htmlFor="cf-email">{t('pg_contact_form_email')}</label>
        <input id="cf-email" className="mk-input" type="email" name="email" autoComplete="email" placeholder={t('pg_contact_form_email_ph')} required />
      </div>
      <div className="mk-field">
        <label htmlFor="cf-type">{t('pg_contact_form_type')}</label>
        <select id="cf-type" className="mk-input" name="type" required>
          <option value="general">{t('pg_contact_form_type_general')}</option>
          <option value="employer">{t('pg_contact_form_type_employer')}</option>
          <option value="partner">{t('pg_contact_form_type_partner')}</option>
          <option value="investor">{t('pg_contact_form_type_investor')}</option>
          <option value="press">{t('pg_contact_form_type_press')}</option>
          <option value="other">{t('pg_contact_form_type_other')}</option>
        </select>
      </div>
      <div className="mk-field">
        <label htmlFor="cf-msg">{t('pg_contact_form_msg')}</label>
        <textarea id="cf-msg" className="mk-input" name="message" placeholder={t('pg_contact_form_msg_ph')} rows={4} required />
      </div>
      <button type="submit" className="mk-btn block" disabled={submitting} aria-busy={submitting}>
        {submitting ? (
          <>
            <span className="spinner" aria-hidden="true" />
            <span className="sr-only">{t('a11y_loading')}</span>
          </>
        ) : (
          t('pg_contact_form_send')
        )}
      </button>
    </form>
  );
}

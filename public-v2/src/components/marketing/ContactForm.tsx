import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';

export function ContactForm() {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);

    try {
      await addDoc(collection(db, 'contacts'), {
        name: data.get('name'),
        email: data.get('email'),
        type: data.get('type'),
        message: data.get('message'),
        createdAt: serverTimestamp(),
      });
      setSent(true);
    } catch {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <div className="cf-success" id="cfSuccess" style={{ display: 'block' }}>
        <p>{t('pg_contact_form_sent')}</p>
      </div>
    );
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit}>
      <div className="cf-field">
        <label htmlFor="cf-name">{t('pg_contact_form_name')}</label>
        <input id="cf-name" type="text" name="name" placeholder={t('pg_contact_form_name_ph')} required />
      </div>
      <div className="cf-field">
        <label htmlFor="cf-email">{t('pg_contact_form_email')}</label>
        <input id="cf-email" type="email" name="email" placeholder={t('pg_contact_form_email_ph')} required />
      </div>
      <div className="cf-field">
        <label htmlFor="cf-type">{t('pg_contact_form_type')}</label>
        <select id="cf-type" name="type" required>
          <option value="general">{t('pg_contact_form_type_general')}</option>
          <option value="employer">{t('pg_contact_form_type_employer')}</option>
          <option value="partner">{t('pg_contact_form_type_partner')}</option>
          <option value="investor">{t('pg_contact_form_type_investor')}</option>
          <option value="press">{t('pg_contact_form_type_press')}</option>
          <option value="other">{t('pg_contact_form_type_other')}</option>
        </select>
      </div>
      <div className="cf-field">
        <label htmlFor="cf-msg">{t('pg_contact_form_msg')}</label>
        <textarea id="cf-msg" name="message" placeholder={t('pg_contact_form_msg_ph')} rows={4} required />
      </div>
      <button type="submit" className="cf-btn" disabled={submitting}>
        {submitting ? <span className="spinner" /> : t('pg_contact_form_send')}
      </button>
    </form>
  );
}

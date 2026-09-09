import { useTranslation } from 'react-i18next';
import { Board, BoardHead, Statement } from '../components/marketing/Board';
import { RichText } from '../components/shared/RichText';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ContactForm } from '../components/marketing/ContactForm';

const CHANNELS = ['general', 'employers', 'press', 'investors', 'privacy'] as const;

export function ContactPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_contact_badge')}`);

  return (
    <>
      <Board label={t('pg_contact_badge')}>
        <Statement html={t('pg_contact_h1')} lead={t('pg_contact_sub')} />
      </Board>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_contact_channels_tag')} title={t('pg_contact_channels_h')} />
          </div>
          <ul className="mk-rows">
            {CHANNELS.map((ch) => (
              <li className="mk-row" key={ch}>
                <span className="a" aria-hidden="true">@</span>
                <div className="t">
                  <b>{t(`pg_contact_${ch}_t`)}</b>
                  <span><a href={`mailto:${t(`pg_contact_${ch}_v`)}`}>{t(`pg_contact_${ch}_v`)}</a></span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Board>

      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_contact_office_tag')} title={t('pg_contact_office_h')} />
          </div>
          <ul className="mk-rows">
            {(['mx', 'ch'] as const).map((loc) => (
              <li className="mk-row" key={loc}>
                <span className="a" aria-hidden="true">{loc.toUpperCase()}</span>
                <div className="t">
                  <b>{t(`pg_contact_office_${loc}_t`)}</b>
                  <p><RichText html={t(`pg_contact_office_${loc}_d`)} /></p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Board>

      <Board tone="paper" id="form">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_contact_form_tag')} title={t('pg_contact_form_h')} />
          </div>
          <ContactForm />
        </div>
      </Board>
    </>
  );
}

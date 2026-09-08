import { useTranslation } from 'react-i18next';
import { Board, BoardHead, Statement, Rows } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function PressPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_press_badge')}`);

  return (
    <>
      <Board label={t('pg_press_badge')}>
        <Statement html={t('pg_press_h1')} lead={t('pg_press_sub')} />
      </Board>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_press_kit_tag')} title={t('pg_press_kit_h')} />
          </div>
          <Rows items={[1, 2, 3].map((n) => ({ title: t(`pg_press_kit_${n}_t`), desc: t(`pg_press_kit_${n}_d`) }))} />
        </div>
      </Board>

      <Board>
        <BoardHead kicker={t('pg_press_contact_tag')} title={t('pg_press_contact_p')} />
        <div className="mk-actions">
          <a href={`mailto:${t('pg_press_contact_email')}`} className="mk-btn">{t('pg_press_contact_email')}</a>
        </div>
      </Board>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_press_brand_tag')} title={t('pg_press_brand_h')} />
          </div>
          <Rows items={[1, 2, 3, 4].map((n) => ({ title: t(`pg_press_brand_${n}_t`), desc: t(`pg_press_brand_${n}_d`) }))} />
        </div>
      </Board>
    </>
  );
}

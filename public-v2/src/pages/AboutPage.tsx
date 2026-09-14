import { useTranslation } from 'react-i18next';
import { Board, BoardHead, Statement, Rows } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function AboutPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_about_badge')}`);

  return (
    <>
      <Board label={t('pg_about_badge')}>
        <Statement html={t('pg_about_h1')} lead={t('pg_about_sub')} />
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('pg_about_mission_tag')} title={t('pg_about_mission_h')} />
        <p className="mk-body" style={{ marginTop: 20 }}>{t('pg_about_mission_p')}</p>
      </Board>

      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_about_struct_tag')} title={t('pg_about_struct_h')} />
          </div>
          <Rows items={[1, 2, 3].map((n) => ({ title: t(`pg_about_struct_${n}_t`), desc: t(`pg_about_struct_${n}_d`) }))} />
        </div>
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('pg_about_values_tag')} title={t('pg_about_values_h')} />
        <div className="mk-gap" />
        <Rows columns={2} items={[1, 2, 3, 4].map((n) => ({ title: t(`pg_about_val_${n}_t`), desc: t(`pg_about_val_${n}_d`) }))} />
      </Board>
    </>
  );
}

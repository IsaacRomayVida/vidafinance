import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, BoardHead, Statement, Rows, Figures, PillSteps } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function PartnersPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_part_badge')}`);

  return (
    <>
      <Board label={t('pg_part_badge')}>
        <Statement html={t('pg_part_h1')} lead={t('pg_part_sub')}>
          <div className="mk-actions">
            <Link to="/contact" className="mk-btn">{t('pg_part_cta')}</Link>
          </div>
        </Statement>
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('pg_part_who_tag')} title={t('pg_part_who_h')} />
        <div className="mk-gap" />
        <Rows columns={2} items={[1, 2, 3, 4].map((n) => ({ title: t(`pg_part_who_${n}_t`), desc: t(`pg_part_who_${n}_d`) }))} />
      </Board>

      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_part_how_tag')} title={t('pg_part_how_h')} />
          </div>
          <PillSteps items={[1, 2, 3].map((n) => ({ title: t(`pg_part_how_${n}_t`), sub: t(`pg_part_how_${n}_d`) }))} />
        </div>
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('pg_part_ben_tag')} title={t('pg_part_ben_h')} />
        <div className="mk-gap" />
        <Figures items={[1, 2, 3, 4].map((n) => ({ value: t(`pg_part_ben_${n}_v`), label: t(`pg_part_ben_${n}_l`) }))} />
        <div className="mk-actions">
          <Link to="/contact" className="mk-btn">{t('pg_part_cta')}</Link>
        </div>
      </Board>
    </>
  );
}

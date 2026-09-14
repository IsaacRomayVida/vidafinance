import { useTranslation } from 'react-i18next';
import { Board, BoardHead, Statement, Rows, Figures } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function InvestorsPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_inv_badge')}`);

  return (
    <>
      <Board label={t('pg_inv_badge')}>
        <Statement html={t('pg_inv_h1')} lead={t('pg_inv_sub')} />
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('pg_inv_market_tag')} title={t('pg_inv_market_h')} lead={t('pg_inv_market_p')} />
        <div className="mk-gap" />
        <Figures items={[1, 2, 3, 4].map((n) => ({ value: t(`pg_inv_market_${n}_v`), label: t(`pg_inv_market_${n}_l`) }))} />
      </Board>

      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_inv_model_tag')} title={t('pg_inv_model_h')} />
          </div>
          <Rows items={[1, 2, 3, 4].map((n) => ({ title: t(`pg_inv_model_${n}_t`), desc: t(`pg_inv_model_${n}_d`) }))} />
        </div>
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('pg_inv_gov_tag')} title={t('pg_inv_gov_h')} />
        <p className="mk-body" style={{ marginTop: 20 }}>{t('pg_inv_gov_p')}</p>
      </Board>

      <Board tone="sage">
        <Statement html={t('pg_inv_cta')} center>
          <div className="mk-actions">
            <a href={`mailto:${t('pg_inv_cta_email')}`} className="mk-btn">{t('pg_inv_cta_email')}</a>
          </div>
        </Statement>
      </Board>
    </>
  );
}

import { useTranslation } from 'react-i18next';
import { Board, BoardHead, Statement, Rows, Figures } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function SecurityPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_sec_badge')}`);

  return (
    <>
      <Board label={t('pg_sec_badge')}>
        <Statement html={t('pg_sec_h1')} lead={t('pg_sec_sub')} />
      </Board>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_sec_enc_tag')} title={t('pg_sec_enc_h')} />
          </div>
          <Rows items={[1, 2, 3, 4].map((n) => ({ title: t(`pg_sec_enc_${n}_t`), desc: t(`pg_sec_enc_${n}_d`) }))} />
        </div>
      </Board>

      <Board>
        <BoardHead kicker={t('pg_sec_infra_tag')} title={t('pg_sec_infra_h')} lead={t('pg_sec_infra_p')} />
        <div className="mk-gap" />
        <Figures items={[1, 2, 3, 4, 5, 6].map((n) => ({ value: t(`pg_sec_infra_${n}_v`), label: t(`pg_sec_infra_${n}_l`) }))} />
      </Board>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('pg_sec_practices_tag')} title={t('pg_sec_practices_h')} />
          </div>
          <Rows items={[1, 2, 3, 4].map((n) => ({ title: t(`pg_sec_pr_${n}_t`), desc: t(`pg_sec_pr_${n}_d`) }))} />
        </div>
      </Board>
    </>
  );
}

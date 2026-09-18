import { useTranslation } from 'react-i18next';
import { Board, Statement } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function PrivacyPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('pg_priv_badge')}`);

  return (
    <Board tone="paper" label={t('pg_priv_badge')}>
      <Statement html={t('pg_priv_h1')} lead={t('pg_priv_updated')} />
      <div className="mk-legal">
        <p className="mk-body">{t('pg_priv_intro')}</p>
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <div key={i}>
            <h2>{t(`pg_priv_${i}_t`)}</h2>
            <p>{t(`pg_priv_${i}_p`)}</p>
          </div>
        ))}
      </div>
    </Board>
  );
}

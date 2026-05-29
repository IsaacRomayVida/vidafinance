import { useTranslation } from 'react-i18next';

export function BenefitsBar() {
  const { t } = useTranslation();

  return (
    <div className="benefits">
      <div className="benefits-inner">
        <div className="ben">
          <svg className="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" strokeWidth="1.5">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
          </svg>
          <div className="ben-val">$0</div>
          <div className="ben-lbl">{t('ben_fees')}</div>
        </div>
        <div className="ben-sep" />
        <div className="ben">
          <svg className="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" strokeWidth="1.5">
            <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
          </svg>
          <div className="ben-val">24hrs</div>
          <div className="ben-lbl">{t('ben_disbursement')}</div>
        </div>
        <div className="ben-sep" />
        <div className="ben">
          <svg className="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" strokeWidth="1.5">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          <div className="ben-val">100%</div>
          <div className="ben-lbl">{t('ben_encrypted')}</div>
        </div>
        <div className="ben-sep" />
        <div className="ben">
          <svg className="ben-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--t3)" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="3" /><path d="M8 12h8M12 8v8" strokeLinecap="round" />
          </svg>
          <div className="ben-val">Swiss</div>
          <div className="ben-lbl">{t('ben_governance')}</div>
        </div>
      </div>
    </div>
  );
}

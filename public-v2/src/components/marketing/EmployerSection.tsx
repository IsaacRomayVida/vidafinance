import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function EmployerSection() {
  const { t } = useTranslation();

  return (
    <section className="section" id="employers">
      <div className="wrap">
        <div className="emp-grid">
          <div className="emp-text">
            <div className="tag rv">{t('emp_tag')}</div>
            <h2 className="sh rv d1">{t('emp_h2')}</h2>
            <p className="sp rv d2">{t('emp_p')}</p>
            <Link to="/employers" className="section-link rv d3">
              {t('emp_link')}{' '}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
          <div>
            <div className="chart rv d3" id="chart">
              {[28, 36, 48, 42, 56, 50, 66, 85].map((h, i) => (
                <div key={i} className={`bar${i === 7 ? ' hi' : ''}`} style={{ height: `${h}%` }} />
              ))}
            </div>
            <div className="metrics rv d4">
              <div className="metric">
                <div className="metric-v">94.2%</div>
                <div className="metric-l">{t('emp_retention')}</div>
                <div className="metric-c">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>+3.1%
                </div>
              </div>
              <div className="metric">
                <div className="metric-v">$0</div>
                <div className="metric-l">{t('emp_liability')}</div>
                <div className="metric-c">{t('emp_liability_c')}</div>
              </div>
              <div className="metric">
                <div className="metric-v">2 {t('calc_days')}</div>
                <div className="metric-l">{t('emp_integration')}</div>
                <div className="metric-c">{t('emp_integration_c')}</div>
              </div>
              <div className="metric">
                <div className="metric-v">87%</div>
                <div className="metric-l">{t('emp_adoption')}</div>
                <div className="metric-c">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>+8.6%
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../shared/RichText';

export function HeroSection() {
  const { t } = useTranslation();

  return (
    <section className="hero">
      <div className="hero-blob b1" />
      <div className="hero-blob b2" />
      <div className="hero-blob b3" />
      <div className="hero-inner">
        <div className="hero-text">
          <div className="hero-badge">
            <span className="badge-dot" />
            <span className="badge-text">{t('hero_badge')}</span>
          </div>
          <h1><RichText html={t('hero_h1')} /></h1>
          <p className="hero-sub">{t('hero_sub')}</p>
          <div className="hero-actions">
            <Link to="/onboarding" className="hero-cta">
              Comenzar
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            </Link>
            <Link to="/login" className="hero-cta-2">{t('nav_login')}</Link>
          </div>
          {/* Social proof */}
          <div className="hero-social" style={{
            display: 'flex', alignItems: 'center', gap: 12, marginTop: 32,
            opacity: 0, animation: 'fu .9s ease .7s forwards',
          }}>
            {/* Avatar stack */}
            <div style={{ display: 'flex', marginRight: -4 }}>
              {['#194445','#247a6e','#a28657','#a8d5d0'].map((c, i) => (
                <div key={i} style={{
                  width: 28, height: 28, borderRadius: '50%', background: c,
                  border: '2px solid #fff', marginLeft: i > 0 ? -8 : 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10, color: '#fff', fontWeight: 700, zIndex: 4 - i,
                }}>
                  {['M','G','A','R'][i]}
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)', lineHeight: 1.3 }}>
                12+ empresas ya confían en VIDA
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)' }}>
                Manufactura, retail y servicios en México
              </div>
            </div>
          </div>
        </div>
        <div className="hero-widget">
          {/* Worker photo with decorative gradient */}
          <div className="hero-worker-img" style={{
            position: 'absolute', left: -80, bottom: 0,
            zIndex: 1, pointerEvents: 'none',
          }}>
            {/* Decorative gradient circle behind person */}
            <div style={{
              position: 'absolute', bottom: -30, left: '50%', transform: 'translateX(-50%)',
              width: 300, height: 300, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(168,213,208,0.12) 0%, rgba(168,213,208,0.03) 50%, transparent 70%)',
              filter: 'blur(20px)',
              pointerEvents: 'none',
            }} />
            <picture>
              <source srcSet="/images/worker.webp" type="image/webp" />
              <img src="/images/worker.png" alt="Trabajador usando VIDA"
                style={{
                  width: 340, position: 'relative',
                  filter: 'drop-shadow(0 20px 40px rgba(25,68,69,0.12))',
                }}
              />
            </picture>
          </div>
          <div className="phone-ring" />
          <div className="phone-ring-2" />
          <div className="phone-glow" />

          <div className="chip chip-1">
            <div className="chip-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
              </svg>
            </div>
            <div className="chip-text">
              <div className="chip-val">{t('chip_24hrs')}</div>
              <div className="chip-lbl">{t('chip_disbursement')}</div>
            </div>
          </div>

          <div className="chip chip-2">
            <div className="chip-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand-light)" strokeWidth="1.5">
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
              </svg>
            </div>
            <div className="chip-text">
              <div className="chip-val">{t('chip_0fees')}</div>
              <div className="chip-lbl">{t('chip_transparent')}</div>
            </div>
          </div>

          <div className="chip chip-3">
            <div className="chip-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.5">
                <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
            </div>
            <div className="chip-text">
              <div className="chip-val">{t('chip_encrypted')}</div>
              <div className="chip-lbl">{t('chip_bankgrade')}</div>
            </div>
          </div>

          <div className="phone-mock">
            <div className="pm-head">
              <span className="pm-label">{t('phone_available')}</span>
              <div className="pm-active"><span className="pm-dot" />{t('phone_active')}</div>
            </div>
            <div className="pm-amount"><div className="pm-big"><span className="cur">$</span>5,000</div></div>
            <div className="pm-unit">{t('phone_currency')}</div>
            <div className="pm-div" />
            <div className="pm-rows">
              <div className="pm-row"><span className="pm-row-label">{t('phone_repayment')}</span><span className="pm-row-val">{t('phone_repayment_val')}</span></div>
              <div className="pm-row"><span className="pm-row-label">{t('phone_disbursement')}</span><span className="pm-row-val">{t('phone_disbursement_val')}</span></div>
              <div className="pm-row"><span className="pm-row-label">{t('phone_deduction')}</span><span className="pm-row-val">{t('phone_deduction_val')}</span></div>
            </div>
            <div className="pm-progress">
              <div className="pm-prog-top"><span>{t('phone_utilization')}</span><span>60%</span></div>
              <div className="pm-prog-bar"><div className="pm-prog-fill" /></div>
            </div>
            <Link to="/onboarding" className="pm-btn">
              {t('phone_request')}{' '}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

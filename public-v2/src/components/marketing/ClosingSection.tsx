import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../shared/RichText';

export function ClosingSection() {
  const { t } = useTranslation();

  return (
    <section className="closing">
      <div className="closing-glow" />
      {/* Testimonial */}
      <div className="rv" style={{
        maxWidth: 640, margin: '0 auto 48px', padding: '32px 40px',
        background: 'rgba(255,255,255,0.06)', borderRadius: 20,
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.06)',
        position: 'relative', zIndex: 2,
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ marginBottom: 12, opacity: 0.2 }}>
          <path d="M10 11H6C6 7.5 7 5 10 4V6.5C8.5 7 8 8.5 8 10H10V14H6V11M18 11H14C14 7.5 15 5 18 4V6.5C16.5 7 16 8.5 16 10H18V14H14V11" fill="white"/>
        </svg>
        <p style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 18, color: 'rgba(255,255,255,0.85)', lineHeight: 1.5, fontStyle: 'italic', marginBottom: 16 }}>
          VIDA nos permitió ofrecer un beneficio real a nuestros empleados sin ningún costo ni riesgo. La adopción fue inmediata.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/images/carlosheadshot.png" alt="Carlos Rodríguez" style={{
            width: 44, height: 44, borderRadius: '50%', objectFit: 'cover',
            border: '2px solid rgba(255,255,255,0.15)',
          }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>Carlos Rodríguez</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Director de RRHH · Manufactura del Norte</div>
          </div>
        </div>
      </div>

      {/* Employee testimonial */}
      <div className="rv d1" style={{
        maxWidth: 640, margin: '0 auto 48px', padding: '28px 36px',
        background: 'rgba(255,255,255,0.04)', borderRadius: 20,
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(255,255,255,0.04)',
        position: 'relative', zIndex: 2,
      }}>
        <p style={{ fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 16, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5, fontStyle: 'italic', marginBottom: 14 }}>
          Cuando mi hijo se enfermó, VIDA me salvó. Sin este beneficio, habría tenido que pedir un préstamo con intereses altísimos. Recibí el dinero en 24 horas.
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: 'rgba(168,213,208,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.6)',
          }}>AM</div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.6)' }}>Ana Martínez</div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Operadora · Manufactura del Norte</div>
          </div>
        </div>
      </div>

      <h2 className="rv"><RichText html={t('close_h2')} /></h2>
      <p className="closing-sub rv d1">{t('close_sub')}</p>
      <Link to="/onboarding" className="closing-btn rv d2">{t('close_cta')}</Link>
    </section>
  );
}

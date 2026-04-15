import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { RichText } from '../shared/RichText';

const testimonials = [
  {
    quote: 'VIDA nos permitió ofrecer un beneficio real a nuestros empleados sin ningún costo ni riesgo. La adopción fue inmediata.',
    name: 'Carlos Rodríguez',
    role: 'Director de RRHH · Manufactura del Norte',
    img: '/images/carlosheadshot.png',
    initials: 'CR',
  },
  {
    quote: 'Cuando mi hijo se enfermó, VIDA me salvó. Sin este beneficio, habría tenido que pedir un préstamo con intereses altísimos. Recibí el dinero en 24 horas.',
    name: 'Ana Martínez',
    role: 'Operadora · Manufactura del Norte',
    img: '/images/ana.png',
    initials: 'AM',
  },
  {
    quote: 'La integración fue increíblemente simple. En dos días teníamos VIDA funcionando con nuestra nómina. Nuestros empleados lo usan cada mes.',
    name: 'Roberto Méndez',
    role: 'Gerente de Operaciones · Logística Express',
    img: '/images/roberto.png',
    initials: 'RM',
  },
];

export function ClosingSection() {
  const { t } = useTranslation();
  const [active, setActive] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setActive(prev => (prev + 1) % testimonials.length);
        setFade(true);
      }, 300);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const goTo = (idx: number) => {
    if (idx === active) return;
    setFade(false);
    setTimeout(() => { setActive(idx); setFade(true); }, 300);
  };

  const curr = testimonials[active];

  return (
    <section className="closing">
      <div className="closing-glow" />

      {/* Testimonial Slider */}
      <div className="rv" style={{
        maxWidth: 600, margin: '0 auto 48px',
        position: 'relative', zIndex: 2,
      }}>
        <div style={{
          padding: '36px 44px',
          background: 'rgba(255,255,255,0.06)', borderRadius: 20,
          backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.06)',
          opacity: fade ? 1 : 0,
          transform: fade ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.3s ease',
          minHeight: 180,
        }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ marginBottom: 14, opacity: 0.15 }}>
            <path d="M10 11H6C6 7.5 7 5 10 4V6.5C8.5 7 8 8.5 8 10H10V14H6V11M18 11H14C14 7.5 15 5 18 4V6.5C16.5 7 16 8.5 16 10H18V14H14V11" fill="white"/>
          </svg>
          <p style={{
            fontFamily: "'DM Serif Display', Georgia, serif", fontSize: 18,
            color: 'rgba(255,255,255,0.85)', lineHeight: 1.55, fontStyle: 'italic', marginBottom: 20,
          }}>
            {curr.quote}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {curr.img ? (
              <img src={curr.img} alt={curr.name} style={{
                width: 44, height: 44, borderRadius: '50%', objectFit: 'cover',
                objectPosition: 'center 15%',
                border: '2px solid rgba(255,255,255,0.15)',
              }} />
            ) : (
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: 'rgba(168,213,208,0.15)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 14, fontWeight: 700, color: 'rgba(255,255,255,0.5)',
                border: '2px solid rgba(255,255,255,0.08)',
              }}>{curr.initials}</div>
            )}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>{curr.name}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>{curr.role}</div>
            </div>
          </div>
        </div>

        {/* Dots */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20 }}>
          {testimonials.map((_, i) => (
            <button key={i} onClick={() => goTo(i)} style={{
              width: active === i ? 24 : 8, height: 8, borderRadius: 4,
              background: active === i ? 'rgba(168,213,208,0.6)' : 'rgba(255,255,255,0.15)',
              border: 'none', cursor: 'pointer', transition: 'all 0.3s ease',
              padding: 0,
            }} />
          ))}
        </div>
      </div>

      <h2 className="rv"><RichText html={t('close_h2')} /></h2>
      <p className="closing-sub rv d1">{t('close_sub')}</p>
      <Link to="/onboarding" className="closing-btn rv d2">{t('close_cta')}</Link>
    </section>
  );
}

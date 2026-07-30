import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const SESSION_KEY = 'funpay_splash_seen_v1';

function initialPhase(): 'hidden' | 'showing' {
  if (typeof window === 'undefined') return 'hidden';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seen = false;
  try {
    seen = sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    /* sessionStorage unavailable — show once */
  }
  if (seen || reduce) return 'hidden';
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* ignore */
  }
  return 'showing';
}

/**
 * Full-screen cinematic intro that plays the Seedance hero clip once per session,
 * then dissolves to reveal the homepage. Skipped entirely for users who prefer
 * reduced motion, and dismissible via click, Escape, or the skip button.
 */
export function SplashIntro() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'hidden' | 'showing' | 'leaving'>(initialPhase);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (phase !== 'showing') return;
    document.body.style.overflow = 'hidden';
    const auto = window.setTimeout(() => setPhase('leaving'), 4600);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPhase('leaving');
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(auto);
      window.removeEventListener('keydown', onKey);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    const done = window.setTimeout(() => {
      setPhase('hidden');
      document.body.style.overflow = '';
    }, 850);
    return () => window.clearTimeout(done);
  }, [phase]);

  if (phase === 'hidden') return null;

  return (
    <div
      className={`splash${phase === 'leaving' ? ' splash--leaving' : ''}`}
      role="dialog"
      aria-label="Funpay"
      onClick={() => setPhase('leaving')}
    >
      <video
        ref={videoRef}
        className="splash-video"
        autoPlay
        muted
        playsInline
        preload="auto"
        poster="/video/hero-poster.jpg"
        onEnded={() => setPhase('leaving')}
        aria-hidden="true"
      >
        <source src="/video/hero.mp4" type="video/mp4" />
      </video>
      <div className="splash-scrim" aria-hidden="true" />
      <div className="splash-content">
        <span className="splash-logo">
          Funpa<span className="g">y</span>
        </span>
        <span className="splash-tagline">{t('hero_badge')}</span>
      </div>
      <button
        type="button"
        className="splash-skip"
        onClick={(e) => {
          e.stopPropagation();
          setPhase('leaving');
        }}
      >
        {t('splash_skip')}
      </button>
    </div>
  );
}

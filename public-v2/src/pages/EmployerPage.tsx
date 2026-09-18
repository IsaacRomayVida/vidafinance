import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, BoardHead, Statement, Rows, Figures, PillSteps } from '../components/marketing/Board';
import { ArrowIcon } from '../components/marketing/ArrowIcon';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { PhotoHero } from '../components/marketing/PhotoHero';
import type { Film } from '../components/marketing/HeroFilm';

// Empleadores hero (docs/design/SHOT_LIST.md, R0): payroll morning in a resort HR office.
const HERO_WIDE: Film = { film: '/video/employer-hero-16x9.mp4', still: '/images/brand/employer-hero-16x9.jpg' };
const HERO_TALL: Film = { film: '/video/employer-hero-9x16.mp4', still: '/images/brand/employer-hero-9x16.jpg' };

export function EmployerPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('lp_e_badge')}`);

  return (
    <>
      <PhotoHero label={t('lp_e_badge')} wide={HERO_WIDE} tall={HERO_TALL}>
        <Statement html={t('lp_e_h1')} lead={t('lp_e_sub')}>
          <div className="mk-actions">
            <Link to="/onboarding?role=employer" className="mk-btn">{t('lp_e_cta')} {ArrowIcon}</Link>
            <Link to="/login" className="mk-btn ghost">{t('lp_e_login')}</Link>
          </div>
        </Statement>
      </PhotoHero>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_e_why_tag')} title={t('lp_e_why_h')} lead={t('lp_e_why_p')} />
          </div>
          <Figures items={[1, 2, 3, 4].map((n) => ({ value: t(`lp_e_why_${n}_v`), label: t(`lp_e_why_${n}_l`) }))} />
        </div>
      </Board>

      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_e_how_tag')} title={t('lp_e_how_h')} />
          </div>
          <PillSteps items={[1, 2, 3, 4].map((n) => ({ title: t(`lp_e_how_${n}_t`), sub: t(`lp_e_how_${n}_d`) }))} />
        </div>
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('lp_e_ben_tag')} title={t('lp_e_ben_h')} />
        <div className="mk-gap" />
        <Rows columns={2} items={[1, 2, 3, 4].map((n) => ({ title: t(`lp_e_ben_${n}_t`), desc: t(`lp_e_ben_${n}_d`) }))} />
      </Board>

      {/* The employer side speaks in the ops language: dark board, no
          photography (funpay-ui). */}
      <Board tone="ops">
        <Statement html={t('lp_e_close_h')} lead={t('lp_e_close_sub')} center>
          <div className="mk-actions">
            <Link to="/onboarding?role=employer" className="mk-btn">{t('lp_e_cta')} {ArrowIcon}</Link>
            <Link to="/contact" className="mk-btn ghost">{t('nav_contact')}</Link>
          </div>
        </Statement>
      </Board>
    </>
  );
}

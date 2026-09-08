import { Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Navbar } from './Navbar';
import { Footer } from './Footer';
import { useHashScroll } from '../../hooks/useHashScroll';
import { PageTransition } from '../ui/PageTransition';

interface MarketingLayoutProps {
  ctaLabel?: string;
  ctaHref?: string;
}

/** The --void page: 10px gutter, boards stacked with 10px gaps, ink footer. */
export function MarketingLayout({ ctaLabel, ctaHref }: MarketingLayoutProps) {
  useHashScroll();
  const { t } = useTranslation();

  return (
    <div className="mk-page">
      <a href="#main-content" className="skip-link">{t('a11y_skip_content')}</a>
      <Navbar ctaLabel={ctaLabel} ctaHref={ctaHref} />
      <main id="main-content">
        <PageTransition><Outlet /></PageTransition>
      </main>
      <Footer />
    </div>
  );
}

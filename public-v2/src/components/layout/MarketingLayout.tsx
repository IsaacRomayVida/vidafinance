import { Outlet } from 'react-router-dom';
import { Navbar } from './Navbar';
import { Footer } from './Footer';
import { useHashScroll } from '../../hooks/useHashScroll';
import { PageTransition } from '../ui/PageTransition';

interface MarketingLayoutProps {
  ctaLabel?: string;
  ctaHref?: string;
}

export function MarketingLayout({ ctaLabel, ctaHref }: MarketingLayoutProps) {
  useHashScroll();

  return (
    <>
      <Navbar ctaLabel={ctaLabel} ctaHref={ctaHref} />
      <PageTransition><Outlet /></PageTransition>
      <Footer />
    </>
  );
}

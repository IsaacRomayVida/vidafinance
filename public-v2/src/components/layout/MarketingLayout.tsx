import { Outlet } from 'react-router-dom';
import { Navbar } from './Navbar';
import { Footer } from './Footer';

interface MarketingLayoutProps {
  ctaLabel?: string;
  ctaHref?: string;
}

export function MarketingLayout({ ctaLabel, ctaHref }: MarketingLayoutProps) {
  return (
    <>
      <Navbar ctaLabel={ctaLabel} ctaHref={ctaHref} />
      <Outlet />
      <Footer />
    </>
  );
}

import React, { Suspense } from 'react';
import { HeroSection } from '../components/marketing/HeroSection';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// Lazy-load below-the-fold boards to reduce initial bundle size
const HowItWorks = React.lazy(() => import('../components/marketing/HowItWorks').then(m => ({ default: m.HowItWorks })));
const ROICalculator = React.lazy(() => import('../components/marketing/ROICalculator').then(m => ({ default: m.ROICalculator })));
const EmployerSection = React.lazy(() => import('../components/marketing/EmployerSection').then(m => ({ default: m.EmployerSection })));
const TrustSection = React.lazy(() => import('../components/marketing/TrustSection').then(m => ({ default: m.TrustSection })));
const FAQSection = React.lazy(() => import('../components/marketing/FAQSection').then(m => ({ default: m.FAQSection })));
const ClosingSection = React.lazy(() => import('../components/marketing/ClosingSection').then(m => ({ default: m.ClosingSection })));

/**
 * Landing: the statement board, then boards that follow the concept —
 * how it works as pill steps, cost in plain sight, the employer side on
 * the dark ops board, trust on the painted leaf, FAQ pills, one closing.
 */
export function HomePage() {
  useDocumentTitle('FunPay');

  return (
    <>
      <HeroSection />
      <Suspense fallback={null}>
        <HowItWorks />
        <ROICalculator />
        <EmployerSection />
        <TrustSection />
        <FAQSection />
        <ClosingSection />
      </Suspense>
    </>
  );
}

import React, { Suspense } from 'react';
import { HeroSection } from '../components/marketing/HeroSection';
import { BenefitsBar } from '../components/marketing/BenefitsBar';
import { SplashIntro } from '../components/marketing/SplashIntro';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// Lazy-load below-the-fold sections to reduce initial bundle size
const LogosBar = React.lazy(() => import('../components/marketing/LogosBar').then(m => ({ default: m.LogosBar })));
const StatementSection = React.lazy(() => import('../components/marketing/StatementSection').then(m => ({ default: m.StatementSection })));
const HowItWorks = React.lazy(() => import('../components/marketing/HowItWorks').then(m => ({ default: m.HowItWorks })));
const ROICalculator = React.lazy(() => import('../components/marketing/ROICalculator').then(m => ({ default: m.ROICalculator })));
const EmployerSection = React.lazy(() => import('../components/marketing/EmployerSection').then(m => ({ default: m.EmployerSection })));
const FeatureCards = React.lazy(() => import('../components/marketing/FeatureCards').then(m => ({ default: m.FeatureCards })));
const TrustSection = React.lazy(() => import('../components/marketing/TrustSection').then(m => ({ default: m.TrustSection })));
const FAQSection = React.lazy(() => import('../components/marketing/FAQSection').then(m => ({ default: m.FAQSection })));
const ClosingSection = React.lazy(() => import('../components/marketing/ClosingSection').then(m => ({ default: m.ClosingSection })));

export function HomePage() {
  useRevealOnScroll();
  useDocumentTitle('Funpay');

  return (
    <>
      <SplashIntro />
      <HeroSection />
      <BenefitsBar />
      <Suspense fallback={null}>
        <LogosBar />
        <StatementSection />
        <HowItWorks />
        <ROICalculator />
        <EmployerSection />
        <FeatureCards />
        <TrustSection />
        <FAQSection />
        <ClosingSection />
      </Suspense>
    </>
  );
}

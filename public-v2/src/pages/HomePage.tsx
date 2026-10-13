import { HeroSection } from '../components/marketing/HeroSection';
import { HowItWorks } from '../components/marketing/HowItWorks';
import { ROICalculator } from '../components/marketing/ROICalculator';
import { EmployerSection } from '../components/marketing/EmployerSection';
import { TrustSection } from '../components/marketing/TrustSection';
import { FAQSection } from '../components/marketing/FAQSection';
import { ClosingSection } from '../components/marketing/ClosingSection';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// The boards below the fold are bundled with the page (~7 KB gzip in all)
// rather than lazy-loaded: as six React.lazy siblings under one Suspense
// they loaded one after another, a request waterfall that Lighthouse
// counted into the hero's LCP.

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
      <HowItWorks />
      <ROICalculator />
      <EmployerSection />
      <TrustSection />
      <FAQSection />
      <ClosingSection />
    </>
  );
}

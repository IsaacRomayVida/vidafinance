import { HeroSection } from '../components/marketing/HeroSection';
import { BenefitsBar } from '../components/marketing/BenefitsBar';
import { StatementSection } from '../components/marketing/StatementSection';
import { HowItWorks } from '../components/marketing/HowItWorks';
import { ROICalculator } from '../components/marketing/ROICalculator';
import { EmployerSection } from '../components/marketing/EmployerSection';
import { FeatureCards } from '../components/marketing/FeatureCards';
import { TrustSection } from '../components/marketing/TrustSection';
import { FAQSection } from '../components/marketing/FAQSection';
import { ClosingSection } from '../components/marketing/ClosingSection';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function HomePage() {
  useRevealOnScroll();
  useDocumentTitle('VIDA Finance');

  return (
    <>
      <HeroSection />
      <BenefitsBar />
      <StatementSection />
      <HowItWorks />
      <ROICalculator />
      <EmployerSection />
      <FeatureCards />
      <TrustSection />
      <FAQSection />
      <ClosingSection />
    </>
  );
}

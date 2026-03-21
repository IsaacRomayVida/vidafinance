import { Helmet } from 'react-helmet-async';
import { useTranslation } from 'react-i18next';
import { HeroSection } from '../components/marketing/HeroSection';
import { BenefitsBar } from '../components/marketing/BenefitsBar';
import { StatementSection } from '../components/marketing/StatementSection';
import { HowItWorks } from '../components/marketing/HowItWorks';
import { ROICalculator } from '../components/marketing/ROICalculator';
import { EmployerSection } from '../components/marketing/EmployerSection';
import { FeatureCards } from '../components/marketing/FeatureCards';
import { TrustSection } from '../components/marketing/TrustSection';
import { ClosingSection } from '../components/marketing/ClosingSection';
import { useRevealOnScroll } from '../hooks/useRevealOnScroll';

export function HomePage() {
  const { i18n } = useTranslation();
  useRevealOnScroll();

  const desc = i18n.language === 'es'
    ? 'Crédito de emergencia habilitado por el empleador. Gobernanza suiza. Operación en México.'
    : 'Employer-enabled emergency credit. Swiss-governed. Mexico-operating.';

  return (
    <>
      <Helmet>
        <title>VIDA Finance</title>
        <meta name="description" content={desc} />
        <meta property="og:title" content="VIDA Finance" />
        <meta property="og:description" content={desc} />
      </Helmet>
      <HeroSection />
      <BenefitsBar />
      <StatementSection />
      <HowItWorks />
      <ROICalculator />
      <EmployerSection />
      <FeatureCards />
      <TrustSection />
      <ClosingSection />
    </>
  );
}

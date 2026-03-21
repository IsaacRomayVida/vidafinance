import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MarketingLayout } from './components/layout/MarketingLayout';
import { RouteGuard } from './components/RouteGuard';
import { EmployeeLayout } from './components/layouts/EmployeeLayout';
import { EmployerLayout } from './components/layouts/EmployerLayout';
import { AdminLayout } from './components/layouts/AdminLayout';
import { HomePage } from './pages/HomePage';
import { EmployerPage } from './pages/EmployerPage';
import { EmployeePage } from './pages/EmployeePage';
import { AboutPage } from './pages/AboutPage';
import { SecurityPage } from './pages/SecurityPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { TermsPage } from './pages/TermsPage';
import { PartnersPage } from './pages/PartnersPage';
import { InvestorsPage } from './pages/InvestorsPage';
import { ContactPage } from './pages/ContactPage';
import { PressPage } from './pages/PressPage';
import { Login } from './pages/Login';
import { EmployeeDashboard } from './pages/EmployeeDashboard';
import { LoanWizard } from './pages/LoanWizard';
import { MyLoans } from './pages/MyLoans';
import { EmployerDashboard } from './pages/EmployerDashboard';
import { EmployeeRoster } from './pages/EmployeeRoster';
import { DeductionReports } from './pages/DeductionReports';
import { OnboardingWizard } from './pages/OnboardingWizard';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AdminDashboard } from './pages/AdminDashboard';
import { ReviewQueue } from './pages/ReviewQueue';
import { PortfolioPage } from './pages/PortfolioPage';
import { EmployerMgmt } from './pages/EmployerMgmt';
import { AlertsPage } from './pages/AlertsPage';
import { NotFound } from './pages/NotFound';
import { Onboarding } from './pages/Onboarding';
import './i18n';

export default function App() {
  return (
    <BrowserRouter>
        <Routes>
          {/* Marketing pages */}
          <Route element={<MarketingLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/employers" element={<EmployerPage />} />
            <Route path="/employees" element={<EmployeePage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/security" element={<SecurityPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/partners" element={<PartnersPage />} />
            <Route path="/investors" element={<InvestorsPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/press" element={<PressPage />} />
          </Route>

          {/* Onboarding wizard (standalone, no marketing layout) */}
          <Route path="/get-started" element={<Navigate to="/onboarding" replace />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/signup" element={<Navigate to="/onboarding" replace />} />

          {/* Auth */}
          <Route path="/login" element={<Login />} />

          {/* Employee portal */}
          <Route element={<RouteGuard allowedRoles={['employee']} />}>
            <Route element={<EmployeeLayout />}>
              <Route path="/employee" element={<EmployeeDashboard />} />
              <Route path="/employee/dashboard" element={<Navigate to="/employee" replace />} />
              <Route path="/employee/apply" element={<LoanWizard />} />
              <Route path="/employee/loans" element={<MyLoans />} />
            </Route>
          </Route>

          {/* Employer portal */}
          <Route element={<RouteGuard allowedRoles={['employer_admin']} />}>
            <Route element={<EmployerLayout />}>
              <Route path="/employer" element={<EmployerDashboard />} />
              <Route path="/employer/dashboard" element={<Navigate to="/employer" replace />} />
              <Route path="/employer/employees" element={<EmployeeRoster />} />
              <Route path="/employer/deductions" element={<DeductionReports />} />
              <Route path="/employer/onboarding" element={<OnboardingWizard />} />
              <Route path="/employer/analytics" element={<AnalyticsPage />} />
            </Route>
          </Route>

          {/* Ops / Admin portal */}
          <Route element={<RouteGuard allowedRoles={['ops', 'admin', 'super_admin']} />}>
            <Route element={<AdminLayout />}>
              <Route path="/ops" element={<AdminDashboard />} />
              <Route path="/ops/review-queue" element={<ReviewQueue />} />
              <Route path="/ops/portfolio" element={<PortfolioPage />} />
              <Route path="/ops/employers" element={<EmployerMgmt />} />
              <Route path="/ops/alerts" element={<AlertsPage />} />
            </Route>
          </Route>

          {/* 404 catch-all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
    </BrowserRouter>
  );
}

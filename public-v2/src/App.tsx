import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import { MarketingLayout } from './components/layout/MarketingLayout';
import { RouteGuard } from './components/RouteGuard';
import { EmployeeLayout } from './components/layouts/EmployeeLayout';
import { EmployerLayout } from './components/layouts/EmployerLayout';
import { AdminLayout } from './components/layouts/AdminLayout';
import './i18n';

// Lazy-loaded page components for code splitting
const HomePage = React.lazy(() => import('./pages/HomePage').then(m => ({ default: m.HomePage })));
const EmployerPage = React.lazy(() => import('./pages/EmployerPage').then(m => ({ default: m.EmployerPage })));
const EmployeePage = React.lazy(() => import('./pages/EmployeePage').then(m => ({ default: m.EmployeePage })));
const AboutPage = React.lazy(() => import('./pages/AboutPage').then(m => ({ default: m.AboutPage })));
const SecurityPage = React.lazy(() => import('./pages/SecurityPage').then(m => ({ default: m.SecurityPage })));
const PrivacyPage = React.lazy(() => import('./pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const TermsPage = React.lazy(() => import('./pages/TermsPage').then(m => ({ default: m.TermsPage })));
const PartnersPage = React.lazy(() => import('./pages/PartnersPage').then(m => ({ default: m.PartnersPage })));
const InvestorsPage = React.lazy(() => import('./pages/InvestorsPage').then(m => ({ default: m.InvestorsPage })));
const ContactPage = React.lazy(() => import('./pages/ContactPage').then(m => ({ default: m.ContactPage })));
const PressPage = React.lazy(() => import('./pages/PressPage').then(m => ({ default: m.PressPage })));
const Login = React.lazy(() => import('./pages/Login').then(m => ({ default: m.Login })));
const EmployeeDashboard = React.lazy(() => import('./pages/EmployeeDashboard').then(m => ({ default: m.EmployeeDashboard })));
const LoanWizard = React.lazy(() => import('./pages/LoanWizard').then(m => ({ default: m.LoanWizard })));
const MyLoans = React.lazy(() => import('./pages/MyLoans').then(m => ({ default: m.MyLoans })));
const EmployerDashboard = React.lazy(() => import('./pages/EmployerDashboard').then(m => ({ default: m.EmployerDashboard })));
const EmployeeRoster = React.lazy(() => import('./pages/EmployeeRoster').then(m => ({ default: m.EmployeeRoster })));
const DeductionReports = React.lazy(() => import('./pages/DeductionReports').then(m => ({ default: m.DeductionReports })));
const OnboardingWizard = React.lazy(() => import('./pages/OnboardingWizard').then(m => ({ default: m.OnboardingWizard })));
const AnalyticsPage = React.lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const AdminDashboard = React.lazy(() => import('./pages/AdminDashboard').then(m => ({ default: m.AdminDashboard })));
const ReviewQueue = React.lazy(() => import('./pages/ReviewQueue').then(m => ({ default: m.ReviewQueue })));
const PortfolioPage = React.lazy(() => import('./pages/PortfolioPage').then(m => ({ default: m.PortfolioPage })));
const EmployerMgmt = React.lazy(() => import('./pages/EmployerMgmt').then(m => ({ default: m.EmployerMgmt })));
const AlertsPage = React.lazy(() => import('./pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
const SystemHealth = React.lazy(() => import('./pages/SystemHealth').then(m => ({ default: m.SystemHealth })));
const Onboarding = React.lazy(() => import('./pages/Onboarding').then(m => ({ default: m.Onboarding })));
const NotFound = React.lazy(() => import('./pages/NotFound').then(m => ({ default: m.NotFound })));

export default function App() {
  return (
    <AuthProvider>
    <BrowserRouter>
      <Suspense fallback={<div className="spinner" />}>
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

          {/* Get-started and onboarding redirect to contact */}
          <Route path="/get-started" element={<Navigate to="/contact" replace />} />
          <Route path="/onboarding" element={<Onboarding />} />

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
              <Route path="/employer/loans" element={<Navigate to="/employer/deductions" replace />} />
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
              <Route path="/ops/health" element={<SystemHealth />} />
            </Route>
          </Route>

          {/* Legacy /admin → /ops redirect */}
          <Route path="/admin" element={<Navigate to="/ops" replace />} />
          <Route path="/admin/*" element={<Navigate to="/ops" replace />} />

          {/* 404 catch-all */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
    </AuthProvider>
  );
}

import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './hooks/useAuth';
import { MarketingLayout } from './components/layout/MarketingLayout';
import { RouteGuard } from './components/RouteGuard';
import { ErrorBoundary } from './components/ErrorBoundary';
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
const ReviewDetail = React.lazy(() => import('./pages/ReviewDetail').then(m => ({ default: m.ReviewDetail })));
const PortfolioPage = React.lazy(() => import('./pages/PortfolioPage').then(m => ({ default: m.PortfolioPage })));
const EmployerMgmt = React.lazy(() => import('./pages/EmployerMgmt').then(m => ({ default: m.EmployerMgmt })));
const AlertsPage = React.lazy(() => import('./pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
const SystemHealth = React.lazy(() => import('./pages/SystemHealth').then(m => ({ default: m.SystemHealth })));
const Onboarding = React.lazy(() => import('./pages/Onboarding').then(m => ({ default: m.Onboarding })));
const NotFound = React.lazy(() => import('./pages/NotFound').then(m => ({ default: m.NotFound })));

const PageSpinner = () => (
  <div className="loading-page">
    <div className="spinner" />
  </div>
);

export default function App() {
  return (
    <ErrorBoundary>
    <AuthProvider>
    <BrowserRouter>
      <Routes>
        {/* Marketing pages */}
        <Route element={<MarketingLayout />}>
          <Route path="/" element={<Suspense fallback={<PageSpinner />}><HomePage /></Suspense>} />
          <Route path="/employers" element={<Suspense fallback={<PageSpinner />}><EmployerPage /></Suspense>} />
          <Route path="/employees" element={<Suspense fallback={<PageSpinner />}><EmployeePage /></Suspense>} />
          <Route path="/about" element={<Suspense fallback={<PageSpinner />}><AboutPage /></Suspense>} />
          <Route path="/security" element={<Suspense fallback={<PageSpinner />}><SecurityPage /></Suspense>} />
          <Route path="/privacy" element={<Suspense fallback={<PageSpinner />}><PrivacyPage /></Suspense>} />
          <Route path="/terms" element={<Suspense fallback={<PageSpinner />}><TermsPage /></Suspense>} />
          <Route path="/partners" element={<Suspense fallback={<PageSpinner />}><PartnersPage /></Suspense>} />
          <Route path="/investors" element={<Suspense fallback={<PageSpinner />}><InvestorsPage /></Suspense>} />
          <Route path="/contact" element={<Suspense fallback={<PageSpinner />}><ContactPage /></Suspense>} />
          <Route path="/press" element={<Suspense fallback={<PageSpinner />}><PressPage /></Suspense>} />
        </Route>

        {/* Get-started and onboarding redirect to contact */}
        <Route path="/get-started" element={<Navigate to="/contact" replace />} />
        <Route path="/onboarding" element={<Suspense fallback={<PageSpinner />}><Onboarding /></Suspense>} />

        {/* Auth */}
        <Route path="/login" element={<Suspense fallback={<PageSpinner />}><Login /></Suspense>} />

        {/* Employee portal — Suspense is INSIDE the guard so auth checks
            always run before any lazy chunk is loaded */}
        <Route element={<RouteGuard allowedRoles={['employee']} />}>
          <Route element={<EmployeeLayout />}>
            <Route path="/employee" element={<Suspense fallback={<PageSpinner />}><EmployeeDashboard /></Suspense>} />
            <Route path="/employee/dashboard" element={<Navigate to="/employee" replace />} />
            <Route path="/employee/apply" element={<Suspense fallback={<PageSpinner />}><LoanWizard /></Suspense>} />
            <Route path="/employee/loans" element={<Suspense fallback={<PageSpinner />}><MyLoans /></Suspense>} />
          </Route>
        </Route>

        {/* Employer portal */}
        <Route element={<RouteGuard allowedRoles={['employer_admin']} />}>
          <Route element={<EmployerLayout />}>
            <Route path="/employer" element={<Suspense fallback={<PageSpinner />}><EmployerDashboard /></Suspense>} />
            <Route path="/employer/dashboard" element={<Navigate to="/employer" replace />} />
            <Route path="/employer/employees" element={<Suspense fallback={<PageSpinner />}><EmployeeRoster /></Suspense>} />
            <Route path="/employer/loans" element={<Navigate to="/employer/deductions" replace />} />
            <Route path="/employer/deductions" element={<Suspense fallback={<PageSpinner />}><DeductionReports /></Suspense>} />
            <Route path="/employer/onboarding" element={<Suspense fallback={<PageSpinner />}><OnboardingWizard /></Suspense>} />
            <Route path="/employer/analytics" element={<Suspense fallback={<PageSpinner />}><AnalyticsPage /></Suspense>} />
          </Route>
        </Route>

        {/* Ops / Admin portal */}
        <Route element={<RouteGuard allowedRoles={['ops', 'admin', 'super_admin']} />}>
          <Route element={<AdminLayout />}>
            <Route path="/ops" element={<Suspense fallback={<PageSpinner />}><AdminDashboard /></Suspense>} />
            <Route path="/ops/review-queue" element={<Suspense fallback={<PageSpinner />}><ReviewQueue /></Suspense>} />
            <Route path="/ops/review-queue/:id" element={<Suspense fallback={<PageSpinner />}><ReviewDetail /></Suspense>} />
            <Route path="/ops/portfolio" element={<Suspense fallback={<PageSpinner />}><PortfolioPage /></Suspense>} />
            <Route path="/ops/employers" element={<Suspense fallback={<PageSpinner />}><EmployerMgmt /></Suspense>} />
            <Route path="/ops/alerts" element={<Suspense fallback={<PageSpinner />}><AlertsPage /></Suspense>} />
            <Route path="/ops/health" element={<Suspense fallback={<PageSpinner />}><SystemHealth /></Suspense>} />
          </Route>
        </Route>

        {/* Legacy /admin → /ops redirect */}
        <Route path="/admin" element={<Navigate to="/ops" replace />} />
        <Route path="/admin/*" element={<Navigate to="/ops" replace />} />

        {/* 404 catch-all */}
        <Route path="*" element={<Suspense fallback={<PageSpinner />}><NotFound /></Suspense>} />
      </Routes>
    </BrowserRouter>
    </AuthProvider>
    </ErrorBoundary>
  );
}

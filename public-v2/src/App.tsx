import React, { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MarketingLayout } from './components/layout/MarketingLayout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { HomePage } from './pages/HomePage';
import { EmployerPage } from './pages/EmployerPage';
import { EmployeePage } from './pages/EmployeePage';
import { AboutPage } from './pages/AboutPage';
import './i18n';

// Auth and the portal shells are lazy too: they pull in Firebase, which the
// marketing pages never use, so it stays off their critical path (Lighthouse
// LCP). PortalAuth mounts AuthProvider above the role-guarded routes only.
const PortalAuth = React.lazy(() => import('./components/PortalAuth').then(m => ({ default: m.PortalAuth })));
const RouteGuard = React.lazy(() => import('./components/RouteGuard').then(m => ({ default: m.RouteGuard })));
const EmployeeLayout = React.lazy(() => import('./components/layouts/EmployeeLayout').then(m => ({ default: m.EmployeeLayout })));
const EmployerLayout = React.lazy(() => import('./components/layouts/EmployerLayout').then(m => ({ default: m.EmployerLayout })));
const AdminLayout = React.lazy(() => import('./components/layouts/AdminLayout').then(m => ({ default: m.AdminLayout })));

// Lazy-loaded page components for code splitting. The four landing pages
// above are bundled eagerly: behind a lazy route their hero waited for an
// extra chunk round-trip plus React's ~300ms Suspense reveal throttle after
// the spinner, which was most of the marketing pages' LCP render delay.
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
const PayrollUpload = React.lazy(() => import('./pages/PayrollUpload').then(m => ({ default: m.PayrollUpload })));
const OnboardingWizard = React.lazy(() => import('./pages/OnboardingWizard').then(m => ({ default: m.OnboardingWizard })));
const AnalyticsPage = React.lazy(() => import('./pages/AnalyticsPage').then(m => ({ default: m.AnalyticsPage })));
const AdminDashboard = React.lazy(() => import('./pages/AdminDashboard').then(m => ({ default: m.AdminDashboard })));
const ReviewQueue = React.lazy(() => import('./pages/ReviewQueue').then(m => ({ default: m.ReviewQueue })));
const ReviewDetail = React.lazy(() => import('./pages/ReviewDetail').then(m => ({ default: m.ReviewDetail })));
const PortfolioPage = React.lazy(() => import('./pages/PortfolioPage').then(m => ({ default: m.PortfolioPage })));
const EmployerMgmt = React.lazy(() => import('./pages/EmployerMgmt').then(m => ({ default: m.EmployerMgmt })));
const PayrollRemittances = React.lazy(() => import('./pages/PayrollRemittances').then(m => ({ default: m.PayrollRemittances })));
const AlertsPage = React.lazy(() => import('./pages/AlertsPage').then(m => ({ default: m.AlertsPage })));
const SystemHealth = React.lazy(() => import('./pages/SystemHealth').then(m => ({ default: m.SystemHealth })));
const Onboarding = React.lazy(() => import('./pages/Onboarding').then(m => ({ default: m.Onboarding })));
const NotFound = React.lazy(() => import('./pages/NotFound').then(m => ({ default: m.NotFound })));
// pages/ComingSoon.tsx is the pre-redesign landing (restored — business
// asked to hold the funpay-ui redesign off the public site for now). The
// redesigned version lives side by side, fully working, at
// pages/ComingSoonRedesign.tsx; swap it back in by changing this import to
// `./pages/ComingSoonRedesign` and `m.ComingSoon` to `m.ComingSoonRedesign`
// below — no env var or build flag involved.
const ComingSoon = React.lazy(() => import('./pages/ComingSoon').then(m => ({ default: m.ComingSoon })));

// Pre-launch gate. When 'coming-soon' (the fail-safe default when the env var
// is unset), all public/marketing URLs render the ComingSoon page; /login and
// the role-guarded portals stay reachable by direct URL for internal testing.
// At launch, build with VITE_LAUNCH_MODE=live to expose the full marketing site.
const LAUNCH_MODE = import.meta.env.VITE_LAUNCH_MODE ?? 'coming-soon';
const IS_COMING_SOON = LAUNCH_MODE === 'coming-soon';

const PageSpinner = () => (
  <div className="loading-page">
    <div className="spinner" />
  </div>
);

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Routes>
        {/* Marketing pages — gated by VITE_LAUNCH_MODE */}
        {IS_COMING_SOON ? (
          <Route path="/" element={<ErrorBoundary><Suspense fallback={<PageSpinner />}><ComingSoon /></Suspense></ErrorBoundary>} />
        ) : (
          <Route element={<ErrorBoundary><MarketingLayout /></ErrorBoundary>}>
            <Route path="/" element={<HomePage />} />
            <Route path="/employers" element={<EmployerPage />} />
            <Route path="/employees" element={<EmployeePage />} />
            <Route path="/about" element={<AboutPage />} />
            <Route path="/security" element={<Suspense fallback={<PageSpinner />}><SecurityPage /></Suspense>} />
            <Route path="/privacy" element={<Suspense fallback={<PageSpinner />}><PrivacyPage /></Suspense>} />
            <Route path="/terms" element={<Suspense fallback={<PageSpinner />}><TermsPage /></Suspense>} />
            <Route path="/partners" element={<Suspense fallback={<PageSpinner />}><PartnersPage /></Suspense>} />
            <Route path="/investors" element={<Suspense fallback={<PageSpinner />}><InvestorsPage /></Suspense>} />
            <Route path="/contact" element={<Suspense fallback={<PageSpinner />}><ContactPage /></Suspense>} />
            <Route path="/press" element={<Suspense fallback={<PageSpinner />}><PressPage /></Suspense>} />
          </Route>
        )}

        {/* Get-started and onboarding redirect to contact */}
        <Route path="/get-started" element={<Navigate to="/contact" replace />} />
        <Route path="/onboarding" element={<ErrorBoundary><Suspense fallback={<PageSpinner />}><Onboarding /></Suspense></ErrorBoundary>} />

        {/* Auth */}
        <Route path="/login" element={<ErrorBoundary><Suspense fallback={<PageSpinner />}><Login /></Suspense></ErrorBoundary>} />

        {/* Role-guarded portals share one lazily loaded AuthProvider; its
            Suspense also covers the lazy guard and shell chunks below. */}
        <Route element={<Suspense fallback={<PageSpinner />}><PortalAuth /></Suspense>}>

        {/* Employee portal — page Suspense is INSIDE the guard so auth checks
            always run before any lazy page chunk is loaded */}
        <Route element={<RouteGuard allowedRoles={['employee']} />}>
          <Route element={<ErrorBoundary><EmployeeLayout /></ErrorBoundary>}>
            <Route path="/employee" element={<Suspense fallback={<PageSpinner />}><EmployeeDashboard /></Suspense>} />
            <Route path="/employee/dashboard" element={<Navigate to="/employee" replace />} />
            <Route path="/employee/apply" element={<Suspense fallback={<PageSpinner />}><LoanWizard /></Suspense>} />
            <Route path="/employee/loans" element={<Suspense fallback={<PageSpinner />}><MyLoans /></Suspense>} />
          </Route>
        </Route>

        {/* Employer portal */}
        <Route element={<RouteGuard allowedRoles={['employer_admin']} />}>
          <Route element={<ErrorBoundary><EmployerLayout /></ErrorBoundary>}>
            <Route path="/employer" element={<Suspense fallback={<PageSpinner />}><EmployerDashboard /></Suspense>} />
            <Route path="/employer/dashboard" element={<Navigate to="/employer" replace />} />
            <Route path="/employer/employees" element={<Suspense fallback={<PageSpinner />}><EmployeeRoster /></Suspense>} />
            <Route path="/employer/loans" element={<Navigate to="/employer/deductions" replace />} />
            <Route path="/employer/deductions" element={<Suspense fallback={<PageSpinner />}><DeductionReports /></Suspense>} />
            <Route path="/employer/onboarding" element={<Suspense fallback={<PageSpinner />}><OnboardingWizard /></Suspense>} />
            <Route path="/employer/payroll" element={<Suspense fallback={<PageSpinner />}><PayrollUpload /></Suspense>} />
            <Route path="/employer/analytics" element={<Suspense fallback={<PageSpinner />}><AnalyticsPage /></Suspense>} />
          </Route>
        </Route>

        {/* Ops / Admin portal */}
        <Route element={<RouteGuard allowedRoles={['ops', 'admin', 'super_admin']} />}>
          <Route element={<ErrorBoundary><AdminLayout /></ErrorBoundary>}>
            <Route path="/ops" element={<Suspense fallback={<PageSpinner />}><AdminDashboard /></Suspense>} />
            <Route path="/ops/review-queue" element={<Suspense fallback={<PageSpinner />}><ReviewQueue /></Suspense>} />
            <Route path="/ops/review-queue/:id" element={<Suspense fallback={<PageSpinner />}><ReviewDetail /></Suspense>} />
            <Route path="/ops/portfolio" element={<Suspense fallback={<PageSpinner />}><PortfolioPage /></Suspense>} />
            <Route path="/ops/employers" element={<Suspense fallback={<PageSpinner />}><EmployerMgmt /></Suspense>} />
            <Route path="/ops/remittances" element={<Suspense fallback={<PageSpinner />}><PayrollRemittances /></Suspense>} />
            <Route path="/ops/alerts" element={<Suspense fallback={<PageSpinner />}><AlertsPage /></Suspense>} />
            <Route path="/ops/health" element={<Suspense fallback={<PageSpinner />}><SystemHealth /></Suspense>} />
          </Route>
        </Route>

        </Route>

        {/* Legacy /admin → /ops redirect */}
        <Route path="/admin" element={<Navigate to="/ops" replace />} />
        <Route path="/admin/*" element={<Navigate to="/ops" replace />} />

        {/* Catch-all: pre-launch shows ComingSoon, post-launch the 404 page */}
        <Route path="*" element={<ErrorBoundary><Suspense fallback={<PageSpinner />}>{IS_COMING_SOON ? <ComingSoon /> : <NotFound />}</Suspense></ErrorBoundary>} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}

import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MarketingLayout } from './components/layouts/MarketingLayout';
import { EmployeeLayout } from './components/layouts/EmployeeLayout';
import { EmployerLayout } from './components/layouts/EmployerLayout';
import { AdminLayout } from './components/layouts/AdminLayout';
import { RouteGuard } from './components/RouteGuard';

import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { EmployeeDashboard } from './pages/EmployeeDashboard';
import { EmployerDashboard } from './pages/EmployerDashboard';
import { AdminDashboard } from './pages/AdminDashboard';

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Public marketing routes */}
          <Route element={<MarketingLayout />}>
            <Route index element={<Home />} />
            <Route path="employers" element={<Home />} />
            <Route path="employees" element={<Home />} />
            <Route path="about" element={<Home />} />
            <Route path="security" element={<Home />} />
            <Route path="privacy" element={<Home />} />
            <Route path="terms" element={<Home />} />
            <Route path="partners" element={<Home />} />
            <Route path="investors" element={<Home />} />
            <Route path="contact" element={<Home />} />
            <Route path="get-started" element={<Home />} />
          </Route>

          {/* Login (standalone, no layout) */}
          <Route path="login" element={<Login />} />

          {/* Employee routes — requires 'employee' role */}
          <Route element={<RouteGuard allowedRoles={['employee']} />}>
            <Route element={<EmployeeLayout />}>
              <Route path="employee" element={<EmployeeDashboard />} />
              <Route path="employee/loans" element={<EmployeeDashboard />} />
            </Route>
          </Route>

          {/* Employer routes — requires 'employer_admin' role */}
          <Route element={<RouteGuard allowedRoles={['employer_admin']} />}>
            <Route element={<EmployerLayout />}>
              <Route path="employer" element={<EmployerDashboard />} />
              <Route path="employer/employees" element={<EmployerDashboard />} />
              <Route path="employer/loans" element={<EmployerDashboard />} />
            </Route>
          </Route>

          {/* Ops/Admin routes — requires ops, admin, or super_admin role */}
          <Route element={<RouteGuard allowedRoles={['ops', 'admin', 'super_admin']} />}>
            <Route element={<AdminLayout />}>
              <Route path="ops" element={<AdminDashboard />} />
              <Route path="ops/employers" element={<AdminDashboard />} />
              <Route path="ops/loans" element={<AdminDashboard />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

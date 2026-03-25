export function AdminDashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">Operations Dashboard</h1>
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total Employers</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Total Employees</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-sm text-gray-500">Active Loans</p>
          <p className="mt-1 text-2xl font-bold text-teal-900">0</p>
        </div>
      </div>
    </div>
  );
}

export function AdminDashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-teal-900">Operations Dashboard</h1>
      <div className="stat-grid">
        <div className="stat-card">
          <p className="stat-label">Total Employers</p>
          <p className="stat-value">0</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Total Employees</p>
          <p className="stat-value">0</p>
        </div>
        <div className="stat-card">
          <p className="stat-label">Active Loans</p>
          <p className="stat-value">0</p>
        </div>
      </div>
    </div>
  );
}

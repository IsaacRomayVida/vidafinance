export function AdminDashboard() {
  return (
    <div>
      <h1 style={{ fontFamily: "'DM Serif Display',Georgia,serif", fontSize: 28, color: "#0c1e1f", fontWeight: 400, letterSpacing: "-0.02em" }}>Operations Dashboard</h1>
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

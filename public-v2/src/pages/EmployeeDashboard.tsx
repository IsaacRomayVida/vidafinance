import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../hooks/useAuth';
import { db, functions } from '../lib/firebase';
import {
  doc,
  getDoc,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

interface EmployeeData {
  name: string;
  email: string;
  creditLimit: number;
  availableCredit: number;
  employerName: string;
}

interface Loan {
  id: string;
  amount: number;
  repaymentAmount: number;
  termDays: number;
  status: string;
  createdAt: Date | null;
  dueDate: Date | null;
  contractUrl?: string;
  receiptUrl?: string;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function statusBadgeClass(status: string): string {
  return `badge badge-${status}`;
}

export function EmployeeDashboard() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [empData, setEmpData] = useState<EmployeeData | null>(null);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [loanAmount, setLoanAmount] = useState(500);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState('');

  // Load employee data
  useEffect(() => {
    if (!user) return;
    const loadEmployee = async () => {
      const snap = await getDoc(doc(db, 'employees', user.uid));
      if (snap.exists()) {
        const d = snap.data();
        setEmpData({
          name: d.name,
          email: d.email,
          creditLimit: d.creditLimit || 0,
          availableCredit: d.availableCredit || 0,
          employerName: d.employerName || '',
        });
      }
      setLoading(false);
    };
    loadEmployee();
  }, [user]);

  // Real-time loan listener
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'loans'),
      where('employeeId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snap) => {
      const loanList: Loan[] = snap.docs.map((d) => {
        const data = d.data() as DocumentData;
        return {
          id: d.id,
          amount: data.amount || 0,
          repaymentAmount: data.repaymentAmount || data.totalRepaymentAmount || data.total || 0,
          termDays: data.termDays || 30,
          status: data.status || 'pending',
          createdAt: data.createdAt?.toDate?.() || null,
          dueDate: data.dueDate?.toDate?.() || null,
          contractUrl: data.contractUrl,
          receiptUrl: data.receiptUrl,
        };
      });
      setLoans(loanList);
    });
    return unsub;
  }, [user]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  const requestLoan = async () => {
    if (!empData || submitting) return;
    if (loanAmount < 500) return;
    if (loanAmount > empData.availableCredit) return;
    setSubmitting(true);
    try {
      const fn = httpsCallable(functions, 'requestLoan');
      await fn({ amount: loanAmount, term: 30 });
      setShowModal(false);
      setLoanAmount(500);
      setAcceptedTerms(false);
      showToast(t('toast_loan_submitted'));
    } catch {
      showToast('Error submitting request');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePayNow = async (loanId: string) => {
    try {
      const fn = httpsCallable(functions, 'generatePaymentLink');
      const result = await fn({ loanId });
      const data = result.data as { paymentUrl?: string };
      if (data.paymentUrl) window.open(data.paymentUrl, '_blank');
    } catch {
      showToast('Error generating payment link');
    }
  };

  const utilization = empData
    ? empData.creditLimit > 0
      ? Math.round(((empData.creditLimit - empData.availableCredit) / empData.creditLimit) * 100)
      : 0
    : 0;

  const fee = Math.round(loanAmount * 0.3);
  const total = loanAmount + fee;
  const cat = loanAmount > 0 ? ((Math.pow(1 + fee / loanAmount, 365 / 30) - 1) * 100).toFixed(1) : '0';

  if (loading) {
    return (
      <div className="dash-content" style={{ textAlign: 'center', paddingTop: 100 }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <>
      <div className="dash-header">
        <h1>
          {t('dash_welcome')}, {empData?.name || user?.email}
        </h1>
        <div className="dash-user">
          <span>{empData?.employerName}</span>
          <div className="dash-avatar">{(empData?.name || user?.email || '?')[0].toUpperCase()}</div>
        </div>
      </div>
      <div className="dash-content">
        {/* Stat cards */}
        <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
          <div className="stat-card">
            <div className="stat-label">{t('dash_available_credit')}</div>
            <div className="stat-value">${fmt(empData?.availableCredit || 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_credit_limit')}</div>
            <div className="stat-value">${fmt(empData?.creditLimit || 0)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{t('dash_utilization')}</div>
            <div className="stat-value">{utilization}%</div>
          </div>
          <div className="stat-card" style={{ cursor: 'pointer' }} onClick={() => setShowModal(true)}>
            <div className="stat-label">{t('dash_quick_action')}</div>
            <div className="stat-value" style={{ color: 'var(--brand-light)', fontSize: 16 }}>
              {t('dash_request_funds')} &rarr;
            </div>
          </div>
        </div>

        {/* Loans table */}
        <div className="card" style={{ marginTop: 32 }}>
          <h2 className="card-title">{t('dash_your_loans')}</h2>
          {loans.length === 0 ? (
            <div className="empty-state">
              <p>{t('dash_no_loans_employee')}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th>{t('dash_th_amount')}</th>
                    <th>{t('dash_th_term')}</th>
                    <th>{t('dash_th_repayment')}</th>
                    <th>{t('dash_th_status')}</th>
                    <th>{t('dash_th_docs')}</th>
                    <th>{t('dash_th_date')}</th>
                    <th>{t('dash_th_action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loans.map((loan) => (
                    <tr key={loan.id}>
                      <td>${fmt(loan.amount)}</td>
                      <td>
                        {loan.termDays} {t('dash_days')}
                      </td>
                      <td>${fmt(loan.repaymentAmount)}</td>
                      <td>
                        <span className={statusBadgeClass(loan.status)}>
                          {t(`status_${loan.status}`, loan.status)}
                        </span>
                      </td>
                      <td>
                        {loan.contractUrl && (
                          <a href={loan.contractUrl} target="_blank" rel="noopener noreferrer" className="doc-link">
                            {t('dash_doc_contract')}
                          </a>
                        )}
                        {loan.receiptUrl && (
                          <a href={loan.receiptUrl} target="_blank" rel="noopener noreferrer" className="doc-link" style={{ marginLeft: 8 }}>
                            {t('dash_doc_receipt')}
                          </a>
                        )}
                      </td>
                      <td>{loan.createdAt ? loan.createdAt.toLocaleDateString() : '-'}</td>
                      <td>
                        {(loan.status === 'active' || loan.status === 'overdue') && (
                          <button className="btn-sm" onClick={() => handlePayNow(loan.id)}>
                            {t('dash_pay_now')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Loan Request Modal */}
      <div
        className={`modal-overlay ${showModal ? 'show' : ''}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setShowModal(false);
        }}
      >
        <div className="modal">
          <button className="modal-close" onClick={() => setShowModal(false)}>
            &times;
          </button>
          <h3>{t('modal_request')}</h3>
          <p className="modal-sub">
            {t('modal_available')}: ${fmt(empData?.availableCredit || 0)} MXN
          </p>

          <div className="form-group" style={{ marginBottom: 24 }}>
            <label className="onb-label">{t('modal_amount')}</label>
            <input
              type="range"
              min={500}
              max={empData?.availableCredit || 5000}
              step={100}
              value={loanAmount}
              onChange={(e) => setLoanAmount(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div style={{ textAlign: 'center', fontFamily: 'var(--df)', fontSize: 36, color: 'var(--t1)', marginTop: 8 }}>
              ${fmt(loanAmount)}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <span style={{ color: 'var(--t3)' }}>{t('modal_term')}</span>
              <span style={{ fontWeight: 600 }}>{t('modal_term_30')}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <span style={{ color: 'var(--t3)' }}>{t('modal_loan_amount')}</span>
              <span style={{ fontWeight: 600 }}>${fmt(loanAmount)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
              <span style={{ color: 'var(--t3)' }}>{t('modal_fee')}</span>
              <span style={{ fontWeight: 600 }}>${fmt(fee)}</span>
            </div>
            <div style={{ height: 1, background: 'rgba(25,68,69,0.06)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16, fontWeight: 700 }}>
              <span>{t('modal_total')}</span>
              <span>${fmt(total)}</span>
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--t3)' }}>
              <span className="cat-highlight">{t('modal_cat')}: {cat}%</span>
            </div>
          </div>

          <div className="onb-terms" style={{ marginBottom: 16 }}>
            <input
              type="checkbox"
              id="loan-terms"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
            />
            <label htmlFor="loan-terms">{t('modal_accept_terms')}</label>
          </div>

          <button
            className="onb-btn"
            disabled={!acceptedTerms || submitting || loanAmount < 500}
            onClick={requestLoan}
          >
            {submitting ? t('modal_submitting') : t('modal_confirm')}
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="toast show" style={{ position: 'fixed', bottom: 24, right: 24, background: 'var(--brand)', color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 14, zIndex: 2000 }}>
          {toast}
        </div>
      )}
    </>
  );
}

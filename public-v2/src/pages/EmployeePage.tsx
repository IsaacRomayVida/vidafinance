import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, BoardHead, Statement, Rows, Figures, PillSteps, ArrowIcon } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function fmt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function EmployeePage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('lp_m_badge')}`);

  const [salary, setSalary] = useState(15000);
  const credit = Math.min(Math.round(salary * 0.30 / 100) * 100, 5000);
  const fee = Math.round(credit * 0.30);
  const total = credit + fee;

  const handleSalaryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    setSalary(raw ? parseInt(raw) : 0);
  }, []);

  return (
    <>
      {/* Statement */}
      <Board label={t('lp_m_badge')}>
        <Statement html={t('lp_m_h1')} lead={t('lp_m_sub')}>
          <div className="mk-actions">
            <Link to="/onboarding?role=employee" className="mk-btn">{t('lp_m_cta')} {ArrowIcon}</Link>
          </div>
          <p className="mk-disclose">
            {t('lp_m_no_code')}{' '}
            <Link to="/employers">{t('lp_m_no_code_link')}</Link>
          </p>
        </Statement>
      </Board>

      {/* What you get — numbers as the copy */}
      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_m_what_tag')} title={t('lp_m_what_h')} />
          </div>
          <Figures items={[1, 2, 3, 4].map((n) => ({ value: t(`lp_m_what_${n}_v`), label: t(`lp_m_what_${n}_l`) }))} />
        </div>
      </Board>

      {/* Credit simulator — cost in plain sight */}
      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_m_widget_tag')} title={t('lp_m_widget_h')} lead={t('lp_m_widget_sub')} />
          </div>
          <div>
            <div className="mk-field">
              <label htmlFor="lp-m-salary">{t('lp_m_widget_salary')}</label>
              <div className="mk-money">
                <span className="pre" aria-hidden="true">$</span>
                <input id="lp-m-salary" className="mk-input" type="text" inputMode="numeric" aria-label={t('lp_m_widget_salary')} value={fmt(salary)} onChange={handleSalaryChange} placeholder={t('lp_m_widget_salary_ph')} />
                <span className="suf" aria-hidden="true">MXN</span>
              </div>
            </div>
            <div className="mk-gap-sm" />
            <p className="mk-quiet" style={{ fontSize: 15 }}>{t('lp_m_widget_available')}</p>
            <div className="mk-num money" aria-live="polite">{fmt(credit)}<small>MXN</small></div>
            <p className="mk-disclose">
              {t('lp_m_widget_repayment')} <b>{fmt(total)} MXN</b>
              {' '}<span aria-hidden="true" style={{ color: 'var(--t3)' }}>·</span>{' '}
              {t('lp_m_widget_rate')} {t('lp_m_widget_rate_val')} ({fmt(fee)} MXN) · {t('lp_m_widget_term')} {t('lp_m_widget_term_val')} · {t('lp_m_widget_deduction')} · <b>{t('calc_cat_label')}</b> · {t('calc_cat_pending')}
            </p>
            <p className="mk-disclose">{t('lp_m_widget_disbursement')} {t('lp_m_widget_disbursement_val')}</p>
            <div className="mk-actions">
              <Link to="/onboarding?role=employee" className="mk-btn">{t('lp_m_widget_cta')}</Link>
            </div>
          </div>
        </div>
      </Board>

      {/* How it works */}
      <Board tone="paper" id="how">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_m_how_tag')} title={t('lp_m_how_h')} />
          </div>
          <PillSteps items={[1, 2, 3].map((n) => ({ title: t(`lp_m_how_${n}_t`), sub: t(`lp_m_how_${n}_d`) }))} />
        </div>
      </Board>

      {/* Use cases */}
      <Board tone="leaf" className="photo photo-kitchen">
        <BoardHead kicker={t('lp_m_use_tag')} title={t('lp_m_use_h')} />
        <div className="mk-gap" />
        <Rows columns={2} items={[1, 2, 3, 4].map((n) => ({ title: t(`lp_m_use_${n}_t`), desc: t(`lp_m_use_${n}_d`) }))} />
      </Board>

      {/* Ask your employer */}
      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_m_ask_tag')} title={t('lp_m_ask_h')} lead={t('lp_m_ask_sub')} />
          </div>
          <PillSteps items={[1, 2, 3].map((n) => ({ title: t(`lp_m_ask_${n}_t`), sub: t(`lp_m_ask_${n}_d`) }))} />
        </div>
      </Board>

      {/* Closing */}
      <Board>
        <Statement html={t('lp_m_close_h')} lead={t('lp_m_close_sub')} center>
          <div className="mk-actions">
            <Link to="/onboarding?role=employee" className="mk-btn">{t('lp_m_close_cta')}</Link>
            <Link to="/employers" className="mk-btn ghost">{t('lp_m_close_cta2')}</Link>
          </div>
        </Statement>
      </Board>
    </>
  );
}

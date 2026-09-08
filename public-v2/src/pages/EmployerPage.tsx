import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, BoardHead, Statement, Rows, Figures, PillSteps, ArrowIcon } from '../components/marketing/Board';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function EmployerPage() {
  const { t } = useTranslation();
  useDocumentTitle(`FunPay — ${t('lp_e_badge')}`);

  return (
    <>
      <Board label={t('lp_e_badge')}>
        <Statement html={t('lp_e_h1')} lead={t('lp_e_sub')}>
          <div className="mk-actions">
            <Link to="/onboarding?role=employer" className="mk-btn">{t('lp_e_cta')} {ArrowIcon}</Link>
            <Link to="/login" className="mk-btn ghost">{t('lp_e_login')}</Link>
          </div>
        </Statement>
      </Board>

      <Board tone="paper">
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_e_why_tag')} title={t('lp_e_why_h')} lead={t('lp_e_why_p')} />
          </div>
          <Figures items={[1, 2, 3, 4].map((n) => ({ value: t(`lp_e_why_${n}_v`), label: t(`lp_e_why_${n}_l`) }))} />
        </div>
      </Board>

      <Board>
        <div className="mk-cols">
          <div className="sticky">
            <BoardHead kicker={t('lp_e_how_tag')} title={t('lp_e_how_h')} />
          </div>
          <PillSteps items={[1, 2, 3, 4].map((n) => ({ title: t(`lp_e_how_${n}_t`), sub: t(`lp_e_how_${n}_d`) }))} />
        </div>
      </Board>

      <Board tone="paper">
        <BoardHead kicker={t('lp_e_ben_tag')} title={t('lp_e_ben_h')} />
        <div className="mk-gap" />
        <Rows columns={2} items={[1, 2, 3, 4].map((n) => ({ title: t(`lp_e_ben_${n}_t`), desc: t(`lp_e_ben_${n}_d`) }))} />
      </Board>

      <Board tone="sage">
        <Statement html={t('lp_e_close_h')} lead={t('lp_e_close_sub')} center>
          <div className="mk-actions">
            <Link to="/onboarding?role=employer" className="mk-btn">{t('lp_e_cta')} {ArrowIcon}</Link>
            <Link to="/contact" className="mk-btn ghost">{t('nav_contact')}</Link>
          </div>
        </Statement>
      </Board>
    </>
  );
}

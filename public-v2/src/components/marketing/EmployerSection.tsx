import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, BoardHead } from './Board';
import { Icon, type IconName } from '../shared/Icons';

/**
 * Employer section on the ops-side board. The stage is a generated
 * photograph (stage-employer) with crisp objects on top: the three real
 * things in the operation, each a drawn vector icon. The data panel states
 * product facts (0 MXN for the company, one file per cut-off, the 30% cap)
 * and the cycle — never an invented employer, figure or percentage.
 */
const OBJECTS: { icon: IconName; t: string; d: string; lit?: boolean }[] = [
  { icon: 'nomina', t: 'emp_obj_1_t', d: 'emp_obj_1_d', lit: true },
  { icon: 'quincena', t: 'emp_obj_2_t', d: 'emp_obj_2_d' },
  { icon: 'condusef', t: 'emp_obj_3_t', d: 'emp_obj_3_d' },
];

const CYCLE: { icon: IconName; t: string; d: string }[] = [
  { icon: 'nomina', t: 'emp_cycle_1_t', d: 'emp_cycle_1_d' },
  { icon: 'cobranza', t: 'emp_cycle_2_t', d: 'emp_cycle_2_d' },
  { icon: 'reporte', t: 'emp_cycle_3_t', d: 'emp_cycle_3_d' },
];

export function EmployerSection() {
  const { t } = useTranslation();

  return (
    <Board tone="ops" id="employers-board">
      <BoardHead kicker={t('emp_tag')} title={t('emp_h2')} lead={t('emp_p')} />
      <div className="mk-gap" />

      <div className="mk-ops-grid">
        <div className="mk-panel stage photo" aria-hidden="true">
          <div className="mk-brand-ops"><b>F</b>FunPay · Ops</div>
          <div className="mk-tags">
            <span className="mk-tag"><i />{t('emp_tag_collections')}</span>
            <span className="mk-tag">{t('emp_tag_employers')}</span>
            <span className="mk-tag">CONDUSEF</span>
          </div>
          <div className="mk-objects">
            {OBJECTS.map((o) => (
              <div key={o.icon} className={`mk-object${o.lit ? ' lit' : ''}`}>
                <Icon name={o.icon} size={30} />
                <b>{t(o.t)}</b>
                <span>{t(o.d)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mk-panel data">
          <span className="mk-tag" style={{ alignSelf: 'flex-start' }}>{t('emp_tag_panel')}</span>
          <div className="mk-kpis">
            {[1, 2, 3].map((n) => (
              <div key={n} className="mk-kpi">
                <small>{t(`emp_kpi_${n}_l`)}</small>
                <b>{t(`emp_kpi_${n}_v`)}</b>
              </div>
            ))}
          </div>
          <h3>{t('emp_rows_h')}</h3>
          {CYCLE.map((c, i) => (
            <div key={c.icon} className="mk-batch">
              <span className={`fl${i === 0 ? ' g' : ''}`}><Icon name={c.icon} size={18} /></span>
              <span className="t">{t(c.t)}<small>{t(c.d)}</small></span>
            </div>
          ))}
          <div className="mk-due"><i /><span>{t('emp_due')}<small>{t('emp_due_sub')}</small></span></div>
          <Link to="/employers" className="mk-btn white"><i />{t('emp_link')}</Link>
        </div>
      </div>
    </Board>
  );
}

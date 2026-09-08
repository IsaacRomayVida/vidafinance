import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Board, BoardHead } from './Board';

/**
 * Employer section on the ops-side board: charcoal→forest, dark glass
 * tags, the spatial folder stack with the current quincena lit Harmony
 * Green, a floating progress card, three KPIs and ONE white pill action.
 * The stack and the figures are an illustrative view, labelled as such.
 */
export function EmployerSection() {
  const { t } = useTranslation();

  const folders = [
    { i: -3, n: '4', label: 'Hotel Playa' },
    { i: -2, n: '6', label: 'Grupo Caribe' },
    { i: -1, n: '2', label: 'Villas del Sol' },
    { i: 0, n: '12', label: t('emp_folder_batch'), lit: true },
    { i: 1, n: '3', label: t('emp_folder_aml') },
    { i: 2, n: '1', label: 'CONDUSEF' },
  ];

  return (
    <Board tone="ops" id="employers-board">
      <BoardHead kicker={t('emp_tag')} title={t('emp_h2')} lead={t('emp_p')} />
      <div className="mk-gap" />

      <div className="mk-ops-grid">
        <div className="mk-panel stage" aria-hidden="true">
          <div className="mk-brand-ops"><b>F</b>FunPay · Ops</div>
          <div className="mk-tags">
            <span className="mk-tag"><i />{t('emp_tag_collections')}</span>
            <span className="mk-tag">{t('emp_tag_employers')}</span>
            <span className="mk-tag">CONDUSEF</span>
          </div>
          <div className="mk-stack">
            {folders.map((f) => (
              <div key={f.i} className={`mk-folder${f.lit ? ' lit' : ''}`} style={{ ['--i' as string]: f.i }}>
                <div className="doc"><i /><i /><i /></div>
                <span className="n">{f.n}</span>
                <span className="lbl">{f.label}</span>
              </div>
            ))}
          </div>
          <div className="mk-prog">
            <div className="h"><span>{t('emp_folder_batch')}</span><span>↗</span></div>
            <div className="d">{t('emp_prog_sub')}</div>
            <div className="v">92<b>%</b></div>
            <span className="dotg" />
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
          <div className="mk-batch"><span className="fl g" /><span className="t">Hotel Playa<small>412 · {t('emp_batch_received')}</small></span><span className="p g">98%</span></div>
          <div className="mk-batch"><span className="fl g" /><span className="t">Grupo Caribe<small>288 · {t('emp_batch_received')}</small></span><span className="p g">95%</span></div>
          <div className="mk-batch"><span className="fl" /><span className="t">Villas del Sol<small>190 · {t('emp_batch_pending')}</small></span><span className="p">—</span></div>
          <div className="mk-due"><i /><span>{t('emp_due')}<small>{t('emp_due_sub')}</small></span></div>
          <Link to="/employers" className="mk-btn white"><i />{t('emp_link')}</Link>
        </div>
      </div>
    </Board>
  );
}

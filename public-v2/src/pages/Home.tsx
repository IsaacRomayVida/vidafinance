import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

export function Home() {
  const { t } = useTranslation();

  return (
    <>
      {/* Hero */}
      <section className="bg-teal-950 px-6 py-24 text-center text-white">
        <span className="mb-4 inline-block rounded-full bg-gold-500/20 px-4 py-1.5 text-sm font-medium text-gold-400">
          {t('hero_badge')}
        </span>
        <h1
          className="mx-auto max-w-3xl text-4xl font-bold leading-tight md:text-6xl"
          dangerouslySetInnerHTML={{ __html: t('hero_h1') }}
        />
        <p className="mx-auto mt-4 max-w-xl text-lg text-teal-300">
          {t('hero_sub')}
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <Link
            to="/employers"
            className="rounded-lg bg-gold-500 px-6 py-3 font-medium text-white hover:bg-gold-600"
          >
            {t('hero_cta_employer')}
          </Link>
          <Link
            to="/employees"
            className="rounded-lg border border-teal-600 px-6 py-3 font-medium text-white hover:bg-teal-800"
          >
            {t('hero_cta_employee')}
          </Link>
        </div>
      </section>

      {/* Statement */}
      <section className="px-6 py-20 text-center">
        <h2
          className="mx-auto max-w-2xl text-3xl font-bold text-teal-900 md:text-4xl"
          dangerouslySetInnerHTML={{ __html: t('stmt_h2') }}
        />
        <p className="mx-auto mt-4 max-w-lg text-teal-700">{t('stmt_p')}</p>
      </section>

      {/* How it Works */}
      <section className="bg-teal-50 px-6 py-20">
        <div className="mx-auto max-w-6xl text-center">
          <span className="text-sm font-semibold uppercase tracking-wider text-gold-500">
            {t('hiw_tag')}
          </span>
          <h2 className="mt-2 text-3xl font-bold text-teal-900">{t('hiw_h2')}</h2>
          <p className="mx-auto mt-2 max-w-lg text-teal-700">{t('hiw_p')}</p>
          <div className="mt-12 grid gap-8 md:grid-cols-4">
            {[1, 2, 3, 4].map((step) => (
              <div key={step} className="rounded-xl bg-white p-6 shadow-sm">
                <div className="mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full bg-teal-900 text-sm font-bold text-white">
                  {step}
                </div>
                <h3 className="mb-2 font-semibold text-teal-900">
                  {t(`step_${step}_title`)}
                </h3>
                <p className="text-sm text-teal-700">{t(`step_${step}_desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-teal-900 px-6 py-20 text-center text-white">
        <h2
          className="text-3xl font-bold md:text-4xl"
          dangerouslySetInnerHTML={{ __html: t('close_h2') }}
        />
        <p className="mx-auto mt-4 max-w-lg text-teal-300">{t('close_sub')}</p>
        <Link
          to="/get-started"
          className="mt-8 inline-block rounded-lg bg-gold-500 px-8 py-3 font-medium text-white hover:bg-gold-600"
        >
          {t('close_cta')}
        </Link>
      </section>
    </>
  );
}

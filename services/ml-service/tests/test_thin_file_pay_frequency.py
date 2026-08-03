"""
#435 — 'semimonthly' must not reach the thin-file index as an unseen token.

The index was trained over exactly three cadences (scripts/train_thin_file_index
.py: weekly, biweekly, monthly). Part 1 of #435 made 'semimonthly' selectable at
onboarding, so from that point a borrower paid on the 15th and the last day
produced `pay_frequency:semimonthly` at inference — a token the embedding has
never seen. It does not raise; it just matches worse, on thin-file applicants,
who are the ones with the least other signal to fall back on.
"""

# Only build_profile_text is imported at module scope, on purpose. The helpers
# below are imported inside the tests that need them so that the behavioural
# assertion — what token actually reaches the embedding — fails against the old
# code with a real assertion rather than a collection error.
from models.thin_file_knn import build_profile_text


def profile(**overrides):
    base = {
        "monthlySalary": 20000.0,
        "employmentTenureMonths": 24,
        "employerIndustry": "retail",
        "employerTier": 2,
        "companySize": "51-200",
        "sectorRisk": 2,
        "aforeRegularity": 0.8,
        "riskSealScore": 60.0,
        "principalAmount": 1000.0,
    }
    base.update(overrides)
    return base


def test_semimonthly_embeds_as_a_trained_token():
    text = build_profile_text(profile(payFrequency="semimonthly"))
    assert "pay_frequency:semimonthly" not in text
    assert "pay_frequency:biweekly" in text


def test_semimonthly_and_biweekly_produce_the_same_token():
    from models.thin_file_knn import normalise_pay_frequency

    # Both are two paydays a month. The difference between them matters for WHEN
    # the deduction lands, not for how often income arrives.
    assert normalise_pay_frequency("semimonthly") == normalise_pay_frequency("biweekly")


def test_every_alias_target_is_in_the_trained_vocabulary():
    from models.thin_file_knn import PAY_FREQUENCY_ALIASES, TRAINED_PAY_FREQUENCIES

    # An alias pointing at an untrained token would reintroduce the defect while
    # looking like the fix for it.
    for source, target in PAY_FREQUENCY_ALIASES.items():
        assert target in TRAINED_PAY_FREQUENCIES, f"{source} -> {target} is not trained"


def test_trained_vocabulary_plus_aliases_covers_the_canonical_ts_set():
    """
    Cross-language check against the canonical TypeScript declaration:
    PAY_FREQUENCY_VALUES in functions/src/loans/calculateNextPayrollDate.ts
    (weekly, biweekly, semimonthly, monthly). Python cannot import that union,
    so the four values are restated here on purpose, and this proves every one
    of them is reachable — either trained directly or aliased onto a trained
    cadence. A canonical value that is neither is exactly #435's defect: a
    token the embedding has never seen, matching worst for the applicants with
    the least other signal.
    """
    from models.thin_file_knn import PAY_FREQUENCY_ALIASES, TRAINED_PAY_FREQUENCIES

    canonical_ts_pay_frequencies = {"weekly", "biweekly", "semimonthly", "monthly"}
    reachable = set(TRAINED_PAY_FREQUENCIES) | set(PAY_FREQUENCY_ALIASES)
    assert reachable == canonical_ts_pay_frequencies

    # The alias is deliberate and singular — 'semimonthly' is folded onto
    # 'biweekly' because both are two paydays a month for this model's
    # purposes. Any other alias here would be silently changing what a
    # borrower's cadence is scored as, not filling this gap.
    assert PAY_FREQUENCY_ALIASES == {"semimonthly": "biweekly"}


def test_trained_cadences_pass_through_unchanged():
    from models.thin_file_knn import TRAINED_PAY_FREQUENCIES, normalise_pay_frequency

    for frequency in TRAINED_PAY_FREQUENCIES:
        assert normalise_pay_frequency(frequency) == frequency


def test_unknown_and_missing_cadences_fall_back_to_monthly():
    from models.thin_file_knn import normalise_pay_frequency

    assert normalise_pay_frequency("quincenal") == "monthly"
    assert normalise_pay_frequency(None) == "monthly"
    assert normalise_pay_frequency(17) == "monthly"
    assert "pay_frequency:monthly" in build_profile_text(profile())


def test_every_emitted_token_is_one_the_index_was_trained_on():
    from models.thin_file_knn import PAY_FREQUENCY_ALIASES, TRAINED_PAY_FREQUENCIES

    # The property that actually matters, stated once: whatever a borrower's
    # cadence is, the token that reaches the embedding is a trained one.
    for value in [*TRAINED_PAY_FREQUENCIES, *PAY_FREQUENCY_ALIASES, "quincenal", None]:
        text = build_profile_text(profile(payFrequency=value))
        emitted = next(p for p in text.split(" ") if p.startswith("pay_frequency:"))
        assert emitted.split(":", 1)[1] in TRAINED_PAY_FREQUENCIES

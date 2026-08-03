"""
WoE bin lookup for values outside the training range — ScorecardChampion.

── The defect these tests pin ────────────────────────────────────────────────
`_lookup_woe` scans the stored bins for one whose half-open `[lo, hi)` range
contains the value, and when none does it returned `bins[-1]["woe"]` — the
woe of the HIGHEST bin, unconditionally.

The bins come from `pd.qcut` over the synthetic training frame
(scripts/train_scorecard_champion.py:149), so the first bin's `lo` is the
training-set MINIMUM (minus a pandas epsilon) and the last bin's `hi` is the
training-set MAXIMUM. Those edges are artefacts of where the training data
happened to stop, not real boundaries — the training frame clips
`monthly_salary` to [7000, 60000] and `cdcScore` to [300, 850]
(train_scorecard_champion.py:41, :50). Production clips neither.

So for the two selected features whose training floor a real applicant can sit
below, the fallback inverted the model:

    cdcScore       floor 299.999   lowest bin woe -0.5007   highest +0.6153
    monthly_salary floor 6999.999  lowest bin woe -0.4879   highest +0.5839

Every LR coefficient is positive, so "highest woe" is "safest borrower". A
borrower with a 250 bureau score and a 5,000 salary produced a byte-identical
WoE vector to a borrower with an 800 bureau score and a 50,000 salary, and the
same P(repayment) = 0.9936. The same fallback fires when a feature is ABSENT,
because `_apply_woe` reads it as a raw 0.0 (scorecard_model.py:44) and 0.0 is
below both floors — a missing bureau score scored as a top-tier one.

── What the fix is, and why it is not a policy choice ────────────────────────
Out-of-range values clamp to the NEAREST bin: below the floor takes the lowest
bin, above the ceiling takes the highest. Above-the-ceiling behaviour is
unchanged — `bins[-1]` was already the nearest bin there, which is why the
defect only ever bit on the low side and why no existing test caught it.

This is the monotonicity the binning already asserts, not a risk-appetite
setting: the WoE sequence for every selected feature is monotone across its
bins, and handing the value at one extreme the woe of the other extreme
contradicts the model's own fitted ordering under any appetite. Whether an
applicant BELOW the training floor should be scored at all, rather than routed
to a human as out-of-population, is a separate and genuinely commercial
question and is deliberately not decided here.

Control tests below (`TestControlsUnchangedByTheFix`) cover in-range lookups,
the above-ceiling fallback, and score polarity. They pass in BOTH the before
and after states — that is what makes the red tests above discriminating
rather than an artefact of the harness.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from models.scorecard_model import ScorecardChampion  # noqa: E402

CHAMPION_PATH = "models/scorecard_champion_v2.joblib"


@pytest.fixture(scope="module")
def champion():
    return ScorecardChampion.load(CHAMPION_PATH)


def _bins(model, feature):
    return model.woe_bins[feature]


def _lowest_bin(model, feature):
    return min(_bins(model, feature), key=lambda b: b["range"][0])


def _highest_bin(model, feature):
    return max(_bins(model, feature), key=lambda b: b["range"][1])


# A borrower who is comfortably inside every bin except the one under test, so
# a single feature can be moved without any other bin boundary interfering.
BASE = {
    "scDiasAtraso": 0.0,
    "cdcScore": 600.0,
    "carteraVencida": 500.0,
    "imss_tenure_months": 60.0,
    "lti": 0.10,
    "riskSeal_score": 50.0,
    "employer_tier": 2.0,
    "sector_risk": 2.0,
    "afore_regularity": 0.7,
    "monthly_salary": 20000.0,
}


# ── RED before the fix ───────────────────────────────────────────────────────


class TestBelowTrainingFloor:
    """A value under the lowest bin must not be scored as the highest bin."""

    @pytest.mark.parametrize("feature", ["cdcScore", "monthly_salary"])
    def test_below_floor_takes_lowest_bin_not_highest(self, champion, feature):
        lowest = _lowest_bin(champion, feature)
        highest = _highest_bin(champion, feature)
        # Sanity: this feature is one where the two ends genuinely disagree,
        # otherwise the assertion below would be vacuous.
        assert lowest["woe"] != highest["woe"]

        below = lowest["range"][0] - 50.0
        got = champion._lookup_woe(feature, below)

        assert got != highest["woe"], (
            f"{feature}={below} is below the training floor "
            f"{lowest['range'][0]} and was scored with the HIGHEST bin's woe "
            f"({highest['woe']:.4f}) — the safest band in the model"
        )
        assert got == lowest["woe"]

    def test_subprime_applicant_is_not_identical_to_a_prime_one(self, champion):
        """The headline failure: two opposite borrowers, one identical score."""
        subprime = {**BASE, "cdcScore": 250.0, "monthly_salary": 5000.0}
        prime = {**BASE, "cdcScore": 800.0, "monthly_salary": 50000.0}

        assert champion.predict_proba(subprime) < champion.predict_proba(prime), (
            "a 250 bureau score on a 5,000 salary scored at least as well as "
            "an 800 bureau score on a 50,000 salary"
        )

    def test_salary_is_monotone_across_the_training_floor(self, champion):
        """6,000 must not out-score 7,500 with every other feature held equal."""
        below_floor = {**BASE, "monthly_salary": 6000.0}
        just_inside = {**BASE, "monthly_salary": 7500.0}

        assert champion.predict_proba(below_floor) <= champion.predict_proba(
            just_inside
        ), (
            "salary 6,000 (below the 6,999.999 training floor) scored better "
            "than salary 7,500 — the fallback jumped it to the top salary band"
        )


class TestAbsentFeature:
    """`_apply_woe` reads an absent feature as raw 0.0 — below both floors."""

    @pytest.mark.parametrize("feature", ["cdcScore", "monthly_salary"])
    def test_absent_feature_does_not_score_as_the_safest_band(self, champion, feature):
        without = {k: v for k, v in BASE.items() if k != feature}
        highest = _highest_bin(champion, feature)

        woe_vector = champion._apply_woe(without)
        position = champion.selected_features.index(feature)

        assert woe_vector[position] != highest["woe"], (
            f"a completely absent {feature} was scored with the highest "
            f"bin's woe ({highest['woe']:.4f})"
        )

    def test_absent_features_do_not_beat_a_prime_applicant(self, champion):
        missing_both = {
            k: v for k, v in BASE.items() if k not in ("cdcScore", "monthly_salary")
        }
        prime = {**BASE, "cdcScore": 800.0, "monthly_salary": 50000.0}

        assert champion.predict_proba(missing_both) < champion.predict_proba(prime)


# ── GREEN both before and after — these are the controls ─────────────────────


class TestControlsUnchangedByTheFix:
    @pytest.mark.parametrize("feature", ScorecardChampion.FEATURE_SET)
    def test_above_ceiling_still_takes_the_highest_bin(self, champion, feature):
        """Unchanged behaviour: `bins[-1]` was already the nearest bin here."""
        highest = _highest_bin(champion, feature)
        above = highest["range"][1] + 1000.0
        assert champion._lookup_woe(feature, above) == highest["woe"]

    @pytest.mark.parametrize("feature", ScorecardChampion.FEATURE_SET)
    def test_every_in_range_value_maps_to_its_own_bin(self, champion, feature):
        """Exact lookups are untouched — one probe per stored bin."""
        for entry in _bins(champion, feature):
            lo, hi = entry["range"]
            midpoint = lo + (hi - lo) / 2.0
            assert champion._lookup_woe(feature, midpoint) == entry["woe"]
            assert champion._lookup_woe(feature, lo) == entry["woe"]

    def test_unknown_feature_still_returns_neutral_zero(self, champion):
        assert champion._lookup_woe("a_feature_that_was_never_trained", 42.0) == 0.0

    def test_polarity_a_higher_score_is_the_safer_borrower(self, champion):
        """championScore is P(repayment); stage3 reads `1 - championScore`."""
        good = {
            **BASE,
            "cdcScore": 800.0,
            "imss_tenure_months": 120.0,
            "lti": 0.05,
            "monthly_salary": 45000.0,
        }
        bad = {
            **BASE,
            "cdcScore": 350.0,
            "imss_tenure_months": 1.0,
            "lti": 0.90,
            "monthly_salary": 8000.0,
        }
        assert champion.predict_proba(good) > champion.predict_proba(bad)

    def test_predictions_stay_inside_the_probability_range(self, champion):
        for features in (BASE, {}, {**BASE, "monthly_salary": 1.0}):
            assert 0.0 <= champion.predict_proba(features) <= 1.0

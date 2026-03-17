import numpy as np
import joblib


class UnderwritingModel:
    """
    Logistic regression baseline model for loan underwriting.

    Trained initially on synthetic data + industry benchmarks.
    Will be retrained quarterly on real VIDA portfolio data once
    sufficient loan volume accumulates (target: 200+ completed loans).

    Feature order is fixed and must match training data:
      [employment_tenure_months, monthly_salary, pay_frequency_encoded,
       loan_to_salary_ratio, employer_industry_encoded, principal_amount,
       bureau_score, has_bureau_record]
    """

    FEATURE_ORDER = [
        "employment_tenure_months",
        "monthly_salary",
        "pay_frequency_encoded",
        "loan_to_salary_ratio",
        "employer_industry_encoded",
        "principal_amount",
        "bureau_score",
        "has_bureau_record",
    ]

    def __init__(self, weights, bias, scaler):
        self.weights = np.array(weights, dtype=np.float64)
        self.bias = float(bias)
        self.scaler = scaler
        self.version = "logistic_v1.0"

    def predict_proba(self, features: dict) -> float:
        """Return P(repayment) in [0.0, 1.0]. Higher = safer borrower."""
        x = np.array(
            [features.get(f, 0.0) for f in self.FEATURE_ORDER], dtype=np.float64
        )
        x_scaled = self.scaler.transform([x])[0]
        logit = np.dot(self.weights, x_scaled) + self.bias
        return float(1.0 / (1.0 + np.exp(-logit)))

    @classmethod
    def load(cls, path: str) -> "UnderwritingModel":
        return joblib.load(path)

    def save(self, path: str):
        joblib.dump(self, path)

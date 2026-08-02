"""
Fixed borrower feature vectors used to prove that re-pickling
models/underwriting_v1.joblib under numpy==1.26.0 (see requirements.txt)
did not change the model's scoring behaviour.

Vectors are hand-picked (not randomly generated) so they are byte-for-byte
reproducible regardless of numpy RNG implementation changes across versions.
They span good, marginal, and risky borrower profiles per
UnderwritingModel.FEATURE_ORDER:
  [employment_tenure_months, monthly_salary, pay_frequency_encoded,
   loan_to_salary_ratio, employer_industry_encoded, principal_amount,
   bureau_score, has_bureau_record]

See tests/model_parity_baseline.json for the recorded outputs and
tests/test_model_parity.py for the regression check.
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

# 24 fixed borrower profiles: 8 good, 8 marginal, 8 risky.
BORROWER_VECTORS = [
    # -- good borrowers --------------------------------------------------
    {"employment_tenure_months": 36, "monthly_salary": 25000, "pay_frequency_encoded": 4,
     "loan_to_salary_ratio": 0.08, "employer_industry_encoded": 1, "principal_amount": 2000,
     "bureau_score": 750, "has_bureau_record": 1},
    {"employment_tenure_months": 24, "monthly_salary": 20000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.10, "employer_industry_encoded": 1, "principal_amount": 2000,
     "bureau_score": 700, "has_bureau_record": 1},
    {"employment_tenure_months": 48, "monthly_salary": 30000, "pay_frequency_encoded": 4,
     "loan_to_salary_ratio": 0.05, "employer_industry_encoded": 2, "principal_amount": 1500,
     "bureau_score": 800, "has_bureau_record": 1},
    {"employment_tenure_months": 18, "monthly_salary": 18000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.12, "employer_industry_encoded": 3, "principal_amount": 2200,
     "bureau_score": 680, "has_bureau_record": 1},
    {"employment_tenure_months": 60, "monthly_salary": 22000, "pay_frequency_encoded": 4,
     "loan_to_salary_ratio": 0.09, "employer_industry_encoded": 0, "principal_amount": 2000,
     "bureau_score": 720, "has_bureau_record": 1},
    {"employment_tenure_months": 30, "monthly_salary": 27000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.07, "employer_industry_encoded": 5, "principal_amount": 1900,
     "bureau_score": 690, "has_bureau_record": 1},
    {"employment_tenure_months": 20, "monthly_salary": 19000, "pay_frequency_encoded": 4,
     "loan_to_salary_ratio": 0.11, "employer_industry_encoded": 4, "principal_amount": 2100,
     "bureau_score": 710, "has_bureau_record": 1},
    {"employment_tenure_months": 40, "monthly_salary": 24000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.06, "employer_industry_encoded": 6, "principal_amount": 1500,
     "bureau_score": 760, "has_bureau_record": 1},
    # -- marginal borrowers ------------------------------------------------
    {"employment_tenure_months": 8, "monthly_salary": 12000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.25, "employer_industry_encoded": 3, "principal_amount": 3000,
     "bureau_score": 550, "has_bureau_record": 1},
    {"employment_tenure_months": 6, "monthly_salary": 10000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.30, "employer_industry_encoded": 2, "principal_amount": 3000,
     "bureau_score": 500, "has_bureau_record": 0},
    {"employment_tenure_months": 12, "monthly_salary": 15000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.20, "employer_industry_encoded": 5, "principal_amount": 3000,
     "bureau_score": 580, "has_bureau_record": 1},
    {"employment_tenure_months": 10, "monthly_salary": 13000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.28, "employer_industry_encoded": 7, "principal_amount": 3600,
     "bureau_score": 520, "has_bureau_record": 0},
    {"employment_tenure_months": 9, "monthly_salary": 14000, "pay_frequency_encoded": 4,
     "loan_to_salary_ratio": 0.22, "employer_industry_encoded": 8, "principal_amount": 3100,
     "bureau_score": 560, "has_bureau_record": 1},
    {"employment_tenure_months": 5, "monthly_salary": 11000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.32, "employer_industry_encoded": 1, "principal_amount": 3500,
     "bureau_score": 490, "has_bureau_record": 0},
    {"employment_tenure_months": 14, "monthly_salary": 16000, "pay_frequency_encoded": 2,
     "loan_to_salary_ratio": 0.18, "employer_industry_encoded": 0, "principal_amount": 2900,
     "bureau_score": 600, "has_bureau_record": 1},
    {"employment_tenure_months": 7, "monthly_salary": 12500, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.27, "employer_industry_encoded": 6, "principal_amount": 3300,
     "bureau_score": 530, "has_bureau_record": 0},
    # -- risky borrowers -----------------------------------------------
    {"employment_tenure_months": 1, "monthly_salary": 6000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.50, "employer_industry_encoded": 0, "principal_amount": 3000,
     "bureau_score": 350, "has_bureau_record": 0},
    {"employment_tenure_months": 0, "monthly_salary": 7000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.60, "employer_industry_encoded": 0, "principal_amount": 4000,
     "bureau_score": 320, "has_bureau_record": 0},
    {"employment_tenure_months": 2, "monthly_salary": 8000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.55, "employer_industry_encoded": 1, "principal_amount": 4200,
     "bureau_score": 340, "has_bureau_record": 0},
    {"employment_tenure_months": 1, "monthly_salary": 7500, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.65, "employer_industry_encoded": 2, "principal_amount": 4800,
     "bureau_score": 310, "has_bureau_record": 0},
    {"employment_tenure_months": 3, "monthly_salary": 8500, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.48, "employer_industry_encoded": 3, "principal_amount": 3900,
     "bureau_score": 360, "has_bureau_record": 0},
    {"employment_tenure_months": 0, "monthly_salary": 6500, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.70, "employer_industry_encoded": 4, "principal_amount": 4500,
     "bureau_score": 300, "has_bureau_record": 0},
    {"employment_tenure_months": 2, "monthly_salary": 9000, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.52, "employer_industry_encoded": 5, "principal_amount": 4600,
     "bureau_score": 330, "has_bureau_record": 0},
    {"employment_tenure_months": 1, "monthly_salary": 6800, "pay_frequency_encoded": 1,
     "loan_to_salary_ratio": 0.58, "employer_industry_encoded": 6, "principal_amount": 3900,
     "bureau_score": 345, "has_bureau_record": 0},
]

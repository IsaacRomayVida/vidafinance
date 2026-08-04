/**
 * Inline ML scoring — rule-based scoring loosely ported from
 * services/ml-service/scoring.py.
 *
 * NOT WIRED. Nothing imports this module. The underwriting gateway that
 * actually runs in production is the private `callML()` in index.ts, which
 * POSTs to ML_SERVICE_URL and throws on a non-2xx so an ML outage fails
 * closed (see #544). This file exports a function with the same name and the
 * exact same `(path, body) => Promise<Record<string, unknown>>` signature, so
 * a one-line import would silently swap live underwriting onto a scorer that
 * makes no network call and can never throw — reintroducing precisely the
 * fail-open #544 removed. Kept, rather than deleted, as the reference for the
 * planned inline-scoring migration; wire it only deliberately.
 *
 * It is also NOT a faithful port. scoring.py scores fraud on a 0-100 scale
 * (`requestsLastHour > 2` alone is +50 and trips `is_fraud: sc >= 50`), and
 * its second rule keys off `amountToSalaryRatio > 0.35`, not off amount and
 * bank-account presence. Re-deriving those weights changes who gets flagged
 * as fraud, which is a lending-policy decision, so the divergence is left
 * as-is and only the structurally-unreachable threshold is corrected below.
 */

interface MLInput {
  employeeId: string;
  monthlySalary: number;
  employerTier: number;
  existingLoans: number;
  bankClabe: string | null;
  amount: number;
  requestsLastHour: number;
}

function employeeScore(p: MLInput): { credit_score: number; default_probability: number; credit_limit: number } {
  const sal = p.monthlySalary || 0;
  const tier = p.employerTier || 2;
  let s = 50;

  if (sal >= 20000) s += 15;
  else if (sal >= 12000) s += 8;

  if (tier === 1) s += 15;
  else if (tier === 2) s += 5;

  if (p.existingLoans > 0) s -= 30;
  if (p.bankClabe) s += 10;

  s = Math.max(0, Math.min(100, s));

  // Clamped at 0: a negative or nonsense salary must not produce a negative
  // credit limit. Downstream `amount <= credit_limit` checks would read that
  // as "approve nothing", but a negative peso limit is not a value this
  // function is ever entitled to return.
  const limit = Math.max(0, Math.min(5000, Math.round((sal * 0.30) / 100) * 100));
  const defaultProb = Math.max(0, Math.min(1, (100 - s) / 100 * 0.5));

  return { credit_score: s, default_probability: defaultProb, credit_limit: limit };
}

function fraudScore(p: MLInput): { is_fraud: boolean; fraud_probability: number; flags: string[] } {
  const flags: string[] = [];
  let prob = 0;

  if (p.requestsLastHour > 2) { flags.push('high_frequency'); prob += 0.3; }
  if (p.amount >= 5000 && !p.bankClabe) { flags.push('max_amount_no_bank'); prob += 0.2; }

  // `>=`, not `>`. The two rules above sum to at most 0.3 + 0.2 = 0.5, so a
  // strict `> 0.5` is a threshold no input can reach: `is_fraud` was false for
  // every possible applicant, including one tripping every signal at once, and
  // the gate was decorative. scoring.py uses an inclusive `sc >= 50`, which is
  // the same boundary on its 0-100 scale.
  return { is_fraud: prob >= 0.5, fraud_probability: Math.min(1, prob), flags };
}

export async function callML(_path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input: MLInput = {
    employeeId: (body.employeeId as string) || '',
    monthlySalary: (body.monthlySalary as number) || 0,
    employerTier: (body.employerTier as number) || 2,
    existingLoans: (body.existingLoans as number) || 0,
    bankClabe: (body.bankClabe as string) || null,
    amount: (body.amount as number) || 0,
    requestsLastHour: (body.requestsLastHour as number) || 0,
  };

  const score = employeeScore(input);
  const fraud = fraudScore(input);
  const decisionId = 'ml-inline-' + Date.now();

  return {
    decisionId,
    credit_score: score.credit_score,
    default_probability: score.default_probability,
    credit_limit: score.credit_limit,
    fraud,
    model: 'rule_based_inline_v1',
  };
}

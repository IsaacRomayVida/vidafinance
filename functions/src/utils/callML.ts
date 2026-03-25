/**
 * Inline ML scoring — replaces external Railway ML service.
 * Rule-based scoring ported from services/ml-service/scoring.py
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

  const limit = Math.min(5000, Math.round((sal * 0.30) / 100) * 100);
  const defaultProb = Math.max(0, Math.min(1, (100 - s) / 100 * 0.5));

  return { credit_score: s, default_probability: defaultProb, credit_limit: limit };
}

function fraudScore(p: MLInput): { is_fraud: boolean; fraud_probability: number; flags: string[] } {
  const flags: string[] = [];
  let prob = 0;

  if (p.requestsLastHour > 2) { flags.push('high_frequency'); prob += 0.3; }
  if (p.amount >= 5000 && !p.bankClabe) { flags.push('max_amount_no_bank'); prob += 0.2; }

  return { is_fraud: prob > 0.5, fraud_probability: Math.min(1, prob), flags };
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

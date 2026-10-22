<!-- © Suena AG / FunPay Technologies. All rights reserved. -->
# Security policy

## Reporting a vulnerability

Email **security@suena.ch**. Do not open a public issue or pull request.

Please include:

- what you found and which surface it affects (borrower app, employer or ops dashboard, mobile app, a backend service, Firebase rules or functions);
- steps to reproduce, or a proof of concept;
- the impact as you see it;
- whether you have already told anyone else.

We acknowledge within 3 business days, give a first assessment within 10, and keep you informed until it is fixed. We credit reporters who want credit.

## Please do not

- Create real loans, repayments or payroll deductions to prove a point. Use test data in a non-production environment.
- Access, modify or delete data that is not yours, or degrade the service for others.
- Run automated scanners against production. Ask us for a test target.
- Exfiltrate personal or financial data beyond the minimum needed to show the issue.

Good-faith research that follows these rules will not be pursued legally.

## Supported versions

FunPay ships continuously from `main`. Only what is deployed from `main` is supported; fixes land there and are not backported.

| Version | Supported |
|---|---|
| `main` (deployed) | Yes |
| Any other branch, tag or old build | No |

## Secrets

If you find a credential in the repository or its history, report it the same way. We rotate first, then clean up.

## How we check

The automated pipeline (static analysis, secret scanning, dependency and container scanning) is described in [docs/security/pipeline.md](docs/security/pipeline.md).

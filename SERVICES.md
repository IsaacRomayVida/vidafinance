# VIDA Finance — Railway Microservices

| Service | Port | Language | Purpose |
|---------|------|----------|---------|
| payment-server | 3001 | Node.js | Conekta webhook receiver + SPEI disbursement BullMQ worker |
| notification-service | 3002 | Node.js | BullMQ consumer — WhatsApp (Twilio) + email (SendGrid) |
| pdf-generator | 3003 | Node.js | BullMQ consumer — Puppeteer loan contracts + receipts |
| softcredito-adapter | 3004 | Node.js | SoftCrédito SPEI + payroll deduction API wrapper |
| ml-service | 8000 | Python | XGBoost/LightGBM underwriting + Claude LLM judge |
| Redis | 6379 | Redis 7 | BullMQ queues + rate limiting + ML cache |

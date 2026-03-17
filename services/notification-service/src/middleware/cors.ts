import cors from 'cors';

const ALLOWED_ORIGINS = [
  'https://vida-staging.web.app',
  'https://vida-finance.web.app',
  'https://admin.vida.finance',
  'https://employer.vida.finance',
  'https://beta.vidatravel.mx',
  'https://vidatravel.mx',
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server calls have no Origin
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-secret'],
});

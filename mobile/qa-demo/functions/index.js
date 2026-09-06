/**
 * QA-demo stand-ins for the three callables the mobile app uses. Fixtures
 * only: the same names and response shapes as functions/src/index.ts, none
 * of the real logic, and NO payment rails — generatePaymentLink returns a
 * dead https URL on purpose. These run exclusively inside the local
 * Functions emulator under the offline `demo-funpay` project; nothing here
 * is ever deployed.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');

admin.initializeApp();

exports.getLoanConfig = onCall(() => ({
  feeRate: 0.1,
  defaultTermDays: 30,
  repayment: [{ termDays: 30, label: 'Un solo pago a 30 días' }],
}));

exports.requestLoan = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión para continuar.');
  }
  const { amount, termsAccepted, bankAccountClabe } = request.data || {};
  if (
    termsAccepted !== true ||
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount < 500 ||
    amount > 5000 ||
    typeof bankAccountClabe !== 'string' ||
    bankAccountClabe.length !== 18
  ) {
    throw new HttpsError('invalid-argument', 'La solicitud no es válida.');
  }
  const loanRef = 'QA-' + Date.now().toString(36).toUpperCase();
  const ref = await getFirestore()
    .collection('loans')
    .add({
      employeeId: request.auth.uid,
      status: 'under_review',
      amount,
      principalAmount: amount,
      totalRepaymentAmount: Math.round(amount * 1.1),
      loanRef,
      createdAt: FieldValue.serverTimestamp(),
    });
  return {
    loanId: ref.id,
    loanRef,
    status: 'under_review',
    message: 'Solicitud recibida (demo QA).',
  };
});

exports.generatePaymentLink = onCall((request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Inicia sesión para continuar.');
  }
  // .invalid is reserved (RFC 2606): this link can never resolve to a real
  // payment page, which is exactly the point of a fixture.
  return { paymentUrl: 'https://pago-simulado.invalid/qa-demo' };
});

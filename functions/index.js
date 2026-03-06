const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

exports.api = onRequest({ cors: true }, async (req, res) => {
  if (req.path === "/api/health") {
    return res.json({ status: "ok", service: "vida-finance", timestamp: new Date().toISOString() });
  }
  return res.status(404).json({ error: "Not found" });
});

exports.onLoanStatusChange = onDocumentUpdated("loans/{loanId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();

  if (before.status === "pending" && after.status === "approved") {
    await db.collection("employers").doc(after.employerId).update({
      activeLoans: FieldValue.increment(1),
      totalDisbursed: FieldValue.increment(after.amount),
    });
  }

  if (before.status === "approved" && after.status === "paid") {
    await db.collection("employers").doc(after.employerId).update({
      activeLoans: FieldValue.increment(-1),
    });
    await db.collection("employees").doc(after.employeeId).update({
      availableCredit: FieldValue.increment(after.amount),
    });
  }
});

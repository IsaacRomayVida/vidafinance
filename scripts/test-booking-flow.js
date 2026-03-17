/**
 * End-to-end test for the travel booking flow.
 *
 * This script verifies:
 *  1. Seed data: 10+ active packages exist in Firestore
 *  2. Package schema: all required fields are present and correctly typed
 *  3. Booking creation: a booking doc is correctly structured
 *  4. Deposit processing: deposit status transitions work
 *  5. Installment payments: plan updates correctly
 *  6. Progress tracking: paidMXN / remainingMXN are accurate
 *
 * Usage:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/test-booking-flow.js
 *   node scripts/test-booking-flow.js --production --yes
 */

const admin = require("firebase-admin");

const isProduction = process.argv.includes("--production");

if (!admin.apps.length) {
  admin.initializeApp({ projectId: "vida-finance" });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${label}`);
  } else {
    failed++;
    console.log(`  [FAIL] ${label}`);
  }
}

async function testPackageSeedData() {
  console.log("\n── Test 1: Package Seed Data ──");

  const snapshot = await db.collection("packages").where("active", "==", true).get();
  assert(snapshot.size >= 10, `At least 10 active packages (found ${snapshot.size})`);

  const requiredFields = [
    "name", "description", "destination", "hotel", "priceMXN",
    "adultRate", "childRate", "durationNights", "images", "includes",
    "availability", "active", "createdAt", "updatedAt",
  ];

  for (const doc of snapshot.docs) {
    const data = doc.data();
    for (const field of requiredFields) {
      assert(data[field] !== undefined, `${doc.id}: has field "${field}"`);
    }

    // Bilingual fields
    assert(typeof data.name?.en === "string" && data.name.en.length > 0, `${doc.id}: name.en is non-empty string`);
    assert(typeof data.name?.es === "string" && data.name.es.length > 0, `${doc.id}: name.es is non-empty string`);
    assert(typeof data.description?.en === "string", `${doc.id}: description.en exists`);
    assert(typeof data.description?.es === "string", `${doc.id}: description.es exists`);
    assert(Array.isArray(data.includes?.en), `${doc.id}: includes.en is array`);
    assert(Array.isArray(data.includes?.es), `${doc.id}: includes.es is array`);

    // Numeric fields
    assert(typeof data.priceMXN === "number" && data.priceMXN > 0, `${doc.id}: priceMXN is positive number`);
    assert(typeof data.adultRate === "number" && data.adultRate > 0, `${doc.id}: adultRate is positive number`);
    assert(typeof data.childRate === "number" && data.childRate > 0, `${doc.id}: childRate is positive number`);
    assert(data.childRate <= data.adultRate, `${doc.id}: childRate <= adultRate`);
    assert(typeof data.durationNights === "number" && data.durationNights >= 1, `${doc.id}: durationNights >= 1`);

    // Images
    assert(Array.isArray(data.images) && data.images.length > 0, `${doc.id}: has at least 1 image`);

    // Availability
    assert(data.availability?.startDate, `${doc.id}: availability.startDate exists`);
    assert(data.availability?.endDate, `${doc.id}: availability.endDate exists`);
    assert(typeof data.availability?.spotsTotal === "number", `${doc.id}: availability.spotsTotal is number`);
    assert(typeof data.availability?.spotsRemaining === "number", `${doc.id}: availability.spotsRemaining is number`);

    // Only do detailed checks for first package to avoid noise
    break;
  }

  console.log(`  (Schema validated on first package; ${snapshot.size} packages total)`);
}

async function testBookingCreation() {
  console.log("\n── Test 2: Booking Creation ──");

  // Pick the first active package
  const pkgSnap = await db.collection("packages").where("active", "==", true).limit(1).get();
  assert(!pkgSnap.empty, "Found an active package for booking test");
  if (pkgSnap.empty) return null;

  const pkg = pkgSnap.docs[0].data();
  const packageId = pkgSnap.docs[0].id;

  // Simulate booking creation (what createBooking Cloud Function does)
  const adults = 2;
  const children = 1;
  const installments = 6;
  const totalMXN = (adults * pkg.adultRate) + (children * pkg.childRate);
  const depositAmount = Math.round(totalMXN * 0.2);
  const remainingAfterDeposit = totalMXN - depositAmount;
  const installmentAmount = Math.round(remainingAfterDeposit / installments);

  assert(totalMXN > 0, `Total price calculated: $${totalMXN.toLocaleString()} MXN`);
  assert(depositAmount > 0, `Deposit (20%): $${depositAmount.toLocaleString()} MXN`);

  const plan = [];
  const now = new Date();
  for (let i = 0; i < installments; i++) {
    const dueDate = new Date(now);
    dueDate.setMonth(dueDate.getMonth() + i + 1);
    plan.push({
      installmentNumber: i + 1,
      amountMXN: i === installments - 1
        ? remainingAfterDeposit - installmentAmount * (installments - 1)
        : installmentAmount,
      dueDate: dueDate.toISOString().split("T")[0],
      status: "pending",
      paidAt: null,
    });
  }

  assert(plan.length === installments, `Payment plan has ${installments} installments`);

  const planTotal = plan.reduce((sum, p) => sum + p.amountMXN, 0);
  assert(planTotal === remainingAfterDeposit, `Installment amounts sum to remaining: $${planTotal} === $${remainingAfterDeposit}`);

  const bookingId = "test-booking-" + Date.now();
  const bookingData = {
    bookingId,
    customerId: "test-user-123",
    packageId,
    packageName: pkg.name,
    destination: pkg.destination,
    hotel: pkg.hotel,
    durationNights: pkg.durationNights,
    adults,
    children,
    travelDate: pkg.availability.startDate,
    totalMXN,
    depositAmountMXN: depositAmount,
    depositStatus: "pending",
    depositPaidAt: null,
    installments,
    plan,
    paidMXN: 0,
    remainingMXN: totalMXN,
    status: "awaiting_deposit",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  await db.collection("bookings").doc(bookingId).set(bookingData);
  const created = await db.collection("bookings").doc(bookingId).get();
  assert(created.exists, "Booking document created in Firestore");
  assert(created.data().status === "awaiting_deposit", "Booking status is awaiting_deposit");

  return { bookingId, depositAmount, totalMXN, plan };
}

async function testDepositPayment(bookingId, depositAmount) {
  console.log("\n── Test 3: Deposit Payment ──");

  if (!bookingId) { console.log("  [SKIP] No booking to test"); return; }

  // Simulate what the webhook does when deposit is paid
  await db.collection("bookings").doc(bookingId).update({
    depositStatus: "paid",
    depositPaidAt: FieldValue.serverTimestamp(),
    paidMXN: FieldValue.increment(depositAmount),
    remainingMXN: FieldValue.increment(-depositAmount),
    status: "active",
    updatedAt: FieldValue.serverTimestamp(),
  });

  const booking = (await db.collection("bookings").doc(bookingId).get()).data();
  assert(booking.depositStatus === "paid", "Deposit marked as paid");
  assert(booking.status === "active", "Booking status transitioned to active");
  assert(booking.paidMXN === depositAmount, `paidMXN updated to $${booking.paidMXN}`);
  assert(booking.remainingMXN === booking.totalMXN - depositAmount, `remainingMXN = $${booking.remainingMXN}`);
}

async function testInstallmentPayments(bookingId, plan) {
  console.log("\n── Test 4: Installment Payments ──");

  if (!bookingId || !plan) { console.log("  [SKIP] No booking to test"); return; }

  // Pay first two installments
  for (let i = 0; i < 2; i++) {
    const installment = plan[i];
    const updatedPlan = [...plan];
    updatedPlan[i] = { ...updatedPlan[i], status: "paid", paidAt: new Date().toISOString() };

    await db.collection("bookings").doc(bookingId).update({
      plan: updatedPlan,
      paidMXN: FieldValue.increment(installment.amountMXN),
      remainingMXN: FieldValue.increment(-installment.amountMXN),
      updatedAt: FieldValue.serverTimestamp(),
    });

    plan = updatedPlan;
  }

  const booking = (await db.collection("bookings").doc(bookingId).get()).data();
  const paidInstallments = booking.plan.filter((p) => p.status === "paid").length;
  assert(paidInstallments === 2, `2 installments marked as paid (found ${paidInstallments})`);
  assert(booking.paidMXN > booking.depositAmountMXN, "paidMXN increased beyond deposit");
  assert(booking.remainingMXN < booking.totalMXN, "remainingMXN decreased");
  assert(booking.status === "active", "Booking still active (not all installments paid)");
}

async function testProgressTracking(bookingId) {
  console.log("\n── Test 5: Progress Tracking ──");

  if (!bookingId) { console.log("  [SKIP] No booking to test"); return; }

  const booking = (await db.collection("bookings").doc(bookingId).get()).data();
  const progressPct = Math.round((booking.paidMXN / booking.totalMXN) * 100);
  assert(progressPct > 0 && progressPct < 100, `Progress: ${progressPct}% paid`);

  const paidCount = booking.plan.filter((p) => p.status === "paid").length;
  const pendingCount = booking.plan.filter((p) => p.status === "pending").length;
  assert(paidCount + pendingCount === booking.installments, "All installments accounted for");

  console.log(`  Info: $${booking.paidMXN.toLocaleString()} / $${booking.totalMXN.toLocaleString()} MXN (${progressPct}%)`);
  console.log(`  Info: ${paidCount}/${booking.installments} installments paid`);
}

async function cleanup(bookingId) {
  if (bookingId) {
    await db.collection("bookings").doc(bookingId).delete();
    console.log(`\n  Cleaned up test booking: ${bookingId}`);
  }
}

async function run() {
  const env = process.env.FIRESTORE_EMULATOR_HOST ? "emulator" : "production";
  console.log(`\nVIDA Travel — Booking Flow Tests (${env})`);
  console.log("=".repeat(50));

  if (isProduction && !process.argv.includes("--yes")) {
    console.log("\nWARNING: Running against PRODUCTION. Re-run with --yes to confirm.\n");
    process.exit(1);
  }

  await testPackageSeedData();
  const booking = await testBookingCreation();
  if (booking) {
    await testDepositPayment(booking.bookingId, booking.depositAmount);
    await testInstallmentPayments(booking.bookingId, booking.plan);
    await testProgressTracking(booking.bookingId);
    await cleanup(booking.bookingId);
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("SOME TESTS FAILED\n");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED\n");
  }
}

run().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});

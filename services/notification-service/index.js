const express = require('express');
const admin   = require('firebase-admin');
const IORedis = require('ioredis');
const { Worker } = require('bullmq');
const twilio  = require('twilio');
const sg      = require('@sendgrid/mail');
const { securityHeaders } = require('../shared/securityHeaders');
const { railwayCors } = require('../shared/cors');
const { apiRateLimit } = require('../shared/rateLimiter');
require('dotenv').config();

const svcAcct = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString()
    : process.env.FIREBASE_SERVICE_ACCOUNT
);
admin.initializeApp({ credential: admin.credential.cert(svcAcct) });
const db    = admin.firestore();
const redis = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest:null, tls:process.env.REDIS_URL?.startsWith('rediss://')?{rejectUnauthorized:false}:undefined });
const tw    = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
sg.setApiKey(process.env.SENDGRID_API_KEY);

const WA_FROM = 'whatsapp:' + process.env.TWILIO_WHATSAPP_FROM;
const fmtPhone = p => { const d=String(p).replace(/\D/g,''); return 'whatsapp:+' + (d.length===10?'52'+d:d); };
const fmt = n => Number(n).toLocaleString('es-MX',{minimumFractionDigits:2});

const TEMPLATES = {
  loan_approved:    d => '\u2705 *Tu solicitud de crédito VIDA fue aprobada*\n\nHola '+d.name.split(' ')[0]+', tu préstamo de $'+fmt(d.amount)+' MXN fue aprobado.\n\nEl dinero llegará a tu cuenta en menos de 2 horas vía SPEI.\n\n\uD83D\uDCCB ID: '+d.loanId.slice(0,8).toUpperCase(),
  loan_disbursed:   d => '\uD83C\uDFE6 *Tu dinero está en camino*\n\nTransferimos $'+fmt(d.amount)+' MXN a tu cuenta.\n\u23F1 Menos de 2 horas\n\uD83D\uDCCB Ref: '+d.disbursementRef,
  loan_paid:        d => '\u2705 *Pago recibido*\n\nTu pago de $'+fmt(d.amount)+' MXN fue procesado. Tu crédito disponible ha sido restaurado.',
  loan_overdue:     d => '\u26A0\uFE0F *Préstamo vencido*\n\nTu préstamo de $'+fmt(d.amount)+' MXN venció hace '+(d.daysOverdue||1)+' día(s).\n\nRealiza tu pago: vida-finance.web.app',
  loan_reminder_24h:d => '\uD83D\uDD14 *Tu pago vence mañana*\n\nMañana vence tu pago de $'+fmt(d.amount)+' MXN. Si tu empresa ya hizo el descuento, no tienes que hacer nada.\n\nvida-finance.web.app',
  employer_activated:d=> '\uD83C\uDF89 *Empresa verificada en VIDA*\n\nHola '+d.name+', '+d.companyName+' fue activada.\n\nCódigo: *'+d.employerCode+'*\n\nCompártelo con tus empleados.',
  // Travel plan notifications
  deposit_reminder_24h: d => '\uD83D\uDD14 *Tu depósito vence mañana*\n\nHola '+d.name.split(' ')[0]+', mañana vence tu depósito #'+(d.depositNumber||'')+' de $'+fmt(d.depositAmount)+' MXN para tu viaje a *'+d.destination+'*.\n\nDepósito '+(d.depositNumber||'')+' de '+(d.totalDeposits||'')+'\n\n\uD83D\uDCB3 Realiza tu pago: app.vida.finance',
  deposit_overdue:     d => '\u26A0\uFE0F *Depósito vencido*\n\nTu depósito de $'+fmt(d.depositAmount)+' MXN para tu viaje a *'+d.destination+'* lleva '+(d.daysOverdue||1)+' día(s) de retraso.\n\nRealiza tu pago para no perder tu racha: app.vida.finance',
  deposit_streak:      d => '\uD83D\uDD25 *¡Racha de '+d.streak+' depósitos a tiempo!*\n\nHola '+d.name.split(' ')[0]+', llevas '+d.streak+' depósitos consecutivos a tiempo para tu viaje a *'+d.destination+'*.\n\n\uD83C\uDFAF Progreso: '+d.percentComplete+'% completado ('+d.depositsPaid+'/'+d.totalDeposits+')\n\n¡Sigue así! \uD83D\uDE80',
  supplier_payment_initiated: d => '\u2708\uFE0F *Tu viaje se está confirmando*\n\nHola '+d.name.split(' ')[0]+', estamos procesando el pago '+(d.paymentType==='pre_payment_t14'?'anticipado':'final')+' al hotel para tu viaje a *'+d.destination+'*.\n\n\uD83D\uDCC5 Salida: '+new Date(d.departureDate).toLocaleDateString('es-MX',{day:'numeric',month:'long',year:'numeric'}),
  franchise_commission_paid: d => '\uD83D\uDCB0 *Comisión depositada*\n\nHola, se ha depositado tu comisión de $'+fmt(d.commissionAmount)+' MXN por el periodo '+d.period+'.\n\n\uD83D\uDCCA '+d.depositsCount+' depósitos procesados\n\uD83D\uDCB5 Ingresos totales: $'+fmt(d.totalRevenue)+' MXN',
};

async function sendWA(phone, msg, type, refId) {
  if (!phone) return null;
  const m = await tw.messages.create({ from:WA_FROM, to:fmtPhone(phone), body:msg });
  await db.collection('notification_log').add({ channel:'whatsapp', to:fmtPhone(phone), type, refId, twilioSid:m.sid, status:m.status, sentAt:admin.firestore.FieldValue.serverTimestamp() });
  return m.sid;
}
async function sendEmail(to, subject, text) {
  if (!to?.includes('@')) return;
  await sg.send({ to, from:{email:'[email protected]',name:'VIDA Finance'}, subject, text, html:'<pre>'+text+'</pre>' });
  await db.collection('notification_log').add({ channel:'email', to, subject, status:'sent', sentAt:admin.firestore.FieldValue.serverTimestamp() });
}

const worker = new Worker('vida-notifications', async job => {
  const d = job.data, { type } = d;
  const emp = d.employeeId ? (await db.collection('employees').doc(d.employeeId).get()).data() : null;
  const name = emp?.name || d.employeeName || '';
  const phone = emp?.phone || d.phone;
  const email = emp?.email || d.email;

  if (type==='loan_approved') {
    const msg = TEMPLATES.loan_approved({...d,name});
    await sendWA(phone,msg,type,d.loanId);
    await sendEmail(email,'\u2705 Tu préstamo VIDA fue aprobado',msg);
  }
  if (type==='loan_disbursed') await sendWA(phone,TEMPLATES.loan_disbursed(d),type,d.loanId);
  if (type==='loan_paid'||type==='loan_paid_payroll') {
    const msg = TEMPLATES.loan_paid(d);
    await sendWA(phone,msg,type,d.loanId);
    await sendEmail(email,'\u2705 Pago recibido — VIDA Finance',msg);
  }
  if (type==='loan_overdue') {
    const msg = TEMPLATES.loan_overdue(d);
    await sendWA(phone||d.phone,msg,type,d.loanId);
    await sendEmail(email,'\u26A0\uFE0F Préstamo vencido — VIDA Finance',msg);
  }
  if (type==='loan_reminder_24h') await sendWA(phone||d.phone,TEMPLATES.loan_reminder_24h(d),type,d.loanId);
  if (type==='employer_activated') {
    const er = (await db.collection('employers').doc(d.employerUid).get()).data();
    await sendEmail(er.email,'\uD83C\uDF89 VIDA: Tu empresa fue verificada',TEMPLATES.employer_activated({...d,name:er.name,employerCode:er.employerCode}));
  }
  // Travel plan notification types
  if (type==='deposit_reminder_24h' && d.travelPlanId) {
    const msg = TEMPLATES.deposit_reminder_24h({...d,name});
    await sendWA(phone,msg,type,d.travelPlanId);
  }
  if (type==='deposit_overdue') {
    const msg = TEMPLATES.deposit_overdue(d);
    await sendWA(phone||d.phone,msg,type,d.travelPlanId);
  }
  if (type==='deposit_streak') {
    const msg = TEMPLATES.deposit_streak({...d,name});
    await sendWA(phone||d.phone,msg,type,d.travelPlanId);
  }
  if (type==='supplier_payment_initiated') {
    const msg = TEMPLATES.supplier_payment_initiated({...d,name});
    await sendWA(phone||d.phone,msg,type,d.travelPlanId);
  }
  if (type==='franchise_commission_paid') {
    const msg = TEMPLATES.franchise_commission_paid(d);
    await sendWA(d.phone,msg,type,d.franchiseId);
    await sendEmail(d.email,'\uD83D\uDCB0 Comisión VIDA depositada — '+d.period,msg);
  }
}, { connection:redis, concurrency:10 });

worker.on('failed', async (job,err) => {
  await db.collection('incident_log').add({ source:'notification-worker', type:job?.data?.type, error:err.message, attempts:job?.attemptsMade, ts:admin.firestore.FieldValue.serverTimestamp() });
});

const app = express();
app.use(securityHeaders);
app.use(railwayCors);
app.use(apiRateLimit);
app.use(express.json({limit:'100kb'}));

app.get('/health', async (req,res) => {
  const redisOk = await redis.ping().then(()=>true).catch(()=>false);
  res.json({status:redisOk?'ok':'degraded',service:'vida-notification-service',redis:redisOk,worker:worker.isRunning()});
});

app.listen(process.env.PORT||3002, ()=>console.log('vida-notification-service on', process.env.PORT||3002));

var winston = require('../../config/winston');

const CASEPAY_BASE_URL = 'https://meu.casepay.com.br/api/v1';
const CASEPAY_API_KEY = process.env.CASEPAY_API_KEY;
const CASEPAY_CONNECTION_ID = process.env.CASEPAY_CONNECTION_ID;

async function createMandate({ planName, amount, description, startDate, interval, firstPaymentAmount }) {
  const today = new Date().toISOString().split('T')[0];

  const body = {
    connectionId: CASEPAY_CONNECTION_ID,
    interval: interval || 'MONTHLY',
    amountType: 'FIXED',
    fixedAmount: amount,
    description: description || `Assinatura ${planName}`,
    startDate: startDate || today,
    schedulerEnabled: true,
    retryAccepted: true,
    retryDays: [3, 5, 7],
    firstPayment: {
      amount: firstPaymentAmount != null ? firstPaymentAmount : amount,
      date: today
    }
  };

  const res = await fetch(`${CASEPAY_BASE_URL}/automatic-pix`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CASEPAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    winston.error('CasePay createMandate error', { status: res.status, err });
    throw new Error(`CasePay error ${res.status}: ${JSON.stringify(err)}`);
  }

  const data = await res.json();
  winston.info('CasePay createMandate response: ' + JSON.stringify(data));
  return data;
}

async function getMandate(mandateId) {
  const res = await fetch(`${CASEPAY_BASE_URL}/automatic-pix/${mandateId}`, {
    headers: { 'Authorization': `Bearer ${CASEPAY_API_KEY}` }
  });

  if (!res.ok) {
    throw new Error(`CasePay getMandate error ${res.status}`);
  }

  return res.json();
}

async function cancelMandate(mandateId) {
  const res = await fetch(`${CASEPAY_BASE_URL}/automatic-pix/${mandateId}/cancel`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CASEPAY_API_KEY}` }
  });

  if (!res.ok) {
    throw new Error(`CasePay cancelMandate error ${res.status}`);
  }

  return res.json();
}

async function retryPayment(mandateId, scheduleId, newDate) {
  const res = await fetch(`${CASEPAY_BASE_URL}/automatic-pix/${mandateId}/schedules/${scheduleId}/retry`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CASEPAY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ date: newDate })
  });

  if (!res.ok) {
    throw new Error(`CasePay retryPayment error ${res.status}`);
  }

  return res.json();
}

module.exports = { createMandate, getMandate, cancelMandate, retryPayment };

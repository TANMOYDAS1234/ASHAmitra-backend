require('dotenv').config();
const http = require('http');

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
let token = '';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: 'localhost',
      port: process.env.PORT || 5000,
      path: `/api${path}`,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  console.log('\n=== API Endpoint Tests ===\n');

  // 1. Send OTP
  let res = await req('POST', '/auth/send-otp', { phone: '9330414463' });
  console.log(`POST /auth/send-otp → ${res.status}`, res.body.success ? '✅' : '❌', res.body.message || '');

  // 2. Get OTP from DB
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI);
  const User = mongoose.model('User', new mongoose.Schema({ phone: String, otp: String, otpExpiry: Date, isAdmin: Boolean }));
  const user = await User.findOne({ phone: '9330414463' });
  const otp = user?.otp;
  console.log(`   OTP from DB: ${otp}`);
  await mongoose.disconnect();

  // 3. Verify OTP
  res = await req('POST', '/auth/verify-otp', { phone: '9330414463', otp });
  console.log(`POST /auth/verify-otp → ${res.status}`, res.body.success ? '✅' : '❌');
  if (res.body.success) {
    token = res.body.token;
    console.log(`   Token: ${token.substring(0, 30)}...`);
    console.log(`   User: ${JSON.stringify(res.body.user)}`);
  }

  // 4. Get patients
  res = await req('GET', '/patients');
  console.log(`GET /patients → ${res.status}`, res.body.success ? '✅' : '❌', `(${res.body.data?.length ?? 0} records)`);

  // 5. Create patient
  res = await req('POST', '/patients', { name: 'Test Patient', type: 'pregnancy', village: 'Test Village', mobile: '9000000000', lastVisit: 'এইমাত্র', risk: 'safe' });
  console.log(`POST /patients → ${res.status}`, res.body.success ? '✅' : '❌', res.body.data?.name || res.body.message || '');
  const patientId = res.body.data?.id;

  // 6. Get admin stats
  res = await req('GET', '/admin/stats');
  console.log(`GET /admin/stats → ${res.status}`, res.body.success ? '✅' : '❌', JSON.stringify(res.body.data || res.body.message));

  // 7. Get admin workers
  res = await req('GET', '/admin/workers');
  console.log(`GET /admin/workers → ${res.status}`, res.body.success ? '✅' : '❌', `(${res.body.data?.length ?? 0} workers)`);

  // 8. Update profile
  res = await req('PUT', `/users/${user._id}`, { name: 'Admin Updated', block: 'Kolkata', district: 'West Bengal' });
  console.log(`PUT /users/:id → ${res.status}`, res.body.success ? '✅' : '❌', res.body.data?.name || res.body.message || '');

  // 9. Delete test patient
  if (patientId) {
    res = await req('DELETE', `/patients/${patientId}`);
    console.log(`DELETE /patients/:id → ${res.status}`, res.body.success ? '✅' : '❌');
  }

  console.log('\n=== Tests complete ===\n');
  process.exit(0);
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

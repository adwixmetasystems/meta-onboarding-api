// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');
const cors = require('cors');

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(cors());
app.use(bodyParser.json());

const {
  PORT = 3000,
  APP_ID,
  APP_SECRET,
  VERIFY_TOKEN,
  REDIRECT_URI
} = process.env;

// === Root Check ===
app.get('/', (req, res) => {
  res.send("✅ WhatsApp Embedded Signup Backend Active");
});

// === Webhook Verification ===
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// === Webhook Listener ===
app.post('/webhook', (req, res) => {
  if (req.body.object === 'whatsapp_business_account') {
    console.log('📩 Webhook Event:', JSON.stringify(req.body, null, 2));
  } else {
    console.log('⚠️ Unhandled Webhook Object:', req.body.object);
  }
  res.sendStatus(200);
});

// === OAuth Callback Handler ===
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('❌ Missing code.');

  try {
    const tokenRes = await axios.get(`https://graph.facebook.com/v21.0/oauth/access_token`, {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      }
    });

    const access_token = tokenRes.data.access_token;

    const businessInfo = await axios.get(`https://graph.facebook.com/v21.0/me`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const business_id = businessInfo.data.id;

    const wabasRes = await axios.get(`https://graph.facebook.com/v21.0/${business_id}/owned_whatsapp_business_accounts`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const waba_id = wabasRes.data.data[0]?.id;
    if (!waba_id) throw new Error('No WABA ID found');

    const phoneRes = await axios.get(`https://graph.facebook.com/v21.0/${waba_id}/phone_numbers`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const phone_number_id = phoneRes.data.data[0]?.id;
    if (!phone_number_id) throw new Error('No phone number found');

    await axios.post(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {}, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    await db.collection('clients').doc(waba_id).set({
      waba_id,
      phone_number_id,
      access_token,
      verified: false,
      onboarded_at: new Date()
    });

    res.json({ status: 'pending_verification', waba_id, phone_number_id });
  } catch (err) {
    console.error('❌ OAuth Callback Error:', err.response?.data || err.message);
    res.status(500).send('❌ Error during onboarding.');
  }
});

// === Trigger PIN Code (request_code) ===
app.post('/phone/request-code', async (req, res) => {
  const { waba_id } = req.body;
  try {
    const doc = await db.collection('clients').doc(waba_id).get();
    if (!doc.exists) return res.status(404).send('WABA not found');
    const { phone_number_id, access_token } = doc.data();

    await axios.post(`https://graph.facebook.com/v21.0/${phone_number_id}/request_code`, {
      code_method: 'SMS'
    }, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    res.send('✅ PIN sent via SMS');
  } catch (err) {
    console.error('❌ Error sending PIN:', err.response?.data || err.message);
    res.status(500).send('Failed to send verification code');
  }
});

// === Verify PIN Code ===
app.post('/phone/verify-code', async (req, res) => {
  const { waba_id, code } = req.body;
  try {
    const doc = await db.collection('clients').doc(waba_id).get();
    if (!doc.exists) return res.status(404).send('WABA not found');
    const { phone_number_id, access_token } = doc.data();

    await axios.post(`https://graph.facebook.com/v21.0/${phone_number_id}/verify_code`, {
      code
    }, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    await db.collection('clients').doc(waba_id).update({ verified: true });
    res.send('✅ Phone number verified successfully');
  } catch (err) {
    console.error('❌ Verification Failed:', err.response?.data || err.message);
    res.status(500).send('Phone verification failed');
  }
});

// === Send Message Test ===
app.post('/send-message', async (req, res) => {
  const { waba_id, to, body } = req.body;
  try {
    const doc = await db.collection('clients').doc(waba_id).get();
    if (!doc.exists) return res.status(404).send('Client not found');

    const { phone_number_id, access_token } = doc.data();

    const result = await axios.post(`https://graph.facebook.com/v21.0/${phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    }, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    res.json(result.data);
  } catch (err) {
    console.error('❌ Message Error:', err.response?.data || err.message);
    res.status(500).send('Message send failed');
  }
});

// === Start Server ===
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));

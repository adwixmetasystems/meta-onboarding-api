// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const path = require('path');

// Firebase setup
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(bodyParser.json());

// ENV Variables
const {
  PORT = 3000,
  APP_ID,
  APP_SECRET,
  VERIFY_TOKEN,
  REDIRECT_URI
} = process.env;

// === Serve Frontend ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
  console.log('📩 Webhook Payload Received:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// === OAuth Callback Handler (after embedded signup) ===
app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('❌ Missing code from query.');
  }

  try {
    // STEP 1: Exchange Code for Access Token
    const tokenRes = await axios.get(`https://graph.facebook.com/v21.0/oauth/access_token`, {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        redirect_uri: REDIRECT_URI,
        code
      }
    });

    const access_token = tokenRes.data.access_token;

    // STEP 2: Get Business Info
    const businessInfo = await axios.get(`https://graph.facebook.com/v21.0/me`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const business_id = businessInfo.data.id;

    // STEP 3: Get WABA Accounts
    const wabasRes = await axios.get(`https://graph.facebook.com/v21.0/${business_id}/owned_whatsapp_business_accounts`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const waba_id = wabasRes.data.data[0]?.id;

    if (!waba_id) throw new Error('No WABA ID found');

    // STEP 4: Get Phone Number ID
    const phoneRes = await axios.get(`https://graph.facebook.com/v21.0/${waba_id}/phone_numbers`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const phone_number_id = phoneRes.data.data[0]?.id;
    if (!phone_number_id) throw new Error('No phone number found');

    // STEP 5: Subscribe to Webhooks
    await axios.post(`https://graph.facebook.com/v21.0/${waba_id}/subscribed_apps`, {}, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    // STEP 6: Store in Firestore
    await db.collection('clients').doc(waba_id).set({
      waba_id,
      phone_number_id,
      access_token,
      onboarded_at: new Date()
    });

    return res.send(`✅ Onboarding complete. You may now use the WhatsApp Business API!`);
  } catch (err) {
    console.error('❌ Onboarding Error:', err.response?.data || err.message);
    return res.status(500).send('❌ Error during onboarding');
  }
});

// === Simple Send Message Endpoint ===
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

    return res.json(result.data);
  } catch (err) {
    console.error('❌ Message Error:', err.response?.data || err.message);
    res.status(500).send('Error sending message');
  }
});

// === Start Server ===
app.listen(PORT, () => console.log(`🚀 Server is running on http://localhost:${PORT}`));

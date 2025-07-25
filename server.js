// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

// Firestore Init
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
app.use(bodyParser.json());
const path = require('path');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});


const {
  PORT = 3000,
  APP_ID,
  APP_SECRET,
  VERIFY_TOKEN
} = process.env;

// Webhook Verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Webhook Listener
app.post('/webhook', (req, res) => {
  console.log('Webhook Received:', JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

// OAuth Callback Handler
app.get('/oauth/callback', async (req, res) => {
  const { code, waba_id, phone_number_id } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    // Step 1: Exchange code for token
    const tokenResp = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code
      }
    });

    const business_token = tokenResp.data.access_token;

    // Step 2: Subscribe to webhooks on WABA
    await axios.post(`https://graph.facebook.com/v23.0/${waba_id}/subscribed_apps`, {}, {
      headers: { Authorization: `Bearer ${business_token}` }
    });

    // Step 3: Store data in Firestore
    await db.collection('clients').doc(waba_id).set({
      waba_id,
      phone_number_id,
      business_token,
      onboarded_at: new Date()
    });

    res.send('✅ Onboarding completed! Ask client to add payment method here: https://www.facebook.com/business/help/488291839463771');
  } catch (err) {
    console.error('OAuth Error:', err.response?.data || err.message);
    res.status(500).send('Error during onboarding');
  }
});

// Register Number with PIN
app.post('/register-number', async (req, res) => {
  const { waba_id, pin } = req.body;
  try {
    const doc = await db.collection('clients').doc(waba_id).get();
    if (!doc.exists) return res.status(404).send('Client not found');
    const { phone_number_id, business_token } = doc.data();

    const response = await axios.post(`https://graph.facebook.com/v21.0/${phone_number_id}/register`, {
      messaging_product: 'whatsapp',
      pin
    }, {
      headers: { Authorization: `Bearer ${business_token}` }
    });

    res.json(response.data);
  } catch (e) {
    console.error('Register Error:', e.response?.data || e.message);
    res.status(500).json(e.response?.data || e.message);
  }
});

// Send Message
app.post('/send-message', async (req, res) => {
  const { waba_id, to, body } = req.body;
  try {
    const doc = await db.collection('clients').doc(waba_id).get();
    if (!doc.exists) return res.status(404).send('Client not found');
    const { phone_number_id, business_token } = doc.data();

    const response = await axios.post(`https://graph.facebook.com/v21.0/${phone_number_id}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body }
    }, {
      headers: { Authorization: `Bearer ${business_token}` }
    });

    res.json(response.data);
  } catch (e) {
    console.error('Message Error:', e.response?.data || e.message);
    res.status(500).json(e.response?.data || e.message);
  }
});

app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));

// test-tts.js — run with: node test-tts.js
// Set TTS_BASE_URL env var to test against the deployed server instead of local.
const fs = require('fs');

const BASE_URL = process.env.TTS_BASE_URL || 'http://localhost:5000';

async function testTts() {
  console.log('Testing /api/tts endpoint...\n');

  try {
    const res = await fetch(`${BASE_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'বুঝেছি। মাথায় কি কোনো ব্যথা আছে?' }),
    });

    console.log('Status:', res.status, res.statusText);
    console.log('Content-Type:', res.headers.get('content-type'));

    if (res.status === 200) {
      const buffer = await res.arrayBuffer();
      const bytes = Buffer.from(buffer);
      fs.writeFileSync('test-tts-output.mp3', bytes);
      console.log(`\n✅ SUCCESS — MP3 saved as test-tts-output.mp3 (${bytes.length} bytes)`);
      console.log('Open test-tts-output.mp3 to hear the Bengali voice.');
    } else {
      const json = await res.json().catch(() => null);
      console.log('\n❌ FAILED');
      console.log('Status:', res.status);
      console.log('Body:', JSON.stringify(json, null, 2));
    }
  } catch (err) {
    console.log('\n❌ ERROR:', err.message);
    if (err.message.includes('fetch')) {
      console.log('Possible cause: Render server is cold-starting. Wait 30s and try again.');
    }
  }
}

testTts();

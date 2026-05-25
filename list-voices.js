// list-voices.js — run with: node list-voices.js
// Lists every voice available on your ElevenLabs account (incl. cloned voices).
// Use this to find a voice_id to set as ELEVENLABS_VOICE_ID in .env.
require('dotenv').config();

async function listVoices() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    console.error('ELEVENLABS_API_KEY missing in .env');
    process.exit(1);
  }

  const res = await fetch('https://api.elevenlabs.io/v2/voices', {
    headers: { 'xi-api-key': key },
  });

  if (!res.ok) {
    console.error('Failed:', res.status, await res.text());
    process.exit(1);
  }

  const { voices } = await res.json();
  console.log(`\nYou have ${voices.length} voice(s) available:\n`);
  for (const v of voices) {
    const labels = v.labels ? Object.values(v.labels).join(', ') : '';
    console.log(`  ${v.voice_id}   ${v.name.padEnd(20)} [${v.category}] ${labels}`);
  }
  console.log(`\nCurrent default: ${process.env.ELEVENLABS_VOICE_ID || '(not set)'}`);
  console.log('To change, edit ELEVENLABS_VOICE_ID in backend/.env and restart the server.\n');
}

listVoices().catch(err => { console.error(err); process.exit(1); });

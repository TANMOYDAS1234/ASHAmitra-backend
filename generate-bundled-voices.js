// One-shot: generate the bundled critical-emergency MP3s that ship inside
// the Flutter APK so they work offline even on day-1 zero-internet installs.
//
// Run: node generate-bundled-voices.js
// Output: writes MP3s to ../ashamitra/assets/voices/<sha1>.mp3 AND a manifest
//         (../ashamitra/assets/voices/manifest.json) mapping phrase → filename.
//
// After running, delete this file. Re-run only when CRITICAL_PHRASES changes
// or when the production voice changes (then bump the prefix).

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Must match the production /api/tts cache-key tag exactly so the client
// can recognize the bundled file as the same logical entry.
const VOICE_TAG = 'gcloud:Chirp3-HD-Charon:v1';

// Phrases that MUST work even when the user has zero internet on first run.
// Mix of static phrases + parameterized vital alerts for the most clinically
// time-critical ranges. Each phrase = ~15 KB MP3. Currently ~70 phrases
// = ~1 MB APK bloat — acceptable for the always-on offline guarantee.
// Each entry: { text, tone } — tone MUST match the runtime call site so the
// md5 cache key matches.
const STATIC_PHRASES = [
  // Emergency callouts
  { text: '১০৮ এ কল করুন। এটা জরুরি অবস্থা।',                  tone: 'emergency' },
  { text: 'এখনই হাসপাতালে যান। দেরি করবেন না।',                tone: 'emergency' },
  { text: 'এটা গুরুতর। FRU বা DH-তে এখনই রেফার করুন।',          tone: 'emergency' },
  { text: 'রোগীকে বাম কাতে শোয়ান এবং অপেক্ষা করুন।',           tone: 'emergency' },

  // Common danger-sign acknowledgments
  { text: 'বুঝেছি। এটা একটা বিপদচিহ্ন।',                       tone: 'urgent' },
  { text: 'শিশুর শ্বাসকষ্ট গুরুতর। SNCU-তে রেফার করুন।',         tone: 'emergency' },
  { text: 'গুরুতর রক্তপাত। এখনই FRU-তে রেফার করুন।',            tone: 'emergency' },

  // UI prompts (most common spoken entry points)
  { text: 'পরিস্থিতি বলুন বা প্রশ্ন করুন',                      tone: 'empathy' },
  { text: 'মাইক্রোফোন চালু করুন এবং কথা বলুন।',                tone: 'empathy' },
  { text: 'আমি আশামিত্র। আপনার সহায়তা করতে এসেছি।',           tone: 'empathy' },

  // Reassurance
  { text: 'চিন্তা করবেন না। সব ঠিক হয়ে যাবে।',                 tone: 'positive' },
  { text: 'আপনি ভালো করেছেন জানিয়েছেন। ধন্যবাদ।',              tone: 'empathy' },
  { text: 'রোগী এখন নিরাপদ। বাড়িতে যত্ন নিন।',                 tone: 'positive' },

  // Generic fillers (covers most Gemini-style acknowledgments)
  { text: 'বুঝেছি।',                                          tone: 'normal' },
  { text: 'আরেকটু জানতে চাই।',                                tone: 'question' },
];

// Parameterized vital alerts — values most likely to be spoken by an ASHA
// during a real emergency. Must match vitals_extractor.dart formatting EXACTLY
// (Dart's `${double}` toString → '38.9' / '40.0', Dart's `${int}` toString → '85').
function range(start, end, step) {
  const out = [];
  for (let v = start; v <= end + 1e-9; v += step) {
    out.push(Number(v.toFixed(1)));
  }
  return out;
}
function dartDouble(n) {
  // Dart `'${double}'.toString()` always renders at least one decimal.
  return Number.isInteger(n) ? `${n}.0` : `${n}`;
}

function buildVitalAlerts() {
  const out = [];

  // ── Newborn fever (every 0.1°C from 37.6 to 39.0) — hard-stop RED ──────
  // Newborn fever is the most time-critical vital alert in the app; full
  // granularity here is worth the ~225 KB cost.
  for (const t of range(37.6, 39.0, 0.1)) {
    out.push({
      text: `জ্বর ${dartDouble(t)}°C — নবজাতকের জন্য বিপদচিহ্ন! এখনই SNCU-তে রেফার করুন।`,
      tone: 'emergency',
    });
  }

  // ── Child / general fever (every 0.5°C from 38.6 to 41.0) — YELLOW PHC ─
  // Coarser steps are fine: child fever is YELLOW-tier and the runtime
  // would still cache the exact value on first online play. Most common
  // values get the bundled treatment.
  for (const t of [38.6, 38.8, 39.0, 39.2, 39.5, 39.8, 40.0, 40.5, 41.0]) {
    out.push({
      text: `জ্বর ${dartDouble(t)}°C — উচ্চ জ্বর। PHC-তে নিয়ে যান।`,
      tone: 'urgent',
    });
  }

  // ── Newborn RR > 60 (every 1/min from 61 to 80) — RED ──────────────────
  for (let r = 61; r <= 80; r++) {
    out.push({
      text: `শ্বাসের হার ${r}/মিনিট — নবজাতকের জন্য বিপদচিহ্ন! SNCU-তে রেফার করুন।`,
      tone: 'emergency',
    });
  }

  // ── SpO2 critical hypoxia (every 1% from 70 to 89) — RED below 90 ──────
  for (let s = 70; s < 90; s++) {
    out.push({
      text: `SpO2 ${s}% — গুরুতর হাইপক্সিয়া! এখনই ১০৮ কল করুন।`,
      tone: 'emergency',
    });
  }

  // ── SpO2 mild hypoxia (90-93) — YELLOW ────────────────────────────────
  for (let s = 90; s < 94; s++) {
    out.push({
      text: `SpO2 ${s}% — কম অক্সিজেন। FRU-তে রেফার করুন।`,
      tone: 'urgent',
    });
  }

  // ── MUAC SAM (every 0.5cm from 9.0 to 11.4) — RED ─────────────────────
  for (const m of [9.0, 9.5, 10.0, 10.5, 11.0, 11.4]) {
    out.push({
      text: `MUAC ${dartDouble(m)} cm — SAM (গুরুতর অপুষ্টি)! NRC-তে রেফার করুন।`,
      tone: 'emergency',
    });
  }

  // ── Newborn LBW (every 0.1 kg from 0.9 to 1.4) — RED ──────────────────
  for (const w of range(0.9, 1.4, 0.1)) {
    out.push({
      text: `ওজন ${dartDouble(w)} kg — LBW (কম ওজন)। SNCU-তে রেফার করুন।`,
      tone: 'emergency',
    });
  }

  // ── BP severe pre-eclampsia (clinically common readings) — RED ────────
  // Sys/Dia pairs that ASHAs most commonly see. Full enumeration would be
  // huge; this is the realistic field set.
  const bpPairs = [
    [140, 90], [140, 95], [145, 95], [150, 95], [150, 100],
    [155, 100], [160, 100], [160, 110], [170, 110], [180, 120],
  ];
  for (const [s, d] of bpPairs) {
    out.push({
      text: `BP ${dartDouble(s)}/${d} — প্রি-এক্লাম্পসিয়া! বাম কাতে শোয়ান, ১০৮ কল করুন।`,
      tone: 'emergency',
    });
  }

  return out;
}

const CRITICAL_PHRASES = [...STATIC_PHRASES, ...buildVitalAlerts()];

// Match the Flutter client's cache key derivation EXACTLY: md5(text|voice|tone).
function cacheKey(text, tone) {
  return crypto
    .createHash('md5')
    .update(`${text}|${VOICE_TAG}|${tone}`)
    .digest('hex');
}

// Match the production /api/tts SSML wrapping so audio matches what the
// runtime would have generated. If these diverge the client won't recognize
// the bundled file as a cache hit.
function toSsml(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak>${esc
    .replace(/।/g, '।<break time="350ms"/>')
    .replace(/\?/g, '?<break time="450ms"/>')
    .replace(/,/g, ',<break time="180ms"/>')}</speak>`;
}

const TONE_PROFILES = {
  normal:    { rate: 1.00 },
  empathy:   { rate: 0.90 },
  urgent:    { rate: 1.15 },
  emergency: { rate: 1.25 },
  positive:  { rate: 0.96 },
  question:  { rate: 0.92 },
};

(async () => {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  if (!apiKey) {
    console.error('GOOGLE_TTS_API_KEY env var not set');
    process.exit(1);
  }

  const tts = google.texttospeech({ version: 'v1', auth: apiKey });

  const outDir = path.resolve(__dirname, '..', 'ashamitra', 'assets', 'voices');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Generating ${CRITICAL_PHRASES.length} bundled MP3s → ${outDir}\n`);

  const manifest = [];
  for (const { text, tone } of CRITICAL_PHRASES) {
    const p = TONE_PROFILES[tone];
    const key = cacheKey(text, tone);
    const filename = `${key}.mp3`;
    const filepath = path.join(outDir, filename);

    try {
      const resp = await tts.text.synthesize({
        requestBody: {
          input: { ssml: toSsml(text) },
          voice: { languageCode: 'bn-IN', name: 'bn-IN-Chirp3-HD-Charon' },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: p.rate,
            sampleRateHertz: 24000,
            effectsProfileId: ['handset-class-device'],
          },
        },
      });
      const bytes = Buffer.from(resp.data.audioContent, 'base64');
      fs.writeFileSync(filepath, bytes);
      manifest.push({ text, tone, key, filename, bytes: bytes.length });
      console.log(`  ✅ ${tone.padEnd(9)} ${filename}  ${(bytes.length/1024).toFixed(1)}KB — ${text.slice(0, 40)}...`);
    } catch (err) {
      console.error(`  ❌ ${text.slice(0, 40)}... — ${err.message}`);
    }
  }

  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );

  const totalBytes = manifest.reduce((s, m) => s + m.bytes, 0);
  console.log(`\n✅ Done. ${manifest.length} files, ${(totalBytes/1024).toFixed(1)}KB total.`);
  console.log('Next: add assets/voices/ to pubspec.yaml, rebuild APK.');
})().catch(e => { console.error(e); process.exit(1); });

// Sarvam AI speech: Saaras for speech-to-text, Bulbul for text-to-speech.
// Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
//       https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert
// Used only when SARVAM_API_KEY is set; otherwise the browser's own speech is used.

const BASE = process.env.SARVAM_BASE_URL || 'https://api.sarvam.ai';
export const sarvamEnabled = () => !!process.env.SARVAM_API_KEY;

class SarvamError extends Error {}

async function call(path, init) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY, ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SarvamError(`Sarvam ${res.status}: ${data.error?.message || res.statusText}`);
  return data;
}

/**
 * Speech to text. With Claude available we keep the user's own words (Hindi, Hinglish, any Indian
 * language), since Claude understands them. Without Claude we ask Sarvam to translate to English,
 * because the offline parser only understands English.
 * @param {Buffer} audio  @param {string} mimeType  @param {{understandsIndic: boolean, keyterms: string[]}} opts
 */
export async function transcribe(audio, mimeType, { understandsIndic, keyterms = [] }) {
  const form = new FormData();
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
  form.append('file', new Blob([audio], { type: mimeType }), `speech.${ext}`);
  if (understandsIndic) {
    form.append('model', 'saaras:v4');
    form.append('language_code', 'unknown');
    // Restaurant and dish names it might otherwise mishear. Max 50 terms of 64 characters.
    const terms = [...new Set(['Swiggy', 'Zomato', ...keyterms])].filter(t => t && t.length <= 64).slice(0, 50);
    form.append('keyterms', JSON.stringify(terms));
  } else {
    form.append('model', 'saaras:v3');
    form.append('mode', 'translate');
  }
  const data = await call('/speech-to-text', { method: 'POST', body: form });
  return { transcript: (data.transcript || '').trim(), language: data.language_code || null };
}

const DEVANAGARI = /[ऀ-ॿ]/;

/** Text to speech in an Indian voice. Returns base64 MP3. */
export async function speak(text) {
  const data = await call('/text-to-speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text.replace(/₹\s?/g, 'Rs ').slice(0, 2500),
      language_code: DEVANAGARI.test(text) ? 'hi-IN' : 'en-IN',
      model: 'bulbul:v3',
      speaker: process.env.SARVAM_SPEAKER || 'priya',
      pace: 1.05,
      output_audio_codec: 'mp3',
    }),
  });
  return data.audios?.[0] || null;
}

// Order Agent front end: Setup, Order and Dashboard tabs. Plain JS, no build step.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const NAMES = { swiggy: 'Swiggy', zomato: 'Zomato' };
const FLOW_NAMES = { reorder: 'Reorder', search: 'Search & order', address_change: 'Address change', table_booking: 'Table booking' };

let meta, me, userId;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const adminKey = store.get('adminKey');
  if (adminKey) headers['X-Admin-Key'] = adminKey;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Wraps a click/submit handler so errors show as a toast instead of disappearing.
const guard = (fn) => async (e) => { e?.preventDefault?.(); try { await fn(e); } catch (err) { toast(err.message, true); } };

// ---------- tabs ----------

const views = { setup: renderSetup, order: renderOrder, dashboard: renderDashboard };
function currentTab() { const h = location.hash.slice(1); return views[h] ? h : 'setup'; }
async function show() {
  // Order needs an account; Setup and Dashboard don't.
  const tab = !userId && currentTab() === 'order' ? 'setup' : currentTab();
  for (const k of Object.keys(views)) $('#' + k).hidden = k !== tab;
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  try { await views[tab]($('#' + tab)); } catch (err) { toast(err.message, true); }
}
window.addEventListener('hashchange', show);

async function refreshMe() {
  if (!userId) { me = null; return; }
  try { me = await api('GET', '/api/me?userId=' + userId); }
  catch { userId = null; me = null; store.set('userId', null); }
}
const linked = () => (me?.links || []).filter(l => l.status === 'linked').map(l => l.platform);

// ---------- Setup ----------

async function renderSetup(el) {
  if (!me) {
    el.innerHTML = `
      <h2>Set up once</h2>
      <p class="muted">Sign up with your phone number, then link Swiggy and Zomato. After that, every order goes through one place.</p>
      <form class="card" id="signup">
        <div class="field"><label for="phone">Mobile number</label>
          <input id="phone" inputmode="numeric" autocomplete="tel" placeholder="98765 43210" required></div>
        <button class="primary">Continue</button>
        <p class="note">Demo build: no OTP is sent.</p>
      </form>`;
    $('#signup').onsubmit = guard(async () => {
      const u = await api('POST', '/api/signup', { phone: $('#phone').value });
      userId = u.id; store.set('userId', u.id);
      await api('POST', '/api/open', { userId });
      await refreshMe(); renderSetup(el);
    });
    return;
  }

  el.innerHTML = `
    <div class="row spread">
      <div><h2>Setup</h2><p class="muted">Signed in as +91 ${esc(me.user.phone)}</p></div>
      <button id="signout">Sign out</button>
    </div>
    ${linkWizard()}
    <div class="card">
      <h3>Linked platforms</h3>
      ${me.links.map(l => `
        <div class="platform">
          <div>
            <strong>${NAMES[l.platform]}</strong>
            ${l.status === 'linked' ? `<span class="badge b-ok">Linked</span><div class="note">Since ${when(l.linkedAt)}</div>`
              : l.status === 'disconnected' ? `<span class="badge b-bad">Disconnected</span><div class="note">${when(l.disconnectedAt)}</div>`
              : `<span class="badge">Not linked</span>`}
          </div>
          ${l.status === 'linked'
            ? `<button class="danger" data-disconnect="${l.platform}">Disconnect</button>`
            : `<button data-start="${l.platform}">Link</button>`}
        </div>`).join('')}
    </div>
    <div class="card">
      <h3>Safety</h3>
      <p>COD only. Orders above <strong>${rupees(meta.settings.codCap)}</strong> are blocked, and every order below it waits for your approval.</p>
    </div>`;

  $('#signout').onclick = () => { userId = null; me = null; wizard.active = false; store.set('userId', null); renderSetup(el); };
  $('#link-all')?.addEventListener('click', () => { wizard.active = true; wizard.skipped = []; wizard.only = null; renderSetup(el); });
  el.querySelectorAll('[data-start]').forEach(b => b.onclick = () => { wizard.active = true; wizard.skipped = []; wizard.only = b.dataset.start; renderSetup(el); });
  $('#w-skip')?.addEventListener('click', () => { wizard.skipped.push(wizardStep()); renderSetup(el); });
  $('#w-close')?.addEventListener('click', () => { wizard.active = false; renderSetup(el); });
  $('#w-done')?.addEventListener('click', guard(async () => {
    const p = wizardStep();
    await api('POST', '/api/link', { userId, platform: p });
    await refreshMe(); toast(`${NAMES[p]} linked`);
    if (wizard.only === p) wizard.only = null;
    renderSetup(el);
  }));
  el.querySelectorAll('[data-disconnect]').forEach(b => b.onclick = guard(async () => {
    if (!confirm(`Disconnect ${NAMES[b.dataset.disconnect]}? No orders can go through it until you link it again.`)) return;
    await api('POST', '/api/disconnect', { userId, platform: b.dataset.disconnect });
    await refreshMe(); renderSetup(el); toast(`${NAMES[b.dataset.disconnect]} disconnected`);
  }));
}

// One button links every platform in turn. Each platform's login (phone + its own OTP) happens on
// that platform's official connector page in the AI assistant; we never see the OTP or the session.
const wizard = { active: false, skipped: [], only: null };
const unlinked = () => meta.platforms.filter(p => !linked().includes(p));
function wizardStep() {
  const todo = unlinked().filter(p => !wizard.skipped.includes(p));
  return wizard.only && todo.includes(wizard.only) ? wizard.only : todo[0] || null;
}

function linkWizard() {
  const todo = unlinked();
  if (!wizard.active) {
    return todo.length ? `
      <div class="card">
        <h3>Link your food apps</h3>
        <p>One go, one platform at a time. Each one asks for its own OTP on its own login page.</p>
        <button class="primary" id="link-all">${todo.length === meta.platforms.length ? 'Link Swiggy & Zomato' : `Link ${todo.map(p => NAMES[p]).join(' & ')}`}</button>
      </div>` : '';
  }

  const step = wizardStep();
  const order = meta.platforms;
  const dots = order.map((p, i) => {
    const state = linked().includes(p) ? 'done' : p === step ? 'now' : wizard.skipped.includes(p) ? 'skipped' : '';
    return `<li class="${state}"><span>${linked().includes(p) ? '✓' : i + 1}</span>${NAMES[p]}</li>`;
  }).join('');

  if (!step) {
    const skipped = unlinked();
    return `
      <div class="card wizard">
        <ol class="steps">${dots}</ol>
        <h3>${skipped.length ? 'Almost done' : 'All linked'} </h3>
        <p>${skipped.length ? `You skipped ${skipped.map(p => NAMES[p]).join(' and ')}. You can link it any time below.` : 'Swiggy and Zomato are both linked. You can order from the Order tab.'}</p>
        <div class="row">${skipped.length ? '' : '<a href="#order"><button class="primary">Start ordering</button></a>'}<button id="w-close">Close</button></div>
      </div>`;
  }

  const n = order.indexOf(step) + 1;
  return `
    <div class="card wizard">
      <ol class="steps">${dots}</ol>
      <h3>Step ${n} of ${order.length}: link ${NAMES[step]}</h3>
      <ol class="howto">
        <li>Open your AI assistant and connect the <strong>${NAMES[step]}</strong> connector.</li>
        <li>${NAMES[step]}'s own login page opens. Enter your phone number <strong>+91 ${esc(me.user.phone)}</strong>.</li>
        <li>${NAMES[step]} texts you an OTP. Type it on <strong>${NAMES[step]}'s page</strong>, not here, then approve access.</li>
      </ol>
      <p class="note">We never see your OTP or your ${NAMES[step]} password. You can disconnect any time.</p>
      <div class="row">
        <button class="primary" id="w-done">Done, ${NAMES[step]} is linked</button>
        <button id="w-skip">Skip for now</button>
      </div>
    </div>`;
}

// ---------- Order ----------

const STATUS = {
  pending_approval: ['Waiting for your approval', 'b-warn'], blocked: ['Blocked: over COD cap', 'b-bad'],
  approved: ['Approved, record the result', 'b-warn'], rejected: ['Rejected', ''],
  placed: ['Placed', 'b-ok'], failed: ['Failed', 'b-bad'],
};

const ago = (iso) => {
  if (!iso) return 'never';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const SEGMENT_CLS = { 'Power user': 'b-ok', Regular: 'b-ok', New: 'b-warn', Occasional: '', 'At risk': 'b-warn', Lapsed: 'b-bad' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Customer view: only a quick reorder of their usual. Segments and usage stats live in Admin.
function usualCard({ usual: u }) {
  if (!u) return '';
  return `
    <div class="card usual">
      <div><strong>Your usual</strong>: ${u.items.map(i => `${esc(i.name)} × ${i.quantity}`).join(', ')}${u.restaurant ? ` from ${esc(u.restaurant)}` : ''} on ${NAMES[u.platform]} · ${rupees(u.total)}
        <div class="note">Last ordered ${ago(u.lastAt)}</div></div>
      <button class="primary" id="reorder-usual">Reorder</button>
    </div>`;
}

async function renderOrder(el) {
  const platforms = linked();
  const [orders, activity] = await Promise.all([api('GET', '/api/orders?userId=' + userId), api('GET', '/api/usual?userId=' + userId)]);
  const failOpts = Object.entries(meta.failures).filter(([k]) => k !== 'cod_over_cap')
    .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  el.innerHTML = `
    <h2>Order</h2>
    <p class="muted">Ask your AI assistant to build the cart on Swiggy or Zomato, then enter it here. Orders up to ${rupees(meta.settings.codCap)} go to approval, and anything above is blocked.</p>
    ${usualCard(activity)}
    ${platforms.length ? voicePanel() : ''}
    ${platforms.length ? `
    <form class="card" id="new-order">
      <div class="row">
        <div class="field"><label>Platform</label><select name="platform">${platforms.map(p => `<option value="${p}">${NAMES[p]}</option>`).join('')}</select></div>
        <div class="field"><label>Flow</label><select name="flow">${meta.flows.map(f => `<option value="${f}">${FLOW_NAMES[f]}</option>`).join('')}</select></div>
        <div class="field"><label>Cart total (₹)</label><input name="total" type="number" min="1" step="1" placeholder="450"></div>
      </div>
      <div class="field"><label>Items or restaurant</label><input name="items" placeholder="Chicken biryani x1, Raita x1 from Meghana Foods" required></div>
      <button class="primary">Check and send for approval</button>
    </form>` : `<div class="card empty">Link Swiggy or Zomato on the <a href="#setup">Setup</a> tab first.</div>`}
    <div class="card">
      <h3>Your orders</h3>
      ${orders.length ? orders.map(o => {
        const [label, cls] = STATUS[o.status];
        return `
        <div class="order">
          <div class="row spread">
            <div><strong>${NAMES[o.platform]}</strong> · ${FLOW_NAMES[o.flow]} · ${o.flow === 'table_booking' ? 'no payment' : rupees(o.total) + ' COD'}</div>
            <span class="badge ${cls}">${label}</span>
          </div>
          <div>${esc(o.items)}</div>
          <div class="note">${when(o.createdAt)}${o.source === 'voice' ? ' · by voice' : ''}${o.status === 'blocked' ? ` · cap was ${rupees(o.cap)}` : ''}</div>
          ${o.status === 'pending_approval' ? `
            <div class="row" style="margin-top:8px">
              <button class="primary" data-decide="approve" data-id="${o.id}">Approve</button>
              <button data-decide="reject" data-id="${o.id}">Reject</button>
            </div>` : ''}
          ${o.status === 'approved' ? `
            <form class="result" data-id="${o.id}" style="margin-top:8px">
              <p class="note">Tell the assistant to place it, then record what happened.</p>
              <div class="row">
                <div class="field"><label>Outcome</label><select name="outcome"><option value="success">Worked</option><option value="failed">Failed</option></select></div>
                <div class="field"><label>Failure type</label><select name="failure" disabled>${failOpts}</select></div>
                <div class="field"><label>Was COD offered?</label><select name="codOffered"><option value="">Not checked</option><option value="yes">Yes</option><option value="no">No</option></select></div>
              </div>
              <div class="field"><label>Notes</label><textarea name="notes" placeholder="Where it broke, error text"></textarea></div>
              <button class="primary">Save result</button>
            </form>` : ''}
        </div>`;
      }).join('') : '<div class="empty">No orders yet.</div>'}
    </div>`;

  if (platforms.length) wireVoice(el);
  // Puts the usual order into the voice draft, so it still goes through "Send for approval".
  $('#reorder-usual')?.addEventListener('click', () => {
    const u = activity.usual;
    if (!platforms.includes(u.platform)) return toast(`Link ${NAMES[u.platform]} first`, true);
    voice.draft = { platform: u.platform, flow: 'reorder', restaurant: u.restaurant, items: u.items, total: u.total };
    renderOrder(el).then(() => $('.voice')?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  });
  $('#new-order')?.addEventListener('submit', guard(async (e) => {
    const f = new FormData(e.target);
    const o = await api('POST', '/api/orders', { userId, platform: f.get('platform'), flow: f.get('flow'), total: f.get('total'), items: f.get('items') });
    toast(o.status === 'blocked' ? `Blocked: ${rupees(o.total)} is over the ${rupees(o.cap)} cap` : 'Sent for approval', o.status === 'blocked');
    renderOrder(el);
  }));
  el.querySelectorAll('[data-decide]').forEach(b => b.onclick = guard(async () => {
    await api('POST', '/api/orders/decide', { userId, orderId: b.dataset.id, decision: b.dataset.decide });
    renderOrder(el);
  }));
  el.querySelectorAll('form.result').forEach(form => {
    form.outcome.onchange = () => { form.failure.disabled = form.outcome.value === 'success'; };
    form.onsubmit = guard(async () => {
      const cod = form.codOffered.value;
      await api('POST', '/api/orders/result', {
        userId, orderId: form.dataset.id, outcome: form.outcome.value, failure: form.failure.value,
        codOffered: cod === '' ? null : cod === 'yes', notes: form.notes.value,
      });
      toast('Result saved'); renderOrder(el);
    });
  });
}

// ---------- Voice agent ----------
// Speech-to-text and text-to-speech run in the browser (Web Speech API); understanding runs on the server.
// The agent only builds a draft and, on "yes", sends it for approval. Approving stays a tap.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const voice = { draft: null, history: [], listening: false, muted: store.get('voiceMuted') === '1' };

function voicePanel() {
  const d = voice.draft;
  const hasDraft = d && (d.platform || d.items?.length || d.restaurant || d.total);
  return `
    <div class="card voice">
      <div class="row spread">
        <h3 style="margin:0">Voice order</h3>
        <span class="note">Speech: ${useSarvam() ? 'Sarvam' : 'browser'} · ${meta.agentEngine === 'claude' ? 'Understood by Claude' : 'Offline parser (no API key)'} ·
          <a href="#" id="mute">${voice.muted ? 'Sound off' : 'Sound on'}</a></span>
      </div>
      <p class="note">Say the platform, what you want and how many, and the cart total. Or ask a question, like "what's my COD limit?"</p>
      <div class="chat" id="chat">
        ${voice.history.length ? voice.history.slice(-8).map(h => `<div class="bubble ${h.role}">${esc(h.text)}</div>`).join('')
          : '<div class="note">Try: "2 chicken biryani and a raita from Meghana on Swiggy, total 600"</div>'}
      </div>
      ${hasDraft ? `
        <div class="draft">
          <div><strong>${d.platform ? NAMES[d.platform] : 'Platform?'}</strong> · ${FLOW_NAMES[d.flow] || 'Search & order'}${d.restaurant ? ' · ' + esc(d.restaurant) : ''}</div>
          ${d.items?.length ? `<ul>${d.items.map(i => `<li>${esc(i.name)} × ${i.quantity}</li>`).join('')}</ul>` : ''}
          <div>${d.total ? rupees(d.total) + ' COD' + (d.total > meta.settings.codCap ? ' <span class="badge b-bad">over cap</span>' : '') : d.flow === 'table_booking' ? 'No payment' : '<span class="muted">Total?</span>'}</div>
          <div class="row" style="margin-top:8px">
            <button class="primary" id="v-send">Send for approval</button>
            <button id="v-clear">Clear</button>
          </div>
        </div>` : ''}
      <form class="row" id="v-form" style="margin-top:10px">
        ${(useSarvam() && canRecord) || Recognition ? `<button type="button" id="mic" class="mic ${voice.listening ? 'on' : ''}" aria-label="Speak">${voice.listening ? '● Tap to stop' : '🎤 Speak'}</button>` : ''}
        <input id="v-text" placeholder="${(useSarvam() && canRecord) || Recognition ? 'or type here' : 'Type here (voice needs Chrome, Edge or Safari)'}" style="flex:1 1 200px">
        <button>Send</button>
      </form>
    </div>`;
}

// Sarvam when the server has a key and it hasn't failed this session; the browser's speech otherwise.
const canRecord = !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
const useSarvam = () => meta.speech === 'sarvam' && !voice.sarvamFailed;
function sarvamFailed(err) {
  voice.sarvamFailed = true;
  toast(`Sarvam speech failed (${err.message}). Using browser speech instead.`, true);
}

function stopSpeaking() {
  voice.audio?.pause(); voice.audio = null;
  window.speechSynthesis?.cancel();
}

async function speak(text) {
  if (voice.muted || !text) return;
  stopSpeaking();
  if (useSarvam()) {
    try {
      const { audio } = await api('POST', '/api/voice/speak', { text });
      if (audio) { voice.audio = new Audio('data:audio/mpeg;base64,' + audio); await voice.audio.play(); return; }
    } catch (err) { sarvamFailed(err); }
  }
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text.replace(/₹/g, 'rupees '));
  u.lang = /[ऀ-ॿ]/.test(text) ? 'hi-IN' : 'en-IN';
  speechSynthesis.speak(u);
}

function setMic(state) {
  const mic = $('#mic'); if (!mic) return;
  mic.classList.toggle('on', state === 'listening');
  mic.disabled = state === 'busy';
  mic.textContent = state === 'listening' ? '● Tap to stop' : state === 'busy' ? 'Transcribing…' : '🎤 Speak';
}

// Records until tapped again (or 20 s), then sends the audio to Sarvam via our server.
async function recordWithSarvam(say) {
  if (voice.recorder) return voice.recorder.stop();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    clearTimeout(voice.recTimer);
    stream.getTracks().forEach(t => t.stop());
    voice.recorder = null; voice.listening = false;
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
    if (blob.size < 1000) { setMic('idle'); return toast('Didn\'t hear anything. Tap and speak again.', true); }
    setMic('busy');
    try {
      const res = await fetch('/api/voice/transcribe?userId=' + encodeURIComponent(userId), {
        method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] }, body: blob,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'transcription failed');
      setMic('idle');
      if (data.transcript) say(data.transcript); else toast('Didn\'t catch that. Try again.', true);
    } catch (err) { setMic('idle'); sarvamFailed(err); }
  };
  voice.recorder = rec; voice.listening = true;
  rec.start();
  voice.recTimer = setTimeout(() => rec.state === 'recording' && rec.stop(), 20000);
  setMic('listening');
}

// Chrome / Edge / Safari built-in recognition. Stops by itself when you pause.
function recordWithBrowser(say) {
  if (voice.listening) return voice.rec?.stop();
  const rec = new Recognition();
  rec.lang = 'en-IN'; rec.interimResults = true; rec.maxAlternatives = 1;
  let finalText = '';
  rec.onresult = (e) => {
    const r = [...e.results].map(x => x[0].transcript).join(' ');
    $('#v-text').value = r;
    if (e.results[e.results.length - 1].isFinal) finalText = r;
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') toast(e.error === 'not-allowed' ? 'Allow microphone access to use voice' : 'Voice error: ' + e.error, true); };
  rec.onend = () => {
    voice.listening = false; voice.rec = null; setMic('idle');
    if (finalText) { $('#v-text').value = ''; say(finalText); }
  };
  voice.listening = true; voice.rec = rec;
  setMic('listening');
  rec.start();
}

async function sendToAgent(text, el) {
  text = text.trim();
  if (!text) return;
  voice.history.push({ role: 'user', text });
  const out = await api('POST', '/api/agent', { userId, text, draft: voice.draft, history: voice.history.slice(-6) });
  voice.draft = out.draft;
  if (out.reply) { voice.history.push({ role: 'agent', text: out.reply }); speak(out.reply); }
  if (out.order) toast(out.order.status === 'blocked' ? 'Blocked: over COD cap' : 'Sent for approval', out.order.status === 'blocked');
  await renderOrder(el);
  const chat = $('#chat'); if (chat) chat.scrollTop = chat.scrollHeight;
}

function wireVoice(el) {
  const say = guard((text) => sendToAgent(text, el));
  $('#v-form').onsubmit = (e) => { e.preventDefault(); const t = $('#v-text').value; $('#v-text').value = ''; say(t); };
  $('#mute').onclick = (e) => { e.preventDefault(); voice.muted = !voice.muted; store.set('voiceMuted', voice.muted ? '1' : '0'); if (voice.muted) speechSynthesis?.cancel(); renderOrder(el); };
  $('#v-send')?.addEventListener('click', () => say('yes'));
  $('#v-clear')?.addEventListener('click', () => { voice.draft = null; renderOrder(el); });
  $('#mic')?.addEventListener('click', guard(async () => {
    stopSpeaking();
    if (useSarvam() && canRecord) {
      try { return await recordWithSarvam(say); }
      catch (err) { if (err.name === 'NotAllowedError') throw new Error('Allow microphone access to use voice'); throw err; }
    }
    if (Recognition) return recordWithBrowser(say);
    toast('Voice needs Chrome, Edge or Safari here. Type instead.', true);
  }));
}

// ---------- Dashboard ----------

let includeSample = store.get('includeSample') === '1';

function renderAdminLogin(el, failed) {
  el.innerHTML = `
    <h2>Admin</h2>
    <p class="muted">Users, test results and settings. Admins only.</p>
    <form class="card" id="admin-login" style="max-width:420px">
      <div class="field"><label for="admin-key">Admin key</label><input id="admin-key" type="password" autocomplete="current-password" required></div>
      ${failed ? '<p class="b-bad" style="margin-top:0">That key is not right.</p>' : ''}
      <button class="primary">Open admin</button>
    </form>`;
  $('#admin-login').onsubmit = (e) => { e.preventDefault(); store.set('adminKey', $('#admin-key').value); renderDashboard(el, true); };
}

async function renderDashboard(el, justTried = false) {
  if (meta.adminLocked) {
    try { await api('GET', '/api/admin/check'); }
    catch { store.set('adminKey', null); return renderAdminLogin(el, justTried); }
  }
  const [runs, users] = await Promise.all([
    api('GET', '/api/runs' + (includeSample ? '?sample=1' : '')),
    api('GET', '/api/activity/all' + (includeSample ? '?sample=1' : '')),
  ]);
  const segCounts = users.reduce((m, u) => (m[u.segment] = (m[u.segment] || 0) + 1, m), {});
  const level = (n) => n === 0 ? '' : n === 1 ? 'l1' : n <= 3 ? 'l2' : 'l3';
  const byPlatform = meta.platforms.map(p => {
    const rs = runs.filter(r => r.platform === p);
    const ok = rs.filter(r => r.outcome === 'success').length;
    const codChecked = rs.filter(r => r.codOffered !== null);
    return { p, n: rs.length, ok, rate: rs.length ? Math.round(ok / rs.length * 100) : null,
      cod: codChecked.length ? `${codChecked.filter(r => r.codOffered).length} of ${codChecked.length}` : '—' };
  });
  const failed = runs.filter(r => r.outcome === 'failed');
  const groups = Object.entries(failed.reduce((m, r) => (m[r.failure] = (m[r.failure] || 0) + 1, m), {})).sort((a, b) => b[1] - a[1]);
  const failOpts = Object.entries(meta.failures).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

  el.innerHTML = `
    <div class="row spread">
      <div><h2>Admin</h2><p class="muted">Who uses the app and how often, every test run, and where it breaks.
        ${meta.adminLocked ? '<a href="#" id="admin-out">Lock admin</a>' : '<span class="b-warn">Open to anyone: set ADMIN_KEY in .env to lock it.</span>'}</p></div>
      <div class="row">
        <label class="row" style="color:var(--text);margin:0"><input type="checkbox" id="sample" ${includeSample ? 'checked' : ''}> Include sample data</label>
        <button id="load-sample">Load sample data</button>
        <button id="clear-sample" class="danger">Clear sample</button>
      </div>
    </div>

    <div class="card">
      <h3>Users: recency and frequency</h3>
      <div class="legend">
        ${['Power user', 'Regular', 'New', 'Occasional', 'At risk', 'Lapsed'].map(s => `<span><span class="badge ${SEGMENT_CLS[s]}">${s}</span> ${segCounts[s] || 0}</span>`).join('')}
      </div>
      ${users.length ? `<div class="table-wrap"><table>
        <tr><th>User</th><th>Segment</th><th>Last active</th><th>Sessions 7d / 30d</th><th>Active days (30d)</th><th>Orders (30d)</th><th>Last order</th><th>Mostly</th><th>Last 30 days</th></tr>
        ${users.map(u => `<tr>
          <td>${esc(u.phone)} ${u.sample ? '<span class="badge b-sample">SAMPLE</span>' : ''}</td>
          <td><span class="badge ${SEGMENT_CLS[u.segment]}">${u.segment}</span></td>
          <td>${ago(u.lastActiveAt)}</td>
          <td>${u.sessions7d} / ${u.sessions30d}</td>
          <td>${u.activeDays30d}</td>
          <td>${u.orders30d}</td>
          <td>${ago(u.lastOrderAt)}</td>
          <td>${u.favouritePlatform ? NAMES[u.favouritePlatform] : '—'}</td>
          <td><div class="strip" title="Each square is a day, darker means more activity">${u.strip.map(d => `<i class="${level(d.count)}" title="${d.day}: ${d.count}"></i>`).join('')}</div></td>
        </tr>`).join('')}
      </table></div>
      <p class="note">Recency = days since last active. Frequency = days active out of the last 30. New: joined in the last 7 days. Power user: active in the last 3 days and on 10+ days. Regular: last 7 days and 4+ days. Occasional: last 14 days. At risk: 15–30 days. Lapsed: over 30 days.</p>`
      : '<div class="empty">No users yet.</div>'}
    </div>

    <div class="grid" style="margin-top:16px">
      ${byPlatform.map(s => `
        <div class="card">
          <h3>${NAMES[s.p]}</h3>
          <div class="big">${s.rate === null ? '—' : s.rate + '%'}</div>
          <div class="muted">${s.ok} of ${s.n} runs worked</div>
          <div class="note">COD offered: ${s.cod}</div>
        </div>`).join('')}
      <div class="card">
        <h3>All runs</h3>
        <div class="big">${runs.length}</div>
        <div class="muted">${failed.length} failed</div>
      </div>
    </div>

    <div class="card">
      <h3>Where it breaks</h3>
      ${groups.length ? groups.map(([k, n]) => `
        <div class="fail-row">
          <div class="row spread"><span>${esc(meta.failures[k])}</span><span class="muted">${n}</span></div>
          <div class="bar"><i style="width:${Math.round(n / failed.length * 100)}%"></i></div>
        </div>`).join('') : '<div class="empty">No failures logged yet.</div>'}
    </div>

    <div class="card">
      <h3>Run log</h3>
      ${runs.length ? `<div class="table-wrap"><table>
        <tr><th>When</th><th>Platform</th><th>Flow</th><th>Result</th><th>Total</th><th>COD</th><th>Notes</th></tr>
        ${runs.map(r => `<tr>
          <td>${when(r.at)} ${r.sample ? '<span class="badge b-sample">SAMPLE</span>' : ''}</td>
          <td>${NAMES[r.platform]}</td><td>${FLOW_NAMES[r.flow]}</td>
          <td>${r.outcome === 'success' ? '<span class="badge b-ok">Worked</span>' : `<span class="badge b-bad">${esc(meta.failures[r.failure])}</span>`}</td>
          <td>${r.total ? rupees(r.total) : '—'}</td>
          <td>${r.codOffered === null ? '—' : r.codOffered ? 'Yes' : 'No'}</td>
          <td class="note">${esc(r.notes)}</td></tr>`).join('')}
      </table></div>` : '<div class="empty">No runs yet. Place an order on the Order tab, or log a test below.</div>'}
    </div>

    ${`
    <form class="card" id="log-run">
      <h3>Log a test you ran in the assistant</h3>
      <div class="row">
        <div class="field"><label>Platform</label><select name="platform">${meta.platforms.map(p => `<option value="${p}">${NAMES[p]}</option>`).join('')}</select></div>
        <div class="field"><label>Flow</label><select name="flow">${meta.flows.map(f => `<option value="${f}">${FLOW_NAMES[f]}</option>`).join('')}</select></div>
        <div class="field"><label>Outcome</label><select name="outcome"><option value="success">Worked</option><option value="failed">Failed</option></select></div>
        <div class="field"><label>Failure type</label><select name="failure" disabled>${failOpts}</select></div>
      </div>
      <div class="row">
        <div class="field"><label>Cart total (₹)</label><input name="total" type="number" min="0" step="1"></div>
        <div class="field"><label>Was COD offered?</label><select name="codOffered"><option value="">Not checked</option><option value="yes">Yes</option><option value="no">No</option></select></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" placeholder="Paste the error text"></textarea></div>
      <button class="primary">Log run</button>
    </form>`}

    <form class="card" id="settings">
      <h3>COD cap</h3>
      <div class="row">
        <div class="field"><label>Block COD orders above (₹)</label><input name="codCap" type="number" min="1" step="1" value="${meta.settings.codCap}"></div>
        <button class="primary">Save</button>
      </div>
    </form>`;

  $('#sample').onchange = (e) => { includeSample = e.target.checked; store.set('includeSample', includeSample ? '1' : '0'); renderDashboard(el); };
  $('#admin-out')?.addEventListener('click', (e) => { e.preventDefault(); store.set('adminKey', null); renderAdminLogin(el); });
  $('#load-sample').onclick = guard(async () => {
    await api('POST', '/api/sample');
    includeSample = true; store.set('includeSample', '1');
    toast('Sample data loaded and shown. It is labelled SAMPLE.'); renderDashboard(el);
  });
  $('#clear-sample').onclick = guard(async () => {
    if (!confirm('Remove all sample users, orders and runs? Your real data stays.')) return;
    await api('POST', '/api/sample/clear');
    toast('Sample data removed'); renderDashboard(el);
  });
  const log = $('#log-run');
  if (log) {
    log.outcome.onchange = () => { log.failure.disabled = log.outcome.value === 'success'; };
    log.onsubmit = guard(async () => {
      const f = new FormData(log), cod = f.get('codOffered');
      await api('POST', '/api/runs', { platform: f.get('platform'), flow: f.get('flow'), outcome: f.get('outcome'),
        failure: log.failure.value, total: f.get('total'), codOffered: cod === '' ? null : cod === 'yes', notes: f.get('notes') });
      toast('Run logged'); renderDashboard(el);
    });
  }
  $('#settings').onsubmit = guard(async () => {
    meta.settings = await api('PUT', '/api/settings', { codCap: $('#settings').codCap.value });
    toast(`COD cap set to ${rupees(meta.settings.codCap)}`);
  });
}

// ---------- start ----------

(async () => {
  meta = await api('GET', '/api/meta');
  userId = store.get('userId');
  if (userId) { try { await api('POST', '/api/open', { userId }); } catch {} }
  await refreshMe();
  show();
})();

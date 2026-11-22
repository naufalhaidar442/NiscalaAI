const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = 3000;
const ROOT = __dirname;
const STORY_DIR = path.join(ROOT, 'story');
const DATA_DIR = path.join(ROOT, 'data');   // data/<googleUserId>/<chatId>.json
const AUTH_DIR = path.join(ROOT, 'auth');   // sessions.json

// ===== GOOGLE LOGIN =====
// Isi dari Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web)
const GOOGLE_CLIENT_ID = '230132707860-e18s9hlga0039qrlme7s31lp41s8bf31.apps.googleusercontent.com';
// Kosongkan [] = semua akun Google boleh masuk. Isi untuk membatasi, mis. ['kamu@gmail.com']
const ALLOWED_EMAILS = [];
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 hari

const LM_URL = 'http://localhost:1234/v1/chat/completions'; // fallback
const RUNPOD_URL = process.env.RUNPOD_URL || 'https://api.runpod.ai/v2/utstmcoe7bojem/openai/v1/chat/completions';
// false = tunggu jawaban penuh lalu simpan (stabil). true = teks tampil bertahap saat ditulis AI.
const STREAM = false;
// Model Qwen3.x punya mode "thinking". Kalau jawaban masih sering kosong, coba true.
const DISABLE_THINKING = false;
const RUNPOD_KEY = process.env.RUNPOD_KEY || '';
const RUNPOD_MODEL = 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M';

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
ensureDir(STORY_DIR); ensureDir(DATA_DIR); ensureDir(AUTH_DIR);

const jobs = new Map(); // "<userId>:<chatId>" -> { partial }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}
function safeId(id) { return /^[a-zA-Z0-9_-]+$/.test(id) ? id : null; }

// ===== SESSIONS =====
const SESS_FILE = path.join(AUTH_DIR, 'sessions.json');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch { }
function saveSessions() { fs.writeFile(SESS_FILE, JSON.stringify(sessions), () => { }); }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getSession(req) {
  const sid = parseCookies(req).sid;
  const s = sid && sessions[sid];
  if (!s) return null;
  if (s.exp < Date.now()) { delete sessions[sid]; saveSessions(); return null; }
  return { sid, user: s.user };
}
function setCookie(res, sid, maxAgeSec) {
  // Kalau nanti pakai HTTPS, tambahkan "; Secure"
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`);
}

async function verifyGoogle(credential) {
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!r.ok) throw new Error('Token Google tidak valid');
  const t = await r.json();
  if (t.aud !== GOOGLE_CLIENT_ID) throw new Error('Client ID tidak cocok');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss)) throw new Error('Issuer salah');
  if (String(t.email_verified) !== 'true') throw new Error('Email belum terverifikasi');
  if (!safeId(String(t.sub))) throw new Error('ID user tidak valid');
  if (ALLOWED_EMAILS.length && !ALLOWED_EMAILS.includes(t.email)) throw new Error('Akun ini tidak diizinkan');
  return { sub: String(t.sub), email: t.email, name: t.name || t.email, picture: t.picture || '' };
}

// ===== PER-USER DATA =====
function userDir(user) {
  const d = path.join(DATA_DIR, user.sub);
  ensureDir(d);
  return d;
}

// ===== WALLET =====
const AI_REPLY_COST = 30;
const INITIAL_COINS = Math.max(0, Number(process.env.INITIAL_COINS) || 0);
function walletFile(user) { return path.join(userDir(user), 'wallet.json'); }
function readWallet(user) {
  const file = walletFile(user);
  let wallet;
  try { wallet = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { wallet = { coins: INITIAL_COINS, subscriptionUntil: 0 }; }
  wallet.coins = Math.max(0, Number(wallet.coins) || 0);
  wallet.subscriptionUntil = Number(wallet.subscriptionUntil) || 0;
  return wallet;
}
function writeWallet(user, wallet) {
  fs.writeFileSync(walletFile(user), JSON.stringify(wallet, null, 2), 'utf8');
}
function hasUnlimited(wallet) { return wallet.subscriptionUntil > Date.now(); }

// Chat lama (data/*.json tanpa folder user) dipindah ke user PERTAMA yang login.
async function migrateLegacy(user) {
  const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  const hasUserDirs = entries.some(e => e.isDirectory());
  const legacy = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
  if (hasUserDirs || legacy.length === 0) return;
  const dir = userDir(user);
  for (const f of legacy) await fsp.rename(path.join(DATA_DIR, f.name), path.join(dir, f.name));
  console.log(`[migrate] ${legacy.length} chat lama dipindah ke user ${user.email}`);
}

// ===== BACKGROUND GENERATE =====
// Buang blok <think>...</think> kalau bocor ke dalam content
function cleanThink(t) {
  t = String(t || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const i = t.lastIndexOf('</think>');
  if (i >= 0) t = t.slice(i + 8);
  return t.replace(/<\/?think>/g, '').trim();
}

async function runJob(key, file, job, body) {
  let reply = '';
  try {
    if (!RUNPOD_KEY) throw new Error('RUNPOD_KEY belum diatur di environment server');
    const payload = {
      model: body.model || RUNPOD_MODEL,
      messages: body.messages,
      max_tokens: body.max_tokens ?? 2000,
      temperature: body.temperature ?? 0.85,
      stream: false
    };
    if (DISABLE_THINKING) payload.chat_template_kwargs = { enable_thinking: false };

    const upstream = await fetch(RUNPOD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RUNPOD_KEY },
      body: JSON.stringify(payload)
    });
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      throw new Error(`RunPod ${upstream.status}: ${t.slice(0, 300)}`);
    }

    let content = '', reasoning = '', finish = null;

    if (!STREAM) {
      // ---- Non-stream: satu blok JSON ----
      const raw = await upstream.text();
      let j;
      try { j = JSON.parse(raw); }
      catch { throw new Error('Balasan RunPod bukan JSON: ' + raw.slice(0, 200)); }
      if (j.error) throw new Error('RunPod: ' + (j.error.message || JSON.stringify(j.error)).slice(0, 300));
      const ch = j.choices?.[0];
      finish = ch?.finish_reason ?? null;
      content = ch?.message?.content || '';
      reasoning = ch?.message?.reasoning_content || ch?.message?.reasoning || '';
    } else {
      // ---- Stream: SSE "data: {...}" ----
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const ch = JSON.parse(d).choices?.[0];
            if (ch?.finish_reason) finish = ch.finish_reason;
            const dl = ch?.delta || {};
            if (dl.content) { content += dl.content; job.partial = cleanThink(content); }
            const rc = dl.reasoning_content ?? dl.reasoning;
            if (rc) reasoning += rc;
          } catch { }
        }
      }
    }

    let final = cleanThink(content);
    console.log(`[job ${key}] stream=${STREAM} content=${content.length} reasoning=${reasoning.length} finish=${finish}`);
    if (!final && reasoning.trim()) {
      console.warn(`[job ${key}] content kosong, pakai reasoning_content sebagai jawaban`);
      final = cleanThink(reasoning);
    }
    if (!final) throw new Error(`Empty AI output (content=${content.length}, reasoning=${reasoning.length} karakter, finish=${finish})`);
    reply = final;
  } catch (e) {
    reply = 'Error: ' + (e.message || e);
    console.error(`[job ${key}]`, e.message || e);
  }

  // Biaya hanya final jika AI berhasil memberi jawaban. Kegagalan mengembalikan reservasi.
  if (job.reserved && reply.startsWith('Error: ')) {
    const wallet = readWallet(job.user);
    wallet.coins += AI_REPLY_COST;
    writeWallet(job.user, wallet);
  }
  try {
    const chat = JSON.parse(await fsp.readFile(file, 'utf8'));
    chat.messages.push({ role: 'assistant', content: reply });
    chat.updatedAt = Date.now();
    await fsp.writeFile(file, JSON.stringify(chat, null, 2), 'utf8');
  } catch (e) { console.error('[JOB save]', e); }
  jobs.delete(key);
}

// File/folder yang TIDAK boleh diakses lewat static server
const BLOCKED_TOP = new Set(['data', 'story', 'auth', 'node_modules']);
const BLOCKED_FILES = new Set(['server.js', 'package.json', 'package-lock.json']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    // ===== AUTH (publik) =====
    if (p === '/api/auth/config' && req.method === 'GET') {
      return json(res, 200, { clientId: GOOGLE_CLIENT_ID });
    }
    if (p === '/api/auth/google' && req.method === 'POST') {
      const { credential } = JSON.parse(await readBody(req));
      if (!credential) return json(res, 400, { error: 'credential kosong' });
      let user;
      try { user = await verifyGoogle(credential); }
      catch (e) { return json(res, 401, { error: e.message }); }
      await migrateLegacy(user);
      userDir(user);
      const sid = crypto.randomBytes(32).toString('hex');
      sessions[sid] = { user, exp: Date.now() + SESSION_TTL };
      saveSessions();
      setCookie(res, sid, SESSION_TTL / 1000);
      return json(res, 200, { ok: true, user });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const s = getSession(req);
      if (s) { delete sessions[s.sid]; saveSessions(); }
      setCookie(res, '', 0);
      return json(res, 200, { ok: true });
    }

    // ===== SEMUA /api LAINNYA WAJIB LOGIN =====
    let user = null;
    if (p.startsWith('/api/')) {
      const s = getSession(req);
      if (!s) return json(res, 401, { error: 'unauthorized' });
      user = s.user;
    }

    if (p === '/api/me' && req.method === 'GET') return json(res, 200, user);

    if (p === '/api/wallet' && req.method === 'GET') {
      const wallet = readWallet(user);
      return json(res, 200, { coins: wallet.coins, subscriptionUntil: wallet.subscriptionUntil, unlimited: hasUnlimited(wallet), replyCost: AI_REPLY_COST });
    }
    if (p === '/api/shop/checkout' && req.method === 'POST') {
      // Payment must be verified by a provider webhook before coins/subscription are credited.
      return json(res, 503, { error: 'Pembayaran belum dikonfigurasi. Hubungkan Midtrans/Xendit dan webhook terverifikasi terlebih dahulu.' });
    }

    // ===== STORIES (dibaca semua user; hanya pemilik yang boleh ubah/hapus) =====
    if (p === '/api/stories' && req.method === 'GET') {
      const files = await fsp.readdir(STORY_DIR).catch(() => []);
      const list = [];
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try { list.push(JSON.parse(await fsp.readFile(path.join(STORY_DIR, f), 'utf8'))); } catch { }
      }
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return json(res, 200, list);
    }
    if (p === '/api/stories' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !safeId(body.id)) return json(res, 400, { error: 'invalid id' });
      const file = path.join(STORY_DIR, body.id + '.json');
      let existing = null;
      try { existing = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { }
      if (existing?.ownerId && existing.ownerId !== user.sub)
        return json(res, 403, { error: 'Cerita ini milik user lain' });
      body.ownerId = existing?.ownerId || user.sub;
      body.updatedAt = Date.now();
      if (!body.createdAt) body.createdAt = existing?.createdAt || body.updatedAt;
      await fsp.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
      return json(res, 200, body);
    }

    let m = p.match(/^\/api\/stories\/([^/]+)$/);
    if (m) {
      const id = safeId(m[1]); if (!id) return json(res, 400, { error: 'invalid id' });
      const file = path.join(STORY_DIR, id + '.json');
      if (req.method === 'GET') {
        try { return json(res, 200, JSON.parse(await fsp.readFile(file, 'utf8'))); }
        catch { return json(res, 404, { error: 'not found' }); }
      }
      if (req.method === 'DELETE') {
        try {
          const st = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (st.ownerId && st.ownerId !== user.sub)
            return json(res, 403, { error: 'Cerita ini milik user lain' });
        } catch { }
        try { await fsp.unlink(file); } catch { }
        // hapus chat terkait milik SEMUA user
        const dirs = await fsp.readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
        for (const d of dirs) {
          if (!d.isDirectory()) continue;
          const dp = path.join(DATA_DIR, d.name);
          for (const cf of await fsp.readdir(dp).catch(() => [])) {
            if (!cf.endsWith('.json')) continue;
            try {
              const c = JSON.parse(await fsp.readFile(path.join(dp, cf), 'utf8'));
              if (c.storyId === id) await fsp.unlink(path.join(dp, cf));
            } catch { }
          }
        }
        return json(res, 200, { ok: true });
      }
    }

    // ===== CHATS (per user) =====
    if (p === '/api/chats' && req.method === 'GET') {
      const dir = userDir(user);
      const storyId = url.searchParams.get('story');
      const files = await fsp.readdir(dir).catch(() => []);
      const list = [];
      for (const f of files) {
        if (!f.endsWith('.json') || f === 'wallet.json') continue;
        try {
          const c = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'));
          if (!storyId || c.storyId === storyId) list.push(c);
        } catch { }
      }
      list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const summary = list.map(c => ({
        id: c.id, storyId: c.storyId, title: c.title,
        messageCount: c.messages?.length || 0,
        createdAt: c.createdAt, updatedAt: c.updatedAt
      }));
      return json(res, 200, summary);
    }

    if (p === '/api/chats' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !safeId(body.id)) return json(res, 400, { error: 'invalid id' });
      body.updatedAt = Date.now();
      if (!body.createdAt) body.createdAt = body.updatedAt;
      await fsp.writeFile(path.join(userDir(user), body.id + '.json'), JSON.stringify(body, null, 2), 'utf8');
      return json(res, 200, body);
    }

    m = p.match(/^\/api\/chats\/([^/]+)$/);
    if (m) {
      const id = safeId(m[1]); if (!id) return json(res, 400, { error: 'invalid id' });
      const file = path.join(userDir(user), id + '.json');
      if (req.method === 'GET') {
        try { return json(res, 200, JSON.parse(await fsp.readFile(file, 'utf8'))); }
        catch { return json(res, 404, { error: 'not found' }); }
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        body.id = id; body.updatedAt = Date.now();
        if (!body.createdAt) body.createdAt = body.updatedAt;
        await fsp.writeFile(file, JSON.stringify(body, null, 2), 'utf8');
        return json(res, 200, body);
      }
      if (req.method === 'DELETE') {
        try { await fsp.unlink(file); } catch { }
        return json(res, 200, { ok: true });
      }
    }

    // ===== BACKGROUND GENERATE (per user) =====
    m = p.match(/^\/api\/chats\/([^/]+)\/(generate|status)$/);
    if (m) {
      const id = safeId(m[1]); if (!id) return json(res, 400, { error: 'invalid id' });
      const file = path.join(userDir(user), id + '.json');
      const key = user.sub + ':' + id;
      if (m[2] === 'status' && req.method === 'GET') {
        const job = jobs.get(key);
        return json(res, 200, { generating: !!job, partial: job?.partial || '' });
      }
      if (m[2] === 'generate' && req.method === 'POST') {
        if (!fs.existsSync(file)) return json(res, 404, { error: 'chat tidak ditemukan' });
        if (jobs.has(key)) return json(res, 409, { error: 'sedang generate' });
        const body = JSON.parse(await readBody(req));
        const wallet = readWallet(user);
        const unlimited = hasUnlimited(wallet);
        if (!unlimited && wallet.coins < AI_REPLY_COST) {
          return json(res, 402, { error: `Koin tidak cukup. Satu jawaban AI membutuhkan ${AI_REPLY_COST} koin.`, coins: wallet.coins, required: AI_REPLY_COST });
        }
        // Reservasi dilakukan sinkron agar dua request bersamaan tidak memakai saldo yang sama.
        if (!unlimited) { wallet.coins -= AI_REPLY_COST; writeWallet(user, wallet); }
        const job = { partial: '', reserved: !unlimited, user };
        jobs.set(key, job);
        runJob(key, file, job, body); // background, tanpa await
        return json(res, 200, { started: true });
      }
    }

    // ===== CHAT PROXY (lama, sekarang wajib login) =====
    if (p === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const payload = {
        model: body.model || RUNPOD_MODEL,
        messages: body.messages,
        max_tokens: body.max_tokens ?? 2000,
        temperature: body.temperature ?? 0.85,
        stream: !!body.stream
      };
      const upstream = await fetch(RUNPOD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RUNPOD_KEY },
        body: JSON.stringify(payload)
      });
      if (!upstream.ok) {
        const t = await upstream.text().catch(() => '');
        return json(res, 502, { error: `RunPod ${upstream.status}: ${t.slice(0, 300)}` });
      }
      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(dec.decode(value, { stream: true }));
          }
        } finally { res.end(); }
        return;
      }
      return json(res, 200, await upstream.json());
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // ===== STATIC =====
    let fp = p === '/' ? '/index.html' : p;
    const resolved = path.normalize(path.join(ROOT, fp));
    if (!resolved.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const rel = path.relative(ROOT, resolved);
    const top = rel.split(path.sep)[0];
    if (BLOCKED_TOP.has(top) || BLOCKED_FILES.has(rel) || rel.split(path.sep).some(s => s.startsWith('.'))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found: ' + fp);
    }
    try {
      const st = await fsp.stat(resolved);
      if (st.isDirectory()) { res.writeHead(403); return res.end('Forbidden'); }
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(resolved).pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + fp);
    }
  } catch (e) {
    console.error('[ERR]', e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`🚀 http://localhost:${PORT}`);
  console.log(`   story/  ← ${STORY_DIR}`);
  console.log(`   data/   ← ${DATA_DIR}  (per user)`);
});

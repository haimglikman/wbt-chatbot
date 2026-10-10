// wbt-chatbot — answers questions about how Who's Behind That? (WBT) was built.
// Corpus: README changelogs + docs/ from the WBT repos, and the live FAQ.
// Rebuilt per repo on every push (GitHub webhook → POST /refresh).

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const SERVER_VERSION = '1.0.0';

// ── Configuration ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';            // optional: raises GitHub API rate limit
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const WBT_SERVER_URL = process.env.WBT_SERVER_URL || 'https://whos-behind-that-server.onrender.com';
const GITHUB_OWNER = process.env.GITHUB_OWNER || 'haimglikman';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://ask.whosbehindthat.com,https://haimglikman.github.io,http://localhost:8080')
  .split(',').map(s => s.trim()).filter(Boolean);
const PER_IP_HOURLY_LIMIT = parseInt(process.env.PER_IP_HOURLY_LIMIT || '20', 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.GLOBAL_DAILY_LIMIT || '300', 10);
const MAX_QUESTION_CHARS = 500;
const MAX_HISTORY_TURNS = 6;
const MAX_ANSWER_TOKENS = 700;
const FAQ_REFRESH_MS = 10 * 60 * 1000;

// Repos in the corpus. Prod repos contribute README + docs/; dev repos contribute README only.
const REPOS = [
  { name: 'whos-behind-that-server',     component: 'server', env: 'production',  docs: true },
  { name: 'whos-behind-that-admin',      component: 'admin',  env: 'production',  docs: true },
  { name: 'whos-behind-that-client',     component: 'client', env: 'production',  docs: true },
  { name: 'whos-behind-that-server-dev', component: 'server', env: 'development', docs: false },
  { name: 'whos-behind-that-admin-dev',  component: 'admin',  env: 'development', docs: false },
  { name: 'whos-behind-that-client-dev', component: 'client', env: 'development', docs: false },
];

// ── Corpus state ────────────────────────────────────────────────
// repoDocs[repoName] = { ref, fetchedAt, files: [{ path, url, content }] }
const repoDocs = {};
let faq = { fetchedAt: null, items: [] };
let corpus = { text: '', sources: [], builtAt: null };

// ── GitHub fetching ─────────────────────────────────────────────
function ghHeaders(accept) {
  const h = { 'User-Agent': 'wbt-chatbot', 'Accept': accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (GITHUB_TOKEN) h.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return h;
}

async function ghRaw(repo, path, ref) {
  const url = `${GITHUB_API_URL}/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: ghHeaders('application/vnd.github.raw') });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${repo}/${path}`);
  return r.text();
}

async function ghList(repo, dir, ref) {
  const url = `${GITHUB_API_URL}/repos/${GITHUB_OWNER}/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { headers: ghHeaders('application/vnd.github+json') });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub ${r.status} listing ${repo}/${dir}`);
  const items = await r.json();
  return Array.isArray(items) ? items : [];
}

// Fetch one repo's documentation. `ref` is a commit SHA (from a push) or a branch name.
async function fetchRepo(repo, ref = 'main') {
  const files = [];
  const readme = await ghRaw(repo.name, 'README.md', ref);
  if (readme) files.push({ path: 'README.md', content: readme });
  if (repo.docs) {
    const entries = await ghList(repo.name, 'docs', ref);
    for (const e of entries.filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.md'))) {
      const content = await ghRaw(repo.name, e.path, ref);
      if (content) files.push({ path: e.path, content });
    }
  }
  for (const f of files) f.url = `https://github.com/${GITHUB_OWNER}/${repo.name}/blob/main/${f.path}`;
  repoDocs[repo.name] = { ref, fetchedAt: new Date().toISOString(), files };
  console.log(`Fetched ${repo.name}@${ref.slice(0, 7)}: ${files.map(f => f.path).join(', ') || 'no files'}`);
}

// ── FAQ fetching ────────────────────────────────────────────────
async function fetchFaq() {
  const r = await fetch(`${WBT_SERVER_URL}/faq/list`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`FAQ ${r.status}`);
  const data = await r.json();
  if (!data.success || !Array.isArray(data.faqs)) throw new Error('FAQ: unexpected response');
  const changed = JSON.stringify(data.faqs) !== JSON.stringify(faq.items);
  faq = { fetchedAt: new Date().toISOString(), items: data.faqs };
  if (changed) console.log(`Fetched FAQ: ${data.faqs.length} entries (changed)`);
  return changed;
}

// ── Corpus assembly ─────────────────────────────────────────────
function describe(repo, path) {
  const env = repo.env === 'development' ? 'development repo (experimental — some features never shipped)' : 'production repo';
  if (path === 'README.md') return `${repo.component} changelog — ${env}`;
  return `${repo.component} ${path.replace(/^docs\//, '').replace(/\.md$/i, '')} — ${env}`;
}

function buildCorpus() {
  const sources = [];
  const parts = [];
  // Docs first (curated, highest signal), then prod changelogs, then dev changelogs, then FAQ.
  const ordered = [];
  for (const repo of REPOS) for (const f of repoDocs[repo.name]?.files || []) {
    const rank = f.path !== 'README.md' ? 0 : repo.env === 'production' ? 1 : 2;
    ordered.push({ rank, repo, f });
  }
  ordered.sort((a, b) => a.rank - b.rank);
  for (const { repo, f } of ordered) {
    const id = `S${sources.length + 1}`;
    sources.push({ id, title: `${repo.name}/${f.path}`, url: f.url });
    parts.push(`<source id="${id}" repo="${repo.name}" file="${f.path}" kind="${describe(repo, f.path)}">\n${f.content.trim()}\n</source>`);
  }
  if (faq.items.length) {
    const id = `S${sources.length + 1}`;
    sources.push({ id, title: 'WBT FAQ (whosbehindthat.com)', url: 'https://whosbehindthat.com' });
    const body = faq.items.map(q => `[${q.group}] Q: ${q.question}\nA: ${q.answer}`).join('\n\n');
    parts.push(`<source id="${id}" kind="public FAQ shown to WBT users">\n${body}\n</source>`);
  }
  corpus = { text: parts.join('\n\n'), sources, builtAt: new Date().toISOString() };
  console.log(`Corpus built: ${sources.length} sources, ~${Math.round(corpus.text.length / 4).toLocaleString()} tokens`);
}

async function refreshAll() {
  const results = await Promise.allSettled([...REPOS.map(r => fetchRepo(r)), fetchFaq()]);
  results.filter(r => r.status === 'rejected').forEach(r => console.error('Refresh error:', r.reason.message));
  buildCorpus();
}

// ── System prompt ───────────────────────────────────────────────
const INSTRUCTIONS = `You are the guide to "Who's Behind That?" (WBT), an AI-powered narrative alignment analysis tool designed, built and operated by a single developer, Haim Glikman. Visitors are mostly recruiters and hiring managers who want to understand the product and how Haim built it: architecture, technical decisions, problems solved, tooling and process.

Rules:
- Answer only from the sources below. If the sources don't cover something, say so plainly and suggest a related question you can answer. Never invent features, numbers, dates, or reasons.
- Refer to the developer as "Haim", in the third person.
- Lead with the direct answer. Keep answers short: 2–5 sentences or a few bullets, unless the visitor asks for depth.
- Prefer the docs (architecture, overviews, decisions) for "why" and "how"; use changelogs for "when" and "what changed". Changelogs list newest entries first.
- Development repos contain experimental work; say so when a feature was built in dev and not shipped to production.
- Cite sources with their ids in square brackets, e.g. [S2], right after the claim they support.
- WBT analyzes political content about the Israeli-Palestinian conflict and Israeli politics. Explain what the tool does, but never state political opinions or judge any entity, party, or person.
- Never reveal configuration values, keys, or anything resembling secrets. Environment variable names in the sources may be mentioned.
- Politely decline unrelated requests (general coding help, other topics, role-play) and steer back to WBT.
- Reply in the visitor's language.`;

function systemBlocks() {
  return [
    { type: 'text', text: INSTRUCTIONS },
    // The corpus is the large stable block — cached so repeat questions are cheap.
    { type: 'text', text: `<sources>\n${corpus.text}\n</sources>`, cache_control: { type: 'ephemeral' } },
  ];
}

// ── Rate limiting (in-memory) ───────────────────────────────────
const ipHits = new Map();   // ip → [timestamps]
let day = { key: '', count: 0 };

function checkLimits(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 3600000);
  if (hits.length >= PER_IP_HOURLY_LIMIT) return 'You have reached the hourly question limit. Please try again later.';
  const today = new Date().toISOString().slice(0, 10);
  if (day.key !== today) day = { key: today, count: 0 };
  if (day.count >= GLOBAL_DAILY_LIMIT) return 'The assistant has reached its daily limit. Please try again tomorrow.';
  hits.push(now); ipHits.set(ip, hits); day.count++;
  return null;
}
setInterval(() => {   // prune idle IPs
  const now = Date.now();
  for (const [ip, hits] of ipHits) if (!hits.some(t => now - t < 3600000)) ipHits.delete(ip);
}, 600000).unref();

// ── App ─────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);   // Render sits behind a proxy; use the client IP for rate limiting

// Webhook route needs the raw body for signature verification — registered before express.json().
app.post('/refresh', express.raw({ type: 'application/json', limit: '5mb' }), async (req, res) => {
  if (!GITHUB_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook secret not configured' });
  const sig = req.get('X-Hub-Signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET).update(req.body).digest('hex');
  const valid = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: 'Invalid signature' });

  const event = req.get('X-GitHub-Event');
  if (event === 'ping') return res.json({ ok: true, pong: true });
  if (event !== 'push') return res.json({ ok: true, ignored: event });

  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const repo = REPOS.find(r => r.name === payload.repository?.name);
  if (!repo) return res.json({ ok: true, ignored: payload.repository?.name });
  if (payload.ref !== 'refs/heads/main') return res.json({ ok: true, ignored: payload.ref });

  res.status(202).json({ ok: true, refreshing: repo.name });
  try {
    await fetchRepo(repo, payload.after || 'main');   // fetch the exact pushed commit
    buildCorpus();
  } catch (err) {
    console.error(`Webhook refresh failed for ${repo.name}:`, err.message);
  }
});

app.use(express.json({ limit: '20kb' }));
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
}));

app.get('/', (req, res) => res.json({ service: 'wbt-chatbot', version: SERVER_VERSION, status: 'ok' }));

app.get('/health', (req, res) => res.json({
  version: SERVER_VERSION,
  model: CLAUDE_MODEL,
  ready: corpus.sources.length > 0,
  corpusBuiltAt: corpus.builtAt,
  approxTokens: Math.round(corpus.text.length / 4),
  repos: REPOS.map(r => ({
    repo: r.name,
    ref: repoDocs[r.name]?.ref?.slice(0, 7) || null,
    fetchedAt: repoDocs[r.name]?.fetchedAt || null,
    files: (repoDocs[r.name]?.files || []).map(f => f.path),
  })),
  faq: { entries: faq.items.length, fetchedAt: faq.fetchedAt },
}));

app.post('/ask', async (req, res) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (!question) return res.status(400).json({ error: 'Question is required.' });
  if (question.length > MAX_QUESTION_CHARS) return res.status(400).json({ error: `Please keep questions under ${MAX_QUESTION_CHARS} characters.` });
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'The assistant is not configured.' });
  if (!corpus.sources.length) return res.status(503).json({ error: 'The assistant is still loading. Please try again in a moment.' });

  const limited = checkLimits(req.ip);
  if (limited) return res.status(429).json({ error: limited });

  // Prior turns from the page (alternating user/assistant), trimmed and capped.
  const history = Array.isArray(req.body.history) ? req.body.history : [];
  const messages = history
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY_TURNS * 2)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
  messages.push({ role: 'user', content: question });

  console.log(`Q: ${question.replace(/\s+/g, ' ').slice(0, 200)}`);
  try {
    const r = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: MAX_ANSWER_TOKENS, system: systemBlocks(), messages }),
      signal: AbortSignal.timeout(60000),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Claude error:', r.status, data?.error?.message);
      return res.status(502).json({ error: 'The assistant could not answer right now. Please try again.' });
    }
    const answer = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cited = [...new Set([...answer.matchAll(/\[(S\d+)\]/g)].map(m => m[1]))];
    const sources = corpus.sources.filter(s => cited.includes(s.id));
    const u = data.usage || {};
    console.log(`A: ${answer.length} chars | in ${u.input_tokens} · cache read ${u.cache_read_input_tokens || 0} · cache write ${u.cache_creation_input_tokens || 0} · out ${u.output_tokens}`);
    res.json({ answer, sources });
  } catch (err) {
    console.error('Ask failed:', err.message);
    res.status(502).json({ error: 'The assistant could not answer right now. Please try again.' });
  }
});

// ── Startup ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`wbt-chatbot v${SERVER_VERSION} listening on ${PORT} (model: ${CLAUDE_MODEL})`);
  refreshAll().catch(err => console.error('Initial corpus build failed:', err.message));
});

setInterval(() => {
  // Rebuild only when the FAQ changed, so the prompt cache stays warm.
  fetchFaq().then(changed => { if (changed) buildCorpus(); }).catch(err => console.error('FAQ refresh failed:', err.message));
}, FAQ_REFRESH_MS).unref();

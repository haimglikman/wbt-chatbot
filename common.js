// Shared by index.html and architecture.html

const API = new URLSearchParams(location.search).get('api') || 'https://wbt-chatbot.onrender.com';

// Live chatbot version in the top bar, read from the running service.
function showVersion(health) {
  const el = document.getElementById('version-badge');
  if (el && health && health.version) { el.textContent = 'Chatbot v' + health.version; el.hidden = false; }
}

async function fetchHealth() {
  const r = await fetch(API + '/health', { cache: 'no-store' });
  if (!r.ok) throw new Error('health ' + r.status);
  const health = await r.json();
  showVersion(health);
  return health;
}

// Markdown → sanitized HTML. Links open in a new tab.
function renderMarkdown(md) {
  const html = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: false }));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  return tpl.content;
}

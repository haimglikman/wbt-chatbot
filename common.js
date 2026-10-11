// Shared by index.html and architecture.html

const API = new URLSearchParams(location.search).get('api') || 'https://wbt-chatbot.onrender.com';

async function fetchHealth() {
  const r = await fetch(API + '/health', { cache: 'no-store' });
  if (!r.ok) throw new Error('health ' + r.status);
  return r.json();
}

// Markdown → sanitized HTML. Links open in a new tab.
// Falls back to plain paragraphs if the markdown libraries failed to load.
function renderMarkdown(md) {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
    const frag = document.createDocumentFragment();
    md.split(/\n{2,}/).forEach(block => {
      const p = document.createElement('p');
      p.style.whiteSpace = 'pre-line';
      p.textContent = block.replace(/^#+\s*/gm, '').replace(/\*\*|__/g, '');
      frag.appendChild(p);
    });
    return frag;
  }
  const html = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: false }));
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('a[href]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  return tpl.content;
}

import { fetchIncidents, ack } from './api.js';

const REFRESH_MS = 2000; // R4
const loader = document.querySelector('[data-testid="loader"]');
const empty = document.querySelector('[data-testid="empty"]');
const list = document.querySelector('[data-testid="incident-list"]');
const updated = document.querySelector('.updated');

const acked = new Map(); // id -> ackedAt, survives every refresh
const pending = new Set(); // ids with an ack in flight

// R5: viewer's own zone and own day/month order (en-GB, de-DE, ... give dd/mm; en-US gives mm/dd).
const locale = navigator.languages?.[0] || navigator.language || undefined;
const fmt = new Intl.DateTimeFormat(locale, {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
});
const localTime = (iso) => fmt.format(new Date(iso));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function rowHtml(i) {
  return `<span class="id">${esc(i.id)}</span>
    <span class="sev">${esc(i.severity)}</span>
    <span class="what">${esc(i.service)} · ${esc(i.region)} · ${esc(i.summary)}</span>
    <time datetime="${esc(i.openedAt)}" title="${esc(i.openedAt)}">${esc(localTime(i.openedAt))}</time>
    <span class="act"></span>`;
}

function renderAction(li, id) {
  const slot = li.querySelector('.act');
  if (acked.has(id)) {
    if (!slot.querySelector('[data-testid="acked"]')) slot.innerHTML = `<span data-testid="acked" class="acked">✓ acked</span>`;
    li.classList.add('is-acked');
  } else if (!slot.querySelector('[data-testid="ack"]')) {
    slot.innerHTML = `<button type="button" data-testid="ack">Ack</button>`;
  }
  const btn = slot.querySelector('[data-testid="ack"]');
  if (btn) btn.disabled = pending.has(id);
}

// R1: newest first; rows are kept by id, so a refresh does not rebuild rows the viewer is using.
function render(incidents) {
  const sorted = [...incidents].sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  const existing = new Map([...list.children].map((li) => [li.dataset.id, li]));
  const keep = new Set();
  let prev = null;
  for (const i of sorted) {
    keep.add(i.id);
    let li = existing.get(i.id);
    const sig = `${i.severity}|${i.service}|${i.region}|${i.summary}|${i.openedAt.slice(0, 16)}`;
    if (!li) {
      li = document.createElement('li');
      li.setAttribute('data-testid', 'incident-row');
      li.dataset.id = i.id;
    }
    if (li.dataset.sig !== sig) {
      li.className = `row ${i.severity}`;
      li.innerHTML = rowHtml(i);
      li.dataset.sig = sig;
    } else {
      const t = li.querySelector('time'); // keep the full UTC value current
      t.setAttribute('datetime', i.openedAt);
    }
    renderAction(li, i.id);
    const want = prev ? prev.nextSibling : list.firstChild;
    if (want !== li) list.insertBefore(li, want);
    prev = li;
  }
  for (const [id, li] of existing) if (!keep.has(id)) li.remove();
  empty.hidden = sorted.length > 0;
  list.hidden = sorted.length === 0;
}

// R2 (product, after SCHED-4511 step 1): Ack asks to confirm, and the confirm names the incident id.
// The id is taken from the row at click time and held by the confirm, so a row that moved under the
// pointer shows up as the wrong id before anything is sent.
const confirmBox = document.querySelector('[data-testid="confirm"]');
const confirmText = confirmBox.querySelector('.confirm-text');
const confirmAck = confirmBox.querySelector('[data-testid="confirm-ack"]');
const confirmCancel = confirmBox.querySelector('[data-testid="confirm-cancel"]');
let confirming = null; // { id, summary }

function openConfirm(id, summary) {
  confirming = { id };
  confirmText.innerHTML = `Ack <strong class="confirm-id">${esc(id)}</strong>?<span class="confirm-what">${esc(summary)}</span>`;
  confirmBox.hidden = false;
  confirmAck.focus();
}
function closeConfirm() {
  confirming = null;
  confirmBox.hidden = true;
}

list.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-testid="ack"]');
  if (!btn) return;
  const li = btn.closest('[data-testid="incident-row"]');
  openConfirm(li.dataset.id, li.querySelector('.what')?.textContent ?? '');
});

confirmCancel.addEventListener('click', closeConfirm);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && confirming) closeConfirm(); });

confirmAck.addEventListener('click', async () => {
  if (!confirming) return;
  const { id } = confirming;
  closeConfirm();
  pending.add(id);
  const row = () => list.querySelector(`[data-testid="incident-row"][data-id="${CSS.escape(id)}"]`);
  if (row()) renderAction(row(), id);
  try {
    const reply = await ack(id);
    acked.set(id, reply.ackedAt);
  } catch (err) {
    console.error(err);
  } finally {
    pending.delete(id);
    if (row()) renderAction(row(), id);
  }
});

async function refresh() {
  try {
    const page = await fetchIncidents();
    render(page.incidents);
    loader.hidden = true; // R3: gone once incidents are on screen
    loader.remove?.();
    if (updated) updated.textContent = `updated ${localTime(page.updatedAt)}`;
  } catch (err) {
    console.error(err);
  } finally {
    setTimeout(refresh, REFRESH_MS); // R4
  }
}

refresh();

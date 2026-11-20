// The upload queue: what goes out next on each platform, and when.
//
// Everything here comes from /api/uploads, which is local data — no platform
// credentials are involved, so this page works before anything is connected.
// That is deliberate: it is the one dashboard that can answer "what is it
// going to post?" while the sign-ins are still being sorted out.

const POLL_MS = 30_000;

const PLATFORMS = ['youtube', 'tiktok', 'instagram'];

const els = {
  updated: document.getElementById('updated'),
  refresh: document.getElementById('refresh'),
  offNote: document.getElementById('queue-off-note'),
  emptyNote: document.getElementById('queue-empty-note'),
  youtube: { state: document.getElementById('youtube-state'), body: document.getElementById('youtube-body') },
  tiktok: { state: document.getElementById('tiktok-state'), body: document.getElementById('tiktok-body') },
  instagram: { state: document.getElementById('instagram-state'), body: document.getElementById('instagram-body') },
};

const escape = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const startOfDay = (value) => {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Today / Tomorrow / a weekday, whichever a person would actually say. */
function dayName(iso) {
  const day = startOfDay(iso);
  const today = startOfDay(Date.now());
  const days = Math.round((day - today) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return new Date(iso).toLocaleDateString([], { weekday: 'long' });
  return new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function stateLine(state) {
  if (!state.keys) return 'needs keys';
  if (!state.connected) return 'not connected';
  if (state.mode === 'off') return 'off';
  return state.mode === 'dry-run' ? 'dry run' : 'on';
}

/** Why nothing is scheduled, when nothing is. */
function emptyReason(state) {
  // Three empty columns used to print the same forty-word explanation three
  // times, once per platform, differing only in the platform's name. The
  // explanation is said once above, by render(); a column with nothing in it
  // only has to say so.
  if (!state.queued) return '<p class="pending-note">Nothing queued.</p>';
  // There are shorts waiting but no times: something is holding it with no
  // known end. Say which thing, rather than showing an empty list.
  const why = state.lastError ? `: ${escape(state.lastError)}` : '';
  return `<p class="pending-note is-held">${state.queued} short${state.queued === 1 ? '' : 's'} waiting, but nothing is
          scheduled — ${escape(state.waitingFor || 'the platform is not accepting uploads')}${why}.</p>`;
}

function renderRows(upcoming) {
  const out = [];
  let lastDay = null;
  for (const item of upcoming) {
    if (!item.at) continue;
    const day = startOfDay(item.at);
    if (day !== lastDay) {
      out.push(`<li class="queue-day">${escape(dayName(item.at))}</li>`);
      lastDay = day;
    }
    out.push(`
      <li class="queue-row">
        <span class="queue-time">${escape(time(item.at))}</span>
        <span class="queue-score" title="engagement score">${escape(item.score)}</span>
        <span class="queue-title" title="${escape(item.file)}">${escape(item.title || item.file)}</span>
        <span class="queue-who">${escape(item.broadcaster || '')}</span>
      </li>`);
  }
  return out.join('');
}

function renderPlatform(name, state) {
  const target = els[name];
  if (!state) return;
  target.state.textContent = stateLine(state);

  const bits = [];
  if (state.mode !== 'off') bits.push(`${state.today} of ${state.perDay} used in the last ${state.rolling ? '24h' : 'day'}`);
  bits.push(`${state.queued} waiting`);
  bits.push(`one every ${Math.round((state.spacingMinutes / 60) * 10) / 10}h`);
  const summary = `<p class="queue-summary">${escape(bits.join(' · '))}</p>`;

  // Two separate facts, so they stack rather than hide each other: whether
  // it is switched on, and what an upload to this platform actually is.
  // "This platform is off. The times below are when these would go out if
  // you switched it on" is the same sentence whatever the platform, and all
  // three were usually off together, so the reader met it three times in one
  // screen. It is said once, above, by render(). What stays here is only what
  // differs between platforms.
  const notes = [];
  if (state.draftsOnly) {
    notes.push('Each one arrives as a <b>draft in your TikTok inbox</b> at the time shown — you still tap post.');
  }
  const banner = notes.map((note) => `<p class="pending-note">${note}</p>`).join('');

  const rows = renderRows(state.upcoming || []);
  target.body.innerHTML = summary + banner + (rows ? `<ol class="queue-list">${rows}</ol>` : emptyReason(state));
}

const LABELS = { youtube: 'YouTube', tiktok: 'TikTok', instagram: 'Instagram' };

/** "YouTube and TikTok", "YouTube, TikTok and Instagram". */
const listNames = (names) =>
  names.length < 2 ? names[0] || '' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

function render(view) {
  // Which platforms are switched off, said once rather than once per column.
  const off = PLATFORMS.filter((name) => view[name]?.built && view[name].mode === 'off');
  if (els.offNote) {
    els.offNote.hidden = off.length === 0;
    if (off.length) {
      const all = off.length === PLATFORMS.filter((n) => view[n]?.built).length;
      const who = all && off.length > 1 ? 'All of them are' : `${listNames(off.map((n) => LABELS[n]))} ${off.length > 1 ? 'are' : 'is'}`;
      els.offNote.textContent = `${who} off. The times below are when shorts would go out if you switched them on.`;
    }
  }

  // Why a column might be empty, said once for however many are.
  const built = PLATFORMS.filter((name) => view[name]?.built);
  const empty = built.filter((name) => !view[name].queued);
  if (els.emptyNote) {
    els.emptyNote.hidden = empty.length === 0;
    els.emptyNote.textContent =
      'A short appears here once it is rendered, scored above the keep line, and not already posted.';
  }

  for (const name of PLATFORMS) {
    const state = view[name];
    if (!state?.built) continue;
    renderPlatform(name, {
      ...state,
      label: { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube' }[name],
      // YouTube resets on a calendar day; the other two count a moving 24h.
      rolling: name !== 'youtube',
    });
  }
  const total = PLATFORMS.reduce((sum, name) => sum + (view[name]?.upcoming?.length || 0), 0);
  // This runs on the main page too, which has its own header and so has no
  // #updated or #refresh of its own. Say it where there is somewhere to say it.
  if (els.updated) {
    els.updated.textContent = total ? `${total} scheduled · updated ${time(new Date().toISOString())}` : 'nothing scheduled';
  }
}

async function poll() {
  try {
    const res = await fetch('/api/uploads');
    if (!res.ok) throw new Error(`uploads returned ${res.status}`);
    render(await res.json());
  } catch (err) {
    if (els.updated) els.updated.textContent = 'offline';
    for (const name of PLATFORMS) {
      els[name].body.innerHTML = `<p class="pending-note is-held">Cannot reach the server: ${escape(err.message)}.
        Is <code>npm start</code> still running?</p>`;
    }
  }
}

els.refresh?.addEventListener('click', () => {
  els.refresh.disabled = true;
  poll().finally(() => {
    els.refresh.disabled = false;
  });
});

// On the main page nobody presses Refresh, so keep it current on its own.
if (!els.refresh) setInterval(poll, 30_000);

poll();
setInterval(poll, POLL_MS);

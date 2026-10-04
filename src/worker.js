import { checkAuth } from './auth.js';
/**
 * STL/Music — Cloudflare Worker v2
 *
 * Bindings (wrangler.toml):
 *   MUSIC_KV   — KV Namespace
 *   ASSETS     — static site assets
 *
 * Secrets (wrangler secret put):
 *   TM_API_KEY    — Ticketmaster Discovery API key
 *   SG_CLIENT_ID  — SeatGeek client ID (free: seatgeek.com/account/develop)
 *   PULSE_SECRET  — shared secret for /api/pulse manual trigger
 *   GMAIL_TOKEN   — optional; OAuth access token for Gmail ingestion layer
 *
 * Cron schedule (wrangler.toml):
 *   "0 10 * * 1"   Monday    10:00 UTC (5 AM CT)  — full weekly reset
 *   "0 14 * * 4"   Thursday  14:00 UTC (9 AM CT)  — mid-week refresh
 *
 * Source priority (highest → lowest confidence):
 *   1. Ticketmaster — geo radius, covers all major ticketed venues
 *   2. SeatGeek     — geo radius, catches venues TM misses
 *   3. Gmail        — parses STL music email digests for anything both APIs miss
 *
 * Dedup logic: events within same title+date are merged, TM record wins on conflict.
 */

// ─── STL Metro center + radius ────────────────────────────────────────────────
const STL_LAT  = '38.6270';
const STL_LNG  = '-90.1994';
const STL_RADIUS_MILES = '40';   // covers Maryland Heights, Chesterfield, O'Fallon, Belleville

// ─── Venue name → venueKey map ────────────────────────────────────────────────
const VENUE_KEYS = {
  'Hollywood Casino Amphitheatre': 'amphitheater',
  'Amphitheatre':   'amphitheater',
  'Helium':         'helium',
  'Delmar Hall':    'delmarhall',
  'Hawthorn':       'hawthorn',
  'Chaifetz':       'chaifetz',
  'Stifel':         'stifel',
  'Fox Theatre':    'fox',
  'The Pageant':    'pageant',
  'Powell Hall':    'sheldon',
  'Scottrade':      'enterprise',
  'Enterprise Center': 'enterprise',
  'Busch Stadium':  'busch',
  'River City Casino': 'rivercity',
  'The Factory':    'factory',
  'Red Flag':       'redflag',
  'Blueberry Hill': 'blueberryhill',
  'Atomic Cowboy':  'atomiccowboy',
  'Off Broadway':   'offbroadway',
  'Old Rock House': 'oldrockhouse',
  'The Firebird':   'firebird',
  'Scottrade Center': 'enterprise',
};

function venueKey(name = '') {
  for (const [fragment, key] of Object.entries(VENUE_KEYS)) {
    if (name.includes(fragment)) return key;
  }
  return 'other';
}

// ─── Genre normalizer ─────────────────────────────────────────────────────────
function normalizeGenre(segment = '', genre = '') {
  if (segment === 'Comedy') return 'Comedy';
  if (segment === 'Classical') return 'Classical / Symphony';
  if (segment === 'Arts & Theatre') return 'Theater';
  if (segment === 'Sports') return null;
  if (segment === 'Music' || segment === 'concert') {
    const g = genre.toLowerCase();
    if (g.includes('hip hop') || g.includes('rap')) return 'Hip-Hop';
    if (g.includes('country') || g.includes('folk') || g.includes('americana')) return 'Country';
    if (g.includes('rock') || g.includes('alternative') || g.includes('punk')) return 'Rock';
    if (g.includes('metal')) return 'Metal';
    if (g.includes('pop')) return 'Pop';
    if (g.includes('r&b') || g.includes('soul')) return 'R&B / Soul';
    if (g.includes('jazz') || g.includes('blues')) return 'Jazz / Blues';
    if (g.includes('indie')) return 'Indie / Alternative';
    if (g.includes('electronic') || g.includes('edm') || g.includes('dance')) return 'Electronic / EDM';
    if (g.includes('classical') || g.includes('symphony') || g.includes('orchestra')) return 'Classical / Symphony';
    return 'Music';
  }
  return segment || 'Event';
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
const isoFmt   = (d) => d.toISOString().slice(0, 19) + 'Z';
const todayPlusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };

// ─── Dedup key ───────────────────────────────────────────────────────────────
// Normalize title for fuzzy matching (ignore case, punctuation, "the")
function dedupKey(title = '', date = '') {
  return (title.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '') + '|' + date);
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 1 — TICKETMASTER
// Uses lat/lon + radius to catch all metro venues including Maryland Heights
// ══════════════════════════════════════════════════════════════════════════════
async function fetchTicketmaster(apiKey) {
  const params = new URLSearchParams({
    apikey:             apiKey,
    latlong:            `${STL_LAT},${STL_LNG}`,
    radius:             STL_RADIUS_MILES,
    unit:               'miles',
    startDateTime:      isoFmt(new Date()),
    endDateTime:        isoFmt(todayPlusDays(7)),
    size:               '200',
    sort:               'date,asc',
    classificationName: 'Music,Comedy,Arts & Theatre',
  });

  const resp = await fetch(
    `https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!resp.ok) {
    console.error(`TM error: ${resp.status}`);
    return [];
  }

  const json = await resp.json();
  const raw  = json?._embedded?.events || [];

  return raw.flatMap(ev => {
    const seg    = ev.classifications?.[0]?.segment?.name || '';
    const genre  = ev.classifications?.[0]?.genre?.name   || '';
    const display = normalizeGenre(seg, genre);
    if (!display) return [];

    const venue  = ev._embedded?.venues?.[0];
    const vName  = venue?.name || 'TBD';
    const addr   = venue
      ? [venue.address?.line1, venue.city?.name, venue.state?.stateCode].filter(Boolean).join(', ')
      : '';
    const date   = ev.dates?.start?.localDate || '';
    const time   = ev.dates?.start?.localTime?.slice(0, 5) || '19:00';
    const price  = ev.priceRanges?.[0]?.min;

    return [{
      id:        `tm-${ev.id}`,
      source:    'ticketmaster',
      venueKey:  venueKey(vName),
      genre:     display,
      title:     ev.name,
      date,
      time,
      venue:     vName,
      address:   addr,
      headliner: false,
      ticketUrl: ev.url || null,
      story:     price ? `Tickets from $${Math.round(price)}.` : null,
    }];
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 2 — SEATGEEK
// Catches venues and shows not on Ticketmaster (independent clubs, etc.)
// Free client_id from seatgeek.com/account/develop
// ══════════════════════════════════════════════════════════════════════════════
async function fetchSeatGeek(clientId) {
  const now  = new Date();
  const end  = todayPlusDays(7);

  // SeatGeek uses YYYY-MM-DDTHH:MM:SS format (no Z)
  const sgFmt = (d) => d.toISOString().slice(0, 19);

  const params = new URLSearchParams({
    client_id:              clientId,
    lat:                    STL_LAT,
    lon:                    STL_LNG,
    range:                  `${STL_RADIUS_MILES}mi`,
    'datetime_local.gte':   sgFmt(now),
    'datetime_local.lte':   sgFmt(end),
    per_page:               '200',
    sort:                   'datetime_local.asc',
    // taxonomies: concert=2000000, comedy=1000000 (SeatGeek taxonomy IDs)
    'taxonomies.id':        '2000000',  // concerts only; comedy queried separately
  });

  const [concertResp, comedyResp] = await Promise.all([
    fetch(`https://api.seatgeek.com/2/events?${params}`, { headers: { Accept: 'application/json' } }),
    fetch(`https://api.seatgeek.com/2/events?${new URLSearchParams({ ...Object.fromEntries(params), 'taxonomies.id': '1000000' })}`,
      { headers: { Accept: 'application/json' } }),
  ]);

  const concerts = concertResp.ok ? (await concertResp.json()).events || [] : [];
  const comedy   = comedyResp.ok  ? (await comedyResp.json()).events  || [] : [];
  const raw      = [...concerts, ...comedy];

  return raw.flatMap(ev => {
    const taxName  = ev.type || '';
    const genre    = ev.performers?.[0]?.genres?.[0]?.name || taxName;
    const display  = normalizeGenre(taxName === 'concert' ? 'Music' : 'Comedy', genre);
    if (!display) return [];

    const venue    = ev.venue || {};
    const vName    = venue.name || 'TBD';
    const addr     = [venue.address, venue.city, venue.state].filter(Boolean).join(', ');

    // SeatGeek datetime_local is "2026-07-09T19:00:00"
    const dtLocal  = ev.datetime_local || '';
    const date     = dtLocal.slice(0, 10);
    const time     = dtLocal.slice(11, 16) || '19:00';
    const price    = ev.stats?.lowest_price;

    return [{
      id:        `sg-${ev.id}`,
      source:    'seatgeek',
      venueKey:  venueKey(vName),
      genre:     display,
      title:     ev.title,
      date,
      time,
      venue:     vName,
      address:   addr,
      headliner: false,
      ticketUrl: ev.url || null,
      story:     price ? `Tickets from $${Math.round(price)}.` : null,
    }];
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// SOURCE 3 — GMAIL DIGEST PARSER
// Reads STL-focused music newsletters from Gmail and extracts event mentions.
// Requires GMAIL_TOKEN secret (OAuth2 access token with gmail.readonly scope).
// This is a best-effort layer — failures are silent and don't block the pulse.
// ══════════════════════════════════════════════════════════════════════════════

// Known STL music email senders to scan
const GMAIL_SENDERS = [
  'from:stlmag.com',
  'from:riverfronttimes.com',
  'from:ticketmaster.com',
  'from:hollywoodcasinoamphitheatre.com',
  'from:livenation.com',
  'from:stifeltheatre.com',
  'from:thefactorystl.com',
];

// ── Gmail OAuth token refresh ──────────────────────────────────────────────
// Access tokens expire in ~60 minutes, but the cron only fires twice a week,
// so a static token is useless past its first hour. We mint a fresh access
// token from the long-lived refresh token at the start of every pulse instead.
//
// One-time setup (see deploy notes):
//   wrangler secret put GMAIL_CLIENT_ID
//   wrangler secret put GMAIL_CLIENT_SECRET
//   wrangler secret put GMAIL_REFRESH_TOKEN
async function getGmailAccessToken(env) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    return null; // Gmail layer not configured — skip silently
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });

  if (!resp.ok) {
    console.error(`Gmail token refresh failed: ${resp.status}`);
    return null;
  }

  const json = await resp.json();
  return json.access_token || null; // valid for ~60 min, used immediately below
}

async function fetchGmailEvents(env) {
  const gmailToken = await getGmailAccessToken(env);
  if (!gmailToken) return [];

  if (!env.ANTHROPIC_API_KEY) {
    console.error('Gmail layer skipped: missing ANTHROPIC_API_KEY secret');
    return [];
  }

  try {
    // Search last 24h of email from known STL music senders (pulse cadence
    // is twice weekly, so a rolling 1-day window per run avoids re-parsing
    // the same digest repeatedly — widen if pulses are ever less frequent).
    const since    = new Date(); since.setDate(since.getDate() - 1);
    const epochSec = Math.floor(since.getTime() / 1000);
    const query    = `(${GMAIL_SENDERS.join(' OR ')}) after:${epochSec}`;

    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`,
      { headers: { Authorization: `Bearer ${gmailToken}`, Accept: 'application/json' } }
    );
    if (!listResp.ok) {
      console.error(`Gmail list failed: ${listResp.status}`);
      return [];
    }

    const listJson  = await listResp.json();
    const messages  = listJson.messages || [];

    // Fetch each message body (snippet is enough for event extraction)
    const snippets = await Promise.all(messages.slice(0, 10).map(async (msg) => {
      const msgResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${gmailToken}`, Accept: 'application/json' } }
      );
      if (!msgResp.ok) return null;
      const msgJson = await msgResp.json();
      return msgJson.snippet || '';
    }));

    // Parse event mentions from snippets using Claude API
    const content = snippets.filter(Boolean).join('\n\n---\n\n');
    if (!content.trim()) return [];

    const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key':          env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role:    'user',
          content: `Extract upcoming St. Louis concert/show events from these email snippets.
Return ONLY a JSON array of objects with keys: title, date (YYYY-MM-DD), time (HH:MM 24h), venue, genre.
Only include events in the next 7 days from today (${new Date().toISOString().slice(0,10)}).
If nothing clear, return [].

EMAIL SNIPPETS:
${content}`,
        }],
      }),
    });

    if (!aiResp.ok) {
      console.error(`Anthropic API error: ${aiResp.status}`);
      return [];
    }
    const aiJson = await aiResp.json();
    const text   = aiJson.content?.[0]?.text || '[]';

    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()); }
    catch { return []; }

    return (Array.isArray(parsed) ? parsed : []).map((ev, i) => ({
      id:        `gmail-${Date.now()}-${i}`,
      source:    'gmail',
      venueKey:  venueKey(ev.venue || ''),
      genre:     ev.genre || 'Music',
      title:     ev.title || '',
      date:      ev.date  || '',
      time:      ev.time  || '19:00',
      venue:     ev.venue || '',
      address:   '',
      headliner: false,
      ticketUrl: null,
      story:     null,
    })).filter(ev => ev.title && ev.date);

  } catch (err) {
    console.error('Gmail layer error:', err.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ON-SALE-SOON  (TM only, 8–60 days out)
// ══════════════════════════════════════════════════════════════════════════════
async function fetchOnSaleSoon(apiKey) {
  const params = new URLSearchParams({
    apikey:             apiKey,
    latlong:            `${STL_LAT},${STL_LNG}`,
    radius:             STL_RADIUS_MILES,
    unit:               'miles',
    startDateTime:      isoFmt(todayPlusDays(8)),
    endDateTime:        isoFmt(todayPlusDays(60)),
    size:               '20',
    sort:               'date,asc',
    classificationName: 'Music,Comedy',
  });

  const resp = await fetch(
    `https://app.ticketmaster.com/discovery/v2/events.json?${params}`,
    { headers: { Accept: 'application/json' } }
  );
  if (!resp.ok) return [];

  const json = await resp.json();
  return (json?._embedded?.events || []).slice(0, 10).map(ev => {
    const dateStr = ev.dates?.start?.localDate || '';
    const d       = dateStr ? new Date(dateStr + 'T00:00:00') : null;
    return {
      artist: ev.name,
      venue:  ev._embedded?.venues?.[0]?.name || 'TBD',
      onsale: d
        ? `On sale now · ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
        : 'Watch for announcement',
    };
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MERGE + DEDUP
// TM wins on conflict; SeatGeek fills gaps; Gmail adds anything both missed.
// ══════════════════════════════════════════════════════════════════════════════
function mergeAndDedup(tmEvents, sgEvents, gmailEvents) {
  const seen   = new Map();  // dedupKey → event (TM wins)
  const result = [];

  for (const ev of [...tmEvents, ...sgEvents, ...gmailEvents]) {
    if (!ev.title || !ev.date) continue;
    const key = dedupKey(ev.title, ev.date);
    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(ev);
    }
    // If already seen (from higher-priority source), skip
  }

  return result.sort((a, b) => {
    const dt = (e) => `${e.date}T${e.time}`;
    return dt(a).localeCompare(dt(b));
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN PULSE
// ══════════════════════════════════════════════════════════════════════════════
async function runPulse(env) {
  if (!env.TM_API_KEY) throw new Error('Missing TM_API_KEY secret');

  const [tmEvents, sgEvents, gmailEvents, onSaleSoon] = await Promise.all([
    fetchTicketmaster(env.TM_API_KEY),
    env.SG_CLIENT_ID ? fetchSeatGeek(env.SG_CLIENT_ID) : Promise.resolve([]),
    fetchGmailEvents(env), // handles its own "not configured" no-op internally
    fetchOnSaleSoon(env.TM_API_KEY),
  ]);

  const events = mergeAndDedup(tmEvents, sgEvents, gmailEvents);

  const payload = {
    pulsedAt: new Date().toISOString(),
    sources: {
      ticketmaster: tmEvents.length,
      seatgeek:     sgEvents.length,
      gmail:        gmailEvents.length,
      merged:       events.length,
    },
    events,
    onSaleSoon,
  };

  await env.MUSIC_KV.put('events', JSON.stringify(payload));
  return payload;
}

// ══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === '/api/events') {
      const data = await env.MUSIC_KV.get('events', 'json');
      return Response.json(data || { events: [], onSaleSoon: [] });
    }

    if (url.pathname === '/api/pulse') {
      const unauthorized = await checkAuth(req, env.PULSE_SECRET);
      if (unauthorized) {
        unauthorized.headers.set('Cache-Control', 'no-store');
        return unauthorized;
      }
      try {
        const payload = await runPulse(env);
        return Response.json(
          { ok: true, pulsedAt: payload.pulsedAt, sources: payload.sources },
          { headers: { 'Cache-Control': 'no-store' } }
        );
      } catch (err) {
        return Response.json(
          { ok: false, error: err.message },
          { status: 500, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPulse(env));
  },
};

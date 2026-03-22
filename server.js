require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodeFetch = require('node-fetch');
const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
// Use native fetch (undici) for SportyBet — node-fetch gets 403'd by Cloudflare
const nativeFetch = globalThis.fetch;

// ─── AI providers (mutable — can be updated at runtime via /api/ai-keys) ──
const aiProviders = {};
let availableProviders = [];

function initProvider(name, key) {
  if (!key) return false;
  if (name === 'openai') aiProviders.openai = new OpenAI({ apiKey: key });
  else if (name === 'gemini') aiProviders.gemini = new GoogleGenerativeAI(key);
  else if (name === 'grok') aiProviders.grok = new OpenAI({ apiKey: key, baseURL: 'https://api.x.ai/v1' });
  else return false;
  return true;
}

function refreshProviderList() {
  availableProviders = Object.keys(aiProviders);
}

// Init from .env on startup
if (process.env.OPENAI_API_KEY) { initProvider('openai', process.env.OPENAI_API_KEY); console.log('[AI] OpenAI (GPT-4o-mini) enabled via .env'); }
if (process.env.GEMINI_API_KEY) { initProvider('gemini', process.env.GEMINI_API_KEY); console.log('[AI] Google Gemini enabled via .env'); }
if (process.env.GROK_API_KEY) { initProvider('grok', process.env.GROK_API_KEY); console.log('[AI] Grok (xAI) enabled via .env'); }
refreshProviderList();
if (availableProviders.length > 0) console.log(`[AI] Available providers: ${availableProviders.join(', ')}`);
else console.log('[AI] No AI keys configured — AI fallback disabled, static mapping only');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// ─── Public API CORS (no auth required) ──────────────────────────
const publicOrigins = (process.env.PUBLIC_ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
app.use('/api/public', cors({
  origin: publicOrigins.includes('*') ? '*' : publicOrigins,
  methods: ['POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// ─── Auth middleware ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.path.startsWith('/public/')) return next();
  const key = req.headers['x-api-key'];
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/api', requireAuth);

// ─── Constants ───────────────────────────────────────────────────
const IZENTBET_BASE = process.env.IZENTBET_BASE_URL;
const IZENTBET_KEY = process.env.IZENTBET_API_KEY;
const SPORTYBET_COUNTRY = process.env.SPORTYBET_COUNTRY || 'ng';

const SPORTYBET_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.sportybet.com/ng/',
  'Origin': 'https://www.sportybet.com',
  'clientid': 'web',
  'operid': '2',
  'platform': 'web',
  'Connection': 'keep-alive',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sportyFetch(url, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) {
      const delay = 1000 * i + Math.random() * 500;
      console.log(`[SPORTYBET] Retry ${i}/${retries} after ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
    try {
      const res = await nativeFetch(url, options);
      if (res.status === 403 && i < retries - 1) {
        console.log(`[SPORTYBET] Got 403, will retry...`);
        continue;
      }
      return res;
    } catch (err) {
      console.log(`[SPORTYBET] Fetch error: ${err.message}`);
      if (i === retries - 1) throw err;
    }
  }
}

const OUTCOME_MAP = { home: '1', draw: '2', away: '3' };
const REVERSED_OUTCOME_MAP = { home: '3', draw: '2', away: '1' };
const TIME_TOLERANCE = 3 * 60 * 60 * 1000; // 3 hours in ms

// ─── Bet9ja Constants ────────────────────────────────────────────
const BET9JA_SEARCH_URL = 'https://apigw.bet9ja.com/sportsbook/search/SearchV2?source=desktop&v_cache_version=1.307.1.229';
const BET9JA_BOOK_URL = 'https://coupon.bet9ja.com/mobile/feapi/PlacebetAjax/BookABetV2';
const BET9JA_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://sports.bet9ja.com/',
  'Origin': 'https://sports.bet9ja.com',
  'Connection': 'keep-alive',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};
const BET9JA_TIME_TOLERANCE = 6 * 60 * 60 * 1000; // 6 hours in ms

function mapToSportyBet(market, selection, homeTeam, awayTeam, teamsReversed = false) {
  const sel = (selection || '').toLowerCase().trim();
  const mkt = (market || '').toLowerCase().trim();
  // When teams are reversed, swap IzentBet home/away so side() resolves correctly
  const home = teamsReversed ? (awayTeam || '').toLowerCase().trim() : (homeTeam || '').toLowerCase().trim();
  const away = teamsReversed ? (homeTeam || '').toLowerCase().trim() : (awayTeam || '').toLowerCase().trim();

  // Helper: is team name the home side or away side?
  function side(name) {
    const t = name.toLowerCase().trim();
    if (away && (away.includes(t) || t.includes(away))) return 'away';
    if (home && (home.includes(t) || t.includes(home))) return 'home';
    return 'home';
  }

  // ─── Combo: Over/Under & BTTS ───
  // SportyBet has no O/U & BTTS combo market → fall back to Over/Under (market 18)
  const ouBtts = sel.match(/^(over|under)\s+([\d.]+)\s*&\s*btts\s*(yes|no)$/);
  if (ouBtts) {
    return { marketId: '18', specifier: `total=${ouBtts[2]}`, outcomeId: ouBtts[1] === 'over' ? '12' : '13' };
  }

  // ─── Combo: Team Win & BTTS  (market 35 = 1X2 & GG/NG) ───
  const winBtts = sel.match(/^(.+?)\s+win\s*&\s*btts\s*(yes|no)$/);
  if (winBtts) {
    const s = side(winBtts[1]);
    const ids = { 'home-yes': '78', 'home-no': '80', 'away-yes': '86', 'away-no': '88' };
    return { marketId: '35', specifier: null, outcomeId: ids[`${s}-${winBtts[2]}`] };
  }

  // ─── Combo: Draw & BTTS  (market 35) ───
  const drawBtts = sel.match(/^draw\s*&\s*btts\s*(yes|no)$/);
  if (drawBtts) {
    return { marketId: '35', specifier: null, outcomeId: drawBtts[1] === 'yes' ? '82' : '84' };
  }

  // ─── Combo: Team Win & Over/Under  (market 37 = 1X2 & Over/Under) ───
  const winOu = sel.match(/^(.+?)\s+win\s*&\s*(over|under)\s+([\d.]+)$/);
  if (winOu) {
    const s = side(winOu[1]);
    const ids = { 'home-over': '796', 'home-under': '794', 'away-over': '804', 'away-under': '802' };
    return { marketId: '37', specifier: `total=${winOu[3]}`, outcomeId: ids[`${s}-${winOu[2]}`] };
  }

  // ─── Combo: Draw & Over/Under  (market 37) ───
  const drawOu = sel.match(/^draw\s*&\s*(over|under)\s+([\d.]+)$/);
  if (drawOu) {
    return { marketId: '37', specifier: `total=${drawOu[2]}`, outcomeId: drawOu[1] === 'over' ? '800' : '798' };
  }

  // ─── BTTS (Both Teams To Score)  (market 29) ───
  if (/^btts\s*(yes|no)$/.test(sel)) {
    return { marketId: '29', specifier: null, outcomeId: sel.includes('yes') ? '74' : '76' };
  }

  // ─── Over/Under  (market 18) ───
  if (mkt === 'totals' || mkt.startsWith('over/under')) {
    const overMatch = sel.match(/^over\s+([\d.]+)$/);
    const underMatch = sel.match(/^under\s+([\d.]+)$/);
    if (overMatch) return { marketId: '18', specifier: `total=${overMatch[1]}`, outcomeId: '12' };
    if (underMatch) return { marketId: '18', specifier: `total=${underMatch[1]}`, outcomeId: '13' };
    const lineMatch = mkt.match(/([\d.]+)/);
    if (lineMatch) {
      return { marketId: '18', specifier: `total=${lineMatch[1]}`, outcomeId: sel.includes('over') ? '12' : '13' };
    }
  }
  // Selection-only Over/Under (no market field)
  const overOnly = sel.match(/^over\s+([\d.]+)$/);
  if (overOnly) return { marketId: '18', specifier: `total=${overOnly[1]}`, outcomeId: '12' };
  const underOnly = sel.match(/^under\s+([\d.]+)$/);
  if (underOnly) return { marketId: '18', specifier: `total=${underOnly[1]}`, outcomeId: '13' };

  // ─── 1X2 outcome resolver — handles ALL IzentBet selection formats ───
  function resolveOutcome(s) {
    // Numeric win: "1 win" = home, "2 win" = away
    if (/^1\s*win$/i.test(s)) return teamsReversed ? '3' : '1';
    if (/^2\s*win$/i.test(s)) return teamsReversed ? '1' : '3';

    // Team-name win: "Barcelona win" etc.
    const teamWin = s.match(/^(.+?)\s+win$/);
    if (teamWin) return side(teamWin[1]) === 'home' ? '1' : '3';

    // Draw variations
    if (s === 'draw' || s === 'x' || s === 'tie') return '2';

    // Home variations
    if (s === 'home' || s === '1' || s === 'home win') return teamsReversed ? '3' : '1';

    // Away variations
    if (s === 'away' || s === '2' || s === 'away win') return teamsReversed ? '1' : '3';

    console.log('[WARN] Unknown selection format:', s);
    return null;
  }

  const outcomeId = resolveOutcome(sel);
  if (outcomeId) {
    return { marketId: '1', specifier: null, outcomeId };
  }

  // ─── Unrecognised — mark uncertain for AI fallback ───
  return { marketId: '1', specifier: null, outcomeId: '1', _uncertain: true };
}

// ─── Bet9ja Selection Mapper ─────────────────────────────────────

function mapToBet9ja(market, selection, teamsReversed = false) {
  const sel = (selection || '').toLowerCase().trim();

  // Over/Under
  const overMatch = sel.match(/over\s*([\d.]+)/i);
  const underMatch = sel.match(/under\s*([\d.]+)/i);
  if (overMatch) return `S_OU@${overMatch[1]}_O`;
  if (underMatch) return `S_OU@${underMatch[1]}_U`;

  // Both Teams Score
  if (market === 'btts') {
    if (sel === 'yes') return 'S_GGNG_Y';
    if (sel === 'no')  return 'S_GGNG_N';
  }

  // Double Chance
  if (market === 'double_chance') {
    if (sel === '1x') return 'S_DC_1X';
    if (sel === 'x2') return 'S_DC_X2';
    if (sel === '12') return 'S_DC_12';
  }

  // 1X2 — handle all formats + team reversal
  const isHome = /^1\s*win$/.test(sel) || sel === 'home' ||
                 sel === '1' || sel === 'home win';
  const isAway = /^2\s*win$/.test(sel) || sel === 'away' ||
                 sel === '2' || sel === 'away win';
  const isDraw = sel === 'draw' || sel === 'x' ||
                 sel === 'tie' || /^x\s*win$/.test(sel);

  if (isDraw) return 'S_1X2_X';
  if (isHome) return teamsReversed ? 'S_1X2_2' : 'S_1X2_1';
  if (isAway) return teamsReversed ? 'S_1X2_1' : 'S_1X2_2';

  console.log('[WARN] Unknown selection for Bet9ja:', sel);
  return 'S_1X2_1';
}

// ─── Market Label Normaliser ─────────────────────────────────────
function normaliseMarketLabel(market) {
  const m = (market || '').toLowerCase().trim();
  if (m === 'h2h' || m === '1x2' || m === 'moneyline') return '1X2';
  if (m === 'totals' || m.startsWith('over/under') || m.startsWith('over_under')) return 'Over/Under';
  if (m === 'btts' || m === 'both_teams_to_score') return 'BTTS';
  if (m === 'double_chance') return 'Double Chance';
  if (m === 'draw_no_bet') return 'Draw No Bet';
  return market || 'Unknown';
}

// ─── Bet9ja Search & Book Helpers ────────────────────────────────

async function searchBet9ja(keyword) {
  const body = new URLSearchParams({
    TERM: keyword,
    START: '0',
    ROWS: '100000',
    ISCOMPETITION: '0',
    ISEVENT: '1',
    ISTEAM: '0',
    GROUPBYFIELD: 'sp_id',
    GROUPBYLIMIT: '11'
  });
  console.log(`[BET9JA] Searching: "${keyword}"`);
  try {
    const res = await nativeFetch(BET9JA_SEARCH_URL, {
      method: 'POST',
      headers: { ...BET9JA_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    if (!res.ok) {
      console.log(`[BET9JA] Search returned ${res.status}`);
      return [];
    }
    const json = await res.json();
    if (json.R !== 'OK' || !json.D || !json.D.S) return [];

    const events = [];
    for (const sport of Object.values(json.D.S)) {
      if (Array.isArray(sport.E)) events.push(...sport.E);
    }
    // Only football (SID === 1)
    return events.filter(e => e.SID === 1);
  } catch (err) {
    console.log(`[BET9JA] Search error: ${err.message}`);
    return [];
  }
}

function findBet9jaMatch(events, keyword, commenceTime, awayKeyword) {
  const kw = keyword.toLowerCase();
  const akw = (awayKeyword || '').toLowerCase();
  const targetTime = new Date(commenceTime).getTime();
  const hasTime = !isNaN(targetTime);

  let bestMatch = null;
  let bestScore = 0;

  for (const ev of events) {
    const ds = (ev.DS || ev.GN || '').toLowerCase();
    // Reject Zoom / SRL events unless keyword contains those words
    if (/zoom|srl/i.test(ds) && !/zoom|srl/i.test(kw)) continue;

    if (!ds.includes(kw)) continue;

    let score = 0;
    // Name match quality
    const parts = ds.split(' - ');
    const home = (parts[0] || '').trim();
    const away = (parts[1] || '').trim();
    if (home === kw || away === kw) score += 10;
    else score += 1;
    if (akw && (home.includes(akw) || away.includes(akw))) score += 5;

    // Time match
    if (hasTime) {
      const evTime = new Date(ev.STARTDATE).getTime();
      const diff = Math.abs(evTime - targetTime);
      if (diff < BET9JA_TIME_TOLERANCE) score += 20;
      else continue; // skip if time doesn't match at all
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = ev;
    }
  }

  return bestMatch;
}

async function searchBet9jaWithFallbacks(homeTeam, awayTeam, commenceTime) {
  const attempts = [
    { keyword: homeTeam, label: 'home_team_full' },
    { keyword: awayTeam, label: 'away_team_full' }
  ];

  // Add word-level fallbacks
  const homeWords = homeTeam.split(/\s+/);
  if (homeWords.length > 1) {
    for (const word of homeWords) {
      if (word.length >= 2) attempts.push({ keyword: word, label: 'home_team_word' });
    }
  }
  const awayWords = awayTeam.split(/\s+/);
  if (awayWords.length > 1) {
    for (const word of awayWords) {
      if (word.length >= 2) attempts.push({ keyword: word, label: 'away_team_word' });
    }
  }

  for (const attempt of attempts) {
    const events = await searchBet9ja(attempt.keyword);
    if (events.length === 0) {
      await sleep(300);
      continue;
    }

    const awayKw = attempt.keyword === homeTeam ? awayTeam : homeTeam;
    const match = findBet9jaMatch(events, attempt.keyword, commenceTime, awayKw);
    if (match) {
      const ds = match.DS || match.GN || '';
      console.log(`[BET9JA] Matched: ${ds} → ID ${match.ID}`);

      // Detect team reversal
      const parts = ds.split(' - ');
      const bet9jaHome = (parts[0] || '').toLowerCase().trim();
      const izentHomeWord = homeTeam.toLowerCase().split(/\s+/)[0];
      const teamsReversed = izentHomeWord.length >= 2 &&
        !bet9jaHome.includes(izentHomeWord) &&
        (parts[1] || '').toLowerCase().trim().includes(izentHomeWord);

      if (teamsReversed) {
        console.log(`[BET9JA] Teams reversed! IzentBet home "${homeTeam}" is Bet9ja away`);
      }

      return {
        found: true,
        eventId: match.ID,
        eventName: ds,
        startDate: match.STARTDATE,
        groupName: match.GN || '',
        superGroup: match.SG || '',
        odds: match.O || {},
        matchedBy: attempt.label,
        timeMatched: true,
        teamsReversed
      };
    }
    await sleep(300);
  }

  return { found: false, keyword: homeTeam };
}

async function createBet9jaCode(selections) {
  const oddsObj = {};
  const evsObj = {};
  for (const sel of selections) {
    const key = `${sel.eventId}$${sel.marketKey}`;
    oddsObj[key] = sel.odds;
    evsObj[key] = {
      id: key,
      eventId: String(sel.eventId),
      eventCode: '',
      eventName: (sel.eventName || '').replace(' - ', ' v '),
      market: sel.marketKey.replace(/^S_/, '').replace(/_.*$/, ''),
      sid: sel.marketKey,
      sign: sel.marketKey.split('_').pop(),
      GN: sel.groupName || '',
      leagueName: sel.groupName || '',
      SG: sel.superGroup || '',
      startdate: (sel.startDate || '').replace(/-/g, '/'),
      oddValue: sel.odds,
      hnd: ''
    };
  }

  const betslip = {
    BETS: [{
      BSTYPE: 0,
      TAB: 0,
      NUMLINES: selections.length,
      COMB: 1,
      TYPE: selections.length,
      STAKE: 100,
      POTWINMIN: 0,
      POTWINMAX: 0,
      BONUSMIN: 0,
      BONUSMAX: 0,
      ODDMIN: 0,
      ODDMAX: 0,
      ODDS: oddsObj,
      FIXED: {}
    }],
    EVS: evsObj,
    IMPERSONIZE: 0
  };

  const formBody = 'BETSLIP=' + encodeURIComponent(JSON.stringify(betslip)) + '&IS_PASSBET=0';

  console.log(`[BET9JA] Creating booking code with ${selections.length} selection(s)`);
  console.log(`[BET9JA] BookABetV2 payload: ${JSON.stringify(betslip).substring(0, 500)}`);

  const res = await nativeFetch(BET9JA_BOOK_URL, {
    method: 'POST',
    headers: { ...BET9JA_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody
  });

  const text = await res.text();
  console.log(`[BET9JA] BookABetV2 response: status=${res.status} body=${text.substring(0, 500)}`);

  if (!res.ok) {
    throw new Error(`Bet9ja BookABetV2 returned ${res.status}: ${text}`);
  }

  const json = JSON.parse(text);
  if (json.R !== 'OK' || !json.D || !json.D[0]) {
    throw new Error(`Bet9ja BookABetV2 error: ${JSON.stringify(json)}`);
  }

  return json;
}

// ─── AI Market Resolver ──────────────────────────────────────────

async function fetchSportyBetEventMarkets(eventId) {
  const url = `https://www.sportybet.com/api/${SPORTYBET_COUNTRY}/factsCenter/event?eventId=${encodeURIComponent(eventId)}&_t=${Date.now()}`;
  console.log(`[AI] Fetching markets for event ${eventId}`);
  const res = await sportyFetch(url, { headers: SPORTYBET_HEADERS });
  if (!res || !res.ok) return [];
  const json = await res.json();
  if (json.bizCode !== 10000 || !json.data || !json.data.markets) return [];
  return json.data.markets;
}

function summariseMarkets(markets) {
  return markets.map(m => {
    const outcomes = (m.outcomes || []).map(o => `outcomeId=${o.id} "${o.desc}" (odds ${o.odds})`);
    return `marketId=${m.id} "${m.desc}" specifier="${m.specifier || ''}" outcomes=[${outcomes.join('; ')}]`;
  }).join('\n');
}

function buildPrompt(izentSelection, izentMarket, marketSummary, homeTeam, awayTeam) {
  return `You are a sports betting market mapper. A user placed a bet on IzentBet and we need to find the EXACT matching market and outcome on SportyBet.

Match: ${homeTeam} vs ${awayTeam}
IzentBet selection: "${izentSelection}"
IzentBet market field: "${izentMarket || '(not provided)'}"

Available SportyBet markets and outcomes:
${marketSummary}

Rules:
- BTTS = Both Teams To Score = GG/NG on SportyBet
- "Over X.X" = Over/Under market with the matching total line
- "Team Win" = 1X2 market, pick the right side (home=1, draw=2, away=3)
- Combo markets like "Team Win & BTTS" = look for "1X2 & GG/NG" market
- Combo markets like "Team Win & Over X.X" = look for "1X2 & Over/Under" market
- If the exact combo market doesn't exist, pick the CLOSEST single market

Return ONLY a JSON object (no markdown, no explanation):
{"marketId": "...", "specifier": "..." or null, "outcomeId": "..."}`;
}

function parseAiJson(text) {
  const jsonStr = text.replace(/^```json\s*/, '').replace(/```$/, '').trim();
  const result = JSON.parse(jsonStr);
  if (result.marketId && result.outcomeId) {
    return {
      marketId: String(result.marketId),
      specifier: result.specifier || null,
      outcomeId: String(result.outcomeId)
    };
  }
  return null;
}

async function aiCallOpenAI(client, model, prompt) {
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: 100
  });
  return (completion.choices[0].message.content || '').trim();
}

async function aiCallGemini(client, prompt) {
  const model = client.getGenerativeModel({ model: 'gemini-2.5-flash-preview-05-20' });
  const result = await model.generateContent(prompt);
  return (result.response.text() || '').trim();
}

async function aiResolveMarket(izentSelection, izentMarket, sportyMarkets, homeTeam, awayTeam, provider) {
  // Pick provider: requested → first available → none
  const providerKey = (provider && aiProviders[provider]) ? provider : availableProviders[0];
  if (!providerKey) return null;

  const marketSummary = summariseMarkets(sportyMarkets);
  const prompt = buildPrompt(izentSelection, izentMarket, marketSummary, homeTeam, awayTeam);

  console.log(`[AI:${providerKey}] Resolving: "${izentSelection}" for ${homeTeam} vs ${awayTeam}`);

  try {
    let text;
    if (providerKey === 'gemini') {
      text = await aiCallGemini(aiProviders.gemini, prompt);
    } else if (providerKey === 'grok') {
      text = await aiCallOpenAI(aiProviders.grok, 'grok-3-mini-fast', prompt);
    } else {
      text = await aiCallOpenAI(aiProviders.openai, 'gpt-4o-mini', prompt);
    }

    console.log(`[AI:${providerKey}] Response: ${text}`);
    const resolved = parseAiJson(text);
    if (resolved) {
      console.log(`[AI:${providerKey}] Resolved: marketId=${resolved.marketId} specifier=${resolved.specifier} outcomeId=${resolved.outcomeId}`);
    }
    return resolved;
  } catch (err) {
    console.error(`[AI:${providerKey}] Error: ${err.message}`);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

async function fetchIzentBet(code) {
  const url = `${IZENTBET_BASE}/betslip/code/${encodeURIComponent(code)}`;
  console.log(`[IZENTBET] Fetching code ${code}`);
  const res = await nodeFetch(url, {
    headers: { 'x-api-key': IZENTBET_KEY }
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`IzentBet API returned ${res.status}: ${text}`), { statusCode: res.status });
  }
  const json = await res.json();
  if (!json.success) {
    throw Object.assign(new Error(json.error || 'IzentBet returned success=false'), { statusCode: 422 });
  }
  if (!json.data || !Array.isArray(json.data.selections) || json.data.selections.length === 0) {
    throw Object.assign(new Error('No selections found in booking code'), { statusCode: 422 });
  }
  if (new Date(json.data.expires_at) <= new Date()) {
    throw Object.assign(new Error('This IzentBet booking code has expired'), { statusCode: 410 });
  }
  console.log(`[IZENTBET] Fetched code ${code} — ${json.data.selections.length} selections`);
  return json.data;
}

async function searchSportyBet(keyword) {
  const params = new URLSearchParams({
    keyword,
    offset: '0',
    pageSize: '20',
    withOneUpMarket: 'true',
    withTwoUpMarket: 'true',
    _t: String(Date.now())
  });
  const url = `https://www.sportybet.com/api/${SPORTYBET_COUNTRY}/factsCenter/event/firstSearch?${params}`;
  console.log(`[SPORTYBET] Searching: "${keyword}"`);
  const res = await sportyFetch(url, { headers: SPORTYBET_HEADERS });
  if (!res || !res.ok) {
    console.log(`[SPORTYBET] Search returned ${res ? res.status : 'no response'}`);
    return [];
  }
  const json = await res.json();
  if (json.bizCode !== 10000 || !json.data) return [];

  const events = [];
  if (Array.isArray(json.data.live)) events.push(...json.data.live);
  if (Array.isArray(json.data.upcoming)) events.push(...json.data.upcoming);
  // Collect from any other arrays in data
  for (const key of Object.keys(json.data)) {
    if (Array.isArray(json.data[key]) && key !== 'live' && key !== 'upcoming') {
      events.push(...json.data[key]);
    }
  }
  return events;
}

function findMatchingEvent(events, keyword, commenceTime, awayKeyword) {
  const kw = keyword.toLowerCase();
  const akw = (awayKeyword || '').toLowerCase();
  const targetTime = new Date(commenceTime).getTime();
  const hasTime = !isNaN(targetTime);

  // Partition: real events first, BAZ/SRL/virtual as fallback
  const isLimited = (ev) => {
    const id = ev.eventId || '';
    const home = ev.homeTeamName || '';
    const away = ev.awayTeamName || '';
    return /\bSRL\b/i.test(home) || /\bSRL\b/i.test(away) || id.includes(':BAZ');
  };
  const realEvents = events.filter(ev => !isLimited(ev));
  const fallbackEvents = events.filter(ev => isLimited(ev));
  const ordered = [...realEvents, ...fallbackEvents];

  // Score each event: higher = better match
  function score(ev) {
    const home = (ev.homeTeamName || '').toLowerCase();
    const away = (ev.awayTeamName || '').toLowerCase();
    let s = 0;
    // Exact match on team names
    if (home === kw || away === kw) s += 10;
    else if (home.includes(kw) || away.includes(kw)) s += 1;
    // Bonus for matching away team too
    if (akw && (home.includes(akw) || away.includes(akw))) s += 5;
    if (akw && (home === akw || away === akw)) s += 10;
    // Penalize if team name is much longer (e.g. "Real Madrid B" vs "Real Madrid")
    const matchedName = home.includes(kw) ? home : away;
    if (matchedName.length - kw.length <= 2) s += 3;
    // Time match bonus
    if (hasTime) {
      const timeDiff = Math.abs(ev.estimateStartTime - targetTime);
      if (timeDiff < TIME_TOLERANCE) s += 20;
    }
    return s;
  }

  let bestMatch = null;
  let bestScore = 0;

  for (const ev of ordered) {
    const home = (ev.homeTeamName || '').toLowerCase();
    const away = (ev.awayTeamName || '').toLowerCase();
    if (!home.includes(kw) && !away.includes(kw)) continue;

    const s = score(ev);
    if (s > bestScore) {
      bestScore = s;
      bestMatch = ev;
    }
  }

  if (bestMatch) {
    const timeMatched = hasTime && Math.abs(bestMatch.estimateStartTime - targetTime) < TIME_TOLERANCE;
    return { event: bestMatch, timeMatched };
  }
  return null;
}

async function searchWithFallbacks(homeTeam, awayTeam, commenceTime) {
  const attempts = [
    { keyword: homeTeam, label: 'home_team_full' },
    { keyword: awayTeam, label: 'away_team_full' }
  ];

  // Add first-word fallbacks
  const homeWords = homeTeam.split(/\s+/);
  if (homeWords.length > 1) {
    for (const word of homeWords) {
      if (word.length >= 2) {
        attempts.push({ keyword: word, label: 'home_team_word' });
      }
    }
  }
  const awayWords = awayTeam.split(/\s+/);
  if (awayWords.length > 1) {
    for (const word of awayWords) {
      if (word.length >= 2) {
        attempts.push({ keyword: word, label: 'away_team_word' });
      }
    }
  }

  for (const attempt of attempts) {
    const events = await searchSportyBet(attempt.keyword);
    if (events.length === 0) {
      await sleep(300);
      continue;
    }

    const result = findMatchingEvent(events, attempt.keyword, commenceTime, attempt.keyword === homeTeam ? awayTeam : homeTeam);
    if (result) {
      console.log(`[SPORTYBET] Matched: ${result.event.homeTeamName} vs ${result.event.awayTeamName} → ${result.event.eventId}`);

      // Detect if teams are reversed between IzentBet and SportyBet
      const sportyHome = (result.event.homeTeamName || '').toLowerCase();
      const izentHome = homeTeam.toLowerCase();
      const izentHomeWord = izentHome.split(/\s+/)[0];
      const teamsReversed = izentHomeWord.length >= 2 &&
        !sportyHome.includes(izentHomeWord) &&
        (result.event.awayTeamName || '').toLowerCase().includes(izentHomeWord);
      if (teamsReversed) {
        console.log(`[SPORTYBET] Teams reversed! IzentBet home "${homeTeam}" is SportyBet away "${result.event.awayTeamName}"`);
      }

      console.log('[REVERSAL CHECK]');
      console.log('  IzentBet home_team:', homeTeam);
      console.log('  IzentBet away_team:', awayTeam);
      console.log('  SportyBet homeTeamName:', result.event.homeTeamName);
      console.log('  SportyBet awayTeamName:', result.event.awayTeamName);
      console.log('  sportyHome:', sportyHome);
      console.log('  izentHome first word:', izentHome.split(' ')[0]);
      console.log('  teamsReversed:', teamsReversed);

      return {
        found: true,
        eventId: result.event.eventId,
        homeTeamName: result.event.homeTeamName,
        awayTeamName: result.event.awayTeamName,
        estimateStartTime: result.event.estimateStartTime,
        matchedBy: attempt.label,
        timeMatched: result.timeMatched,
        teamsReversed
      };
    }
    await sleep(300);
  }

  return { found: false, keyword: homeTeam, attempted: attempts.length };
}

async function createSportyBetCode(selections) {
  const url = `https://www.sportybet.com/api/${SPORTYBET_COUNTRY}/orders/share`;
  const sanitised = selections.map(s => ({
    eventId: s.eventId,
    marketId: s.marketId || '1',
    specifier: s.specifier || null,
    outcomeId: s.outcomeId
  }));
  const body = JSON.stringify({ selections: sanitised });
  console.log(`[SPORTYBET] Creating booking code with ${sanitised.length} selection(s)`);
  console.log(`[SPORTYBET] Share payload: ${body}`);

  // Retry up to 3 times — SportyBet can be flaky
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = 1500 * attempt + Math.random() * 500;
      console.log(`[SPORTYBET] Share retry ${attempt}/3 after ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
    const res = await nativeFetch(url, {
      method: 'POST',
      headers: {
        ...SPORTYBET_HEADERS,
        'Content-Type': 'application/json;charset=UTF-8'
      },
      body
    });
    if (!res.ok) {
      const text = await res.text();
      console.log(`[SPORTYBET] Share returned ${res.status}: ${text}`);
      if (attempt < 2) continue;
      throw new Error(`SportyBet share returned ${res.status}: ${text}`);
    }
    const json = await res.json();
    console.log(`[SPORTYBET] Share response: bizCode=${json.bizCode} isAvailable=${json.isAvailable}`);
    if (json.bizCode === 10000 && json.isAvailable) {
      return json;
    }
    console.log(`[SPORTYBET] Share attempt ${attempt + 1} rejected: bizCode=${json.bizCode} message=${json.message}`);
    if (attempt === 2) return json;
  }
}

// ─── ENDPOINT 0a: GET /api/ai-providers ──────────────────────────
const AI_LABELS = { openai: 'OpenAI (GPT-4o-mini)', gemini: 'Google Gemini', grok: 'Grok (xAI)' };

app.get('/api/ai-providers', (req, res) => {
  const providers = availableProviders.map(key => ({ id: key, name: AI_LABELS[key] || key }));
  res.json({ providers });
});

// ─── ENDPOINT 0b: POST /api/ai-keys (set keys from UI) ──────────
app.post('/api/ai-keys', (req, res) => {
  const { openai: oKey, gemini: gKey, grok: xKey } = req.body || {};
  const updated = [];

  if (oKey !== undefined) {
    if (oKey) { initProvider('openai', oKey); updated.push('openai'); }
    else { delete aiProviders.openai; updated.push('-openai'); }
  }
  if (gKey !== undefined) {
    if (gKey) { initProvider('gemini', gKey); updated.push('gemini'); }
    else { delete aiProviders.gemini; updated.push('-gemini'); }
  }
  if (xKey !== undefined) {
    if (xKey) { initProvider('grok', xKey); updated.push('grok'); }
    else { delete aiProviders.grok; updated.push('-grok'); }
  }

  refreshProviderList();
  console.log(`[AI] Keys updated from UI: [${updated.join(', ')}] — active: ${availableProviders.join(', ') || 'none'}`);

  const providers = availableProviders.map(key => ({ id: key, name: AI_LABELS[key] || key }));
  res.json({ success: true, providers });
});

// ─── ENDPOINT 1: GET /api/booking/:code ──────────────────────────
app.get('/api/booking/:code', async (req, res) => {
  try {
    const data = await fetchIzentBet(req.params.code);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`[ERROR] /api/booking: ${err.message}`);
    const status = err.statusCode || 502;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 2: POST /api/proxy/sportybet/search ────────────────
app.post('/api/proxy/sportybet/search', async (req, res) => {
  try {
    const { keyword, commenceTime } = req.body;
    if (!keyword) {
      return res.status(422).json({ error: 'keyword is required' });
    }

    // Use the keyword as home_team, derive away from empty if not given
    const awayTeam = req.body.awayTeam || '';
    const result = await searchWithFallbacks(keyword, awayTeam, commenceTime);
    res.json(result);
  } catch (err) {
    console.error(`[ERROR] /api/proxy/sportybet/search: ${err.message}`);
    res.status(502).json({ found: false, error: err.message });
  }
});

// ─── ENDPOINT 3: POST /api/proxy/sportybet/share ─────────────────
app.post('/api/proxy/sportybet/share', async (req, res) => {
  try {
    const selections = req.body;
    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(422).json({ success: false, error: 'Body must be a non-empty array of selections' });
    }

    const json = await createSportyBetCode(selections);

    if (json.bizCode === 10000 && json.isAvailable) {
      const shareCode = json.data.shareCode;
      console.log(`[SPORTYBET] Code created: ${shareCode}`);
      res.json({
        success: true,
        shareCode,
        shareURL: `https://www.sportybet.com/${SPORTYBET_COUNTRY}/sport/booking-code?bc=${shareCode}`
      });
    } else {
      console.log(`[SPORTYBET] Share rejected: ${JSON.stringify(json)}`);
      res.json({ success: false, error: 'SportyBet rejected the selections', raw: json });
    }
  } catch (err) {
    console.error(`[ERROR] /api/proxy/sportybet/share: ${err.message}`);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT 4: POST /api/convert (full pipeline) ──────────────
app.post('/api/convert', async (req, res) => {
  try {
    const { bookingCode, useAI, aiProvider } = req.body;
    if (!bookingCode) {
      return res.status(422).json({ success: false, error: 'bookingCode is required' });
    }

    const aiEnabled = useAI !== false && availableProviders.length > 0;

    console.log(`[CONVERT] Starting conversion for ${bookingCode}`);

    // Step A: Fetch from IzentBet
    const izentData = await fetchIzentBet(bookingCode);
    const selections = izentData.selections;

    // Step B: Search SportyBet for each selection
    const results = [];
    const sportySelections = [];

    for (const sel of selections) {
      const searchResult = await searchWithFallbacks(
        sel.home_team,
        sel.away_team,
        sel.commence_time
      );

      let sportyMapping = mapToSportyBet(sel.market, sel.selection, sel.home_team, sel.away_team, searchResult.teamsReversed || false);
      let resolvedBy = 'static';

      // AI fallback: if static mapper fell through to default 1X2 but the
      // selection doesn't look like a simple home/draw/away, ask AI
      if (sportyMapping._uncertain && searchResult.found && aiEnabled) {
        console.log(`[AI] Static mapper uncertain for "${sel.selection}" — trying AI`);
        const eventMarkets = await fetchSportyBetEventMarkets(searchResult.eventId);
        if (eventMarkets.length > 0) {
          const aiResult = await aiResolveMarket(
            sel.selection, sel.market, eventMarkets, sel.home_team, sel.away_team, aiProvider
          );
          if (aiResult) {
            sportyMapping = aiResult;
            resolvedBy = 'ai';
          }
        }
      }
      delete sportyMapping._uncertain;

      const entry = {
        izentbet: {
          home_team: sel.home_team,
          away_team: sel.away_team,
          selection: sel.selection,
          market: sel.market,
          odds: sel.odds
        },
        sportybet: {
          eventId: searchResult.found ? searchResult.eventId : null,
          ...sportyMapping,
          found: searchResult.found,
          matchedBy: searchResult.found ? searchResult.matchedBy : null,
          teamsReversed: searchResult.teamsReversed || false,
          resolvedBy
        }
      };

      results.push(entry);

      if (searchResult.found) {
        console.log('[OUTCOME]');
        console.log('  match:', sel.home_team, 'vs', sel.away_team);
        console.log('  selection:', sel.selection);
        console.log('  teamsReversed:', searchResult.teamsReversed);
        console.log('  outcomeId:', sportyMapping.outcomeId);
        sportySelections.push({
          eventId: searchResult.eventId,
          ...sportyMapping
        });
      }
    }

    // Step C: Check if any matched
    if (sportySelections.length === 0) {
      console.log(`[CONVERT] 0/${selections.length} matched — aborting`);
      return res.status(422).json({
        success: false,
        error: 'None of the selected matches were found on SportyBet. These may be leagues SportyBet does not cover.',
        originalCode: bookingCode,
        matched: 0,
        total: selections.length,
        selections: results
      });
    }

    // Step D: Create SportyBet code
    const shareResponse = await createSportyBetCode(sportySelections);

    if (shareResponse.bizCode !== 10000 || !shareResponse.isAvailable) {
      console.log(`[CONVERT] SportyBet rejected: ${JSON.stringify(shareResponse)}`);
      return res.json({
        success: false,
        error: 'SportyBet rejected the selections',
        originalCode: bookingCode,
        matched: sportySelections.length,
        total: selections.length,
        selections: results,
        raw: shareResponse
      });
    }

    const shareCode = shareResponse.data.shareCode;
    console.log(`[CONVERT] Success: ${bookingCode} → ${shareCode} (${sportySelections.length}/${selections.length} matched)`);

    res.json({
      success: true,
      originalCode: bookingCode,
      sportyBetCode: shareCode,
      sportyBetURL: `https://www.sportybet.com/${SPORTYBET_COUNTRY}/sport/booking-code?bc=${shareCode}`,
      matched: sportySelections.length,
      total: selections.length,
      selections: results
    });
  } catch (err) {
    console.error(`[ERROR] /api/convert: ${err.message}`);
    const status = err.statusCode || 502;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT: POST /api/proxy/bet9ja/search ────────────────────
app.post('/api/proxy/bet9ja/search', async (req, res) => {
  try {
    const { keyword, commenceTime } = req.body;
    if (!keyword) {
      return res.status(422).json({ error: 'keyword is required' });
    }
    const homeTeam = keyword;
    const awayTeam = req.body.awayTeam || '';
    const result = await searchBet9jaWithFallbacks(homeTeam, awayTeam, commenceTime);
    res.json(result);
  } catch (err) {
    console.error(`[ERROR] /api/proxy/bet9ja/search: ${err.message}`);
    res.status(502).json({ found: false, error: err.message });
  }
});

// ─── ENDPOINT: POST /api/proxy/bet9ja/book ───────────────────────
app.post('/api/proxy/bet9ja/book', async (req, res) => {
  try {
    const selections = req.body;
    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(422).json({ success: false, error: 'Body must be a non-empty array of selections' });
    }

    const json = await createBet9jaCode(selections);

    if (json.R === 'OK' && json.D && json.D[0] && json.D[0].RIS) {
      const code = json.D[0].RIS;
      console.log(`[BET9JA] Code created: ${code}`);
      res.json({
        success: true,
        bookingCode: code,
        bookingURL: `https://sports.bet9ja.com/#booking/${code}`
      });
    } else {
      console.log(`[BET9JA] BookABet rejected: ${JSON.stringify(json)}`);
      res.json({ success: false, error: 'Bet9ja rejected the booking', raw: json });
    }
  } catch (err) {
    console.error(`[ERROR] /api/proxy/bet9ja/book: ${err.message}`);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ─── ENDPOINT: POST /api/convert/bet9ja (full Bet9ja pipeline) ──
app.post('/api/convert/bet9ja', async (req, res) => {
  try {
    const { bookingCode } = req.body;
    if (!bookingCode) {
      return res.status(422).json({ success: false, error: 'bookingCode is required' });
    }

    console.log(`[CONVERT:BET9JA] Starting conversion for ${bookingCode}`);

    // Step A: Fetch from IzentBet
    const izentData = await fetchIzentBet(bookingCode);
    const selections = izentData.selections;

    // Step B: Search Bet9ja for each selection and map
    const results = [];
    const bet9jaSelections = [];

    for (const sel of selections) {
      const searchResult = await searchBet9jaWithFallbacks(
        sel.home_team,
        sel.away_team,
        sel.commence_time
      );

      const marketKey = searchResult.found
        ? mapToBet9ja(sel.market, sel.selection, searchResult.teamsReversed || false)
        : null;

      const oddsValue = searchResult.found && marketKey
        ? (searchResult.odds[marketKey] || '1.00')
        : null;

      const entry = {
        izentbet: {
          home_team: sel.home_team,
          away_team: sel.away_team,
          selection: sel.selection,
          market: sel.market,
          odds: sel.odds
        },
        bet9ja: {
          eventId: searchResult.found ? searchResult.eventId : null,
          marketKey: marketKey,
          odds: oddsValue,
          found: searchResult.found,
          matchedBy: searchResult.found ? searchResult.matchedBy : null,
          teamsReversed: searchResult.teamsReversed || false
        }
      };

      results.push(entry);

      if (searchResult.found && marketKey) {
        console.log(`[BET9JA] ${sel.home_team}: ${sel.selection} → ${marketKey} @ ${oddsValue}`);
        bet9jaSelections.push({
          eventId: searchResult.eventId,
          marketKey: marketKey,
          odds: oddsValue,
          eventName: searchResult.eventName || '',
          startDate: searchResult.startDate || '',
          groupName: searchResult.groupName || '',
          superGroup: searchResult.superGroup || ''
        });
      }
    }

    // Step C: Check if any matched
    if (bet9jaSelections.length === 0) {
      console.log(`[CONVERT:BET9JA] 0/${selections.length} matched — aborting`);
      return res.status(422).json({
        success: false,
        error: 'None of the selected matches were found on Bet9ja. These may be leagues Bet9ja does not cover.',
        originalCode: bookingCode,
        matched: 0,
        total: selections.length,
        selections: results
      });
    }

    // Step D: Create Bet9ja booking code
    const bookResponse = await createBet9jaCode(bet9jaSelections);

    if (bookResponse.R !== 'OK' || !bookResponse.D || !bookResponse.D[0] || !bookResponse.D[0].RIS) {
      console.log(`[CONVERT:BET9JA] Bet9ja rejected: ${JSON.stringify(bookResponse)}`);
      return res.json({
        success: false,
        error: 'Bet9ja rejected the booking',
        originalCode: bookingCode,
        matched: bet9jaSelections.length,
        total: selections.length,
        selections: results,
        raw: bookResponse
      });
    }

    const bet9jaCode = bookResponse.D[0].RIS;
    console.log(`[CONVERT:BET9JA] Success: ${bookingCode} → ${bet9jaCode} (${bet9jaSelections.length}/${selections.length} matched)`);

    res.json({
      success: true,
      originalCode: bookingCode,
      bet9jaCode: bet9jaCode,
      bet9jaURL: `https://sports.bet9ja.com/#booking/${bet9jaCode}`,
      matched: bet9jaSelections.length,
      total: selections.length,
      selections: results
    });
  } catch (err) {
    console.error(`[ERROR] /api/convert/bet9ja: ${err.message}`);
    const status = err.statusCode || 502;
    res.status(status).json({ success: false, error: err.message });
  }
});

// ─── Public Conversion Helpers ───────────────────────────────────

async function convertToSportyBet(izentSelections) {
  const results = [];
  const sportySelections = [];

  for (const sel of izentSelections) {
    const searchResult = await searchWithFallbacks(sel.home_team, sel.away_team, sel.commence_time);
    const sportyMapping = mapToSportyBet(sel.market, sel.selection, sel.home_team, sel.away_team, searchResult.teamsReversed || false);
    delete sportyMapping._uncertain;

    results.push({ found: searchResult.found });

    if (searchResult.found) {
      sportySelections.push({ eventId: searchResult.eventId, ...sportyMapping });
    }
  }

  if (sportySelections.length === 0) {
    return { convertedCode: null, convertedURL: null, results, matched: 0 };
  }

  const shareResponse = await createSportyBetCode(sportySelections);
  if (shareResponse.bizCode !== 10000 || !shareResponse.isAvailable) {
    return { convertedCode: null, convertedURL: null, results, matched: sportySelections.length };
  }

  const code = shareResponse.data.shareCode;
  return {
    convertedCode: code,
    convertedURL: `https://www.sportybet.com/${SPORTYBET_COUNTRY}/sport/booking-code?bc=${code}`,
    results,
    matched: sportySelections.length
  };
}

async function convertToBet9ja(izentSelections) {
  const results = [];
  const bet9jaSelections = [];

  for (const sel of izentSelections) {
    const searchResult = await searchBet9jaWithFallbacks(sel.home_team, sel.away_team, sel.commence_time);
    const marketKey = searchResult.found
      ? mapToBet9ja(sel.market, sel.selection, searchResult.teamsReversed || false)
      : null;
    const oddsValue = searchResult.found && marketKey
      ? (searchResult.odds[marketKey] || '1.00')
      : null;

    results.push({ found: searchResult.found });

    if (searchResult.found && marketKey) {
      bet9jaSelections.push({
        eventId: searchResult.eventId,
        marketKey,
        odds: oddsValue,
        eventName: searchResult.eventName || '',
        startDate: searchResult.startDate || '',
        groupName: searchResult.groupName || '',
        superGroup: searchResult.superGroup || ''
      });
    }
  }

  if (bet9jaSelections.length === 0) {
    return { convertedCode: null, convertedURL: null, results, matched: 0 };
  }

  const bookResponse = await createBet9jaCode(bet9jaSelections);
  if (bookResponse.R !== 'OK' || !bookResponse.D || !bookResponse.D[0] || !bookResponse.D[0].RIS) {
    return { convertedCode: null, convertedURL: null, results, matched: bet9jaSelections.length };
  }

  const code = bookResponse.D[0].RIS;
  return {
    convertedCode: code,
    convertedURL: `https://sports.bet9ja.com/#booking/${code}`,
    results,
    matched: bet9jaSelections.length
  };
}

// ─── POST /api/public/convert ────────────────────────────────────
app.post('/api/public/convert', async (req, res) => {
  const start = Date.now();
  try {
    const { bookingCode, platform } = req.body;

    if (!bookingCode || typeof bookingCode !== 'string' || !bookingCode.trim()) {
      return res.status(400).json({
        success: false, error: 'bookingCode is required', code: 'MISSING_CODE'
      });
    }

    const plat = (platform || '').toLowerCase().trim();
    const supported = ['sportybet', 'bet9ja', '1xbet'];
    if (!plat || !supported.includes(plat)) {
      return res.status(400).json({
        success: false,
        error: `Invalid platform. Supported: ${supported.join(', ')}`,
        code: 'INVALID_PLATFORM'
      });
    }

    if (plat === '1xbet') {
      return res.status(501).json({
        success: false, error: '1xBet coming soon', code: 'NOT_IMPLEMENTED'
      });
    }

    console.log(`[PUBLIC] Converting ${bookingCode.trim()} → ${plat}`);

    // Step A: Fetch from IzentBet
    let izentData;
    try {
      izentData = await fetchIzentBet(bookingCode.trim());
    } catch (err) {
      if (err.statusCode === 410) {
        return res.status(410).json({
          success: false, error: err.message, code: 'EXPIRED', ms: Date.now() - start
        });
      }
      if (err.statusCode === 404 || err.statusCode === 422) {
        return res.status(404).json({
          success: false, error: 'Booking code not found or invalid', code: 'NOT_FOUND', ms: Date.now() - start
        });
      }
      throw err;
    }

    const izentSelections = izentData.selections;

    // Step B + C: Platform-specific conversion
    let convertedCode, convertedURL, results, matched;

    if (plat === 'sportybet') {
      ({ convertedCode, convertedURL, results, matched } = await convertToSportyBet(izentSelections));
    } else if (plat === 'bet9ja') {
      ({ convertedCode, convertedURL, results, matched } = await convertToBet9ja(izentSelections));
    }

    // Build standardised selections array
    const selections = izentSelections.map((sel, i) => ({
      match: `${sel.home_team} vs ${sel.away_team}`,
      market: normaliseMarketLabel(sel.market),
      pick: sel.selection,
      odds: sel.odds,
      converted: results[i].found
    }));

    if (matched === 0) {
      return res.status(422).json({
        success: false,
        error: `None of the selections were found on ${plat}`,
        code: 'NO_MATCHES',
        originalCode: bookingCode.trim(),
        platform: plat,
        matched: 0,
        total: izentSelections.length,
        selections,
        ms: Date.now() - start
      });
    }

    if (!convertedCode) {
      return res.status(502).json({
        success: false,
        error: `${plat} rejected the booking`,
        code: 'UPSTREAM_ERROR',
        originalCode: bookingCode.trim(),
        platform: plat,
        matched,
        total: izentSelections.length,
        selections,
        ms: Date.now() - start
      });
    }

    console.log(`[PUBLIC] Success: ${bookingCode.trim()} → ${convertedCode} on ${plat} (${matched}/${izentSelections.length})`);

    res.json({
      success: true,
      originalCode: bookingCode.trim(),
      convertedCode,
      convertedURL,
      platform: plat,
      matched,
      total: izentSelections.length,
      selections,
      ms: Date.now() - start
    });
  } catch (err) {
    console.error(`[ERROR] /api/public/convert: ${err.message}`);
    res.status(502).json({
      success: false,
      error: 'Upstream service error',
      code: 'UPSTREAM_ERROR',
      ms: Date.now() - start
    });
  }
});

// ─── GET /api/lookup/sportybet/:code ─────────────────────────────
app.get('/api/lookup/sportybet/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const url = `https://www.sportybet.com/api/${SPORTYBET_COUNTRY}/orders/share/${encodeURIComponent(code)}?_t=${Date.now()}`;
    console.log(`[SPORTYBET] Looking up code ${code}`);
    const response = await nativeFetch(url, { headers: SPORTYBET_HEADERS });
    const json = await response.json();

    if (json.bizCode === 10000 && json.isAvailable) {
      res.json({ success: true, data: json.data });
    } else {
      res.json({ success: false, error: 'Code not found or unavailable', raw: json });
    }
  } catch (err) {
    console.error(`[ERROR] /api/lookup/sportybet: ${err.message}`);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ─── GET / ───────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'IzentBet → SportyBet / Bet9ja Converter',
    version: '1.2.0',
    status: 'running',
    endpoints: {
      'GET  /health': 'Health check',
      'GET  /api/booking/:code': 'Decode IzentBet booking code',
      'POST /api/proxy/sportybet/search': 'Search SportyBet events',
      'POST /api/proxy/sportybet/share': 'Create SportyBet booking code',
      'POST /api/convert': 'Full SportyBet conversion pipeline',
      'GET  /api/lookup/sportybet/:code': 'Lookup SportyBet code details',
      'POST /api/proxy/bet9ja/search': 'Search Bet9ja events',
      'POST /api/proxy/bet9ja/book': 'Create Bet9ja booking code',
      'POST /api/convert/bet9ja': 'Full Bet9ja conversion pipeline',
      'POST /api/public/convert': 'Public unified conversion (no auth)'
    }
  });
});

// ─── GET /health ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ─── Start server ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nIzentBet → SportyBet / Bet9ja Converter running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log(`  GET  /api/booking/:code`);
  console.log(`  POST /api/proxy/sportybet/search`);
  console.log(`  POST /api/proxy/sportybet/share`);
  console.log(`  POST /api/convert`);
  console.log(`  GET  /api/lookup/sportybet/:code`);
  console.log(`  POST /api/proxy/bet9ja/search`);
  console.log(`  POST /api/proxy/bet9ja/book`);
  console.log(`  POST /api/convert/bet9ja`);
  console.log(`  POST /api/public/convert       (public, no auth)`);
  console.log(`  GET  /health\n`);
});

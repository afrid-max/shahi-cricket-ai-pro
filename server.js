const express = require('express');
const cors = require('cors');
require('dotenv').config();
const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',').map(x=>x.trim()) : true }));
app.use(express.json({ limit: '200kb' }));
const PORT = process.env.PORT || 3000;
const CRIC_API_KEY = process.env.CRICAPI_KEY || '';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/,'');
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const cache = new Map();
async function cached(key, ttl, fn) {
  const hit=cache.get(key); if(hit && Date.now()-hit.at<ttl) return hit.value;
  const value=await fn(); cache.set(key,{at:Date.now(),value}); return value;
}
async function jsonFetch(url, opts={}) {
  const r=await fetch(url,opts); const body=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(body.message || body.error || `Provider returned HTTP ${r.status}`);
  return body;
}
function cricNormalize(m) {
  const teams=Array.isArray(m.teams)?m.teams:[m.team1,m.team2].filter(Boolean);
  const scoreRows=Array.isArray(m.score)?m.score:[];
  return { id:m.id, name:m.name, series:m.series||m.seriesName||m.name, teams,
    scores:scoreRows.map(s=>s.r!=null?`${s.r}/${s.w??0}`:'').slice(0,2),
    overs:scoreRows.map(s=>s.o!=null?`${s.o} ov`:'').slice(0,2),
    status:m.status||m.matchStatus||'Status unavailable',
    live: /live|in progress|innings|stumps/i.test(m.status||m.matchStatus||''),
    startTime:m.dateTimeGMT||m.date||null, venue:m.venue||'',
    matchType:m.matchType||'', note:m.status||'' };
}
async function getCricketMatches() {
  if(!CRIC_API_KEY) return {live:[],upcoming:[],configured:false};
  const data=await cached('cric-current',15000,()=>jsonFetch(`https://api.cricapi.com/v1/currentMatches?apikey=${encodeURIComponent(CRIC_API_KEY)}&offset=0`));
  const all=(data.data||[]).map(cricNormalize);
  const live=all.filter(m=>m.live);
  // Current-match endpoint may also include not-yet-started fixtures; for a full schedule, use the provider's matches endpoint.
  let upcoming=[];
  try {
    const future=await cached('cric-upcoming',300000,()=>jsonFetch(`https://api.cricapi.com/v1/matches?apikey=${encodeURIComponent(CRIC_API_KEY)}&offset=0`));
    upcoming=(future.data||[]).map(cricNormalize).filter(m=>!m.live).slice(0,40);
  } catch(e) { upcoming=all.filter(m=>!m.live); }
  return {live,upcoming,configured:true};
}
async function getOdds() {
  if(!ODDS_API_KEY) return [];
  return cached('odds-cricket',30000,async()=>{
    const sports=await jsonFetch(`https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(ODDS_API_KEY)}`);
    const cricket=(sports||[]).filter(s=>/cricket/i.test(`${s.key} ${s.title}`)&&s.active);
    const results=[];
    for(const sport of cricket.slice(0,5)) {
      try {
        const events=await jsonFetch(`https://api.the-odds-api.com/v4/sports/${encodeURIComponent(sport.key)}/odds/?apiKey=${encodeURIComponent(ODDS_API_KEY)}&regions=${encodeURIComponent(process.env.ODDS_REGIONS||'uk')}&markets=h2h&oddsFormat=decimal`);
        for(const ev of events||[]) {
          const books=ev.bookmakers||[];
          for(const book of books.slice(0,3)) {
            const market=(book.markets||[]).find(m=>m.key==='h2h'); if(!market) continue;
            const outs=market.outcomes||[];
            results.push({id:ev.id,sportTitle:sport.title,sport_key:sport.key,home_team:ev.home_team,away_team:ev.away_team,
              bookmaker:book.title,market:'h2h',homeOdds:outs.find(o=>o.name===ev.home_team)?.price??null,
              awayOdds:outs.find(o=>o.name===ev.away_team)?.price??null,updated:book.last_update||ev.commence_time||''});
          }
        }
      } catch(e) { console.warn('Odds sport skipped:',sport.key,e.message); }
    }
    return results.slice(0,100);
  });
}
app.get('/api/health',(req,res)=>res.json({ok:true,service:'SHAHI Cricket AI Pro backend',cricketConfigured:!!CRIC_API_KEY,oddsConfigured:!!ODDS_API_KEY,aiConfigured:!!OPENAI_API_KEY,utc:new Date().toISOString()}));
app.get('/api/dashboard',async(req,res)=>{
  try { const [cricket,odds]=await Promise.all([getCricketMatches(),getOdds()]);
    res.json({live:cricket.live,upcoming:cricket.upcoming,odds,updatedAt:new Date().toISOString(),providers:{cricketConfigured:cricket.configured,oddsConfigured:!!ODDS_API_KEY}});
  } catch(e) { console.error(e); res.status(502).json({error:'Unable to retrieve provider data. Check API keys, plan, and provider status.'}); }
});
app.post('/api/ask',async(req,res)=>{
  const question=String(req.body?.question||'').trim().slice(0,1500);
  if(!question) return res.status(400).json({error:'Please enter a question.'});
  const context=JSON.stringify(req.body?.context||{}).slice(0,14000);
  if(!OPENAI_API_KEY) return res.json({answer:'AI model is not configured yet. I can still answer basic questions from the dashboard. Ask about live scores, upcoming schedules, or available odds. Add OPENAI_API_KEY to the backend environment to enable full AI answers.'});
  try {
    const result=await jsonFetch(`${OPENAI_BASE_URL}/chat/completions`,{method:'POST',headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({
      model:AI_MODEL,temperature:0.3,max_tokens:500,
      messages:[
        {role:'system',content:'You are SHAHI Cricket AI Pro, a cricket information assistant. Use only supplied dashboard data for claims about current matches, scores, dates and odds. If data is absent or stale, say you cannot verify it. Never fabricate live scores or odds. Odds are informational, not guarantees. Do not encourage reckless gambling or claim certainty.'},
        {role:'user',content:`Dashboard data (may be empty): ${context}\n\nQuestion: ${question}`}
      ]
    })});
    res.json({answer:result.choices?.[0]?.message?.content||'No answer returned.'});
  } catch(e) { console.error(e); res.status(502).json({error:'AI provider request failed. Check AI key, model and billing.'}); }
});
app.listen(PORT,()=>console.log(`SHAHI Cricket AI backend listening on ${PORT}`));

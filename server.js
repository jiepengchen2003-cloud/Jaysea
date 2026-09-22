// 飆股 TERMINAL — backend
// 連 Finnhub WebSocket 取即時成交價，計算漲跌%，用自家 WebSocket 推給前端。
// 金鑰只存在伺服器端（環境變數），永不進入前端。

import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const FINNHUB_KEY = process.env.FINNHUB_KEY;
// 觀察標的：指數用 ETF 代理（SPY/QQQ/DIA）
const SYMBOLS = (process.env.SYMBOLS ||
  "SPY,QQQ,DIA,ALAB,DOCN,RMBS,CRDO,AKAM,TWLO,MDB,MP,CRML")
  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

if (!FINNHUB_KEY) {
  console.error("✗ 缺少 FINNHUB_KEY 環境變數。請在 .env 或部署平台設定。");
  process.exit(1);
}

// 報價狀態：{ SYM: {c: last, pc: prevClose, dp: pct, t: ms} }
const quotes = {};
let asof = new Date().toISOString();

// ---- 1) 開盤前用 REST 抓 prevClose + 初始價 ----
async function seedQuote(sym) {
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
    const d = await r.json();
    if (typeof d.c === "number" && d.c > 0) {
      quotes[sym] = { c: d.c, pc: d.pc || d.c, dp: d.dp ?? 0, t: Date.now() };
    }
  } catch (e) { console.warn("seed fail", sym, e.message); }
}
async function seedAll() {
  for (const s of SYMBOLS) { await seedQuote(s); await new Promise(r => setTimeout(r, 120)); }
  asof = new Date().toISOString();
  console.log(`✓ 初始報價載入 ${Object.keys(quotes).length}/${SYMBOLS.length} 檔`);
}

// ---- 1b) Yahoo Finance 新聞（伺服器端抓，前端無跨域問題）----
let news = [], newsSrc = "yahoo", newsDirty = false;
function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g; let m;
  const pick = (b, tag) => {
    const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b);
    return r ? r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim() : "";
  };
  while ((m = re.exec(xml)) && items.length < 30) {
    const b = m[1], title = pick(b, "title"), link = pick(b, "link"), time = pick(b, "pubDate");
    if (title && link) items.push({ title, link, time });
  }
  return items;
}
async function fetchNews() {
  const syms = SYMBOLS.filter(s => !["SPY", "QQQ", "DIA"].includes(s)).slice(0, 10).join(",");
  try {
    const r = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${syms}&region=US&lang=en-US`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; FuxiTerminal/1.0)" } });
    if (r.ok) {
      const items = parseRss(await r.text());
      if (items.length) { news = items.slice(0, 15); newsSrc = "yahoo"; newsDirty = true; console.log(`✓ Yahoo 新聞 ${news.length} 則`); return; }
    }
    throw new Error("yahoo empty " + r.status);
  } catch (e) {
    console.warn("Yahoo 新聞失敗，改用 Finnhub：", e.message);
    try {
      const arr = await (await fetch(`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`)).json();
      if (Array.isArray(arr) && arr.length) {
        news = arr.slice(0, 15).map(n => ({ title: n.headline, link: n.url, time: new Date(n.datetime * 1000).toUTCString(), source: n.source }));
        newsSrc = "finnhub"; newsDirty = true; console.log(`✓ Finnhub 新聞 ${news.length} 則`);
      }
    } catch (e2) { console.warn("Finnhub 新聞也失敗", e2.message); }
  }
}

// ---- 2) Finnhub WebSocket 即時串流 ----
let fh = null, fhAlive = false, dirty = false;
function connectFinnhub() {
  fh = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);
  fh.on("open", () => {
    fhAlive = true;
    console.log("✓ Finnhub WS 已連線，訂閱中…");
    SYMBOLS.forEach(s => fh.send(JSON.stringify({ type: "subscribe", symbol: s })));
  });
  fh.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
    for (const t of msg.data) {
      const q = quotes[t.s];
      if (!q) { quotes[t.s] = { c: t.p, pc: t.p, dp: 0, t: t.t }; continue; }
      q.c = t.p; q.t = t.t;
      if (q.pc) q.dp = ((q.c - q.pc) / q.pc) * 100;
    }
    dirty = true;
  });
  fh.on("close", () => { fhAlive = false; console.warn("Finnhub WS 斷線，5s 後重連"); setTimeout(connectFinnhub, 5000); });
  fh.on("error", (e) => { console.warn("Finnhub WS error", e.message); try { fh.close(); } catch {} });
}

// ---- 3) 自家 HTTP + WebSocket ----
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/quotes", (_req, res) => res.json({ asof, symbols: SYMBOLS, q: quotes, feed: fhAlive ? "live" : "rest" }));
app.get("/api/news", (_req, res) => res.json({ news, newsSrc }));
app.get("/api/health", (_req, res) => res.json({ ok: true, feed: fhAlive ? "live" : "rest", symbols: SYMBOLS.length, news: news.length }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  // 新連線先送目前快照
  ws.send(JSON.stringify({ type: "snapshot", asof, q: quotes, feed: fhAlive ? "live" : "rest", news, newsSrc }));
});

// 每 1 秒若有更新就廣播（報價或新聞）
setInterval(() => {
  if (!dirty && !newsDirty) return;
  dirty = false; newsDirty = false;
  asof = new Date().toISOString();
  const payload = JSON.stringify({ type: "update", asof, q: quotes, feed: fhAlive ? "live" : "rest", news, newsSrc });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}, 1000);

// 盤中/收盤都定期用 REST 補一次（維持 prevClose 與非活躍標的）
setInterval(seedAll, 10 * 60 * 1000);
// 每 5 分鐘更新 Yahoo 新聞
setInterval(fetchNews, 5 * 60 * 1000);

server.listen(PORT, async () => {
  console.log(`▸ 伏羲 FUXI TERMINAL 在 http://localhost:${PORT}`);
  await seedAll();
  connectFinnhub();
  fetchNews();
});

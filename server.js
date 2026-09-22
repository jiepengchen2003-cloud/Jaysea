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
app.get("/api/health", (_req, res) => res.json({ ok: true, feed: fhAlive ? "live" : "rest", symbols: SYMBOLS.length }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  // 新連線先送目前快照
  ws.send(JSON.stringify({ type: "snapshot", asof, q: quotes, feed: fhAlive ? "live" : "rest" }));
});

// 每 1 秒若有更新就廣播（節流，避免每筆成交都推）
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  asof = new Date().toISOString();
  const payload = JSON.stringify({ type: "update", asof, q: quotes, feed: fhAlive ? "live" : "rest" });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(payload); });
}, 1000);

// 盤中/收盤都定期用 REST 補一次（維持 prevClose 與非活躍標的）
setInterval(seedAll, 10 * 60 * 1000);

server.listen(PORT, async () => {
  console.log(`▸ 飆股 TERMINAL 在 http://localhost:${PORT}`);
  await seedAll();
  connectFinnhub();
});

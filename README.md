# 飆股 TERMINAL（Phase 4 · 可部署即時版）

Bloomberg 風格的美股即時動能分析終端機。後端連 **Finnhub WebSocket** 取即時成交價、計算漲跌%，再用自家 WebSocket **逐秒推播**給前端終端機。

- 金鑰只存在**伺服器端環境變數**，永不進前端。
- 前端：即時報價跳動、漲跌閃色、跑馬燈、觀察清單、題材/風控面板、指令列（HELP / SCAN / 代號…）。
- 資料：指數用 SPY/QQQ/DIA ETF 代理；個股即時；10Y、BTC 為靜態占位（可再接來源）。

> ⚠️ 教育／資訊用途，非投資建議。Finnhub 免費方案為美股即時 trade 串流；請遵守其使用條款與速率限制。

---

## 需要什麼
- Node.js 18+（本機跑）或任何支援 Node/長連線的雲平台（Render、Railway、Fly.io、VPS…）。
  - 注意：**Vercel/Netlify 的 serverless 不適合**常駐 WebSocket；請用會常駐的平台。
- 一把 Finnhub API key（finnhub.io 免費註冊）。

## A. 本機執行
```bash
cp .env.example .env      # 填入 FINNHUB_KEY
npm install
npm start
# 開瀏覽器 http://localhost:8080
```

## B. Docker
```bash
docker build -t feibiao-terminal .
docker run -p 8080:8080 -e FINNHUB_KEY=你的金鑰 feibiao-terminal
# http://localhost:8080
```

## C. Render.com（免費、最簡單）
1. 把這個資料夾推到你的 GitHub repo。
2. Render → New → Blueprint，選這個 repo（會讀 `render.yaml`）。
3. 在服務的 Environment 填入 `FINNHUB_KEY`。
4. 部署完成後開它給的網址即可（免費方案閒置會休眠，首次載入稍慢）。

## D. Railway / Fly.io
- Railway：New Project → Deploy from repo → 加環境變數 `FINNHUB_KEY` → 自動偵測 `npm start`。
- Fly.io：`fly launch`（有 Dockerfile）→ `fly secrets set FINNHUB_KEY=...` → `fly deploy`。

---

## 設定
| 環境變數 | 說明 | 預設 |
|---|---|---|
| `FINNHUB_KEY` | Finnhub API 金鑰（**必填**） | — |
| `SYMBOLS` | 觀察標的，逗號分隔 | SPY,QQQ,DIA,ALAB,DOCN,RMBS,CRDO,AKAM,TWLO,MDB,MP,CRML |
| `PORT` | 連接埠 | 8080 |

## 端點
- `/` 終端機前端
- `/api/quotes` 目前報價快照（JSON）
- `/api/health` 健康檢查
- `/ws` WebSocket 即時推播

## 架構
```
Finnhub WS ──trade──▶ server.js（算 dp、節流 1s）──WS──▶ 前端終端機（逐秒更新）
                          │
                          └─ REST /quote 每 10 分鐘補 prevClose
```

## 安全
- 金鑰只在後端；前端與 `/api/*` 都不外露金鑰。
- 這份程式碼沒有內建帳號系統。若要對外公開並限制存取，建議放在有登入保護的環境（如 Cloudflare Access、反向代理 Basic Auth），或自行加一層驗證。

## 之後可擴充
- 接你先前的 agent 產物（每日簡報、異常警報）到 Alert Feed。
- 指數改用真實指數來源、加 10Y/VIX 即時。
- 加使用者登入（Auth）與多裝置同步。

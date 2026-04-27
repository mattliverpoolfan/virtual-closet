# 花我最多錢 — Virtual Closet PWA

個人虛擬衣櫃 web app，純本機儲存、無需登入、不需要 App Store、**不會過期**。

## 為什麼是 PWA？

原本的 Swift 版本因為 iOS code signing 限制，每 7 天 / 1 年就要重新連電腦簽署。
改成 PWA 後：
- 不需要 Xcode / 開發者帳號 / AltStore
- 加到 iPhone 主畫面後，圖示外觀跟一般 app 一模一樣
- 完全離線運作（首次載入後）
- 永遠不會過期

## 功能

- ✅ 拍照 / 從相簿選圖
- ✅ 自動去背（瀏覽器內 ONNX 模型，純本機運算）
- ✅ 完整衣物資料管理（季節、類型、品牌、風格、價格、狀態、購買日期、備註）
- ✅ 搜尋與多條件篩選
- ✅ 自訂分類（新增 / 修改 / 刪除）
- ✅ 備份匯出 / 匯入 zip（**與原 Swift App 備份格式相容**）
- ✅ 離線可用（Service Worker）

## 部署

### 方法 A：GitHub Pages（推薦，免費）

```sh
cd web
git init
git add .
git commit -m "init"
# 在 GitHub 新建一個 repo，例如 virtual-closet
git remote add origin git@github.com:你的帳號/virtual-closet.git
git branch -M main
git push -u origin main
```

然後在 GitHub repo 設定裡：
1. Settings → Pages
2. Source: `Deploy from a branch`
3. Branch: `main` / `/ (root)`
4. 等待數十秒，就會得到網址：`https://你的帳號.github.io/virtual-closet/`

### 方法 B：Cloudflare Pages（免費，更快）

1. 註冊 https://pages.cloudflare.com
2. Connect to Git → 選擇你的 repo
3. Build command 留空、Build output directory 留空（或 `/`）
4. Deploy

### 方法 C：本機測試

```sh
cd web
python3 -m http.server 8080
# 開啟 http://localhost:8080
```

⚠️ 注意：iOS Safari 要求 PWA 必須 **HTTPS** 才能加到主畫面以「standalone」模式運行。
所以實際使用一定要部署到 GitHub Pages / Cloudflare Pages（這兩個都自動 HTTPS）。

## 把網頁加到 iPhone 主畫面

1. 用 **Safari** 打開部署好的網址（必須是 Safari，不能是 Chrome）
2. 點下方分享按鈕
3. 「加入主畫面」
4. 之後從主畫面打開，就會像一般 app 一樣全螢幕運行

## 從原 Swift App 移轉資料

### 步驟

1. **在原 Swift App** → 設定 → 匯出備份
   - 這會產生一個 `VirtualCloset_Backup_xxx` 資料夾，內含 `data.json` + `images/` 子資料夾
2. **將該資料夾壓縮成 .zip**
   - iOS Files App：長按資料夾 → 壓縮
   - Mac Finder：右鍵 → 壓縮
3. **在 PWA** → 設定 → 匯入備份 → 選擇剛才的 .zip
4. 完成 ✅

備份格式跟 Swift `BackupService` 完全相容，使用同一個 JSON schema：
- `data.json`: `{ version, categories[], items[] }`
- `images/{UUID}.png`

匯入時若 ID 重複會合併（更新內容），分類同名會合併（不會重複）。

## 資料儲存

所有資料只存在這支裝置的瀏覽器中（IndexedDB）：
- `categories`: 分類
- `items`: 衣物
- `images`: 圖片 Blob（PNG）

**完全不會上傳到任何地方**。建議定期匯出備份保險。

## 技術備註

- 純靜態 HTML / CSS / JS，無需 build step
- 去背使用 [`@imgly/background-removal`](https://github.com/imgly/background-removal-js)（從 jsDelivr CDN 載入，首次約 40MB，之後永久快取）
- 壓縮使用 [JSZip](https://stuk.github.io/jszip/)（CDN）
- Service Worker 提供離線支援（首次載入後完全可離線使用）

## 檔案結構

```
web/
├── index.html      # 入口
├── app.js          # 全部 app 邏輯
├── style.css       # 樣式
├── manifest.json   # PWA manifest
├── sw.js           # Service Worker（離線快取）
├── icon.jpg        # 圖示
└── README.md
```

整個專案 < 1 MB，沒有 node_modules，沒有編譯產物。

// ============================================================
// 花我最多錢 - Virtual Closet PWA
// ============================================================
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

// ===== Debug Log Capture (in-app console for iOS) =====
// Persist to localStorage so logs survive page reload (iOS Safari kills tab on OOM)
const LOG_KEY = 'vc-debug-logs';
const MAX_LOGS = 300;
let debugLogs = [];
try { debugLogs = JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { debugLogs = []; }
let _logFlushTimer = null;
function flushLogs() {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(debugLogs)); } catch {}
}
function pushLog(level, args) {
  const ts = new Date().toLocaleTimeString('zh-TW', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
  const text = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
  debugLogs.push({ ts, level, text });
  if (debugLogs.length > MAX_LOGS) debugLogs.shift();
  // Synchronous flush so logs survive page kill
  flushLogs();
}
// Mark startup so we can see if page reloaded mid-flow
pushLog('info', [`=== app boot ===`]);
['log', 'info', 'warn', 'error'].forEach(level => {
  const orig = console[level].bind(console);
  console[level] = (...args) => { pushLog(level, args); orig(...args); };
});
window.addEventListener('error', (e) => {
  pushLog('error', [`[onerror] ${e.message}`, `at ${e.filename}:${e.lineno}:${e.colno}`, e.error?.stack || '']);
});
window.addEventListener('unhandledrejection', (e) => {
  pushLog('error', ['[unhandledrejection]', e.reason?.stack || e.reason || 'unknown']);
});

// ===== Constants =====
const SEASONS = ['春&秋', '夏', '冬'];
const STATUSES = ['堪用', '淘汰'];
const DEFAULT_CATEGORIES = ['襯衫', '外套', '褲子', '套頭衫', 'T 恤'];

// ===== IndexedDB Layer =====
const DB_NAME = 'virtual-closet';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('purchaseDate', 'purchaseDate');
      }
      if (!db.objectStoreNames.contains('images')) {
        db.createObjectStore('images'); // key = imageID, value = Blob
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = key !== undefined ? tx.objectStore(store).put(value, key) : tx.objectStore(store).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ===== State =====
const state = {
  items: [],
  categories: [],
  imageCache: new Map(), // imageID -> object URL
  filter: {
    search: '',
    season: null,
    categoryID: null,
    status: null,
    brand: null,
    style: null,
  },
  currentView: 'closet',
  editingItem: null,
};

// ===== Utilities =====
const $ = (sel, root = document) => root.querySelector(sel);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
}));
const normalizeId = (id) => (id || '').toString().toLowerCase();

function showToast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function escapeHTML(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
}

function dateInputValue(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function getImageURL(imageID) {
  if (!imageID) return null;
  if (state.imageCache.has(imageID)) return state.imageCache.get(imageID);
  const blob = await dbGet('images', imageID);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  state.imageCache.set(imageID, url);
  return url;
}

function clearImageCache() {
  for (const url of state.imageCache.values()) URL.revokeObjectURL(url);
  state.imageCache.clear();
}

// ===== Initialization & Seeding =====
async function init() {
  state.categories = await dbAll('categories');
  state.items = await dbAll('items');

  if (state.categories.length === 0) {
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      const cat = { id: uuid(), name: DEFAULT_CATEGORIES[i], isDefault: true, sortOrder: i };
      await dbPut('categories', cat);
      state.categories.push(cat);
    }
  }

  state.categories.sort((a, b) => a.sortOrder - b.sortOrder);
  state.items.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));

  // Restore add-item form if page was reloaded during bg removal
  restoreDraft();

  renderApp();
}

// ===== Filtering =====
function getFilteredItems() {
  const f = state.filter;
  const q = f.search.trim().toLowerCase();
  return state.items.filter(it => {
    if (f.season && it.season !== f.season) return false;
    if (f.categoryID && normalizeId(it.categoryID) !== normalizeId(f.categoryID)) return false;
    if (f.status && it.status !== f.status) return false;
    if (f.brand && it.brand !== f.brand) return false;
    if (f.style && it.style !== f.style) return false;
    if (q) {
      const cat = state.categories.find(c => normalizeId(c.id) === normalizeId(it.categoryID));
      const haystack = [it.brand, it.style, it.notes, cat?.name].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

// ===== Rendering =====
function renderApp() {
  const app = $('#app');
  if (state.currentView === 'closet') app.innerHTML = renderCloset();
  else if (state.currentView === 'add') app.innerHTML = renderAddEdit();
  else if (state.currentView === 'detail') app.innerHTML = renderDetail();
  else if (state.currentView === 'settings') app.innerHTML = renderSettings();
  else if (state.currentView === 'categories') app.innerHTML = renderCategories();
  else if (state.currentView === 'debug') app.innerHTML = renderDebug();
  bindEvents();
  // Reset scroll to top after every re-render (so detail/edit views always start at top)
  window.scrollTo(0, 0);
  document.querySelectorAll('.scroll-content').forEach(el => { el.scrollTop = 0; });
  if (state.currentView === 'closet') hydrateClosetImages();
  if (state.currentView === 'detail') hydrateDetailImage();
  if (state.currentView === 'add') hydrateEditImage();
}

function renderCloset() {
  const items = getFilteredItems();
  const cells = items.map(it => {
    const cat = state.categories.find(c => normalizeId(c.id) === normalizeId(it.categoryID));
    return `
      <div class="grid-cell" data-action="open-detail" data-id="${escapeHTML(it.id)}">
        <div class="cell-image-wrap"><img data-img="${escapeHTML(it.imageID)}" alt=""/></div>
        <div class="cell-meta">
          <div class="cell-season">${escapeHTML(it.season)}</div>
          <div class="cell-category">${escapeHTML(cat?.name || 'Unknown')}</div>
        </div>
      </div>
    `;
  }).join('');

  const empty = items.length === 0
    ? `<div class="empty">${state.items.length === 0 ? '尚未新增任何衣物<br/>點右上角 + 開始建立你的衣櫃' : '找不到符合條件的衣物'}</div>`
    : '';

  return `
    <div class="view active">
      <div class="header">
        <button class="icon-btn" data-action="open-settings" aria-label="設定">⚙</button>
        <div class="header-title">花我最多錢</div>
        <button class="primary-btn" data-action="open-add">＋ Add</button>
      </div>
      <div class="search-row">
        <div class="search-box">
          <span>🔍</span>
          <input type="text" placeholder="搜尋" id="search-input" value="${escapeHTML(state.filter.search)}"/>
        </div>
        <button class="filter-btn" data-action="open-filter" aria-label="篩選">≡</button>
      </div>
      ${empty}
      <div class="grid">${cells}</div>
    </div>
  `;
}

async function hydrateClosetImages() {
  for (const img of document.querySelectorAll('img[data-img]')) {
    const url = await getImageURL(img.dataset.img);
    if (url) img.src = url;
  }
}

function renderDetail() {
  const it = state.editingItem;
  if (!it) { state.currentView = 'closet'; renderApp(); return ''; }
  const cat = state.categories.find(c => normalizeId(c.id) === normalizeId(it.categoryID));
  return `
    <div class="view active">
      <div class="header">
        <button class="icon-btn" data-action="back-to-closet">‹</button>
        <div class="header-title">Details</div>
        <button class="modal-link bold" data-action="open-edit">Edit</button>
      </div>
      <div class="scroll-content">
        <img class="detail-image" data-img="${escapeHTML(it.imageID)}" alt=""/>
        <div class="detail-row"><span class="label">品牌 (Brand)</span><span class="value">${escapeHTML(it.brand || '-')}</span></div>
        <div class="detail-row"><span class="label">類型 (Type)</span><span class="value">${escapeHTML(cat?.name || '-')}</span></div>
        <div class="detail-row"><span class="label">風格 (Style)</span><span class="value">${escapeHTML(it.style || '-')}</span></div>
        <div class="detail-row"><span class="label">季節 (Season)</span><span class="value">${escapeHTML(it.season)}</span></div>
        <div class="detail-row"><span class="label">價格 (Price)</span><span class="value">${it.price > 0 ? 'NT$ ' + it.price.toLocaleString() : '-'}</span></div>
        <div class="detail-row"><span class="label">狀態 (Status)</span><span class="value">${escapeHTML(it.status)}</span></div>
        <div class="detail-row"><span class="label">購買日期 (Date)</span><span class="value">${formatDate(it.purchaseDate)}</span></div>
        <div class="detail-row"><span class="label">備註 (Notes)</span><span class="value">${escapeHTML(it.notes || '-')}</span></div>
        <div style="height: 24px;"></div>
        <button class="action-btn danger" data-action="delete-item">刪除這件 (Delete Item)</button>
      </div>
    </div>
  `;
}

async function hydrateDetailImage() {
  const img = document.querySelector('.detail-image');
  if (img && img.dataset.img) {
    const url = await getImageURL(img.dataset.img);
    if (url) img.src = url;
  }
}

function renderAddEdit() {
  const editing = !!state.editingItem;
  const it = state.editingItem || {
    season: '春&秋',
    categoryID: state.categories[0]?.id || null,
    style: '',
    brand: '',
    price: 0,
    status: '堪用',
    purchaseDate: new Date().toISOString(),
    notes: '',
    imageID: null,
  };
  const seasonOpts = SEASONS.map(s => `<option value="${s}" ${s === it.season ? 'selected' : ''}>${s}</option>`).join('');
  const statusOpts = STATUSES.map(s => `<option value="${s}" ${s === it.status ? 'selected' : ''}>${s}</option>`).join('');
  const catOpts = state.categories.map(c => `<option value="${c.id}" ${normalizeId(c.id) === normalizeId(it.categoryID) ? 'selected' : ''}>${escapeHTML(c.name)}</option>`).join('');

  return `
    <div class="view active">
      <div class="header">
        <button class="icon-btn" data-action="back-to-closet">‹</button>
        <div class="header-title">${editing ? '編輯項目' : '添加項目'}</div>
        <button class="modal-link bold" data-action="save-item">完成</button>
      </div>
      <div class="scroll-content">
        <div class="form-section">
          <h3>Photo</h3>
          <div class="photo-area" id="photo-area">
            ${it.imageID
              ? `<img id="preview-img" data-img="${escapeHTML(it.imageID)}" alt=""/>`
              : `
                <div class="photo-buttons">
                  <label class="photo-button">
                    <span class="ico">📷</span><span>拍照 / 選圖</span>
                    <input type="file" accept="image/*" capture="environment" id="file-input" hidden/>
                  </label>
                </div>
              `}
          </div>
          <div id="processing" class="processing hidden"><span class="spinner"></span><span id="processing-text">去背中...</span></div>
          ${it.imageID ? '<button class="action-btn secondary" data-action="reshoot">重新拍照 / 選圖</button>' : ''}
        </div>

        <div class="form-section">
          <h3>Details</h3>
          <div class="form-row"><label>季節</label>
            <select id="f-season">${seasonOpts}</select>
          </div>
          <div class="form-row"><label>類型</label>
            <select id="f-category">${catOpts}</select>
          </div>
          <div class="form-row"><label>&nbsp;</label>
            <button class="modal-link" data-action="open-categories">管理分類 ›</button>
          </div>
          <div class="form-row"><label>風格</label>
            <input type="text" id="f-style" value="${escapeHTML(it.style)}" placeholder="例：Casual"/>
          </div>
          <div class="form-row"><label>品牌</label>
            <input type="text" id="f-brand" value="${escapeHTML(it.brand)}" placeholder="例：Uniqlo"/>
          </div>
          <div class="form-row"><label>購買日期</label>
            <input type="date" id="f-date" value="${dateInputValue(it.purchaseDate)}"/>
          </div>
          <div class="form-row"><label>價格 NT$</label>
            <input type="number" id="f-price" value="${it.price || ''}" placeholder="0" inputmode="numeric"/>
          </div>
          <div class="form-row"><label>狀態</label>
            <select id="f-status">${statusOpts}</select>
          </div>
          <div class="form-row column"><label>備註</label>
            <textarea id="f-notes" placeholder="備註">${escapeHTML(it.notes)}</textarea>
          </div>
        </div>

        <button class="action-btn secondary" data-action="back-to-closet">取消</button>
        ${editing ? '<button class="action-btn danger" style="margin-top:12px;" data-action="delete-item">刪除這件</button>' : ''}
        <div style="height: 32px;"></div>
      </div>
    </div>
  `;
}

async function hydrateEditImage() {
  const img = document.querySelector('#preview-img');
  if (img && img.dataset.img) {
    const url = await getImageURL(img.dataset.img);
    if (url) img.src = url;
  }
}

function renderSettings() {
  const itemCount = state.items.length;
  const catCount = state.categories.length;
  return `
    <div class="view active">
      <div class="header">
        <button class="icon-btn" data-action="back-to-closet">‹</button>
        <div class="header-title">設定</div>
        <button class="modal-link bold" data-action="back-to-closet">完成</button>
      </div>
      <div class="scroll-content">
        <div class="form-section">
          <h3>資料移轉 (Data Migration)</h3>
          <button class="settings-row" data-action="export"><span class="ico">⬆</span>匯出備份 (Export Backup .zip)</button>
          <label class="settings-row" style="cursor:pointer;">
            <span class="ico">⬇</span>匯入備份 (Import Backup .zip)
            <input type="file" accept=".zip,application/zip" id="import-input" hidden/>
          </label>
          <button class="settings-row" data-action="open-categories"><span class="ico">📂</span>管理分類</button>
          <button class="settings-row" data-action="open-debug"><span class="ico">🐞</span>查看 Log (Debug)</button>
          <div class="settings-note">
            匯入時會與現有資料合併（同 ID 或同名分類會合併，不會重複）。<br/>
            支援從原 Swift App 匯出的備份（將原始 App 匯出的資料夾壓縮成 .zip 即可）。
          </div>
        </div>

        <div class="form-section">
          <h3>關於 (About)</h3>
          <div class="form-row"><label>版本</label><span>1.0.0 (PWA)</span></div>
          <div class="form-row"><label>衣物總數</label><span>${itemCount}</span></div>
          <div class="form-row"><label>分類總數</label><span>${catCount}</span></div>
        </div>

        <div class="settings-note">
          這是純本地運行的網頁 app — 你的資料只存在這支裝置的瀏覽器中，不會上傳任何地方。<br/>
          建議定期匯出備份作為保險。
        </div>
        <div style="height: 24px;"></div>
      </div>
    </div>
  `;
}

function renderDebug() {
  const logs = debugLogs.slice().reverse(); // newest first
  const ua = navigator.userAgent;
  const gpu = navigator.gpu ? '✅ WebGPU' : '❌ no WebGPU';
  const head = `
    <div style="font-size:12px;color:#888;margin-bottom:12px;line-height:1.5;word-break:break-all;">
      <div>${escapeHTML(ua)}</div>
      <div>${gpu} · IndexedDB: ${'indexedDB' in window ? '✅' : '❌'} · 圖片快取: ${state.imageCache.size}</div>
    </div>
  `;
  const items = logs.length === 0
    ? '<div style="color:#666;padding:20px;text-align:center;">尚無 log</div>'
    : logs.map(l => {
        const color = l.level === 'error' ? '#ff5050' : l.level === 'warn' ? '#ffb84d' : '#aaa';
        return `<div style="font-family:Menlo,monospace;font-size:11px;color:${color};padding:6px 0;border-bottom:1px solid #1a1a1a;word-break:break-all;white-space:pre-wrap;">
          <span style="color:#555;">${l.ts}</span> [${l.level}] ${escapeHTML(l.text)}
        </div>`;
      }).join('');
  return `
    <div class="view active">
      <div class="header">
        <button class="icon-btn" data-action="back-to-settings">‹</button>
        <div class="header-title">Debug Log</div>
        <button class="modal-link" data-action="copy-debug">複製</button>
      </div>
      <div class="scroll-content">
        ${head}
        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button class="action-btn secondary" data-action="refresh-debug" style="flex:1;">重新整理</button>
          <button class="action-btn secondary" data-action="clear-debug" style="flex:1;">清空</button>
        </div>
        ${items}
      </div>
    </div>
  `;
}

function renderCategories() {
  const list = state.categories.map(c => `
    <li>
      <span data-action="rename-category" data-id="${escapeHTML(c.id)}">${escapeHTML(c.name)}</span>
      <button class="delete" data-action="delete-category" data-id="${escapeHTML(c.id)}">刪除</button>
    </li>
  `).join('');
  return `
    <div class="view active">
      <div class="header">
        <button class="icon-btn" data-action="back-from-categories">‹</button>
        <div class="header-title">管理分類</div>
        <button class="modal-link" data-action="add-category">＋</button>
      </div>
      <ul class="category-list">${list}</ul>
    </div>
  `;
}

// ===== Filter Modal =====
function openFilterModal() {
  const cats = state.categories;
  const brands = [...new Set(state.items.map(i => i.brand).filter(Boolean))].sort();
  const styles = [...new Set(state.items.map(i => i.style).filter(Boolean))].sort();

  const chip = (label, active, key, value) =>
    `<button class="chip ${active ? 'active' : ''}" data-filter-key="${key}" data-filter-value="${escapeHTML(value ?? '')}">${escapeHTML(label)}</button>`;

  const html = `
    <div class="modal">
      <div class="modal-header">
        <button class="modal-link" data-action="clear-filter">全部清除</button>
        <div class="modal-title">篩選</div>
        <button class="modal-link bold" data-action="close-modal">完成</button>
      </div>
      <div class="modal-content">
        <div class="filter-section">
          <h4>季節</h4>
          <div class="chip-row">
            ${chip('全部', state.filter.season === null, 'season', '')}
            ${SEASONS.map(s => chip(s, state.filter.season === s, 'season', s)).join('')}
          </div>
        </div>
        <div class="filter-section">
          <h4>類型</h4>
          <div class="chip-row">
            ${chip('全部', state.filter.categoryID === null, 'categoryID', '')}
            ${cats.map(c => chip(c.name, normalizeId(state.filter.categoryID) === normalizeId(c.id), 'categoryID', c.id)).join('')}
          </div>
        </div>
        <div class="filter-section">
          <h4>狀態</h4>
          <div class="chip-row">
            ${chip('全部', state.filter.status === null, 'status', '')}
            ${STATUSES.map(s => chip(s, state.filter.status === s, 'status', s)).join('')}
          </div>
        </div>
        ${brands.length ? `<div class="filter-section">
          <h4>品牌</h4>
          <div class="chip-row">
            ${chip('全部', state.filter.brand === null, 'brand', '')}
            ${brands.map(b => chip(b, state.filter.brand === b, 'brand', b)).join('')}
          </div>
        </div>` : ''}
        ${styles.length ? `<div class="filter-section">
          <h4>風格</h4>
          <div class="chip-row">
            ${chip('全部', state.filter.style === null, 'style', '')}
            ${styles.map(s => chip(s, state.filter.style === s, 'style', s)).join('')}
          </div>
        </div>` : ''}
        <div style="height: 24px;"></div>
      </div>
    </div>
  `;
  showModal(html);
}

function showModal(innerHTML) {
  let overlay = $('#modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = innerHTML;
  overlay.classList.add('active');
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

function closeModal() {
  const overlay = $('#modal-overlay');
  if (overlay) overlay.classList.remove('active');
}

// ===== Event Binding =====
function bindEvents() {
  document.body.onclick = handleClick;

  const search = $('#search-input');
  if (search) {
    search.oninput = (e) => {
      state.filter.search = e.target.value;
      // Re-render only the grid for performance
      const grid = $('.grid');
      if (grid) {
        const items = getFilteredItems();
        grid.innerHTML = items.map(it => {
          const cat = state.categories.find(c => normalizeId(c.id) === normalizeId(it.categoryID));
          return `
            <div class="grid-cell" data-action="open-detail" data-id="${escapeHTML(it.id)}">
              <div class="cell-image-wrap"><img data-img="${escapeHTML(it.imageID)}" alt=""/></div>
              <div class="cell-meta">
                <div class="cell-season">${escapeHTML(it.season)}</div>
                <div class="cell-category">${escapeHTML(cat?.name || 'Unknown')}</div>
              </div>
            </div>
          `;
        }).join('');
        hydrateClosetImages();
      }
    };
  }

  const fileInput = $('#file-input');
  if (fileInput) fileInput.onchange = handleImageSelected;

  const importInput = $('#import-input');
  if (importInput) importInput.onchange = handleImportFile;
}

async function handleClick(e) {
  // Filter chip clicks (no data-action, only data-filter-key)
  const chip = e.target.closest('[data-filter-key]');
  if (chip && !e.target.closest('[data-action]')) {
    const key = chip.dataset.filterKey;
    const val = chip.dataset.filterValue;
    state.filter[key] = val === '' ? null : val;
    openFilterModal();
    return;
  }

  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  switch (action) {
    case 'open-add':
      state.editingItem = null;
      state.currentView = 'add';
      renderApp();
      break;
    case 'open-detail': {
      const it = state.items.find(i => i.id === id);
      if (it) { state.editingItem = it; state.currentView = 'detail'; renderApp(); }
      break;
    }
    case 'open-edit':
      state.currentView = 'add';
      renderApp();
      break;
    case 'back-to-closet':
      clearDraft();
      state.editingItem = null;
      state.currentView = 'closet';
      renderApp();
      break;
    case 'open-settings':
      state.currentView = 'settings';
      renderApp();
      break;
    case 'open-categories':
      state.currentView = 'categories';
      renderApp();
      break;
    case 'back-from-categories':
      state.currentView = state.editingItem ? 'add' : 'settings';
      renderApp();
      break;
    case 'open-debug':
      state.currentView = 'debug';
      renderApp();
      break;
    case 'back-to-settings':
      state.currentView = 'settings';
      renderApp();
      break;
    case 'refresh-debug':
      renderApp();
      break;
    case 'clear-debug':
      debugLogs.length = 0;
      flushLogs();
      renderApp();
      break;
    case 'copy-debug': {
      const text = debugLogs.map(l => `${l.ts} [${l.level}] ${l.text}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        showToast('已複製到剪貼簿');
      } catch (err) {
        showToast('複製失敗：' + err.message, true);
      }
      break;
    }
    case 'open-filter':
      openFilterModal();
      break;
    case 'close-modal':
      closeModal();
      renderApp();
      break;
    case 'clear-filter':
      state.filter.season = null;
      state.filter.categoryID = null;
      state.filter.status = null;
      state.filter.brand = null;
      state.filter.style = null;
      closeModal();
      renderApp();
      break;
    case 'reshoot':
      if (state.editingItem) state.editingItem = { ...state.editingItem, imageID: null };
      else state.editingItem = null;
      // Re-render add view with empty image
      const tmp = state.editingItem;
      state.currentView = 'add';
      // Force editing state to keep field values? Easier: collect current form values first
      collectFormIntoEditingItem();
      state.editingItem.imageID = null;
      renderApp();
      break;
    case 'save-item':
      await saveItem();
      break;
    case 'delete-item':
      if (confirm('確定要刪除這件衣物嗎？')) await deleteItem();
      break;
    case 'export':
      await exportBackup();
      break;
    case 'add-category': {
      const name = prompt('新分類名稱：');
      if (name && name.trim()) {
        const cat = { id: uuid(), name: name.trim(), isDefault: false, sortOrder: state.categories.length };
        await dbPut('categories', cat);
        state.categories.push(cat);
        renderApp();
      }
      break;
    }
    case 'rename-category': {
      const cat = state.categories.find(c => c.id === id);
      if (!cat) break;
      const newName = prompt('修改分類名稱：', cat.name);
      if (newName && newName.trim() && newName.trim() !== cat.name) {
        cat.name = newName.trim();
        await dbPut('categories', cat);
        renderApp();
      }
      break;
    }
    case 'delete-category': {
      const cat = state.categories.find(c => c.id === id);
      if (!cat) break;
      const usedBy = state.items.filter(i => normalizeId(i.categoryID) === normalizeId(id)).length;
      const msg = usedBy > 0
        ? `這個分類被 ${usedBy} 件衣物使用，刪除後它們會變成「未分類」。確定？`
        : '確定刪除這個分類？';
      if (confirm(msg)) {
        await dbDelete('categories', cat.id);
        state.categories = state.categories.filter(c => c.id !== cat.id);
        // Nullify references in items
        for (const it of state.items) {
          if (normalizeId(it.categoryID) === normalizeId(id)) {
            it.categoryID = null;
            await dbPut('items', it);
          }
        }
        renderApp();
      }
      break;
    }
  }

}

function collectFormIntoEditingItem() {
  const ed = state.editingItem || {};
  ed.season = $('#f-season')?.value || ed.season || '春&秋';
  ed.categoryID = $('#f-category')?.value || ed.categoryID || null;
  ed.style = $('#f-style')?.value || '';
  ed.brand = $('#f-brand')?.value || '';
  ed.price = parseInt($('#f-price')?.value || '0', 10) || 0;
  ed.status = $('#f-status')?.value || '堪用';
  const dateStr = $('#f-date')?.value;
  ed.purchaseDate = dateStr ? new Date(dateStr).toISOString() : (ed.purchaseDate || new Date().toISOString());
  ed.notes = $('#f-notes')?.value || '';
  state.editingItem = ed;
}

// ===== Image handling =====
async function handleImageSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  console.log(`[step 1] 選了照片: ${file.name || 'unnamed'} (${(file.size/1024/1024).toFixed(2)} MB, type=${file.type})`);
  collectFormIntoEditingItem();

  let blob;
  try {
    blob = await readImageAsBlob(file);
    console.log(`[step 2] 縮圖完成，大小 ${(blob.size/1024/1024).toFixed(2)} MB`);
  } catch (err) {
    console.error('[step 2 失敗] 讀圖錯誤', err);
    showToast('圖片讀取失敗：' + err.message, true);
    return;
  }

  const imageID = state.editingItem?.imageID || uuid();
  try {
    await dbPut('images', blob, imageID);
    console.log(`[step 3] 原圖已存入 IndexedDB (${imageID.slice(0,8)})`);
  } catch (err) {
    console.error('[step 3 失敗] 存原圖錯誤', err);
    showToast('儲存圖片失敗：' + err.message, true);
    return;
  }
  state.imageCache.delete(imageID);
  if (!state.editingItem) state.editingItem = {};
  state.editingItem.imageID = imageID;

  saveDraft();
  console.log('[step 4] draft 已存 localStorage');

  const processing = $('#processing');
  const processingText = $('#processing-text');
  if (processing) processing.classList.remove('hidden');
  if (processingText) processingText.textContent = '載入去背模型...';

  console.log('[step 5] 開始去背流程');
  try {
    const processed = await removeBackground(blob, (progress) => {
      const el = $('#processing-text');
      if (el) el.textContent = progress;
    });
    console.log(`[step 6] 去背完成，輸出大小 ${(processed.size/1024/1024).toFixed(2)} MB`);
    await dbPut('images', processed, imageID);
    console.log('[step 7] 已將去背圖存回 IndexedDB');
    state.imageCache.delete(imageID);
    clearDraft();
    renderApp();
    console.log('[step 8] renderApp 完成');
  } catch (err) {
    console.error('[去背流程失敗]', err?.message || err, err?.stack || '');
    showToast('去背失敗，使用原圖', true);
    clearDraft();
    renderApp();
  } finally {
    const el = $('#processing');
    if (el) el.classList.add('hidden');
  }
}

// ===== Draft Persistence (survives iOS Safari page reload) =====
function saveDraft() {
  if (!state.editingItem) return;
  try {
    localStorage.setItem('vc-draft', JSON.stringify(state.editingItem));
  } catch {}
}

function clearDraft() {
  try { localStorage.removeItem('vc-draft'); } catch {}
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem('vc-draft');
    if (!raw) return false;
    const draft = JSON.parse(raw);
    if (!draft || !draft.imageID) return false;
    state.editingItem = draft;
    state.currentView = 'add';
    return true;
  } catch { return false; }
}

function readImageAsBlob(file) {
  // Use HTMLCanvasElement for maximum iOS compatibility
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const maxSide = 600;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (Math.max(w, h) > maxSide) {
        const ratio = maxSide / Math.max(w, h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob failed'));
      }, 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Image load failed')); };
    img.src = objectUrl;
  });
}

let _bgRemoveModule = null;

// Detect WebGPU support (iOS Safari 18+, Chrome, Edge)
async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

// Detect iOS Safari — force CPU-only to avoid WebGPU+WASM dual-runtime memory blowup
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
}

async function removeBackground(blob, onProgress) {
  if (!_bgRemoveModule) {
    console.log('[bg] 開始載入 imgly 模組');
    onProgress?.('下載去背模型 (首次約 40MB，會被瀏覽器快取)...');
    _bgRemoveModule = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.6.0/+esm');
    console.log('[bg] imgly 模組載入完成', Object.keys(_bgRemoveModule || {}));
  }
  const ios = isIOS();
  const useGPU = !ios && await hasWebGPU();
  console.log(`[bg] iOS=${ios}, useGPU=${useGPU} (iOS 強制 CPU-only 避免雙 runtime)`);
  onProgress?.(useGPU ? '去背中 (GPU 加速)...' : '去背中 (CPU)...');

  const result = await _bgRemoveModule.removeBackground(blob, {
    model: 'isnet_quint8',
    device: useGPU ? 'gpu' : 'cpu',
    progress: (key, current, total) => {
      if (total) {
        const pct = Math.round((current / total) * 100);
        if (key && key.includes('fetch')) {
          onProgress?.(`下載模型 ${pct}%`);
        } else {
          onProgress?.(`處理中 ${pct}%`);
        }
      }
    },
    output: { format: 'image/png' },
  });
  return result; // Blob
}

// ===== Save / Delete Item =====
async function saveItem() {
  collectFormIntoEditingItem();
  const ed = state.editingItem;
  if (!ed.imageID) { showToast('請先選擇照片', true); return; }
  if (!ed.categoryID) { showToast('請選擇類型', true); return; }

  const existing = ed.id ? state.items.find(i => i.id === ed.id) : null;
  const item = existing || {
    id: uuid(),
    imageID: ed.imageID,
    season: ed.season,
    categoryID: ed.categoryID,
    style: ed.style,
    brand: ed.brand,
    price: ed.price,
    status: ed.status,
    purchaseDate: ed.purchaseDate,
    notes: ed.notes,
  };

  if (existing) {
    Object.assign(existing, {
      imageID: ed.imageID,
      season: ed.season,
      categoryID: ed.categoryID,
      style: ed.style,
      brand: ed.brand,
      price: ed.price,
      status: ed.status,
      purchaseDate: ed.purchaseDate,
      notes: ed.notes,
    });
    await dbPut('items', existing);
  } else {
    await dbPut('items', item);
    state.items.push(item);
  }

  state.items.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));
  clearDraft();
  state.editingItem = null;
  state.currentView = 'closet';
  showToast(existing ? '已更新' : '已儲存');
  renderApp();
}

async function deleteItem() {
  const it = state.editingItem;
  if (!it || !it.id) return;
  await dbDelete('items', it.id);
  if (it.imageID) await dbDelete('images', it.imageID);
  state.imageCache.delete(it.imageID);
  state.items = state.items.filter(x => x.id !== it.id);
  state.editingItem = null;
  state.currentView = 'closet';
  showToast('已刪除');
  renderApp();
}

// ===== Backup Export / Import =====
async function exportBackup() {
  const overlay = createLoadingScreen('準備備份...');
  try {
    const zip = new JSZip();

    // data.json compatible with Swift BackupService schema
    const data = {
      version: 1,
      categories: state.categories.map(c => ({
        id: c.id.toUpperCase(),
        name: c.name,
        isDefault: c.isDefault,
        sortOrder: c.sortOrder,
      })),
      items: state.items.map(it => ({
        id: it.id.toUpperCase(),
        imageID: it.imageID.toUpperCase(),
        season: it.season,
        categoryID: it.categoryID ? it.categoryID.toUpperCase() : null,
        style: it.style || '',
        brand: it.brand || '',
        price: it.price || 0,
        status: it.status,
        purchaseDate: it.purchaseDate,
        notes: it.notes || '',
      })),
    };
    zip.file('data.json', JSON.stringify(data, null, 2));

    // images
    const imagesFolder = zip.folder('images');
    for (const it of state.items) {
      if (!it.imageID) continue;
      const blob = await dbGet('images', it.imageID);
      if (blob) imagesFolder.file(`${it.imageID.toUpperCase()}.png`, blob);
    }

    overlay.update('壓縮中...');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const ts = new Date().toISOString().slice(0,16).replace(/[:T]/g, '-');
    const filename = `VirtualCloset_Backup_${ts}.zip`;

    // Try Web Share API for iOS (supports sharing to Files / iCloud)
    const file = new File([zipBlob], filename, { type: 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        overlay.close();
        return;
      } catch { /* fall through to download */ }
    }
    // Fallback: download
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    overlay.close();
    showToast('已匯出');
  } catch (err) {
    console.error(err);
    overlay.close();
    showToast('匯出失敗：' + err.message, true);
  }
}

async function handleImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const overlay = createLoadingScreen('讀取備份...');
  try {
    const zip = await JSZip.loadAsync(file);
    const dataFile = zip.file('data.json') || zip.file(/.*\/data\.json$/)[0];
    if (!dataFile) throw new Error('找不到 data.json');
    const dataText = await dataFile.async('string');
    const backup = JSON.parse(dataText);

    if (!backup.categories || !backup.items) throw new Error('備份格式錯誤');

    overlay.update('合併分類...');
    // Merge categories: by ID first, then by name
    const existingByIdLower = new Map(state.categories.map(c => [normalizeId(c.id), c]));
    const existingByName = new Map(state.categories.map(c => [c.name, c]));
    const idMap = new Map(); // backup ID (lower) -> live category ID

    for (const dto of backup.categories) {
      const lid = normalizeId(dto.id);
      if (existingByIdLower.has(lid)) {
        const live = existingByIdLower.get(lid);
        live.name = dto.name;
        live.isDefault = dto.isDefault;
        live.sortOrder = dto.sortOrder;
        await dbPut('categories', live);
        idMap.set(lid, live.id);
      } else if (existingByName.has(dto.name)) {
        const live = existingByName.get(dto.name);
        idMap.set(lid, live.id);
      } else {
        const newCat = {
          id: dto.id, // keep original (mixed case OK)
          name: dto.name,
          isDefault: !!dto.isDefault,
          sortOrder: dto.sortOrder ?? state.categories.length,
        };
        await dbPut('categories', newCat);
        state.categories.push(newCat);
        existingByIdLower.set(lid, newCat);
        existingByName.set(dto.name, newCat);
        idMap.set(lid, newCat.id);
      }
    }

    overlay.update('合併衣物...');
    const existingItemsByIdLower = new Map(state.items.map(i => [normalizeId(i.id), i]));

    let importedCount = 0;
    for (const dto of backup.items) {
      const lid = normalizeId(dto.id);
      const liveCategoryID = dto.categoryID ? idMap.get(normalizeId(dto.categoryID)) || null : null;

      const itemData = {
        imageID: dto.imageID,
        season: dto.season,
        categoryID: liveCategoryID,
        style: dto.style || '',
        brand: dto.brand || '',
        price: dto.price || 0,
        status: dto.status,
        purchaseDate: dto.purchaseDate,
        notes: dto.notes || '',
      };

      if (existingItemsByIdLower.has(lid)) {
        const live = existingItemsByIdLower.get(lid);
        Object.assign(live, itemData);
        await dbPut('items', live);
      } else {
        const newItem = { id: dto.id, ...itemData };
        await dbPut('items', newItem);
        state.items.push(newItem);
        existingItemsByIdLower.set(lid, newItem);
      }
      importedCount++;
    }

    overlay.update('匯入圖片...');
    const imagesFolder = zip.folder('images');
    let imageCount = 0;
    if (imagesFolder) {
      const entries = [];
      zip.forEach((path, entry) => {
        if (!entry.dir && /^images\/.+\.(png|jpg|jpeg)$/i.test(path)) entries.push(entry);
      });
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        overlay.update(`匯入圖片 ${i+1}/${entries.length}...`);
        const blob = await entry.async('blob');
        // Filename is "{UUID}.png", key into our store is the UUID exactly as stored
        const filename = entry.name.split('/').pop();
        const imageID = filename.replace(/\.(png|jpg|jpeg)$/i, '');
        // Match item's imageID (could be upper/lower); store under the exact case used in items
        const matchingItem = state.items.find(it => normalizeId(it.imageID) === normalizeId(imageID));
        const storeKey = matchingItem ? matchingItem.imageID : imageID;
        await dbPut('images', blob, storeKey);
        imageCount++;
      }
    }

    state.items.sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));
    clearImageCache();
    overlay.close();
    showToast(`匯入成功：${importedCount} 件衣物 / ${imageCount} 張圖`);
    renderApp();
  } catch (err) {
    console.error(err);
    overlay.close();
    showToast('匯入失敗：' + err.message, true);
  } finally {
    e.target.value = '';
  }
}

// ===== Loading Screen =====
function createLoadingScreen(initial) {
  const div = document.createElement('div');
  div.className = 'loading-screen';
  div.innerHTML = `<div class="big-spinner"></div><div class="progress-text">${escapeHTML(initial)}</div>`;
  document.body.appendChild(div);
  return {
    update(text) {
      const t = div.querySelector('.progress-text');
      if (t) t.textContent = text;
    },
    close() { div.remove(); },
  };
}

// ===== Boot =====
init().catch(err => {
  console.error('啟動失敗', err);
  document.body.innerHTML = `<div style="padding:40px;color:#fff;">啟動失敗：${err.message}</div>`;
});

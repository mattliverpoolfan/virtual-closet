// ============================================================
// 花我最多錢 - Virtual Closet PWA
// ============================================================
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

// ===== Constants =====
const SEASONS = ['春&秋', '夏', '冬'];
const STATUSES = ['堪用', '淘汰'];
const DEFAULT_CATEGORIES = ['襯衫', '外套', '褲子', '套頭衫', 'T 恤'];

const SORTS = {
  'date-desc':  { label: '最新購買', fn: (a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate) },
  'date-asc':   { label: '最早購買', fn: (a, b) => new Date(a.purchaseDate) - new Date(b.purchaseDate) },
  'price-desc': { label: '價格高→低', fn: (a, b) => (b.price || 0) - (a.price || 0) },
  'price-asc':  { label: '價格低→高', fn: (a, b) => (a.price || 0) - (b.price || 0) },
  'brand-asc':  { label: '品牌 A→Z', fn: (a, b) => (a.brand || '').localeCompare(b.brand || '', 'zh-Hant') },
};

const LS = {
  draft: 'vc-draft',
  lastBackup: 'vc-last-backup',
  bannerDismissed: 'vc-backup-banner-dismissed',
  autoCutout: 'vc-auto-cutout',
  sort: 'vc-sort',
};

const DAY = 86400000;

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
  sort: localStorage.getItem(LS.sort) || 'date-desc',
  currentView: 'closet',
  editingItem: null,
  processing: false,   // background removal in flight — blocks save
  formBaseline: null,  // serialized add/edit form at render time, for dirty check
};

const scrollPositions = {};

// ===== Utilities =====
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.random() * 16 | 0;
  return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
}));
const normalizeId = (id) => (id || '').toString().toLowerCase();

function escapeHTML(s) {
  return (s || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) {
  return 'NT$ ' + Math.round(n || 0).toLocaleString('zh-TW');
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function dateInputValue(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function relativeDays(ts) {
  const days = Math.floor((Date.now() - ts) / DAY);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function categoryOf(item) {
  return state.categories.find(c => normalizeId(c.id) === normalizeId(item.categoryID));
}

// ===== Toast =====
function showToast(msg, opts = {}) {
  const { error = false, actionLabel = null, onAction = null, duration = 2600 } = opts;
  const t = $('#toast');
  t.innerHTML = `<span class="toast-msg"></span>${actionLabel ? '<button class="toast-action" type="button"></button>' : ''}`;
  t.querySelector('.toast-msg').textContent = msg;
  if (actionLabel) {
    const btn = t.querySelector('.toast-action');
    btn.textContent = actionLabel;
    btn.onclick = () => { t.classList.add('hidden'); onAction?.(); };
  }
  t.classList.toggle('error', error);
  t.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add('hidden'), actionLabel ? Math.max(duration, 5000) : duration);
}

// ===== Images =====
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

let _imgObserver = null;
function observeImages() {
  if (!_imgObserver) {
    _imgObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        _imgObserver.unobserve(e.target);
        loadImageInto(e.target);
      }
    }, { rootMargin: '400px 0px' });
  }
  $$('img[data-img]:not([data-loaded])').forEach(img => _imgObserver.observe(img));
}

// Safari can skip IntersectionObserver callbacks while the page is backgrounded,
// leaving thumbnails blank on return. Re-arm whenever we become visible again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) observeImages();
});
window.addEventListener('pageshow', () => observeImages());

async function loadImageInto(img) {
  const url = await getImageURL(img.dataset.img);
  if (url) {
    img.src = url;
    img.dataset.loaded = '1';
    img.classList.add('loaded');
  }
}

// Load a small set of images immediately, in parallel (detail / edit previews)
async function loadImagesNow(selector) {
  await Promise.all($$(selector).map(loadImageInto));
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
  sortItems();

  // Restore add-item form if page was reloaded during bg removal
  restoreDraft();

  history.replaceState({ view: state.currentView }, '', '#' + state.currentView);
  renderApp();
}

// ===== Filtering / Sorting / Stats =====
function sortItems() {
  const fn = (SORTS[state.sort] || SORTS['date-desc']).fn;
  state.items.sort(fn);
}

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
      const cat = categoryOf(it);
      const haystack = [it.brand, it.style, it.notes, cat?.name].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function activeFilters() {
  const f = state.filter;
  const out = [];
  if (f.season) out.push({ key: 'season', label: f.season });
  if (f.categoryID) {
    const c = state.categories.find(x => normalizeId(x.id) === normalizeId(f.categoryID));
    out.push({ key: 'categoryID', label: c?.name || '分類' });
  }
  if (f.status) out.push({ key: 'status', label: f.status });
  if (f.brand) out.push({ key: 'brand', label: f.brand });
  if (f.style) out.push({ key: 'style', label: f.style });
  return out;
}

function computeStats() {
  const items = state.items;
  const count = items.length;
  const total = items.reduce((s, i) => s + (i.price || 0), 0);
  const avg = count ? total / count : 0;
  const most = items.filter(i => (i.price || 0) > 0).slice().sort((a, b) => b.price - a.price)[0] || null;

  const byCat = new Map();
  for (const it of items) {
    const key = categoryOf(it)?.name || '未分類';
    const cur = byCat.get(key) || { name: key, total: 0, count: 0 };
    cur.total += it.price || 0;
    cur.count++;
    byCat.set(key, cur);
  }
  const cats = [...byCat.values()].sort((a, b) => b.total - a.total || b.count - a.count);

  const byYear = new Map();
  for (const it of items) {
    const y = new Date(it.purchaseDate).getFullYear();
    if (isNaN(y)) continue;
    const cur = byYear.get(y) || { year: y, total: 0, count: 0 };
    cur.total += it.price || 0;
    cur.count++;
    byYear.set(y, cur);
  }
  const years = [...byYear.values()].sort((a, b) => a.year - b.year);

  const retired = items.filter(i => i.status === '淘汰');
  const retiredTotal = retired.reduce((s, i) => s + (i.price || 0), 0);

  return { count, total, avg, most, cats, years, retiredCount: retired.length, retiredTotal };
}

// ===== Backup freshness =====
function lastBackupTs() {
  return Number(localStorage.getItem(LS.lastBackup) || 0);
}

function markBackedUp() {
  localStorage.setItem(LS.lastBackup, String(Date.now()));
}

function shouldShowBackupBanner() {
  if (state.items.length === 0) return false;
  const dismissed = Number(localStorage.getItem(LS.bannerDismissed) || 0);
  if (Date.now() - dismissed < 7 * DAY) return false;
  const last = lastBackupTs();
  if (!last) return true;
  return Date.now() - last > 30 * DAY;
}

// ===== Rendering =====
function renderApp() {
  const app = $('#app');
  const v = state.currentView;
  if (v === 'closet') app.innerHTML = renderCloset();
  else if (v === 'add') app.innerHTML = renderAddEdit();
  else if (v === 'detail') app.innerHTML = renderDetail();
  else if (v === 'settings') app.innerHTML = renderSettings();
  else if (v === 'categories') app.innerHTML = renderCategories();
  else if (v === 'stats') app.innerHTML = renderStats();

  bindEvents();
  restoreScroll();

  if (v === 'closet') observeImages();
  if (v === 'detail') loadImagesNow('.detail-image');
  if (v === 'add') {
    loadImagesNow('#preview-img');
    // Baseline represents the last *saved* state, so it survives in-place
    // re-renders (adding a category, swapping the photo). It is cleared on
    // entering/leaving the form, not on every render.
    if (state.formBaseline === null) state.formBaseline = serializeForm();
  }
}

function headerBar(left, title, right) {
  return `
    <div class="header">
      <div class="hdr-side hdr-left">${left || ''}</div>
      <h1 class="header-title">${title}</h1>
      <div class="hdr-side hdr-right">${right || ''}</div>
    </div>
  `;
}

function backBtn(action = 'back') {
  return `<button class="icon-btn" data-action="${action}" aria-label="返回">
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`;
}

// Single source of truth for a grid cell
function renderCell(it) {
  const cat = categoryOf(it);
  const retired = it.status === '淘汰';
  const primary = it.brand || cat?.name || '未分類';
  const secondary = [it.brand ? cat?.name : null, it.price > 0 ? money(it.price) : null].filter(Boolean).join(' · ');
  const alt = [it.brand, cat?.name, it.style].filter(Boolean).join(' ') || '衣物照片';
  return `
    <div class="grid-cell ${retired ? 'retired' : ''}" data-action="open-detail" data-id="${escapeHTML(it.id)}" role="button" tabindex="0">
      <div class="cell-image-wrap">
        <img data-img="${escapeHTML(it.imageID)}" alt="${escapeHTML(alt)}"/>
        ${retired ? '<span class="cell-badge">已淘汰</span>' : ''}
      </div>
      <div class="cell-meta">
        <div class="cell-primary">${escapeHTML(primary)}</div>
        <div class="cell-secondary">${escapeHTML(secondary || it.season)}</div>
      </div>
    </div>
  `;
}

function renderCloset() {
  const items = getFilteredItems();
  const cells = items.map(renderCell).join('');
  const filters = activeFilters();
  const hasFilter = filters.length > 0 || state.filter.search.trim() !== '';

  const empty = items.length === 0
    ? `<div class="empty">${state.items.length === 0
        ? '尚未新增任何衣物<br/>點右上角 ＋ 開始建立你的衣櫃'
        : '找不到符合條件的衣物'}</div>`
    : '';

  const banner = shouldShowBackupBanner()
    ? `<div class="banner">
         <span class="banner-text">${lastBackupTs() ? '已超過 30 天沒有備份' : '你還沒有備份過資料'}，資料只存在這支裝置上。</span>
         <button class="banner-btn" data-action="export">立即備份</button>
         <button class="banner-close" data-action="dismiss-banner" aria-label="關閉提醒">✕</button>
       </div>`
    : '';

  const chipsRow = filters.length
    ? `<div class="active-filters">
         ${filters.map(f => `<button class="chip removable" data-action="remove-filter" data-key="${f.key}">${escapeHTML(f.label)}<span class="x">✕</span></button>`).join('')}
         <button class="chip clear-all" data-action="clear-filter">全部清除</button>
       </div>`
    : '';

  return `
    <div class="view active">
      ${headerBar(
        `<button class="icon-btn" data-action="open-settings" aria-label="設定">
           <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5m7.43-2.53a7.6 7.6 0 0 0 0-1.94l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.3 7.3 0 0 0-1.69-.98l-.38-2.65a.5.5 0 0 0-.49-.42h-4a.5.5 0 0 0-.49.42l-.38 2.65a7.3 7.3 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65a7.6 7.6 0 0 0 0 1.94L2.49 14.6a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1a7.3 7.3 0 0 0 1.69.98l.38 2.65a.5.5 0 0 0 .49.42h4a.5.5 0 0 0 .49-.42l.38-2.65a7.3 7.3 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64Z"/></svg>
         </button>
         <button class="icon-btn" data-action="open-stats" aria-label="統計">
           <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 20h3V10H4zm6.5 0h3V4h-3zM17 20h3v-8h-3z"/></svg>
         </button>`,
        '花我最多錢',
        `<button class="primary-btn" data-action="open-add">＋ Add</button>`
      )}
      ${banner}
      <div class="search-row">
        <div class="search-box">
          <span aria-hidden="true">🔍</span>
          <input type="text" placeholder="搜尋品牌、風格、分類" id="search-input" value="${escapeHTML(state.filter.search)}" aria-label="搜尋"/>
          ${state.filter.search ? '<button class="search-clear" data-action="clear-search" aria-label="清除搜尋">✕</button>' : ''}
        </div>
        <button class="filter-btn ${hasFilter ? 'has-filter' : ''}" data-action="open-filter" aria-label="篩選與排序">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 7h16v2H4zm3 4h10v2H7zm3 4h4v2h-4z"/></svg>
          ${filters.length ? `<span class="filter-badge">${filters.length}</span>` : ''}
        </button>
      </div>
      ${chipsRow}
      <div class="count-bar" id="item-count-bar">${countLabel(items.length)}</div>
      ${empty}
      <div class="grid">${cells}</div>
    </div>
  `;
}

function countLabel(n) {
  const total = state.items.length;
  return n === total ? `${n} 件` : `${n} / ${total} 件`;
}

function renderDetail() {
  const it = state.editingItem;
  if (!it) { state.currentView = 'closet'; return renderCloset(); }
  const cat = categoryOf(it);
  const alt = [it.brand, cat?.name].filter(Boolean).join(' ') || '衣物照片';
  return `
    <div class="view active">
      ${headerBar(backBtn(), '詳細資訊', `<button class="text-btn bold" data-action="open-edit">編輯</button>`)}
      <div class="scroll-content">
        <div class="detail-image-wrap">
          <img class="detail-image" data-img="${escapeHTML(it.imageID)}" alt="${escapeHTML(alt)}"/>
          ${it.status === '淘汰' ? '<span class="cell-badge lg">已淘汰</span>' : ''}
        </div>
        <div class="detail-row"><span class="label">品牌</span><span class="value">${escapeHTML(it.brand || '-')}</span></div>
        <div class="detail-row"><span class="label">類型</span><span class="value">${escapeHTML(cat?.name || '未分類')}</span></div>
        <div class="detail-row"><span class="label">風格</span><span class="value">${escapeHTML(it.style || '-')}</span></div>
        <div class="detail-row"><span class="label">季節</span><span class="value">${escapeHTML(it.season)}</span></div>
        <div class="detail-row"><span class="label">價格</span><span class="value">${it.price > 0 ? money(it.price) : '-'}</span></div>
        <div class="detail-row"><span class="label">狀態</span><span class="value">${escapeHTML(it.status)}</span></div>
        <div class="detail-row"><span class="label">購買日期</span><span class="value">${formatDate(it.purchaseDate)}</span></div>
        <div class="detail-row"><span class="label">備註</span><span class="value">${escapeHTML(it.notes || '-')}</span></div>
        <div class="spacer-24"></div>
        <button class="action-btn danger" data-action="delete-item">刪除這件</button>
        <div class="spacer-32"></div>
      </div>
    </div>
  `;
}

function renderAddEdit() {
  const editing = !!(state.editingItem && state.editingItem.id);
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
  const autoCut = localStorage.getItem(LS.autoCutout) !== '0';
  const seasonOpts = SEASONS.map(s => `<option value="${s}" ${s === it.season ? 'selected' : ''}>${s}</option>`).join('');
  const statusOpts = STATUSES.map(s => `<option value="${s}" ${s === it.status ? 'selected' : ''}>${s}</option>`).join('');
  const catOpts = state.categories.map(c =>
    `<option value="${escapeHTML(c.id)}" ${normalizeId(c.id) === normalizeId(it.categoryID) ? 'selected' : ''}>${escapeHTML(c.name)}</option>`
  ).join('');

  const canSave = !!it.imageID && !state.processing;

  return `
    <div class="view active">
      ${headerBar(
        backBtn(),
        editing ? '編輯項目' : '添加項目',
        `<button class="text-btn bold" data-action="save-item" ${canSave ? '' : 'disabled'}>完成</button>`
      )}
      <div class="scroll-content">
        <div class="form-section">
          <h2 class="section-title">照片 <span class="req">必填</span></h2>
          <div class="photo-area" id="photo-area">
            ${it.imageID
              ? `<img id="preview-img" data-img="${escapeHTML(it.imageID)}" alt="目前選擇的照片"/>`
              : `
                <div class="photo-buttons">
                  <label class="photo-button">
                    <span class="ico" aria-hidden="true">📷</span><span>拍照</span>
                    <input type="file" accept="image/*" capture="environment" id="file-input" hidden/>
                  </label>
                  <label class="photo-button green">
                    <span class="ico" aria-hidden="true">🖼️</span><span>從相簿選擇</span>
                    <input type="file" accept="image/*" id="file-input-library" hidden/>
                  </label>
                </div>
              `}
          </div>
          <label class="switch-row">
            <span>自動去背</span>
            <input type="checkbox" id="f-autocut" ${autoCut ? 'checked' : ''}/>
          </label>
          <div id="processing" class="processing ${state.processing ? '' : 'hidden'}">
            <span class="spinner"></span><span id="processing-text">去背中...</span>
          </div>
          ${it.imageID ? '<button class="action-btn secondary" data-action="reshoot">重新拍照 / 選圖</button>' : ''}
        </div>

        <div class="form-section">
          <h2 class="section-title">細節</h2>
          <div class="form-row"><label for="f-season">季節</label>
            <div class="select-wrap"><select id="f-season">${seasonOpts}</select></div>
          </div>
          <div class="form-row"><label for="f-category">類型</label>
            <div class="select-wrap"><select id="f-category">${catOpts}<option value="__new__">＋ 新增分類…</option></select></div>
          </div>
          <div class="form-row"><label for="f-style">風格</label>
            <input type="text" id="f-style" value="${escapeHTML(it.style)}" placeholder="例：Casual"/>
          </div>
          <div class="form-row"><label for="f-brand">品牌</label>
            <input type="text" id="f-brand" value="${escapeHTML(it.brand)}" placeholder="例：Uniqlo"/>
          </div>
          <div class="form-row"><label for="f-date">購買日期</label>
            <input type="date" id="f-date" value="${dateInputValue(it.purchaseDate)}"/>
          </div>
          <div class="form-row"><label for="f-price">價格 NT$</label>
            <input type="number" id="f-price" value="${it.price || ''}" placeholder="0" inputmode="numeric" min="0"/>
          </div>
          <div class="form-row"><label for="f-status">狀態</label>
            <div class="select-wrap"><select id="f-status">${statusOpts}</select></div>
          </div>
          <div class="form-row column"><label for="f-notes">備註</label>
            <textarea id="f-notes" placeholder="備註">${escapeHTML(it.notes)}</textarea>
          </div>
        </div>

        ${editing ? '<button class="action-btn danger" data-action="delete-item">刪除這件</button>' : ''}
        <div class="spacer-32"></div>
      </div>
    </div>
  `;
}

function renderSettings() {
  const last = lastBackupTs();
  const stale = !last || Date.now() - last > 30 * DAY;
  return `
    <div class="view active">
      ${headerBar(backBtn(), '設定', `<button class="text-btn bold" data-action="back">完成</button>`)}
      <div class="scroll-content">
        <div class="form-section">
          <h2 class="section-title">資料移轉</h2>
          <button class="settings-row" data-action="export"><span class="ico" aria-hidden="true">⬆</span>匯出備份 (.zip)</button>
          <label class="settings-row">
            <span class="ico" aria-hidden="true">⬇</span>匯入備份 (.zip)
            <input type="file" accept=".zip,application/zip" id="import-input" hidden/>
          </label>
          <div class="backup-status ${stale ? 'stale' : 'ok'}">
            <span class="dot" aria-hidden="true"></span>
            上次備份：${last ? relativeDays(last) : '從未備份'}
          </div>
          <div class="settings-note">
            匯入時會與現有資料合併（同 ID 或同名分類會合併，不會重複）。<br/>
            支援從原 Swift App 匯出的備份（將資料夾壓縮成 .zip 即可）。
          </div>
        </div>

        <div class="form-section">
          <h2 class="section-title">衣櫃</h2>
          <button class="settings-row" data-action="open-categories"><span class="ico" aria-hidden="true">📂</span>管理分類</button>
          <button class="settings-row" data-action="open-stats"><span class="ico" aria-hidden="true">📊</span>花費統計</button>
        </div>

        <div class="settings-note">
          這是純本地運行的網頁 app — 你的資料只存在這支裝置的瀏覽器中，不會上傳任何地方。<br/>
          iOS 若長時間未開啟可能清除瀏覽器資料，建議定期匯出備份。
        </div>
        <div class="spacer-24"></div>
      </div>
    </div>
  `;
}

function renderCategories() {
  const list = state.categories.map(c => {
    const used = state.items.filter(i => normalizeId(i.categoryID) === normalizeId(c.id)).length;
    return `
      <li>
        <button class="cat-name" data-action="rename-category" data-id="${escapeHTML(c.id)}">
          <span>${escapeHTML(c.name)}</span>
          <span class="cat-count">${used} 件</span>
        </button>
        <button class="cat-delete" data-action="delete-category" data-id="${escapeHTML(c.id)}" aria-label="刪除 ${escapeHTML(c.name)}">刪除</button>
      </li>
    `;
  }).join('');
  return `
    <div class="view active">
      ${headerBar(backBtn(), '管理分類', `<button class="text-btn bold" data-action="add-category">＋ 新增</button>`)}
      <div class="scroll-content">
        <ul class="category-list">${list}</ul>
        ${state.categories.length === 0 ? '<div class="empty">尚無分類</div>' : ''}
        <div class="settings-note">點分類名稱可以重新命名。刪除分類不會刪除衣物，它們會變成「未分類」。</div>
      </div>
    </div>
  `;
}

function renderStats() {
  const s = computeStats();
  if (s.count === 0) {
    return `
      <div class="view active">
        ${headerBar(backBtn(), '花費統計', '')}
        <div class="scroll-content"><div class="empty">還沒有任何衣物<br/>新增之後這裡會顯示花費分析</div></div>
      </div>
    `;
  }

  const maxCat = Math.max(...s.cats.map(c => c.total), 1);
  const maxYear = Math.max(...s.years.map(y => y.total), 1);
  const mostCat = s.most ? categoryOf(s.most)?.name : null;

  return `
    <div class="view active">
      ${headerBar(backBtn(), '花費統計', '')}
      <div class="scroll-content">
        <div class="stat-hero">
          <div class="stat-hero-label">衣櫃總花費</div>
          <div class="stat-hero-value">${money(s.total)}</div>
          <div class="stat-hero-sub">${s.count} 件 · 平均 ${money(s.avg)} / 件</div>
        </div>

        ${s.most ? `
        <div class="form-section">
          <h2 class="section-title">最貴的一件</h2>
          <button class="most-card" data-action="open-detail" data-id="${escapeHTML(s.most.id)}">
            <div class="most-thumb"><img data-img="${escapeHTML(s.most.imageID)}" alt=""/></div>
            <div class="most-info">
              <div class="most-name">${escapeHTML(s.most.brand || mostCat || '未命名')}</div>
              <div class="most-sub">${escapeHTML([mostCat, formatDate(s.most.purchaseDate)].filter(Boolean).join(' · '))}</div>
            </div>
            <div class="most-price">${money(s.most.price)}</div>
          </button>
        </div>` : ''}

        <div class="form-section">
          <h2 class="section-title">分類花費</h2>
          ${s.cats.map(c => `
            <div class="bar-row">
              <div class="bar-head">
                <span class="bar-label">${escapeHTML(c.name)}</span>
                <span class="bar-value">${money(c.total)} <span class="bar-count">· ${c.count} 件</span></span>
              </div>
              <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (c.total / maxCat) * 100)}%"></div></div>
            </div>
          `).join('')}
        </div>

        ${s.years.length > 1 ? `
        <div class="form-section">
          <h2 class="section-title">逐年花費</h2>
          ${s.years.map(y => `
            <div class="bar-row">
              <div class="bar-head">
                <span class="bar-label">${y.year}</span>
                <span class="bar-value">${money(y.total)} <span class="bar-count">· ${y.count} 件</span></span>
              </div>
              <div class="bar-track"><div class="bar-fill alt" style="width:${Math.max(2, (y.total / maxYear) * 100)}%"></div></div>
            </div>
          `).join('')}
        </div>` : ''}

        ${s.retiredCount > 0 ? `
        <div class="form-section">
          <h2 class="section-title">已淘汰</h2>
          <div class="form-row static"><label>件數</label><span class="ro-value">${s.retiredCount} 件</span></div>
          <div class="form-row static"><label>沉沒成本</label><span class="ro-value">${money(s.retiredTotal)}</span></div>
          <div class="form-row static"><label>佔總花費</label><span class="ro-value">${s.total ? Math.round(s.retiredTotal / s.total * 100) : 0}%</span></div>
        </div>` : ''}

        <div class="spacer-32"></div>
      </div>
    </div>
  `;
}

// ===== Overlay: sheets & dialogs =====
let _overlayDismiss = null;

function overlayEl() {
  let ov = $('#overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'overlay';
    document.body.appendChild(ov);
  }
  return ov;
}

function isOverlayActive() {
  const ov = $('#overlay');
  return !!ov && ov.classList.contains('active');
}

function openOverlay(html, variant, onDismiss) {
  const ov = overlayEl();
  // NOTE: prefix the variant — the inner panel uses .sheet / .dialog, and an
  // unprefixed class here would make those rules apply to the overlay too.
  ov.className = `overlay overlay-${variant} active`;
  ov.innerHTML = html;
  _overlayDismiss = onDismiss || closeOverlayNow;
  ov.onclick = (e) => { if (e.target === ov) dismissOverlay(); };
}

function closeOverlayNow() {
  const ov = $('#overlay');
  if (ov) { ov.classList.remove('active'); ov.innerHTML = ''; }
  _overlayDismiss = null;
}

function dismissOverlay() {
  const fn = _overlayDismiss;
  _overlayDismiss = null;
  if (fn) fn(); else closeOverlayNow();
}

function showDialog({ title, message = '', input = null, okText = '確定', cancelText = '取消', danger = false }) {
  return new Promise(resolve => {
    const inputHTML = input
      ? `<input class="dialog-input" id="dialog-input" type="text" value="${escapeHTML(input.value || '')}" placeholder="${escapeHTML(input.placeholder || '')}" autocomplete="off"/>`
      : '';
    const finish = (val) => { closeOverlayNow(); resolve(val); };
    openOverlay(`
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-title">${escapeHTML(title)}</div>
        ${message ? `<div class="dialog-message">${escapeHTML(message)}</div>` : ''}
        ${inputHTML}
        <div class="dialog-actions">
          <button class="dialog-btn" data-dlg="cancel">${escapeHTML(cancelText)}</button>
          <button class="dialog-btn primary ${danger ? 'danger' : ''}" data-dlg="ok">${escapeHTML(okText)}</button>
        </div>
      </div>
    `, 'dialog', () => finish(null));

    const ov = $('#overlay');
    ov.querySelector('[data-dlg="cancel"]').onclick = () => finish(null);
    ov.querySelector('[data-dlg="ok"]').onclick = () => {
      if (input) {
        const v = ($('#dialog-input')?.value || '').trim();
        finish(v === '' ? null : v);
      } else finish(true);
    };
    if (input) {
      const el = $('#dialog-input');
      el.onkeydown = (e) => { if (e.key === 'Enter') ov.querySelector('[data-dlg="ok"]').click(); };
      setTimeout(() => { el.focus(); el.select(); }, 60);
    }
  });
}

const showConfirm = (title, message, opts = {}) => showDialog({ title, message, ...opts }).then(v => v === true);
const showPrompt = (title, opts = {}) => showDialog({
  title,
  input: { value: opts.value || '', placeholder: opts.placeholder || '' },
  okText: opts.okText || '確定',
});

// ===== Filter / Sort sheet =====
function openFilterSheet() {
  const cats = state.categories;
  const brands = [...new Set(state.items.map(i => i.brand).filter(Boolean))].sort();
  const styles = [...new Set(state.items.map(i => i.style).filter(Boolean))].sort();

  const chip = (label, key, value) =>
    `<button class="chip" data-filter-key="${key}" data-filter-value="${escapeHTML(value ?? '')}">${escapeHTML(label)}</button>`;

  const section = (title, key, values, labelFn = v => v, valueFn = v => v) => `
    <div class="filter-section">
      <h3>${title}</h3>
      <div class="chip-row">
        ${chip('全部', key, '')}
        ${values.map(v => chip(labelFn(v), key, valueFn(v))).join('')}
      </div>
    </div>`;

  openOverlay(`
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-header">
        <button class="text-btn" data-action="clear-filter">全部清除</button>
        <div class="sheet-title">篩選與排序</div>
        <button class="text-btn bold" data-action="close-sheet">完成</button>
      </div>
      <div class="sheet-content">
        <div class="filter-section">
          <h3>排序</h3>
          <div class="chip-row">
            ${Object.entries(SORTS).map(([k, v]) => `<button class="chip" data-sort-key="${k}">${escapeHTML(v.label)}</button>`).join('')}
          </div>
        </div>
        ${section('季節', 'season', SEASONS)}
        ${section('類型', 'categoryID', cats, c => c.name, c => c.id)}
        ${section('狀態', 'status', STATUSES)}
        ${brands.length ? section('品牌', 'brand', brands) : ''}
        ${styles.length ? section('風格', 'style', styles) : ''}
        <div class="spacer-24"></div>
      </div>
    </div>
  `, 'sheet', () => { closeOverlayNow(); renderApp(); });

  syncSheetChips();
  history.pushState({ view: state.currentView, sheet: true }, '', '#filter');
}

// Update chip active states in place — keeps the sheet's scroll position
function syncSheetChips() {
  $$('#overlay [data-filter-key]').forEach(btn => {
    const cur = state.filter[btn.dataset.filterKey];
    btn.classList.toggle('active', normalizeId(cur) === normalizeId(btn.dataset.filterValue));
  });
  $$('#overlay [data-sort-key]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sortKey === state.sort);
  });
}

// ===== Scroll persistence =====
function scrollContainer() {
  return $('.grid') || $('.scroll-content');
}

function saveScroll() {
  const el = scrollContainer();
  if (el) scrollPositions[state.currentView] = el.scrollTop;
}

function restoreScroll() {
  const el = scrollContainer();
  if (!el) return;
  el.scrollTop = scrollPositions[state.currentView] || 0;
}

// ===== Navigation (History API) =====
function navigate(view) {
  saveScroll();
  if (view !== 'closet' && view !== state.currentView) scrollPositions[view] = 0;
  if (view === 'add') state.formBaseline = null;
  state.currentView = view;
  history.pushState({ view }, '', '#' + view);
  renderApp();
}

function applyView(view) {
  saveScroll();
  if (view === 'closet') state.editingItem = null;
  if (view !== 'add') state.formBaseline = null;
  state.currentView = view;
  renderApp();
}

let _skipDirtyCheck = false;

window.addEventListener('popstate', async (e) => {
  if (isOverlayActive()) {
    dismissOverlay();
    history.pushState({ view: state.currentView }, '', '#' + state.currentView);
    return;
  }
  const s = e.state || { view: 'closet' };

  if (state.currentView === 'add' && !_skipDirtyCheck && isFormDirty()) {
    history.pushState({ view: 'add' }, '', '#add');
    const ok = await showConfirm('放棄編輯？', '尚未儲存的變更會遺失。', { okText: '放棄', cancelText: '繼續編輯', danger: true });
    if (ok) { _skipDirtyCheck = true; clearDraft(); history.back(); }
    return;
  }
  _skipDirtyCheck = false;
  applyView(s.view || 'closet');
});

async function goBack() {
  if (state.currentView === 'add' && isFormDirty()) {
    const ok = await showConfirm('放棄編輯？', '尚未儲存的變更會遺失。', { okText: '放棄', cancelText: '繼續編輯', danger: true });
    if (!ok) return;
    clearDraft();
  }
  _skipDirtyCheck = true;
  history.back();
}

// ===== Form helpers =====
function serializeForm() {
  return JSON.stringify({
    season: $('#f-season')?.value ?? '',
    categoryID: $('#f-category')?.value ?? '',
    style: $('#f-style')?.value ?? '',
    brand: $('#f-brand')?.value ?? '',
    price: $('#f-price')?.value ?? '',
    status: $('#f-status')?.value ?? '',
    date: $('#f-date')?.value ?? '',
    notes: $('#f-notes')?.value ?? '',
    imageID: state.editingItem?.imageID || '',
  });
}

function isFormDirty() {
  if (state.currentView !== 'add' || !state.formBaseline) return false;
  return serializeForm() !== state.formBaseline;
}

function collectFormIntoEditingItem() {
  const ed = state.editingItem || {};
  ed.season = $('#f-season')?.value || ed.season || '春&秋';
  const catVal = $('#f-category')?.value;
  ed.categoryID = (catVal && catVal !== '__new__') ? catVal : (ed.categoryID || null);
  ed.style = $('#f-style')?.value ?? (ed.style || '');
  ed.brand = $('#f-brand')?.value ?? (ed.brand || '');
  ed.price = parseInt($('#f-price')?.value || '0', 10) || 0;
  ed.status = $('#f-status')?.value || ed.status || '堪用';
  const dateStr = $('#f-date')?.value;
  ed.purchaseDate = dateStr ? new Date(dateStr).toISOString() : (ed.purchaseDate || new Date().toISOString());
  ed.notes = $('#f-notes')?.value ?? (ed.notes || '');
  state.editingItem = ed;
}

// ===== Event Binding =====
function bindEvents() {
  document.body.onclick = handleClick;

  const search = $('#search-input');
  if (search) {
    search.oninput = (e) => {
      state.filter.search = e.target.value;
      const grid = $('.grid');
      if (!grid) return;
      const items = getFilteredItems();
      grid.innerHTML = items.map(renderCell).join('');
      observeImages();
      const bar = $('#item-count-bar');
      if (bar) bar.textContent = countLabel(items.length);
    };
  }

  const fileInput = $('#file-input');
  if (fileInput) fileInput.onchange = handleImageSelected;
  const fileInputLib = $('#file-input-library');
  if (fileInputLib) fileInputLib.onchange = handleImageSelected;

  const importInput = $('#import-input');
  if (importInput) importInput.onchange = handleImportFile;

  const autoCut = $('#f-autocut');
  if (autoCut) autoCut.onchange = (e) => localStorage.setItem(LS.autoCutout, e.target.checked ? '1' : '0');

  const catSelect = $('#f-category');
  if (catSelect) {
    catSelect.dataset.prev = catSelect.value;
    catSelect.onchange = async (e) => {
      if (e.target.value !== '__new__') { e.target.dataset.prev = e.target.value; return; }
      e.target.value = e.target.dataset.prev || (state.categories[0]?.id || '');
      const name = await showPrompt('新增分類', { placeholder: '分類名稱', okText: '新增' });
      if (!name) return;
      const cat = { id: uuid(), name, isDefault: false, sortOrder: state.categories.length };
      await dbPut('categories', cat);
      state.categories.push(cat);
      collectFormIntoEditingItem();
      state.editingItem.categoryID = cat.id;
      renderApp();
      showToast(`已新增「${name}」`);
    };
  }

  // Keyboard activation for grid cells
  $$('.grid-cell').forEach(cell => {
    cell.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cell.click(); }
    };
  });
}

async function handleClick(e) {
  // Sort chips
  const sortBtn = e.target.closest('[data-sort-key]');
  if (sortBtn) {
    state.sort = sortBtn.dataset.sortKey;
    localStorage.setItem(LS.sort, state.sort);
    sortItems();
    syncSheetChips();
    return;
  }

  // Filter chips (inside sheet) — update in place, no re-render
  const chip = e.target.closest('[data-filter-key]');
  if (chip && !e.target.closest('[data-action]')) {
    const key = chip.dataset.filterKey;
    const val = chip.dataset.filterValue;
    state.filter[key] = val === '' ? null : val;
    syncSheetChips();
    return;
  }

  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  switch (action) {
    case 'back':
      await goBack();
      break;

    case 'open-add':
      state.editingItem = null;
      navigate('add');
      break;

    case 'open-detail': {
      const it = state.items.find(i => i.id === id);
      if (it) { state.editingItem = it; navigate('detail'); }
      break;
    }

    case 'open-edit':
      navigate('add');
      break;

    case 'open-settings':
      navigate('settings');
      break;

    case 'open-categories':
      navigate('categories');
      break;

    case 'open-stats':
      navigate('stats');
      setTimeout(() => loadImagesNow('.most-thumb img'), 0);
      break;

    case 'open-filter':
      openFilterSheet();
      break;

    case 'close-sheet':
      closeOverlayNow();
      history.back();
      renderApp();
      break;

    case 'clear-search':
      state.filter.search = '';
      renderApp();
      break;

    case 'remove-filter':
      state.filter[target.dataset.key] = null;
      renderApp();
      break;

    case 'clear-filter':
      state.filter.season = null;
      state.filter.categoryID = null;
      state.filter.status = null;
      state.filter.brand = null;
      state.filter.style = null;
      state.filter.search = '';
      if (isOverlayActive()) { syncSheetChips(); }
      else renderApp();
      break;

    case 'dismiss-banner':
      localStorage.setItem(LS.bannerDismissed, String(Date.now()));
      renderApp();
      break;

    case 'reshoot': {
      collectFormIntoEditingItem();
      state.editingItem.imageID = null;
      renderApp();
      break;
    }

    case 'save-item':
      await saveItem();
      break;

    case 'delete-item': {
      const ok = await showConfirm('刪除這件衣物？', '刪除後可以在提示中復原。', { okText: '刪除', danger: true });
      if (ok) await deleteItem();
      break;
    }

    case 'export':
      await exportBackup();
      break;

    case 'add-category': {
      const name = await showPrompt('新增分類', { placeholder: '分類名稱', okText: '新增' });
      if (!name) break;
      const cat = { id: uuid(), name, isDefault: false, sortOrder: state.categories.length };
      await dbPut('categories', cat);
      state.categories.push(cat);
      renderApp();
      break;
    }

    case 'rename-category': {
      const cat = state.categories.find(c => c.id === id);
      if (!cat) break;
      const newName = await showPrompt('修改分類名稱', { value: cat.name, okText: '儲存' });
      if (!newName || newName === cat.name) break;
      cat.name = newName;
      await dbPut('categories', cat);
      renderApp();
      break;
    }

    case 'delete-category': {
      const cat = state.categories.find(c => c.id === id);
      if (!cat) break;
      const usedBy = state.items.filter(i => normalizeId(i.categoryID) === normalizeId(id)).length;
      const ok = await showConfirm(
        `刪除「${cat.name}」？`,
        usedBy > 0 ? `有 ${usedBy} 件衣物使用這個分類，刪除後它們會變成「未分類」。` : '這個分類目前沒有衣物使用。',
        { okText: '刪除', danger: true }
      );
      if (!ok) break;
      await dbDelete('categories', cat.id);
      state.categories = state.categories.filter(c => c.id !== cat.id);
      for (const it of state.items) {
        if (normalizeId(it.categoryID) === normalizeId(id)) {
          it.categoryID = null;
          await dbPut('items', it);
        }
      }
      renderApp();
      break;
    }
  }
}

// ===== Image handling =====
async function handleImageSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const autoCut = localStorage.getItem(LS.autoCutout) !== '0';
  collectFormIntoEditingItem();

  let blob;
  try {
    blob = await readImageAsBlob(file);
  } catch (err) {
    showToast('圖片讀取失敗：' + err.message, { error: true });
    return;
  }

  const imageID = state.editingItem?.imageID || uuid();
  try {
    await dbPut('images', blob, imageID);
  } catch (err) {
    showToast('儲存圖片失敗：' + err.message, { error: true });
    return;
  }
  state.imageCache.delete(imageID);
  if (!state.editingItem) state.editingItem = {};
  state.editingItem.imageID = imageID;

  saveDraft();

  if (!autoCut) {
    clearDraft();
    renderApp();
    return;
  }

  state.processing = true;
  renderApp();
  const processingText = $('#processing-text');
  if (processingText) processingText.textContent = '載入去背模型...';

  try {
    const processed = await removeBackground(blob, (progress) => {
      const el = $('#processing-text');
      if (el) el.textContent = progress;
    });
    await dbPut('images', processed, imageID);
    state.imageCache.delete(imageID);
    clearDraft();
  } catch (err) {
    console.error('[去背流程失敗]', err?.message || err);
    showToast('去背失敗，使用原圖', { error: true });
    clearDraft();
  } finally {
    state.processing = false;
    renderApp();
  }
}

// ===== Draft Persistence (survives iOS Safari page reload) =====
function saveDraft() {
  if (!state.editingItem) return;
  try { localStorage.setItem(LS.draft, JSON.stringify(state.editingItem)); } catch {}
}

function clearDraft() {
  try { localStorage.removeItem(LS.draft); } catch {}
}

function restoreDraft() {
  try {
    const raw = localStorage.getItem(LS.draft);
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

async function hasWebGPU() {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

// iOS Safari — force CPU-only to avoid WebGPU+WASM dual-runtime memory blowup
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
}

async function removeBackground(blob, onProgress) {
  if (!_bgRemoveModule) {
    onProgress?.('下載去背模型 (首次約 40MB，會被瀏覽器快取)...');
    _bgRemoveModule = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.6.0/+esm');
  }
  const useGPU = !isIOS() && await hasWebGPU();
  onProgress?.(useGPU ? '去背中 (GPU 加速)...' : '去背中 (CPU)...');

  return await _bgRemoveModule.removeBackground(blob, {
    model: 'isnet_quint8',
    device: useGPU ? 'gpu' : 'cpu',
    progress: (key, current, total) => {
      if (!total) return;
      const pct = Math.round((current / total) * 100);
      onProgress?.(key && key.includes('fetch') ? `下載模型 ${pct}%` : `處理中 ${pct}%`);
    },
    output: { format: 'image/png' },
  });
}

// ===== Save / Delete Item =====
async function saveItem() {
  if (state.processing) { showToast('去背處理中，請稍候', { error: true }); return; }
  collectFormIntoEditingItem();
  const ed = state.editingItem;
  if (!ed.imageID) { showToast('請先選擇照片', { error: true }); return; }
  if (!ed.categoryID) { showToast('請選擇類型', { error: true }); return; }

  const existing = ed.id ? state.items.find(i => i.id === ed.id) : null;
  const fields = {
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
    Object.assign(existing, fields);
    await dbPut('items', existing);
  } else {
    const item = { id: uuid(), ...fields };
    await dbPut('items', item);
    state.items.push(item);
  }

  sortItems();
  clearDraft();
  state.editingItem = null;
  state.formBaseline = null;
  showToast(existing ? '已更新' : '已儲存');
  _skipDirtyCheck = true;
  state.currentView = 'closet';
  history.pushState({ view: 'closet' }, '', '#closet');
  renderApp();
}

async function deleteItem() {
  const it = state.editingItem;
  if (!it || !it.id) return;

  const blob = it.imageID ? await dbGet('images', it.imageID) : null;
  await dbDelete('items', it.id);
  if (it.imageID) {
    await dbDelete('images', it.imageID);
    state.imageCache.delete(it.imageID);
  }
  state.items = state.items.filter(x => x.id !== it.id);
  state.editingItem = null;
  state.formBaseline = null;
  _skipDirtyCheck = true;
  state.currentView = 'closet';
  history.pushState({ view: 'closet' }, '', '#closet');
  renderApp();

  showToast('已刪除', {
    actionLabel: '復原',
    onAction: async () => {
      await dbPut('items', it);
      if (blob) await dbPut('images', blob, it.imageID);
      state.items.push(it);
      sortItems();
      renderApp();
      showToast('已復原');
    },
  });
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

    const imagesFolder = zip.folder('images');
    for (const it of state.items) {
      if (!it.imageID) continue;
      const blob = await dbGet('images', it.imageID);
      if (blob) imagesFolder.file(`${it.imageID.toUpperCase()}.png`, blob);
    }

    overlay.update('壓縮中...');
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const filename = `VirtualCloset_Backup_${ts}.zip`;

    // Web Share API (iOS: share to Files / iCloud)
    const file = new File([zipBlob], filename, { type: 'application/zip' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        markBackedUp();
        overlay.close();
        showToast('已匯出');
        renderApp();
        return;
      } catch (err) {
        overlay.close();
        // User cancelled the share sheet — do not claim success
        if (err?.name === 'AbortError') { showToast('已取消匯出'); return; }
        // Sharing genuinely failed: fall through to download
        overlay.reopen?.();
      }
    }

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    markBackedUp();
    overlay.close();
    showToast('已匯出');
    renderApp();
  } catch (err) {
    console.error(err);
    overlay.close();
    showToast('匯出失敗：' + err.message, { error: true });
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
    const backup = JSON.parse(await dataFile.async('string'));
    if (!backup.categories || !backup.items) throw new Error('備份格式錯誤');

    // Preview & confirm before mutating anything
    const existingIds = new Set(state.items.map(i => normalizeId(i.id)));
    const incoming = backup.items.length;
    const updates = backup.items.filter(d => existingIds.has(normalizeId(d.id))).length;
    const additions = incoming - updates;
    overlay.close();

    const ok = await showConfirm(
      '確認匯入？',
      `這份備份包含 ${incoming} 件衣物、${backup.categories.length} 個分類。\n將新增 ${additions} 件、更新 ${updates} 件。`,
      { okText: '匯入' }
    );
    if (!ok) { e.target.value = ''; return; }

    const ov2 = createLoadingScreen('合併分類...');
    const existingByIdLower = new Map(state.categories.map(c => [normalizeId(c.id), c]));
    const existingByName = new Map(state.categories.map(c => [c.name, c]));
    const idMap = new Map();

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
        idMap.set(lid, existingByName.get(dto.name).id);
      } else {
        const newCat = {
          id: dto.id,
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

    ov2.update('合併衣物...');
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
        Object.assign(existingItemsByIdLower.get(lid), itemData);
        await dbPut('items', existingItemsByIdLower.get(lid));
      } else {
        const newItem = { id: dto.id, ...itemData };
        await dbPut('items', newItem);
        state.items.push(newItem);
        existingItemsByIdLower.set(lid, newItem);
      }
      importedCount++;
    }

    ov2.update('匯入圖片...');
    const entries = [];
    zip.forEach((path, entry) => {
      if (!entry.dir && /^images\/.+\.(png|jpg|jpeg)$/i.test(path)) entries.push(entry);
    });
    let imageCount = 0;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      ov2.update(`匯入圖片 ${i + 1}/${entries.length}...`);
      const blob = await entry.async('blob');
      const filename = entry.name.split('/').pop();
      const imageID = filename.replace(/\.(png|jpg|jpeg)$/i, '');
      const matchingItem = state.items.find(it => normalizeId(it.imageID) === normalizeId(imageID));
      await dbPut('images', blob, matchingItem ? matchingItem.imageID : imageID);
      imageCount++;
    }

    sortItems();
    clearImageCache();
    ov2.close();
    showToast(`匯入成功：${importedCount} 件衣物 / ${imageCount} 張圖`);
    renderApp();
  } catch (err) {
    console.error(err);
    overlay.close();
    showToast('匯入失敗：' + err.message, { error: true });
  } finally {
    e.target.value = '';
  }
}

// ===== Loading Screen =====
function createLoadingScreen(initial) {
  const div = document.createElement('div');
  div.className = 'loading-screen';
  div.innerHTML = `<div class="big-spinner"></div><div class="progress-text"></div>`;
  div.querySelector('.progress-text').textContent = initial;
  document.body.appendChild(div);
  return {
    update(text) {
      const t = div.querySelector('.progress-text');
      if (t) t.textContent = text;
    },
    reopen() { if (!div.isConnected) document.body.appendChild(div); },
    close() { div.remove(); },
  };
}

// ===== Boot =====
init().catch(err => {
  console.error('啟動失敗', err);
  const app = $('#app');
  app.innerHTML = `
    <div class="boot-error">
      <div class="boot-error-title">啟動失敗</div>
      <div class="boot-error-msg"></div>
      <button class="action-btn" onclick="location.reload()">重新載入</button>
    </div>`;
  app.querySelector('.boot-error-msg').textContent = err.message;
});

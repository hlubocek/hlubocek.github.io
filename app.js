(function () {
'use strict';

// ════════════════════════════════════════
// KONFIGURACE
// ════════════════════════════════════════
const LOCATION  = 'Hluboček';
const SPECIES   = 'Kapr';
const MIN_LEN   = 45;
const MAX_LEN   = 60;
const FEE_VISIT = 300;  // poplatek za návštěvu / 24 h (dle řádu; návštěva si nesmí přisvojit rybu)

const BASE_URL  = 'https://hlubocek.github.io';

// Výchozí Firebase – databáze hlubocek (všichni uživatelé se k ní automaticky připojí).
const FB_CONFIG = {
    apiKey:      'AIzaSyBjFVu6IoWeEQOv1vevEKctAlMOMgAoc2E',
    databaseURL: 'https://hlubocek-default-rtdb.europe-west1.firebasedatabase.app',
    projectId:   'hlubocek'
};

const LS = {
    FISHERS:   'hlb_fishers',
    CHECKINS:  'hlb_checkins',
    CATCHES:   'hlb_catches',
    VISITORS:  'hlb_visitors',
    FB_URL:    'hlb_fb_url',
    FB_KEY:   'hlb_fb_key',
    ADMIN:     'hlb_admin',
    ADMIN_PIN: 'hlb_admin_pin'
};

// ════════════════════════════════════════
// DATA VRSTVA
// ════════════════════════════════════════
let db = null, fbReady = false;

let fishers  = [];
let checkins = [];
let catches  = [];
let visitors = [];

function lsLoad(k)    { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } }
function lsSave(k, d) { localStorage.setItem(k, JSON.stringify(d)); }
function genId()      { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

function initFirebase(dbUrl, apiKey) {
    try {
        if (!dbUrl || !apiKey) return false;
        const cfg = { apiKey, databaseURL: dbUrl, projectId: dbUrl.match(/https:\/\/([^.]+)/)?.[1] || 'p' };
        if (firebase.apps.length === 0) firebase.initializeApp(cfg);
        db = firebase.database();
        fbReady = true;
        setupListeners();
        updateSyncBar();
        return true;
    } catch(e) { console.error(e); fbReady = false; return false; }
}

function setupListeners() {
    db.ref('fishers').on('value',  s => { fishers  = s.val() ? Object.values(s.val()) : []; lsSave(LS.FISHERS,  fishers);  rerender(); });
    db.ref('checkins').on('value', s => { checkins = s.val() ? Object.values(s.val()) : []; lsSave(LS.CHECKINS, checkins); rerender(); });
    db.ref('catches').on('value',  s => { catches  = s.val() ? Object.values(s.val()) : []; lsSave(LS.CATCHES,  catches);  rerender(); });
    db.ref('visitors').on('value', s => { visitors = s.val() ? Object.values(s.val()) : []; lsSave(LS.VISITORS, visitors); rerender(); });
}

function rerender() {
    renderFishers();
    populateFisherSelects();
    if (currentView === 'dochazka')   renderDochazka();
    if (currentView === 'ulovky')     renderUlovky();
    if (currentView === 'navstevy')   renderNavstevy();
    if (currentView === 'statistiky') renderStatistiky();
}

function dbSet(col, id, data) {
    if (fbReady) { db.ref(col + '/' + id).set(data); return; }
    const map = { fishers, checkins, catches, visitors };
    const arr = map[col];
    if (!arr) return;
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) arr[i] = data; else arr.push(data);
    lsSave(LS[col.toUpperCase()], arr);
}

function dbRemove(col, id) {
    if (fbReady) { db.ref(col + '/' + id).remove(); return; }
    const map = { fishers, checkins, catches, visitors };
    const arr = map[col];
    if (!arr) return;
    const i = arr.findIndex(x => x.id === id);
    if (i >= 0) arr.splice(i, 1);
    lsSave(LS[col.toUpperCase()], arr);
}

// ════════════════════════════════════════
// DOM HELPERS
// ════════════════════════════════════════
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const views = {
    rybari:     $('#view-rybari'),
    dochazka:   $('#view-dochazka'),
    ulovky:     $('#view-ulovky'),
    navstevy:   $('#view-navstevy'),
    statistiky: $('#view-statistiky')
};
const navBtns = $$('.nav-btn');

let currentView = 'rybari';

function switchView(name) {
    currentView = name;
    Object.values(views).forEach(v => v.classList.remove('active'));
    views[name].classList.add('active');
    navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === name));
    populateFisherSelects();
    if (name === 'rybari')     renderFishers();
    if (name === 'dochazka')   renderDochazka();
    if (name === 'ulovky')     renderUlovky();
    if (name === 'navstevy')   renderNavstevy();
    if (name === 'statistiky') renderStatistiky();
}
navBtns.forEach(b => b.addEventListener('click', () => switchView(b.dataset.view)));

// ── Toast ──
let toastTimer;
function showToast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' toast-' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3000);
}

// ── Modals ──
const modals = {
    fisher:   $('#modal-fisher'),
    qr:       $('#modal-qr'),
    settings: $('#modal-settings'),
    podminky: $('#modal-podminky'),
    adminPin: $('#modal-admin-pin')
};
function openModal(m)  { if (m) m.classList.add('open');    document.body.style.overflow = 'hidden'; }
function closeModal(m) { if (m) m.classList.remove('open'); document.body.style.overflow = ''; }
Object.values(modals).forEach(m => m && m.addEventListener('click', e => { if (e.target === m) closeModal(m); }));
$('#modal-close-fisher').addEventListener('click',   () => closeModal(modals.fisher));
$('#modal-close-qr').addEventListener('click',       () => closeModal(modals.qr));
$('#modal-close-settings').addEventListener('click', () => closeModal(modals.settings));
$('#modal-close-podminky').addEventListener('click', () => closeModal(modals.podminky));
if ($('#modal-close-admin-pin')) $('#modal-close-admin-pin').addEventListener('click', () => closeModal(modals.adminPin));
$('#btn-podminky').addEventListener('click', e => { e.preventDefault(); openModal(modals.podminky); });

// Odeslání PINu správce
$('#admin-pin-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const pin = $('#admin-pin-input').value.trim();
    if (!pin) { showToast('Zadejte PIN', 'warning'); return; }
    const r = await checkAdminPin(pin);
    if (!r.ok) { showToast(r.msg, 'danger'); return; }
    setAdminUnlocked(true);
    closeModal(modals.adminPin);
    $('#admin-pin-input').value = '';
    renderFishers();
    showToast('Přihlášen jako správce', 'success');
});

// Uložení nového PINu v Nastavení
$('#btn-save-pin')?.addEventListener('click', async () => {
    const newPin = $('#settings-pin-new').value.trim();
    const conf  = $('#settings-pin-confirm').value.trim();
    if (newPin.length < 4 || newPin.length > 8) { showToast('PIN musí mít 4–8 číslic', 'warning'); return; }
    if (newPin !== conf) { showToast('PINy se neshodují', 'danger'); return; }
    const hash = await hashPin(newPin);
    setPinHash(hash);
    $('#settings-pin-new').value = '';
    $('#settings-pin-confirm').value = '';
    showToast('PIN správce uložen', 'success');
});

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function today()          { return new Date().toISOString().split('T')[0]; }
function fmtDate(ds)      { return new Date(ds+'T12:00:00').toLocaleDateString('cs-CZ', { day:'numeric', month:'long', year:'numeric' }); }
function fmtTime(ts)      { return new Date(ts).toLocaleTimeString('cs-CZ', { hour:'2-digit', minute:'2-digit' }); }
function fmtDateShort(ds) { return new Date(ds+'T12:00:00').toLocaleDateString('cs-CZ', { weekday:'short', day:'numeric', month:'numeric' }); }
function initials(name)   { return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2); }
function getAppUrl()      { return (window.location.protocol === 'file:') ? BASE_URL + '/index.html' : window.location.origin + window.location.pathname; }

// ── Režim správce (přidávání / úpravy držitelů jen po zadání PINu)
function isAdminMode() {
    try { return sessionStorage.getItem(LS.ADMIN) === '1'; } catch (_) { return false; }
}
function setAdminUnlocked(yes) {
    try {
        if (yes) sessionStorage.setItem(LS.ADMIN, '1');
        else sessionStorage.removeItem(LS.ADMIN);
    } catch (_) {}
}
async function hashPin(pin) {
    const buf = new TextEncoder().encode(pin);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function getStoredPinHash() {
    try { return localStorage.getItem(LS.ADMIN_PIN) || ''; } catch (_) { return ''; }
}
function setPinHash(hash) {
    try { localStorage.setItem(LS.ADMIN_PIN, hash); } catch (_) {}
}
async function checkAdminPin(pin) {
    const stored = getStoredPinHash();
    if (!stored) return { ok: false, msg: 'Nejdříve nastavte PIN správce v Nastavení (⚙️).' };
    const h = await hashPin(pin);
    if (h !== stored) return { ok: false, msg: 'Nesprávný PIN.' };
    return { ok: true };
}

// ── Sync bar ──
function updateSyncBar() {
    const bar = $('#sync-bar'), icon = $('#sync-icon'), text = $('#sync-text'), btn = $('#btn-sync-setup');
    if (fbReady) {
        bar.className = 'sync-bar sync-firebase';
        icon.textContent = '🔥'; text.textContent = 'Firebase – data sdílena v reálném čase';
        btn.style.display = 'none';
    } else {
        bar.className = 'sync-bar sync-local';
        icon.textContent = '💾'; text.textContent = 'Lokální režim – data jen zde. Pro sdílení: otevřete hlubocek.github.io nebo v ⚙️ nastavte Firebase (a v Firebase Console nastavte Rules).';
        btn.style.display = '';
    }
}
$('#btn-sync-setup').addEventListener('click', openSettings);

// ── QR ──
function makeQr(container, url, size) {
    if (typeof QRCode === 'undefined') return;
    new QRCode(container, { text: url, width: size||260, height: size||260, colorDark: '#1a2e1f', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
}

// ── Naplnit všechny select rybářů ──
function populateFisherSelects() {
    const sorted = [...fishers].sort((a,b) => a.name.localeCompare(b.name, 'cs'));
    const opts   = sorted.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    ['ci-fisher', 'catch-fisher', 'visit-fisher'].forEach(id => {
        const el = $('#' + id);
        if (el) el.innerHTML = opts;
    });
}

// ════════════════════════════════════════
// URL ACTION (naskenování QR)
// ════════════════════════════════════════
function handleUrlAction() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('action') === 'register') {
        showRegOverlay();
        window.history.replaceState({}, '', getAppUrl());
    }
}

// ════════════════════════════════════════
// REGISTRAČNÍ OVERLAY (nový člen přes QR)
// ════════════════════════════════════════
function showRegOverlay() {
    $('#reg-form').reset();
    $('#reg-overlay').style.display = 'flex';
}

$('#reg-form').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#reg-name').value.trim();
    if (!name) return;
    const id   = genId();
    const data = {
        id, name,
        number:      $('#reg-number').value.trim(),
        phone:       $('#reg-phone').value.trim(),
        registeredAt: new Date().toISOString()
    };
    dbSet('fishers', id, data);
    if (!fbReady) { fishers.push(data); renderFishers(); populateFisherSelects(); }
    $('#reg-overlay').style.display = 'none';
    showToast(`✅ ${name} zaregistrován(a)!`, 'success');
});

// ════════════════════════════════════════
// RYBÁŘI
// ════════════════════════════════════════
let editingFisherId = null;

$('#btn-new-fisher').addEventListener('click', () => {
    editingFisherId = null;
    $('#modal-fisher-title').textContent = 'Nový držitel povolenky';
    $('#fisher-form').reset();
    openModal(modals.fisher);
});

$('#btn-reg-qr').addEventListener('click', () => {
    const url  = getAppUrl() + '?action=register';
    const wrap = $('#qr-canvas-wrap');
    wrap.innerHTML = '';
    openModal(modals.qr);
    setTimeout(() => makeQr(wrap, url, 260), 50);
});

$('#fisher-form').addEventListener('submit', e => {
    e.preventDefault();
    const id   = editingFisherId || genId();
    const name = $('#fisher-name').value.trim();
    if (!name) return;
    const data = {
        id, name,
        number:      $('#fisher-number').value.trim(),
        phone:       $('#fisher-phone').value.trim(),
        registeredAt: editingFisherId ? (fishers.find(f=>f.id===id)?.registeredAt || new Date().toISOString()) : new Date().toISOString()
    };
    dbSet('fishers', id, data);
    if (!fbReady) {
        const idx = fishers.findIndex(f => f.id === id);
        if (idx >= 0) fishers[idx] = data; else fishers.push(data);
        renderFishers();
        populateFisherSelects();
    }
    closeModal(modals.fisher);
    showToast(editingFisherId ? 'Držitel povolenky upraven' : `${name} přidán`);
    editingFisherId = null;
});

function renderFishers() {
    const list = $('#fishers-list'), empty = $('#no-fishers');
    const admin = isAdminMode();
    const addBtn = $('#btn-new-fisher');
    const adminHint = $('#admin-hint');
    const adminLogout = $('#link-admin-logout');
    if (addBtn) addBtn.style.display = admin ? '' : 'none';
    if (adminLogout) adminLogout.style.display = admin ? '' : 'none';
    if (adminHint) {
        if (admin) { adminHint.style.display = 'none'; }
        else {
            adminHint.style.display = 'block';
            adminHint.innerHTML = 'Nové držitele přidávejte pouze přes QR kód (tlačítko výše) nebo <a href="#" id="link-admin-pin">zadejte PIN správce</a>.';
        }
    }

    if (!fishers.length) { list.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display = 'none';

    const sorted = [...fishers].sort((a,b) => a.name.localeCompare(b.name, 'cs'));
    list.innerHTML = sorted.map(f => {
        const todayCI     = checkins.filter(c => c.fisherId === f.id && c.date === today()).length;
        const yearCatches = catches.filter(c => c.fisherId === f.id && c.timestamp?.startsWith(new Date().getFullYear().toString())).length;
        const actions = admin ? `<div class="fisher-actions">
                <button class="btn btn-secondary btn-sm" onclick="window._editFisher('${f.id}')">✏️</button>
                <button class="btn btn-danger btn-sm" onclick="window._deleteFisher('${f.id}')">🗑</button>
            </div>` : '';
        return `<div class="fisher-card">
            <div class="fisher-avatar">${esc(initials(f.name))}</div>
            <div class="fisher-info">
                <div class="fisher-name">${esc(f.name)}</div>
                <div class="fisher-sub">${f.number ? '🪪 '+esc(f.number)+' · ' : ''}📅 ${yearCatches} úlovků letos${todayCI ? ' · <span style="color:var(--success);font-weight:700">✓ Dnes</span>' : ''}</div>
            </div>
            ${actions}
        </div>`;
    }).join('');
}

window._editFisher = function(id) {
    const f = fishers.find(x => x.id === id);
    if (!f) return;
    editingFisherId = id;
    $('#modal-fisher-title').textContent = 'Upravit držitele povolenky';
    $('#fisher-name').value   = f.name;
    $('#fisher-number').value = f.number || '';
    $('#fisher-phone').value  = f.phone  || '';
    openModal(modals.fisher);
};

window._deleteFisher = function(id) {
    const f = fishers.find(x => x.id === id);
    if (!f || !confirm(`Smazat držitele povolenky ${f.name} včetně všech záznamů?`)) return;
    dbRemove('fishers', id);
    checkins.filter(c => c.fisherId === id).forEach(c => dbRemove('checkins',  c.id));
    catches.filter(c  => c.fisherId === id).forEach(c => dbRemove('catches',   c.id));
    visitors.filter(v => v.fisherId === id).forEach(v => dbRemove('visitors',  v.id));
    if (!fbReady) {
        fishers  = fishers.filter(x => x.id !== id);
        checkins = checkins.filter(c => c.fisherId !== id);
        catches  = catches.filter(c => c.fisherId !== id);
        visitors = visitors.filter(v => v.fisherId !== id);
        renderFishers();
        populateFisherSelects();
    }
    showToast('Držitel povolenky smazán');
};

// ════════════════════════════════════════
// DOCHÁZKA
// ════════════════════════════════════════
$('#btn-ci-submit').addEventListener('click', () => {
    const fid  = $('#ci-fisher').value;
    const date = $('#ci-date').value;
    if (!fid)  { showToast('Nejdříve přidejte držitele povolenky', 'warning'); return; }
    if (!date) { showToast('Vyberte datum', 'warning'); return; }
    const already = checkins.find(c => c.fisherId === fid && c.date === date);
    if (already) { showToast('Tento držitel povolenky je na tento den již evidován', 'warning'); return; }
    const id = genId();
    const ci = { id, fisherId: fid, date, timestamp: new Date().toISOString() };
    dbSet('checkins', id, ci);
    if (!fbReady) { checkins.push(ci); renderDochazka(); }
    showToast('✓ Příchod zapsán', 'success');
});

function renderDochazka() {
    const cont = $('#dochazka-content');
    if (!checkins.length) {
        cont.innerHTML = `<div class="empty-state"><span class="empty-icon">📅</span><p>Žádné záznamy příchodů.</p></div>`;
        return;
    }
    const sorted = [...checkins].sort((a,b) => b.date.localeCompare(a.date) || b.timestamp.localeCompare(a.timestamp));
    const groups = {};
    sorted.forEach(ci => { if (!groups[ci.date]) groups[ci.date] = []; groups[ci.date].push(ci); });

    cont.innerHTML = Object.entries(groups).map(([date, cis]) => `
        <div class="day-group">
            <div class="day-label">${fmtDate(date)} (${cis.length}×)</div>
            ${cis.map(ci => {
                const f = fishers.find(x => x.id === ci.fisherId);
                const catchCount = catches.filter(c => c.fisherId === ci.fisherId && c.date === date).length;
                return `<div class="checkin-row">
                    <div class="checkin-row-name">${f ? esc(f.name) : '?'}</div>
                    <div class="checkin-row-time">${fmtTime(ci.timestamp)}</div>
                    ${catchCount ? `<div class="checkin-row-catch">🐟 ${catchCount}×</div>` : ''}
                    <button class="btn btn-danger btn-sm" onclick="window._deleteCheckin('${ci.id}')">✕</button>
                </div>`;
            }).join('')}
        </div>`).join('');
}

window._deleteCheckin = function(id) {
    if (!confirm('Smazat záznam příchodu?')) return;
    dbRemove('checkins', id);
    if (!fbReady) { checkins = checkins.filter(c => c.id !== id); renderDochazka(); }
    showToast('Záznam smazán');
};

// ════════════════════════════════════════
// ÚLOVKY
// ════════════════════════════════════════
$('#catch-length').addEventListener('input', () => {
    const val  = parseInt($('#catch-length').value);
    const hint = $('#catch-length-hint');
    if (!val) { hint.textContent = ''; hint.className = 'form-hint'; return; }
    if (val >= MIN_LEN && val <= MAX_LEN) {
        hint.className = 'form-hint hint-ok';
        hint.textContent = `✓ V normě (${MIN_LEN}–${MAX_LEN} cm)`;
    } else {
        hint.className = 'form-hint hint-outside';
        hint.textContent = `⚠ Mimo normu (${MIN_LEN}–${MAX_LEN} cm)`;
    }
});

$('#btn-catch-submit').addEventListener('click', () => {
    const fid    = $('#catch-fisher').value;
    const date   = $('#catch-date').value;
    const length = parseInt($('#catch-length').value);
    const kept   = $('#catch-kept').checked;
    if (!fid)                              { showToast('Nejdříve přidejte držitele povolenky', 'warning'); return; }
    if (!date)                             { showToast('Vyberte datum', 'warning'); return; }
    if (!length || length < 5 || length > 150) { showToast('Zadejte délku v cm (5–150)', 'warning'); return; }
    const id  = genId();
    const cat = {
        id, fisherId: fid, species: SPECIES, length, kept,
        inRange: length >= MIN_LEN && length <= MAX_LEN,
        date, timestamp: new Date().toISOString()
    };
    dbSet('catches', id, cat);
    if (!fbReady) { catches.push(cat); renderUlovky(); }
    $('#catch-length').value   = '';
    $('#catch-length-hint').textContent = '';
    $('#catch-length-hint').className   = 'form-hint';
    $('#catch-kept').checked   = false;
    showToast(`🐟 Úlovek ${length} cm zapsán${kept ? ' · vzal rybu' : ''}`, 'success');
});

function renderUlovky() {
    const cont = $('#ulovky-content');
    if (!catches.length) {
        cont.innerHTML = `<div class="empty-state"><span class="empty-icon">🐟</span><p>Zatím žádné úlovky.</p></div>`;
        return;
    }
    const sorted = [...catches].sort((a,b) => b.timestamp.localeCompare(a.timestamp));
    const years  = [...new Set(sorted.map(c => c.timestamp?.slice(0,4)))].sort().reverse();
    const selYear = $('#ulovky-year-sel')?.value || years[0];
    const filtered = sorted.filter(c => c.timestamp?.startsWith(selYear));
    const keptCount = filtered.filter(c => c.kept).length;

    cont.innerHTML = `
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.85rem;flex-wrap:wrap;">
            <select id="ulovky-year-sel" class="year-select" onchange="window._refreshUlovky()">
                ${years.map(y=>`<option value="${y}" ${y===selYear?'selected':''}>${y}</option>`).join('')}
            </select>
            <span style="font-size:.82rem;color:var(--text-secondary)">${filtered.length} úlovků · prům. ${filtered.length ? Math.round(filtered.reduce((s,c)=>s+c.length,0)/filtered.length) : 0} cm · ${keptCount} vzato</span>
        </div>
        ${filtered.map(cat => {
            const f = fishers.find(x => x.id === cat.fisherId);
            return `<div class="catch-row">
                <span class="catch-fish-icon">🐟</span>
                <div class="catch-row-info">
                    <div class="catch-row-name">${f ? esc(f.name) : '?'}</div>
                    <div class="catch-row-meta">${fmtDateShort(cat.date)} · ${fmtTime(cat.timestamp)}</div>
                </div>
                <span class="catch-length ${cat.inRange?'':'outside'}">${cat.length} cm</span>
                ${cat.kept ? '<span class="catch-kept-badge">vzal</span>' : ''}
                <button class="btn btn-danger btn-sm" onclick="window._deleteCatch('${cat.id}')">✕</button>
            </div>`;
        }).join('')}`;
}

window._refreshUlovky = function() { renderUlovky(); };

window._deleteCatch = function(id) {
    if (!confirm('Smazat úlovek?')) return;
    dbRemove('catches', id);
    if (!fbReady) { catches = catches.filter(c => c.id !== id); renderUlovky(); }
    showToast('Úlovek smazán');
};

// ════════════════════════════════════════
// NÁVŠTĚVY
// ════════════════════════════════════════
$('#btn-visit-submit').addEventListener('click', () => {
    const fid         = $('#visit-fisher').value;
    const date        = $('#visit-date').value;
    const visitorName = $('#visit-name').value.trim();
    if (!fid)         { showToast('Nejdříve přidejte držitele povolenky', 'warning'); return; }
    if (!visitorName) { showToast('Zadejte jméno návštěvy', 'warning'); return; }
    if (!date)        { showToast('Vyberte datum', 'warning'); return; }
    const id  = genId();
    const v   = { id, fisherId: fid, visitorName, date, fee: FEE_VISIT, timestamp: new Date().toISOString() };
    dbSet('visitors', id, v);
    if (!fbReady) { visitors.push(v); renderNavstevy(); }
    $('#visit-name').value = '';
    showToast(`👥 Návštěva zapsána · ${FEE_VISIT} Kč`, 'success');
});

function renderNavstevy() {
    const cont = $('#navstevy-content');
    if (!visitors.length) {
        cont.innerHTML = `<div class="empty-state"><span class="empty-icon">👥</span><p>Žádné záznamy návštěv.</p></div>`;
        return;
    }
    const sorted  = [...visitors].sort((a,b) => b.date.localeCompare(a.date) || b.timestamp.localeCompare(a.timestamp));
    const years   = [...new Set(sorted.map(v => v.timestamp?.slice(0,4)))].sort().reverse();
    const selYear = $('#navstevy-year-sel')?.value || years[0];
    const filtered  = sorted.filter(v => v.timestamp?.startsWith(selYear));
    const totalFee  = filtered.reduce((s,v) => s + (v.fee ?? FEE_VISIT), 0);
    const groups    = {};
    filtered.forEach(v => { if (!groups[v.date]) groups[v.date] = []; groups[v.date].push(v); });

    cont.innerHTML = `
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.85rem;flex-wrap:wrap;">
            <select id="navstevy-year-sel" class="year-select" onchange="window._refreshNavstevy()">
                ${years.map(y=>`<option value="${y}" ${y===selYear?'selected':''}>${y}</option>`).join('')}
            </select>
            <span style="font-size:.82rem;color:var(--text-secondary)">${filtered.length} návštěv · celkem <strong>${totalFee} Kč</strong></span>
        </div>
        ${Object.entries(groups).map(([date, vs]) => `
            <div class="day-group">
                <div class="day-label">${fmtDate(date)} (${vs.length}×)</div>
                ${vs.map(v => {
                    const f = fishers.find(x => x.id === v.fisherId);
                    return `<div class="visit-row">
                        <div class="visit-row-main">
                            <div class="visit-row-name">👤 ${esc(v.visitorName)}</div>
                            <div class="visit-row-meta">hostitel: ${f ? esc(f.name) : '?'}</div>
                        </div>
                        <span class="visit-fee-badge">${v.fee ?? FEE_VISIT} Kč</span>
                        <button class="btn btn-danger btn-sm" onclick="window._deleteVisitor('${v.id}')">✕</button>
                    </div>`;
                }).join('')}
            </div>`).join('')}`;
}

window._refreshNavstevy = function() { renderNavstevy(); };

window._deleteVisitor = function(id) {
    if (!confirm('Smazat záznam návštěvy?')) return;
    dbRemove('visitors', id);
    if (!fbReady) { visitors = visitors.filter(v => v.id !== id); renderNavstevy(); }
    showToast('Záznam smazán');
};

// ════════════════════════════════════════
// STATISTIKY
// ════════════════════════════════════════
function renderStatistiky() {
    const cont    = $('#statistiky-content');
    const yearSel = $('#stats-year');
    const curYear = yearSel.value || new Date().getFullYear().toString();

    const yearCheckins = checkins.filter(c => c.date?.startsWith(curYear));
    const yearCatches  = catches.filter(c => c.timestamp?.startsWith(curYear));
    const yearVisitors = visitors.filter(v => v.timestamp?.startsWith(curYear));
    const totalVisitFee = yearVisitors.reduce((s,v) => s + (v.fee||0), 0);

    const maxVisits  = Math.max(1, ...fishers.map(f => yearCheckins.filter(c => c.fisherId===f.id).length));
    const maxCatches = Math.max(1, ...fishers.map(f => yearCatches.filter(c => c.fisherId===f.id).length));

    const fisherStats = [...fishers].map(f => ({
        fisher:     f,
        visits:     yearCheckins.filter(c => c.fisherId===f.id).length,
        catches:    yearCatches.filter(c => c.fisherId===f.id).length,
        keptCount:  yearCatches.filter(c => c.fisherId===f.id && c.kept).length,
        visitorCnt: yearVisitors.filter(v => v.fisherId===f.id).length,
        visitorFee: yearVisitors.filter(v => v.fisherId===f.id).reduce((s,v) => s+(v.fee||0), 0),
        avgLen: (() => {
            const fc = yearCatches.filter(c => c.fisherId===f.id);
            return fc.length ? Math.round(fc.reduce((s,c)=>s+c.length,0)/fc.length) : 0;
        })()
    })).sort((a,b) => b.visits - a.visits || b.catches - a.catches);

    const inRange = yearCatches.filter(c => c.inRange).length;

    cont.innerHTML = `
        <div class="stats-summary">
            <div class="stat-card"><div class="stat-value">${yearCheckins.length}</div><div class="stat-label">Příchodů</div></div>
            <div class="stat-card"><div class="stat-value">${yearCatches.length}</div><div class="stat-label">Úlovků</div></div>
            <div class="stat-card"><div class="stat-value">${yearVisitors.length}</div><div class="stat-label">Návštěv</div></div>
            <div class="stat-card"><div class="stat-value">${totalVisitFee ? totalVisitFee+' Kč' : '—'}</div><div class="stat-label">Za návštěvy</div></div>
        </div>
        ${fisherStats.length ? fisherStats.map(s => `
            <div class="fisher-stats-card">
                <div class="fsc-header">
                    <div class="fisher-avatar" style="width:36px;height:36px;font-size:.9rem;">${esc(initials(s.fisher.name))}</div>
                    <div class="fsc-name">${esc(s.fisher.name)}</div>
                    <span style="font-size:.78rem;color:var(--text-secondary)">${s.avgLen ? s.avgLen+' cm prům.' : ''}${s.visitorCnt ? ' · 👥 '+s.visitorCnt+' ('+s.visitorFee+' Kč)' : ''}</span>
                </div>
                <div class="fsc-bars">
                    <div class="fsc-bar-row">
                        <span class="fsc-bar-label">Příchody</span>
                        <div class="fsc-bar-track"><div class="fsc-bar-fill" style="width:${Math.round(s.visits/maxVisits*100)}%"></div></div>
                        <span class="fsc-bar-val">${s.visits}</span>
                    </div>
                    <div class="fsc-bar-row">
                        <span class="fsc-bar-label">Úlovky</span>
                        <div class="fsc-bar-track"><div class="fsc-bar-fill catches" style="width:${Math.round(s.catches/maxCatches*100)}%"></div></div>
                        <span class="fsc-bar-val">${s.catches}${s.keptCount ? ' ('+s.keptCount+' vzal)' : ''}</span>
                    </div>
                </div>
            </div>`).join('')
        : '<div class="empty-state"><p>Žádná data pro vybraný rok.</p></div>'}`;
}

function initYearSelectors() {
    const curYear = new Date().getFullYear();
    const years   = [curYear, curYear-1, curYear-2];
    const opts    = years.map(y => `<option value="${y}">${y}</option>`).join('');
    $('#stats-year').innerHTML = opts;
    $('#stats-year').addEventListener('change', renderStatistiky);
}

// ════════════════════════════════════════
// NASTAVENÍ
// ════════════════════════════════════════
function openSettings() {
    $('#settings-firebase-url').value = localStorage.getItem(LS.FB_URL) || FB_CONFIG.databaseURL;
    $('#settings-firebase-key').value = localStorage.getItem(LS.FB_KEY) || FB_CONFIG.apiKey;
    $('#btn-disconnect-firebase').style.display = fbReady ? '' : 'none';
    updateFbStatusBox();
    openModal(modals.settings);
}

function updateFbStatusBox() {
    const box = $('#firebase-status');
    if (!box) return;
    box.innerHTML = fbReady
        ? '<div class="fb-status-ok">✅ Firebase připojena – data jsou sdílena</div>'
        : '<div class="fb-status-warn">⚠️ Firebase není připojena – data jsou pouze lokální</div>';
}

$('#btn-open-settings').addEventListener('click', openSettings);

$('#btn-save-firebase').addEventListener('click', () => {
    const url = $('#settings-firebase-url').value.trim();
    const key = $('#settings-firebase-key').value.trim();
    if (!url || !key) { showToast('Vyplňte URL i API Key', 'danger'); return; }
    localStorage.setItem(LS.FB_URL, url);
    localStorage.setItem(LS.FB_KEY, key);
    if (initFirebase(url, key)) {
        showToast('Firebase připojena!', 'success');
        updateFbStatusBox();
        $('#btn-disconnect-firebase').style.display = '';
        closeModal(modals.settings);
    } else {
        showToast('Nepodařilo se připojit – zkontrolujte údaje', 'danger');
    }
});

$('#btn-disconnect-firebase').addEventListener('click', () => {
    localStorage.removeItem(LS.FB_URL); localStorage.removeItem(LS.FB_KEY);
    fbReady = false; db = null;
    updateSyncBar(); updateFbStatusBox();
    $('#btn-disconnect-firebase').style.display = 'none';
    showToast('Firebase odpojena', 'warning');
});

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════
fishers  = lsLoad(LS.FISHERS);
checkins = lsLoad(LS.CHECKINS);
catches  = lsLoad(LS.CATCHES);
visitors = lsLoad(LS.VISITORS);

// Vždy zkusit připojit Firebase (i při stažené aplikaci) – nejdřív výchozí config z kódu
const fbUrl = localStorage.getItem(LS.FB_URL) || FB_CONFIG.databaseURL;
const fbKey = localStorage.getItem(LS.FB_KEY) || FB_CONFIG.apiKey;
if (fbUrl && fbKey) initFirebase(fbUrl, fbKey);

updateSyncBar();
initYearSelectors();
renderFishers();
populateFisherSelects();

$('#ci-date').value    = today();
$('#catch-date').value = today();
$('#visit-date').value = today();

handleUrlAction();
// Klik na "zadejte PIN správce" otevře modal
document.addEventListener('click', e => {
    if (e.target.id === 'link-admin-pin') {
        e.preventDefault();
        openModal(modals.adminPin);
        $('#admin-pin-input').value = '';
        $('#admin-pin-input').focus();
    }
    if (e.target.id === 'link-admin-logout') {
        e.preventDefault();
        setAdminUnlocked(false);
        renderFishers();
        showToast('Odhlášeno ze správce');
    }
});

})();

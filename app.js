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

let fishers   = [];
let checkins  = [];
let catches   = [];
let visitors  = [];
let activity  = [];
let cachedPinHash = '';

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
    db.ref('config/pinHash').on('value', function(s) {
        var v = s.val();
        cachedPinHash = (v && typeof v === 'string') ? v : '';
        if (cachedPinHash) try { localStorage.setItem(LS.ADMIN_PIN, cachedPinHash); } catch(_) {}
    });
    db.ref('config/pinHash').once('value').then(function(s) {
        if (s.val()) return;
        try {
            var local = localStorage.getItem(LS.ADMIN_PIN);
            if (local && local.length === 64) db.ref('config/pinHash').set(local);
        } catch(_) {}
    }).catch(function() {});
    db.ref('fishers').on('value',  s => { fishers  = s.val() ? Object.values(s.val()) : []; lsSave(LS.FISHERS,  fishers);  updateSyncBar(); rerender(); });
    db.ref('checkins').on('value', s => { checkins = s.val() ? Object.values(s.val()) : []; lsSave(LS.CHECKINS, checkins); rerender(); });
    db.ref('catches').on('value',  s => { catches  = s.val() ? Object.values(s.val()) : []; lsSave(LS.CATCHES,  catches);  rerender(); });
    db.ref('visitors').on('value', s => { visitors = s.val() ? Object.values(s.val()) : []; lsSave(LS.VISITORS, visitors); rerender(); });
    db.ref('activity').limitToLast(30).on('value', s => {
        var val = s.val();
        activity = val ? Object.keys(val).map(function(k) { var v = val[k]; v._key = k; return v; }) : [];
        activity = activity.filter(function(a) { return a.type === 'registration'; }).sort(function(a, b) { return (b.at || '').localeCompare(a.at || ''); });
        rerender();
    });
    // Okamžité načtení všech dat (rybáři, úlovky, docházka, návštěvy) – spolehlivé na všech zařízeních
    Promise.all([
        db.ref('fishers').once('value'),
        db.ref('checkins').once('value'),
        db.ref('catches').once('value'),
        db.ref('visitors').once('value')
    ]).then(function(ss) {
        fishers  = ss[0].val() ? Object.values(ss[0].val()) : [];
        checkins = ss[1].val() ? Object.values(ss[1].val()) : [];
        catches  = ss[2].val() ? Object.values(ss[2].val()) : [];
        visitors = ss[3].val() ? Object.values(ss[3].val()) : [];
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        updateSyncBar();
        rerender();
    }).catch(function() {});
}

function refetchFishersFromFirebase() {
    if (!fbReady || !db) return;
    showToast('Načítám data z Firebase…', 'info');
    db.ref('fishers').once('value').then(function(s) {
        var v = s.val();
        fishers = v ? Object.values(v) : [];
        lsSave(LS.FISHERS, fishers);
        updateSyncBar();
        rerender();
        showToast(fishers.length ? 'Data načtena (' + fishers.length + ' držitelů)' : 'V databázi zatím nikdo není', 'success');
    }).catch(function(e) {
        showToast('Nepodařilo se načíst data', 'danger');
    });
}

function refetchAllFromFirebase() {
    if (!fbReady || !db) return;
    showToast('Načítám data z Firebase…', 'info');
    Promise.all([
        db.ref('fishers').once('value'),
        db.ref('checkins').once('value'),
        db.ref('catches').once('value'),
        db.ref('visitors').once('value')
    ]).then(function(ss) {
        fishers  = ss[0].val() ? Object.values(ss[0].val()) : [];
        checkins = ss[1].val() ? Object.values(ss[1].val()) : [];
        catches  = ss[2].val() ? Object.values(ss[2].val()) : [];
        visitors = ss[3].val() ? Object.values(ss[3].val()) : [];
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        updateSyncBar();
        rerender();
        showToast('Data načtena', 'success');
    }).catch(function() { showToast('Nepodařilo se načíst data', 'danger'); });
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
    if (fbReady && db) {
        return db.ref(col + '/' + id).set(data).then(function() { return true; }).catch(function(err) {
            console.error('dbSet error:', col, err);
            throw err;
        });
    }
    var map = { fishers: fishers, checkins: checkins, catches: catches, visitors: visitors };
    var arr = map[col];
    if (!arr) return Promise.resolve();
    var i = arr.findIndex(function(x) { return x.id === id; });
    if (i >= 0) arr[i] = data; else arr.push(data);
    lsSave(LS[col.toUpperCase()], arr);
    return Promise.resolve();
}

function dbRemove(col, id) {
    if (fbReady && db) {
        return db.ref(col + '/' + id).remove().then(function() { return true; }).catch(function(err) {
            console.error('dbRemove error:', col, err);
            throw err;
        });
    }
    var map = { fishers: fishers, checkins: checkins, catches: catches, visitors: visitors };
    var arr = map[col];
    if (!arr) return Promise.resolve();
    var i = arr.findIndex(function(x) { return x.id === id; });
    if (i >= 0) arr.splice(i, 1);
    lsSave(LS[col.toUpperCase()], arr);
    return Promise.resolve();
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

// Odeslání PINu správce (spolehlivé na PC i mobilu – event delegation)
async function doAdminLogin() {
    var pinEl = document.getElementById('admin-pin-input');
    var pin = (pinEl && pinEl.value) ? pinEl.value.trim() : '';
    if (!pin) { showToast('Zadejte PIN', 'warning'); return; }
    try {
        var r = await checkAdminPin(pin);
        if (!r.ok) { showToast(r.msg, 'danger'); return; }
        setAdminUnlocked(true);
        closeModal(modals.adminPin);
        if (pinEl) pinEl.value = '';
        renderFishers();
        showToast('Přihlášen jako správce', 'success');
    } catch (err) {
        console.error(err);
        showToast('Chyba při ověření PINu. Zkuste obnovit stránku.', 'danger');
    }
}
document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'admin-pin-submit') { e.preventDefault(); e.stopPropagation(); doAdminLogin(); }
});
var adminPinInput = document.getElementById('admin-pin-input');
if (adminPinInput) adminPinInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); doAdminLogin(); }
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
    showToast(fbReady ? 'PIN správce uložen do databáze (platí všude)' : 'PIN správce uložen', 'success');
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
// Souběžné přihlášení: localStorage – platí na všech záložkách i po restartu prohlížeče
function isAdminMode() {
    try { return localStorage.getItem(LS.ADMIN) === '1'; } catch (_) { return false; }
}
function setAdminUnlocked(yes) {
    try {
        if (yes) localStorage.setItem(LS.ADMIN, '1');
        else localStorage.removeItem(LS.ADMIN);
    } catch (_) {}
}
async function hashPin(pin) {
    if (!window.crypto || !window.crypto.subtle) {
        throw new Error('Ověření PINu vyžaduje zabezpečené připojení (HTTPS). Otevřete aplikaci z https://hlubocek.github.io');
    }
    var buf = new TextEncoder().encode(pin);
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function getStoredPinHash() {
    if (cachedPinHash) return cachedPinHash;
    try { return localStorage.getItem(LS.ADMIN_PIN) || ''; } catch (_) { return ''; }
}
function setPinHash(hash) {
    cachedPinHash = hash;
    try { localStorage.setItem(LS.ADMIN_PIN, hash); } catch (_) {}
    if (fbReady && db) db.ref('config/pinHash').set(hash);
}
async function checkAdminPin(pin) {
    var stored = getStoredPinHash();
    if (!stored && fbReady && db) {
        try {
            var snap = await db.ref('config/pinHash').once('value');
            var v = snap.val();
            if (v && typeof v === 'string') { cachedPinHash = v; stored = v; }
        } catch (_) {}
    }
    if (!stored) return { ok: false, msg: 'Nejdříve nastavte PIN správce v Nastavení (⚙️).' };
    const h = await hashPin(pin);
    if (h !== stored) return { ok: false, msg: 'Nesprávný PIN.' };
    return { ok: true };
}

// ── Sync bar ──
function updateSyncBar() {
    const bar = $('#sync-bar'), icon = $('#sync-icon'), text = $('#sync-text'), btn = $('#btn-sync-setup'), refreshWrap = $('#sync-refresh-wrap');
    if (fbReady) {
        bar.className = 'sync-bar sync-firebase';
        icon.textContent = '🔥';
        text.textContent = 'Firebase – data sdílena v reálném čase' + (fishers.length ? ' (' + fishers.length + ' držitelů)' : '');
        btn.style.display = 'none';
        if (refreshWrap) { refreshWrap.style.display = ''; refreshWrap.innerHTML = '<a href="#" id="sync-refresh-link">Obnovit</a>'; }
        var refLink = $('#sync-refresh-link');
        if (refLink) refLink.onclick = function(e) { e.preventDefault(); refetchAllFromFirebase(); };
    } else {
        bar.className = 'sync-bar sync-local';
        icon.textContent = '💾'; text.textContent = 'Lokální režim – data jen zde. Pro sdílení: otevřete hlubocek.github.io nebo v ⚙️ nastavte Firebase (a v Firebase Console nastavte Rules).';
        btn.style.display = '';
        if (refreshWrap) refreshWrap.style.display = 'none';
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

async function doRegSubmit() {
    var name = $('#reg-name') && $('#reg-name').value ? $('#reg-name').value.trim() : '';
    if (!name) { showToast('Zadejte jméno', 'warning'); return; }
    var check = $('#reg-rad-confirm');
    if (!check || !check.checked) { showToast('Zaškrtněte souhlas s rybářským řádem.', 'warning'); return; }
    var number = $('#reg-number') && $('#reg-number').value ? $('#reg-number').value.trim() : '';
    var phone  = $('#reg-phone') && $('#reg-phone').value ? $('#reg-phone').value.trim() : '';
    var duplicate = fishers.find(function(f) {
        if (f.name && name && f.name.trim().toLowerCase() === name.toLowerCase()) return true;
        if (number && f.number && f.number.trim() === number) return true;
        if (phone && f.phone && f.phone.trim().replace(/\s/g, '') === phone.replace(/\s/g, '')) return true;
        return false;
    });
    if (duplicate) {
        showToast('Už jste zaregistrován(a). Pokud máte dotazy, kontaktujte správce.', 'warning');
        return;
    }
    var id   = genId();
    var data = { id: id, name: name, number: number, phone: phone, registeredAt: new Date().toISOString() };
    var btn = $('#reg-submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Ukládám…'; }
    try {
        await dbSet('fishers', id, data);
        if (fbReady && db) {
            try { await db.ref('activity').push({ type: 'registration', name: name, id: id, at: data.registeredAt }); } catch (_) {}
        }
        var idx = fishers.findIndex(function(f) { return f.id === id; });
        if (idx >= 0) fishers[idx] = data; else fishers.push(data);
        lsSave(LS.FISHERS, fishers);
        renderFishers();
        populateFisherSelects();
        $('#reg-overlay').style.display = 'none';
        showToast('✅ ' + name + ' zaregistrován(a)!', 'success');
    } catch (err) {
        console.error('Registrace selhala:', err);
        showToast('Nepodařilo se uložit. Zkontrolujte připojení k internetu a zkuste znovu.', 'danger');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Zaregistrovat se'; }
}

var regBtn = document.getElementById('reg-submit-btn');
if (regBtn) regBtn.addEventListener('click', function() { doRegSubmit(); });
$('#reg-form').addEventListener('submit', function(e) { e.preventDefault(); doRegSubmit(); });

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

$('#fisher-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var id   = editingFisherId || genId();
    var name = $('#fisher-name').value.trim();
    if (!name) return;
    var data = {
        id: id, name: name,
        number:      $('#fisher-number').value.trim(),
        phone:       $('#fisher-phone').value.trim(),
        registeredAt: editingFisherId ? (fishers.find(function(f){ return f.id===id; }) && fishers.find(function(f){ return f.id===id; }).registeredAt || new Date().toISOString()) : new Date().toISOString()
    };
    try {
        await dbSet('fishers', id, data);
        var idx = fishers.findIndex(function(f) { return f.id === id; });
        if (idx >= 0) fishers[idx] = data; else fishers.push(data);
        lsSave(LS.FISHERS, fishers);
        renderFishers();
        populateFisherSelects();
        closeModal(modals.fisher);
        showToast(editingFisherId ? 'Držitel povolenky upraven' : (name + ' přidán'));
    } catch (err) {
        console.error('Uložení držitele selhalo:', err);
        showToast('Nepodařilo se uložit. Zkontrolujte připojení.', 'danger');
    }
    editingFisherId = null;
});

function renderFishers() {
    const list = $('#fishers-list'), empty = $('#no-fishers');
    const admin = isAdminMode();
    const addBtn = $('#btn-new-fisher');
    const adminHint = $('#admin-hint');
    const adminLogout = $('#link-admin-logout');
    const recentReg = $('#recent-registrations');
    if (addBtn) addBtn.style.display = admin ? '' : 'none';
    if (adminLogout) adminLogout.style.display = admin ? '' : 'none';
    if (adminHint) {
        if (admin) { adminHint.style.display = 'none'; }
        else {
            adminHint.style.display = 'block';
            adminHint.innerHTML = 'Nové držitele přidávejte přes QR kód (tlačítko výše). Pro úpravu a mazání: <a href="#" id="link-admin-pin">zadejte PIN správce</a>.';
        }
    }
    if (recentReg) {
        if (admin && fbReady && activity.length) {
            var regs = activity.slice(0, 10);
            var items = regs.map(function(a) {
                var d = (a.at || '').slice(0, 10);
                var t = (a.at || '').slice(11, 16);
                return '<li>' + esc(a.name || '') + (d ? ' <span class="recent-reg-date">' + d + ' ' + (t || '') + '</span>' : '') + '</li>';
            }).join('');
            recentReg.style.display = 'block';
            recentReg.innerHTML = '<h3>📋 Poslední registrace (pro správce)</h3><ul>' + items + '</ul>';
        } else {
            recentReg.style.display = 'none';
        }
    }

    if (!fishers.length) {
        list.innerHTML = '';
        empty.style.display = 'block';
        if (fbReady) {
            empty.innerHTML = '<span class="empty-icon">👤</span><p>Připojeno k Firebase. Zatím zde nejsou žádní držitelé nebo data se načítají.</p><p class="hint">Stiskněte <strong>Obnovit</strong> pro znovunačtení dat z databáze.</p><button type="button" class="btn btn-primary" id="btn-refresh-fishers">🔄 Obnovit data z Firebase</button>';
            var refBtn = $('#btn-refresh-fishers');
            if (refBtn) refBtn.onclick = refetchFishersFromFirebase;
        } else {
            empty.innerHTML = '<span class="empty-icon">👤</span><p>Zatím nejsou přidáni žádní držitelé povolenky.</p><p class="hint">Nové přidejte přes tlačítko „📱 QR registrace“ (vyvěste QR u rybníka) nebo otevřete aplikaci jako správce.</p>';
        }
        return;
    }
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

window._deleteFisher = async function(id) {
    var f = fishers.find(function(x) { return x.id === id; });
    if (!f || !confirm('Smazat držitele povolenky ' + f.name + ' včetně všech záznamů?')) return;
    try {
        await dbRemove('fishers', id);
        var checkToDel = checkins.filter(function(c) { return c.fisherId === id; });
        var catchToDel = catches.filter(function(c) { return c.fisherId === id; });
        var visitToDel = visitors.filter(function(v) { return v.fisherId === id; });
        await Promise.all([
            Promise.all(checkToDel.map(function(c) { return dbRemove('checkins', c.id); })),
            Promise.all(catchToDel.map(function(c) { return dbRemove('catches', c.id); })),
            Promise.all(visitToDel.map(function(v) { return dbRemove('visitors', v.id); }))
        ]);
        fishers  = fishers.filter(function(x) { return x.id !== id; });
        checkins = checkins.filter(function(c) { return c.fisherId !== id; });
        catches  = catches.filter(function(c) { return c.fisherId !== id; });
        visitors = visitors.filter(function(v) { return v.fisherId !== id; });
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        renderFishers();
        populateFisherSelects();
        if (currentView === 'navstevy') renderNavstevy();
        if (currentView === 'statistiky') renderStatistiky();
        showToast('Držitel povolenky smazán');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se smazat držitele povolenky', 'danger');
    }
};

// ════════════════════════════════════════
// DOCHÁZKA
// ════════════════════════════════════════
$('#btn-ci-submit').addEventListener('click', async function() {
    var fid  = $('#ci-fisher').value;
    var date = $('#ci-date').value;
    if (!fid)  { showToast('Nejdříve přidejte držitele povolenky', 'warning'); return; }
    if (!date) { showToast('Vyberte datum', 'warning'); return; }
    var already = checkins.find(function(c) { return c.fisherId === fid && c.date === date; });
    if (already) { showToast('Tento držitel povolenky je na tento den již evidován', 'warning'); return; }
    var id = genId();
    var ci = { id: id, fisherId: fid, date: date, timestamp: new Date().toISOString() };
    try {
        await dbSet('checkins', id, ci);
        checkins.push(ci);
        lsSave(LS.CHECKINS, checkins);
        renderDochazka();
        showToast('✓ Příchod zapsán', 'success');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se zapsat příchod', 'danger');
    }
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

window._deleteCheckin = async function(id) {
    if (!confirm('Smazat záznam příchodu?')) return;
    try {
        await dbRemove('checkins', id);
        checkins = checkins.filter(function(c) { return c.id !== id; });
        lsSave(LS.CHECKINS, checkins);
        renderDochazka();
        showToast('Záznam smazán');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se smazat', 'danger');
    }
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

$('#btn-catch-submit').addEventListener('click', async function() {
    var fid    = $('#catch-fisher').value;
    var date   = $('#catch-date').value;
    var length = parseInt($('#catch-length').value, 10);
    var kept   = $('#catch-kept').checked;
    if (!fid)                              { showToast('Nejdříve přidejte držitele povolenky', 'warning'); return; }
    if (!date)                             { showToast('Vyberte datum', 'warning'); return; }
    if (!length || length < 5 || length > 150) { showToast('Zadejte délku v cm (5–150)', 'warning'); return; }
    var id  = genId();
    var cat = {
        id: id, fisherId: fid, species: SPECIES, length: length, kept: kept,
        inRange: length >= MIN_LEN && length <= MAX_LEN,
        date: date, timestamp: new Date().toISOString()
    };
    try {
        await dbSet('catches', id, cat);
        catches.push(cat);
        lsSave(LS.CATCHES, catches);
        renderUlovky();
        $('#catch-length').value   = '';
        $('#catch-length-hint').textContent = '';
        $('#catch-length-hint').className   = 'form-hint';
        $('#catch-kept').checked   = false;
        showToast('🐟 Úlovek ' + length + ' cm zapsán' + (kept ? ' · vzal rybu' : ''), 'success');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se zapsat úlovek', 'danger');
    }
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

window._deleteCatch = async function(id) {
    if (!confirm('Smazat úlovek?')) return;
    try {
        await dbRemove('catches', id);
        catches = catches.filter(function(c) { return c.id !== id; });
        lsSave(LS.CATCHES, catches);
        renderUlovky();
        if (currentView === 'statistiky') renderStatistiky();
        showToast('Úlovek smazán');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se smazat úlovek', 'danger');
    }
};

// ════════════════════════════════════════
// NÁVŠTĚVY
// ════════════════════════════════════════
$('#btn-visit-submit').addEventListener('click', async function() {
    var fid         = $('#visit-fisher').value;
    var date        = $('#visit-date').value;
    var visitorName = $('#visit-name').value.trim();
    if (!fid)         { showToast('Nejdříve přidejte držitele povolenky', 'warning'); return; }
    if (!visitorName) { showToast('Zadejte jméno návštěvy', 'warning'); return; }
    if (!date)        { showToast('Vyberte datum', 'warning'); return; }
    var id  = genId();
    var v   = { id: id, fisherId: fid, visitorName: visitorName, date: date, fee: FEE_VISIT, timestamp: new Date().toISOString() };
    try {
        await dbSet('visitors', id, v);
        visitors.push(v);
        lsSave(LS.VISITORS, visitors);
        renderNavstevy();
        $('#visit-name').value = '';
        showToast('👥 Návštěva zapsána · ' + FEE_VISIT + ' Kč', 'success');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se zapsat návštěvu', 'danger');
    }
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

window._deleteVisitor = async function(id) {
    if (!confirm('Smazat záznam návštěvy?')) return;
    try {
        await dbRemove('visitors', id);
        visitors = visitors.filter(function(v) { return v.id !== id; });
        lsSave(LS.VISITORS, visitors);
        renderNavstevy();
        if (currentView === 'statistiky') renderStatistiky();
        showToast('Záznam smazán');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se smazat návštěvu', 'danger');
    }
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
    var clearWrap = $('#settings-clear-data-wrap');
    if (clearWrap) clearWrap.style.display = (isAdminMode() && fbReady) ? 'block' : 'none';
    updateFbStatusBox();
    openModal(modals.settings);
    var modalEl = modals.settings && modals.settings.querySelector('.modal');
    if (modalEl) modalEl.scrollTop = 0;
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

$('#btn-clear-all-data').addEventListener('click', function() {
    if (!isAdminMode() || !fbReady || !db) return;
    if (!confirm('Opravdu smazat VŠECHNA data z databáze?\n\n• Všichni rybáři (držitelé povolenky)\n• Všechny úlovky\n• Veškerá docházka\n• Všechny návštěvy\n\nPIN a nastavení zůstanou. Tuto akci nelze vrátit.')) return;
    if (!confirm('Naposledy: opravdu smazat všechna data?')) return;
    showToast('Mažu data…', 'info');
    Promise.all([
        db.ref('fishers').remove(),
        db.ref('checkins').remove(),
        db.ref('catches').remove(),
        db.ref('visitors').remove()
    ]).then(function() {
        fishers = []; checkins = []; catches = []; visitors = [];
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        updateSyncBar();
        rerender();
        closeModal(modals.settings);
        showToast('Všechna data z databáze smazána', 'success');
    }).catch(function() { showToast('Nepodařilo se smazat data', 'danger'); });
});

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════
fishers  = lsLoad(LS.FISHERS);
checkins = lsLoad(LS.CHECKINS);
catches  = lsLoad(LS.CATCHES);
visitors = lsLoad(LS.VISITORS);

// Vždy zkusit připojit Firebase (i při stažené aplikaci) – nejdřív výchozí config z kódu
var storedUrl = localStorage.getItem(LS.FB_URL);
var storedKey = localStorage.getItem(LS.FB_KEY);
var fbUrl = (storedUrl && storedUrl.trim()) ? storedUrl.trim() : FB_CONFIG.databaseURL;
var fbKey = (storedKey && storedKey.trim()) ? storedKey.trim() : FB_CONFIG.apiKey;
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

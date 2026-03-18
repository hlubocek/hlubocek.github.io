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
    ADMIN_PIN: 'hlb_admin_pin',
    FISHER_ID: 'hlb_fisher_id',
    WEBAUTHN:  'hlb_webauthn',
    LAST_VIEW: 'hlb_last_view'  // 'admin' | 'fisher' – při obnovení stránky zachovat zobrazení
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
let cachedAdminPinHashes = [];
let cachedAdminNames = {};
let cachedWebauthnCredentials = {};  // { credentialIdBase64: fisherId }
let pendingLoginFisher = null;  // při přihlášení PINem platném pro oba režimy

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
    db.ref('config/adminPinHashes').on('value', function(s) {
        var v = s.val();
        if (Array.isArray(v)) cachedAdminPinHashes = v;
        else if (v && typeof v === 'object') cachedAdminPinHashes = Object.values(v);
        else cachedAdminPinHashes = [];
        rerender();
    });
    db.ref('config/adminNames').on('value', function(s) {
        var v = s.val();
        cachedAdminNames = (v && typeof v === 'object') ? v : {};
    });
    db.ref('config/webauthnCredentials').on('value', function(s) {
        var v = s.val();
        cachedWebauthnCredentials = (v && typeof v === 'object') ? v : {};
        updateBiometricLoginVisibility();
    });
    db.ref('config/adminPinHashes').once('value').then(function(s) {
        var v = s.val();
        if (v && (Array.isArray(v) ? v.length : Object.keys(v).length)) return;
        return db.ref('config/pinHash').once('value').then(function(old) {
            var legacy = old.val();
            if (legacy && typeof legacy === 'string') {
                cachedAdminPinHashes = [legacy];
                return db.ref('config/adminPinHashes').set([legacy]);
            }
            try {
                var local = localStorage.getItem(LS.ADMIN_PIN);
                if (local && local.length === 64) return db.ref('config/adminPinHashes').set([local]);
            } catch(_) {}
        });
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
    // Okamžité načtení všech dat (rybáři, úlovky, docházka, návštěvy, admin PINy) – spolehlivé na všech zařízeních
    Promise.all([
        db.ref('fishers').once('value'),
        db.ref('checkins').once('value'),
        db.ref('catches').once('value'),
        db.ref('visitors').once('value'),
        db.ref('config/adminPinHashes').once('value')
    ]).then(function(ss) {
        fishers  = ss[0].val() ? Object.values(ss[0].val()) : [];
        checkins = ss[1].val() ? Object.values(ss[1].val()) : [];
        catches  = ss[2].val() ? Object.values(ss[2].val()) : [];
        visitors = ss[3].val() ? Object.values(ss[3].val()) : [];
        var v = ss[4].val();
        if (Array.isArray(v)) cachedAdminPinHashes = v;
        else if (v && typeof v === 'object') cachedAdminPinHashes = Object.values(v);
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        updateSyncBar();
        rerender();
    }).catch(function() {});
    db.ref('config/webauthnCredentials').once('value').then(function(s) {
        var v = s.val();
        cachedWebauthnCredentials = (v && typeof v === 'object') ? v : {};
        updateBiometricLoginVisibility();
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

function dedupeCatches(arr) {
    var seen = new Set();
    return arr.filter(function(c) {
        var key = (c.fisherId || '') + '|' + (c.date || '') + '|' + (c.length || '') + '|' + (c.kept ? '1' : '0');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function dedupeCheckins(arr) {
    var seen = new Set();
    return arr.filter(function(c) {
        var key = (c.fisherId || '') + '|' + (c.date || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
function dedupeVisitors(arr) {
    var seen = new Set();
    return arr.filter(function(v) {
        var key = (v.fisherId || '') + '|' + (v.date || '') + '|' + (v.visitorName || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function rerender() {
    renderFishers();
    populateFisherSelects();
    if (currentView === 'dochazka')   renderDochazka();
    if (currentView === 'ulovky')     renderUlovky();
    if (currentView === 'navstevy')   renderNavstevy();
    if (currentView === 'statistiky') renderStatistiky();
    var fisher = getLoggedInFisher();
    if (fisher && $('#fisher-profile').offsetParent !== null) renderFisherProfile(fisher);
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
    fisher:       $('#modal-fisher'),
    qr:           $('#modal-qr'),
    settings:     $('#modal-settings'),
    podminky:     $('#modal-podminky'),
    adminPin:     $('#modal-admin-pin'),
    loginChoice:  $('#modal-login-choice'),
    pickFisher:   $('#modal-pick-fisher')
};
function openModal(m)  { if (m) m.classList.add('open');    document.body.style.overflow = 'hidden'; }
function closeModal(m) { if (m) m.classList.remove('open'); document.body.style.overflow = ''; }
// Zavírání jen tlačítkem ✕ nebo po odeslání – ne při kliknutí na pozadí (zabraňuje náhodnému zavření při přejetí myší)
$('#modal-close-fisher').addEventListener('click',   () => closeModal(modals.fisher));
$('#modal-close-qr').addEventListener('click',       () => closeModal(modals.qr));
$('#modal-close-settings').addEventListener('click', () => closeModal(modals.settings));
$('#modal-close-podminky').addEventListener('click', () => closeModal(modals.podminky));
if ($('#modal-close-admin-pin')) $('#modal-close-admin-pin').addEventListener('click', () => closeModal(modals.adminPin));
$('#btn-podminky').addEventListener('click', e => { e.preventDefault(); openModal(modals.podminky); });
if ($('#modal-close-login-choice')) $('#modal-close-login-choice').addEventListener('click', function() { pendingLoginFisher = null; closeModal(modals.loginChoice); });
if ($('#modal-close-pick-fisher')) $('#modal-close-pick-fisher').addEventListener('click', () => closeModal(modals.pickFisher));

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

// Uložení nového PINu správce v Nastavení
$('#btn-save-pin')?.addEventListener('click', async () => {
    const name = $('#settings-admin-name').value.trim();
    const newPin = $('#settings-pin-new').value.trim();
    const conf  = $('#settings-pin-confirm').value.trim();
    if (newPin.length < 4 || newPin.length > 8) { showToast('PIN musí mít 4–8 číslic', 'warning'); return; }
    if (newPin !== conf) { showToast('PINy se neshodují', 'danger'); return; }
    const hash = await hashPin(newPin);
    var hashes = getAdminPinHashes();
    if (hashes.indexOf(hash) >= 0) { showToast('Tento PIN už je přidaný', 'warning'); return; }
    addAdminPinHash(hash, name || null);
    $('#settings-admin-name').value = '';
    $('#settings-pin-new').value = '';
    $('#settings-pin-confirm').value = '';
    showToast(fbReady ? 'Správce přidán (platí všude)' : 'Správce přidán', 'success');
    renderAdminPinsList();
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
function getAdminPinHashes() {
    if (cachedAdminPinHashes.length) return cachedAdminPinHashes;
    try {
        var raw = localStorage.getItem('hlb_admin_pin_hashes');
        if (raw) { var arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; }
        var single = localStorage.getItem(LS.ADMIN_PIN);
        if (single && single.length === 64) return [single];
    } catch (_) {}
    return [];
}
function setAdminPinHashes(hashes) {
    cachedAdminPinHashes = hashes;
    try { localStorage.setItem('hlb_admin_pin_hashes', JSON.stringify(hashes)); } catch (_) {}
    if (fbReady && db) db.ref('config/adminPinHashes').set(hashes);
}
function getAdminNames() {
    if (Object.keys(cachedAdminNames).length) return cachedAdminNames;
    try {
        var raw = localStorage.getItem('hlb_admin_names');
        if (raw) return JSON.parse(raw);
    } catch (_) {}
    return {};
}
function setAdminNames(names) {
    cachedAdminNames = names;
    try { localStorage.setItem('hlb_admin_names', JSON.stringify(names)); } catch (_) {}
    if (fbReady && db) db.ref('config/adminNames').set(names);
}
function getAdminDisplayName(hash) {
    var names = getAdminNames();
    if (names[hash]) return names[hash];
    var f = fishers.find(function(x) { return x.pinHash === hash; });
    return f ? f.name : null;
}
function addAdminPinHash(hash, name) {
    var hashes = getAdminPinHashes();
    if (hashes.indexOf(hash) >= 0) return;
    hashes.push(hash);
    setAdminPinHashes(hashes);
    if (name && name.trim()) {
        var names = getAdminNames();
        names[hash] = name.trim();
        setAdminNames(names);
    }
}
function removeAdminPinHash(hash) {
    var hashes = getAdminPinHashes();
    if (hashes.length <= 1) return false;
    var i = hashes.indexOf(hash);
    if (i < 0) return false;
    hashes.splice(i, 1);
    setAdminPinHashes(hashes);
    var names = getAdminNames();
    delete names[hash];
    setAdminNames(names);
    return true;
}
async function checkAdminPin(pin) {
    var hashes = getAdminPinHashes();
    if (!hashes.length && fbReady && db) {
        try {
            var snap = await db.ref('config/adminPinHashes').once('value');
            var v = snap.val();
            if (v) {
                if (Array.isArray(v)) cachedAdminPinHashes = v;
                else if (typeof v === 'object') cachedAdminPinHashes = Object.values(v);
                hashes = cachedAdminPinHashes;
            }
            if (!hashes.length) {
                var old = await db.ref('config/pinHash').once('value');
                if (old.val()) { hashes = [old.val()]; setAdminPinHashes(hashes); }
            }
        } catch (_) {}
    }
    if (!hashes.length) return { ok: false, msg: 'Nejdříve nastavte PIN správce v Nastavení (⚙️).' };
    const h = await hashPin(pin);
    if (hashes.indexOf(h) < 0) return { ok: false, msg: 'Nesprávný PIN.' };
    return { ok: true };
}
async function isPinUsedByOther(pin, excludeFisherId) {
    var h = await hashPin(pin);
    return fishers.some(function(f) {
        if (excludeFisherId && f.id === excludeFisherId) return false;
        return f.pinHash === h;
    });
}
function getAdminFishers() {
    var hashes = getAdminPinHashes();
    return fishers.filter(function(f) { return f.pinHash && hashes.indexOf(f.pinHash) >= 0; });
}
function isFisherAlsoAdmin(fisher) {
    if (!fisher || !fisher.pinHash) return false;
    return getAdminPinHashes().indexOf(fisher.pinHash) >= 0;
}
async function generateUniqueFisherPin() {
    var used = new Set();
    fishers.forEach(function(f) { if (f.pinDisplay) used.add(f.pinDisplay); });
    for (var i = 0; i < 50; i++) {
        var pin = String(Math.floor(100000 + Math.random() * 900000));
        if (used.has(pin)) continue;
        var h = await hashPin(pin);
        var clash = fishers.some(function(f) { return f.pinHash === h; });
        if (!clash) return pin;
    }
    return String(Math.floor(100000 + Math.random() * 900000));
}

// ════════════════════════════════════════
// WEBAUTHN / BIOMETRIKA
// ════════════════════════════════════════
function isAndroidDevice() {
    try { return /Android/i.test((navigator && navigator.userAgent) ? navigator.userAgent : ''); } catch (_) { return false; }
}
function isWebAuthnSupported() {
    return !!(window.PublicKeyCredential && window.crypto && window.crypto.subtle);
}
function getRpId() {
    if (typeof window !== 'undefined' && window.location && window.location.hostname) {
        var h = window.location.hostname;
        if (h === 'localhost' || h === '127.0.0.1') return h;
        if (h === 'hlubocek.github.io') return 'hlubocek.github.io';
        return h;
    }
    return 'hlubocek.github.io';
}
function base64urlEncode(buf) {
    var bin = String.fromCharCode.apply(null, new Uint8Array(buf));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
    str = (str + '==='.slice((str.length + 3) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(str), function(c) { return c.charCodeAt(0); });
}
function getWebauthnCredentials() {
    if (Object.keys(cachedWebauthnCredentials).length) return cachedWebauthnCredentials;
    try {
        var raw = localStorage.getItem(LS.WEBAUTHN);
        if (raw) { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; }
    } catch (_) {}
    return {};
}
function setWebauthnCredentials(obj) {
    cachedWebauthnCredentials = obj;
    try { localStorage.setItem(LS.WEBAUTHN, JSON.stringify(obj)); } catch (_) {}
    if (fbReady && db) db.ref('config/webauthnCredentials').set(obj);
}
function addWebauthnCredential(credentialId, fisherId) {
    var creds = getWebauthnCredentials();
    creds[credentialId] = fisherId;
    setWebauthnCredentials(creds);
}
function removeWebauthnCredentialForFisher(fisherId) {
    var creds = getWebauthnCredentials();
    var changed = false;
    Object.keys(creds).forEach(function(cid) {
        if (creds[cid] === fisherId) { delete creds[cid]; changed = true; }
    });
    if (changed) setWebauthnCredentials(creds);
}
function updateBiometricLoginVisibility() {
    var btn = $('#login-biometric');
    if (!btn) return;
    var creds = getWebauthnCredentials();
    var hasCreds = Object.keys(creds).length > 0;
    btn.style.display = (isWebAuthnSupported() && hasCreds) ? '' : 'none';
}
function updateFisherBiometricButtons(fisher) {
    var creds = getWebauthnCredentials();
    var hasCred = Object.keys(creds).some(function(cid) { return creds[cid] === fisher.id; });
    var addBtn = $('#fisher-btn-add-biometric');
    var remBtn = $('#fisher-btn-remove-biometric');
    if (addBtn) addBtn.style.display = (isWebAuthnSupported() && !hasCred) ? '' : 'none';
    if (remBtn) remBtn.style.display = (isWebAuthnSupported() && hasCred) ? '' : 'none';
}
async function webauthnRegister(fisherId, fisherName) {
    if (!isWebAuthnSupported()) {
        showToast('Otisk / Face ID není podporováno v tomto prohlížeči. Použijte HTTPS.', 'warning');
        return;
    }
    var challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    var userId = new TextEncoder().encode(fisherId);
    var options = {
        challenge: challenge,
        rp: { name: 'Hluboček', id: getRpId() },
        user: {
            id: userId,
            name: fisherId,
            displayName: fisherName
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        authenticatorSelection: {
            authenticatorAttachment: 'platform',
            // Na Androidu se u 'preferred' často vyvolá i fallback na ověření přes zařízení (PIN).
            // 'discouraged' je méně agresivní a typicky nezpouští zařízení PIN v případech, kdy stačí biometrie.
            userVerification: 'discouraged',
            requireResidentKey: false
        },
        timeout: 60000
    };
    try {
        var cred = await navigator.credentials.create({ publicKey: options });
        if (!cred || !cred.id) throw new Error('Registrace nebyla dokončena');
        addWebauthnCredential(cred.id, fisherId);
        updateBiometricLoginVisibility();
        updateFisherBiometricButtons(fishers.find(function(f) { return f.id === fisherId; }));
        showToast('Otisk / Face ID přidán', 'success');
    } catch (err) {
        console.error('WebAuthn register:', err);
        if (err.name === 'NotAllowedError') showToast('Registrace zrušena nebo čas vypršel', 'warning');
        else showToast('Nepodařilo se přidat otisk. Zkuste znovu.', 'danger');
    }
}
async function webauthnAuthenticate() {
    var creds = getWebauthnCredentials();
    var ids = Object.keys(creds);
    if (!ids.length) {
        showToast('Žádný otisk není zaregistrován', 'warning');
        return;
    }
    if (!isWebAuthnSupported()) {
        showToast('Otisk / Face ID není podporováno', 'warning');
        return;
    }
    var challenge = new Uint8Array(32);
    crypto.getRandomValues(challenge);
    var allowCredentials = ids.map(function(id) {
        return { id: base64urlDecode(id), type: 'public-key' };
    });
    var options = {
        challenge: challenge,
        rpId: getRpId(),
        allowCredentials: allowCredentials,
        userVerification: 'discouraged',
        timeout: 60000
    };
    try {
        var assertion = await navigator.credentials.get({ publicKey: options });
        if (!assertion || !assertion.id) throw new Error('Ověření nebylo dokončeno');
        var fisherId = creds[assertion.id];
        if (!fisherId) throw new Error('Neznámý přihlašovací identifikátor');
        var fisher = fishers.find(function(f) { return f.id === fisherId; });
        if (!fisher) {
            showToast('Držitel povolenky nenalezen', 'danger');
            return;
        }
        try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
        showFisherView(fisher);
        showToast('Vítejte, ' + fisher.name, 'success');
    } catch (err) {
        console.error('WebAuthn authenticate:', err);
        if (err.name === 'NotAllowedError') showToast('Přihlášení zrušeno', 'warning');
        else showToast('Nepodařilo se přihlásit otiskem', 'danger');
    }
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
// PŘIHLAŠOVÁNÍ A ZOBRAZENÍ
// ════════════════════════════════════════
function showLoginScreen() {
    $('#login-screen').style.display = 'flex';
    $('#app-wrapper').style.display = 'none';
    $('#fisher-profile').style.display = 'none';
    document.querySelectorAll('.modal-overlay.open').forEach(function(m) { m.classList.remove('open'); });
    document.body.style.overflow = '';
    pendingLoginFisher = null;
    try { localStorage.removeItem(LS.LAST_VIEW); } catch (_) {}
    var pinInput = $('#login-pin');
    if (pinInput) { pinInput.value = ''; pinInput.disabled = false; setTimeout(function() { pinInput.focus(); }, 100); }
    var submitBtn = $('#login-submit');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Přihlásit'; }
    updateBiometricLoginVisibility();
}
function showAdminView() {
    $('#login-screen').style.display = 'none';
    $('#app-wrapper').style.display = 'block';
    $('#fisher-profile').style.display = 'none';
    setAdminUnlocked(true);
    try { localStorage.setItem(LS.LAST_VIEW, 'admin'); } catch (_) {}
    rerender();
}
function showFisherView(fisher) {
    $('#login-screen').style.display = 'none';
    $('#app-wrapper').style.display = 'none';
    $('#fisher-profile').style.display = 'block';
    try { localStorage.setItem(LS.FISHER_ID, fisher.id); localStorage.setItem(LS.LAST_VIEW, 'fisher'); } catch (_) {}
    $('#fisher-profile-name').textContent = fisher.name;
    renderFisherProfile(fisher);
}
function getLoggedInFisher() {
    try {
        var id = localStorage.getItem(LS.FISHER_ID);
        if (!id) return null;
        return fishers.find(function(f) { return f.id === id; }) || null;
    } catch (_) { return null; }
}

// ════════════════════════════════════════
// RYBÁŘI
// ════════════════════════════════════════
let editingFisherId = null;

$('#btn-new-fisher').addEventListener('click', async () => {
    editingFisherId = null;
    $('#modal-fisher-title').textContent = 'Nový držitel povolenky';
    $('#fisher-form').reset();
    $('#fisher-pin').value = await generateUniqueFisherPin();
    $('#fisher-pin-hint').textContent = 'Předáte rybáři – slouží k přihlášení. Musí být unikátní.';
    openModal(modals.fisher);
});

$('#btn-app-qr').addEventListener('click', () => {
    const url  = getAppUrl();
    const wrap = $('#qr-canvas-wrap');
    wrap.innerHTML = '';
    openModal(modals.qr);
    setTimeout(() => makeQr(wrap, url, 260), 50);
});

$('#fisher-gen-pin').addEventListener('click', async function() {
    $('#fisher-pin').value = await generateUniqueFisherPin();
});
$('#fisher-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var id   = editingFisherId || genId();
    var name = $('#fisher-name').value.trim();
    if (!name) return;
    var pin  = $('#fisher-pin').value.trim();
    var existing = fishers.find(function(f) { return f.id === id; });
    var hasExistingPin = existing && existing.pinHash;
    if (!pin && !hasExistingPin) {
        showToast('PIN musí být 6 číslic', 'warning');
        return;
    }
    if (pin && (pin.length !== 6 || !/^\d{6}$/.test(pin))) {
        showToast('PIN musí být 6 číslic', 'warning');
        return;
    }
    if (!pin) pin = existing.pinDisplay;
    var used = pin ? await isPinUsedByOther(pin, editingFisherId || null) : false;
    if (pin && used) {
        showToast('Tento PIN už používá jiný rybář', 'danger');
        return;
    }
    var pinHash = pin ? await hashPin(pin) : existing.pinHash;
    var data = {
        id: id, name: name,
        number:      $('#fisher-number').value.trim(),
        phone:       $('#fisher-phone').value.trim(),
        pinHash:     pinHash,
        pinDisplay:  pin || existing.pinDisplay || '',
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
        showToast(editingFisherId ? 'Držitel povolenky upraven' : (name + ' přidán · PIN: ' + pin));
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
    if (addBtn) addBtn.style.display = admin ? '' : 'none';
    if (adminLogout) adminLogout.style.display = admin ? '' : 'none';
    var switchLink = $('#link-switch-to-fisher');
    if (switchLink) switchLink.style.display = (admin && getAdminFishers().length > 0) ? '' : 'none';
    if (adminHint) {
        if (admin) { adminHint.style.display = 'none'; }
        else {
            adminHint.style.display = 'block';
            adminHint.innerHTML = 'Pro úpravu a mazání: <a href="#" id="link-admin-pin">zadejte PIN správce</a>.';
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
                <div class="fisher-sub">${f.pinDisplay ? '🔑 PIN '+esc(f.pinDisplay)+' · ' : ''}${f.number ? '🪪 '+esc(f.number)+' · ' : ''}📅 ${yearCatches} úlovků letos${todayCI ? ' · <span style="color:var(--success);font-weight:700">✓ Dnes</span>' : ''}</div>
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
    $('#fisher-pin').value    = f.pinDisplay || '';
    $('#fisher-pin-hint').textContent = 'Změna PINu – musí zůstat unikátní.';
    openModal(modals.fisher);
};

window._deleteFisher = async function(id) {
    var f = fishers.find(function(x) { return x.id === id; });
    if (!f || !confirm('Smazat držitele povolenky ' + f.name + ' včetně všech záznamů?')) return;
    try {
        removeWebauthnCredentialForFisher(id);
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
        if (!fbReady) { checkins.push(ci); lsSave(LS.CHECKINS, checkins); }
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
    const deduped = dedupeCheckins(checkins);
    const sorted = [...deduped].sort((a,b) => b.date.localeCompare(a.date) || b.timestamp.localeCompare(a.timestamp));
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
        if (!fbReady) { catches.push(cat); lsSave(LS.CATCHES, catches); }
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
    const deduped = dedupeCatches(catches);
    const sorted = [...deduped].sort((a,b) => b.timestamp.localeCompare(a.timestamp));
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
        if (!fbReady) { visitors.push(v); lsSave(LS.VISITORS, visitors); }
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
    const deduped = dedupeVisitors(visitors);
    const sorted  = [...deduped].sort((a,b) => b.date.localeCompare(a.date) || b.timestamp.localeCompare(a.timestamp));
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
function renderSettingsBiometric() {
    var cont = $('#settings-biometric-content');
    if (!cont) return;
    if (!isWebAuthnSupported()) {
        cont.innerHTML = '<p class="form-hint">Otisk / Face ID není v tomto prohlížeči podporován. Použijte Chrome, Safari nebo Edge na HTTPS.</p>';
        return;
    }
    var creds = getWebauthnCredentials();
    var fisher = getLoggedInFisher();
    var adminHashes = getAdminPinHashes();
    var adminFishers = fishers.filter(function(f) { return f.pinHash && adminHashes.indexOf(f.pinHash) >= 0; });
    var targets = fisher ? [fisher] : adminFishers;
    if (!targets.length) {
        cont.innerHTML = '<p class="form-hint">Pro přidání otisku se odhlaste a přihlaste se svým 6místným PINem jako rybář (ne jako správce).</p>';
        return;
    }
    var html = '';
    targets.forEach(function(f) {
        var hasCred = Object.keys(creds).some(function(cid) { return creds[cid] === f.id; });
        html += '<div class="settings-biometric-item">';
        html += '<span class="settings-biometric-name">' + esc(f.name) + '</span>';
        if (hasCred) {
            html += '<span class="form-hint" style="margin-right:.5rem;">✓ Otisk aktivní</span>';
            html += '<button type="button" class="btn btn-secondary btn-sm" data-fisher-id="' + esc(f.id) + '" data-action="remove">Odstranit</button>';
        } else {
            html += '<button type="button" class="btn btn-primary btn-sm" data-fisher-id="' + esc(f.id) + '" data-action="add">Přidat otisk / Face ID</button>';
        }
        html += '</div>';
    });
    cont.innerHTML = html;
    cont.querySelectorAll('[data-action="add"]').forEach(function(btn) {
        btn.onclick = async function() {
            var f = targets.find(function(t) { return t.id === btn.dataset.fisherId; });
            await webauthnRegister(btn.dataset.fisherId, f ? f.name : '');
            renderSettingsBiometric();
        };
    });
    cont.querySelectorAll('[data-action="remove"]').forEach(function(btn) {
        btn.onclick = function() {
            if (!confirm('Odstranit otisk / Face ID?')) return;
            removeWebauthnCredentialForFisher(btn.dataset.fisherId);
            renderSettingsBiometric();
            updateBiometricLoginVisibility();
            showToast('Otisk odstraněn', 'success');
        };
    });
}

function openSettings() {
    $('#settings-firebase-url').value = localStorage.getItem(LS.FB_URL) || FB_CONFIG.databaseURL;
    $('#settings-firebase-key').value = localStorage.getItem(LS.FB_KEY) || FB_CONFIG.apiKey;
    $('#btn-disconnect-firebase').style.display = fbReady ? '' : 'none';
    var clearWrap = $('#settings-clear-data-wrap');
    if (clearWrap) clearWrap.style.display = (isAdminMode() && fbReady) ? 'block' : 'none';
    var pinSection = $('#settings-pin-section');
    if (pinSection) pinSection.style.display = isAdminMode() ? 'block' : 'none';
    renderAdminPinsList();
    renderSettingsBiometric();
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
// LOGIN HANDLER
// ════════════════════════════════════════
$('#login-biometric').addEventListener('click', function() { webauthnAuthenticate(); });
$('#login-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var pin = $('#login-pin').value.trim();
    if (!pin) { showToast('Zadejte PIN', 'warning'); return; }
    var btn = $('#login-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Ověřuji…'; }
    try {
        var h = await hashPin(pin);
        var adminHashes = getAdminPinHashes();
        if (!adminHashes.length && fbReady && db) {
            var snap = await db.ref('config/adminPinHashes').once('value');
            var v = snap.val();
            if (v) {
                if (Array.isArray(v)) cachedAdminPinHashes = v;
                else cachedAdminPinHashes = Object.values(v);
                adminHashes = cachedAdminPinHashes;
            }
            if (!adminHashes.length) {
                var old = await db.ref('config/pinHash').once('value');
                if (old.val()) { adminHashes = [old.val()]; setAdminPinHashes(adminHashes); }
            }
        }
        var fisher = fishers.find(function(f) { return f.pinHash === h; });
        var isAdmin = adminHashes.indexOf(h) >= 0;
        if (isAdmin && fisher) {
            pendingLoginFisher = fisher;
            openModal(modals.loginChoice);
        } else if (isAdmin) {
            try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
            showAdminView();
            showToast('Přihlášen jako správce', 'success');
        } else if (fisher) {
            showFisherView(fisher);
            showToast('Vítejte, ' + fisher.name, 'success');
        } else {
            showToast('Nesprávný PIN', 'danger');
        }
    } catch (err) {
        console.error(err);
        showToast('Chyba při ověření', 'danger');
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Přihlásit'; }
    $('#login-pin').value = '';
});

// Pending login choice (když PIN platí pro oba režimy)
$('#login-choice-admin').addEventListener('click', function() {
    if (pendingLoginFisher) {
        try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
        showAdminView();
        showToast('Přihlášen jako správce', 'success');
        closeModal(modals.loginChoice);
        pendingLoginFisher = null;
    }
});
$('#login-choice-fisher').addEventListener('click', function() {
    if (pendingLoginFisher) {
        showFisherView(pendingLoginFisher);
        showToast('Vítejte, ' + pendingLoginFisher.name, 'success');
        closeModal(modals.loginChoice);
        pendingLoginFisher = null;
    }
});

// Přepnutí admin → profil rybáře
$('#link-switch-to-fisher').addEventListener('click', function(e) {
    e.preventDefault();
    var adminFishers = getAdminFishers();
    if (adminFishers.length === 1) {
        showFisherView(adminFishers[0]);
        showToast('Přepnuto na profil rybáře', 'success');
    } else if (adminFishers.length > 1) {
        var list = $('#pick-fisher-list');
        list.innerHTML = adminFishers.map(function(f) {
            return '<button type="button" class="btn btn-secondary btn-full pick-fisher-btn" data-fisher-id="' + esc(f.id) + '">' + esc(f.name) + '</button>';
        }).join('');
        list.querySelectorAll('.pick-fisher-btn').forEach(function(btn) {
            btn.onclick = function() {
                var f = adminFishers.find(function(x) { return x.id === btn.dataset.fisherId; });
                if (f) { showFisherView(f); showToast('Přepnuto na profil', 'success'); closeModal(modals.pickFisher); }
            };
        });
        openModal(modals.pickFisher);
    }
});

// Přepnutí rybář → správce (ikona v headeru + tlačítko v obsahu)
function doSwitchToAdmin() {
    setAdminUnlocked(true);
    showAdminView();
    showToast('Přepnuto na režim správce', 'success');
}
$('#fisher-switch-admin').addEventListener('click', doSwitchToAdmin);
var switchAdminMain = $('#fisher-btn-switch-admin');
if (switchAdminMain) switchAdminMain.addEventListener('click', doSwitchToAdmin);

// ════════════════════════════════════════
// FISHER PROFILE
// ════════════════════════════════════════
function renderFisherProfile(fisher) {
    var fid = fisher.id;
    updateFisherBiometricButtons(fisher);
    var isAdmin = isFisherAlsoAdmin(fisher);
    var switchBtn = $('#fisher-switch-admin');
    if (switchBtn) switchBtn.style.display = isAdmin ? '' : 'none';
    var switchBtnMain = $('#fisher-btn-switch-admin');
    if (switchBtnMain) switchBtnMain.style.display = isAdmin ? '' : 'none';
    var settingsBtn = $('#fisher-settings');
    if (settingsBtn) {
        var hasSettingsUse = isFisherAlsoAdmin(fisher) || isWebAuthnSupported();
        settingsBtn.style.display = hasSettingsUse ? '' : 'none';
    }
    var myCheckins = dedupeCheckins(checkins.filter(function(c) { return c.fisherId === fid; })).sort(function(a,b) { return b.date.localeCompare(a.date); }).slice(0, 15);
    var myCatches = dedupeCatches(catches.filter(function(c) { return c.fisherId === fid; })).sort(function(a,b) { return b.timestamp.localeCompare(a.timestamp); }).slice(0, 15);
    var myVisitors = dedupeVisitors(visitors.filter(function(v) { return v.fisherId === fid; })).sort(function(a,b) { return b.date.localeCompare(a.date); }).slice(0, 10);
    $('#fisher-my-checkins').innerHTML = myCheckins.length ? myCheckins.map(function(c) {
        return '<div class="checkin-row"><span>' + fmtDate(c.date) + '</span><span>' + fmtTime(c.timestamp) + '</span></div>';
    }).join('') : '<p class="empty-hint">Zatím žádné příchody</p>';
    $('#fisher-my-catches').innerHTML = myCatches.length ? myCatches.map(function(c) {
        return '<div class="catch-row"><span>🐟 ' + c.length + ' cm</span><span>' + fmtDateShort(c.date) + '</span>' + (c.kept ? ' <span class="catch-kept-badge">vzal</span>' : '') + '</div>';
    }).join('') : '<p class="empty-hint">Zatím žádné úlovky</p>';
    $('#fisher-my-visitors').innerHTML = myVisitors.length ? myVisitors.map(function(v) {
        return '<div class="visit-row"><span>👤 ' + esc(v.visitorName) + '</span><span>' + fmtDate(v.date) + ' · ' + (v.fee || FEE_VISIT) + ' Kč</span></div>';
    }).join('') : '<p class="empty-hint">Zatím žádné návštěvy</p>';
}
$('#fisher-settings').addEventListener('click', openSettings);
$('#fisher-logout').addEventListener('click', function() {
    try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
    showLoginScreen();
    showToast('Odhlášeno');
});
$('#fisher-btn-checkin').addEventListener('click', async function() {
    var fisher = getLoggedInFisher();
    if (!fisher) return;
    var date = today();
    var already = checkins.find(function(c) { return c.fisherId === fisher.id && c.date === date; });
    if (already) { showToast('Dnes už máte zapsaný příchod', 'warning'); return; }
    var id = genId();
    var ci = { id: id, fisherId: fisher.id, date: date, timestamp: new Date().toISOString() };
    try {
        await dbSet('checkins', id, ci);
        if (!fbReady) { checkins.push(ci); lsSave(LS.CHECKINS, checkins); }
        renderFisherProfile(fisher);
        showToast('✓ Příchod zapsán', 'success');
    } catch (err) {
        showToast('Nepodařilo se zapsat', 'danger');
    }
});
$('#fisher-btn-catch').addEventListener('click', function() {
    $('#fisher-catch-length').value = '';
    $('#fisher-catch-length-hint').textContent = '';
    $('#fisher-catch-kept').checked = false;
    openModal($('#modal-fisher-catch'));
});
$('#fisher-btn-visit').addEventListener('click', function() {
    $('#fisher-visit-name').value = '';
    openModal($('#modal-fisher-visit'));
});
$('#fisher-catch-length').addEventListener('input', function() {
    var val = parseInt(this.value);
    var hint = $('#fisher-catch-length-hint');
    if (!val) { hint.textContent = ''; return; }
    hint.textContent = (val >= MIN_LEN && val <= MAX_LEN) ? '✓ V normě' : '⚠ Mimo normu';
});
$('#fisher-catch-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var fisher = getLoggedInFisher();
    if (!fisher) return;
    var length = parseInt($('#fisher-catch-length').value, 10);
    var kept = $('#fisher-catch-kept').checked;
    if (!length || length < 5 || length > 150) { showToast('Zadejte délku 5–150 cm', 'warning'); return; }
    var id = genId();
    var cat = { id: id, fisherId: fisher.id, species: SPECIES, length: length, kept: kept, inRange: length >= MIN_LEN && length <= MAX_LEN, date: today(), timestamp: new Date().toISOString() };
    try {
        await dbSet('catches', id, cat);
        if (!fbReady) { catches.push(cat); lsSave(LS.CATCHES, catches); }
        closeModal($('#modal-fisher-catch'));
        renderFisherProfile(fisher);
        showToast('🐟 Úlovek ' + length + ' cm zapsán', 'success');
    } catch (err) { showToast('Nepodařilo se zapsat', 'danger'); }
});
$('#fisher-visit-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var fisher = getLoggedInFisher();
    if (!fisher) return;
    var name = $('#fisher-visit-name').value.trim();
    if (!name) { showToast('Zadejte jméno návštěvy', 'warning'); return; }
    var id = genId();
    var v = { id: id, fisherId: fisher.id, visitorName: name, date: today(), fee: FEE_VISIT, timestamp: new Date().toISOString() };
    try {
        await dbSet('visitors', id, v);
        if (!fbReady) { visitors.push(v); lsSave(LS.VISITORS, visitors); }
        closeModal($('#modal-fisher-visit'));
        renderFisherProfile(fisher);
        showToast('👥 Návštěva zapsána · 300 Kč', 'success');
    } catch (err) { showToast('Nepodařilo se zapsat', 'danger'); }
});
$('#modal-close-fisher-catch').addEventListener('click', function() { closeModal($('#modal-fisher-catch')); });
$('#modal-close-fisher-visit').addEventListener('click', function() { closeModal($('#modal-fisher-visit')); });
$('#btn-podminky-fisher').addEventListener('click', function(e) { e.preventDefault(); openModal(modals.podminky); });
$('#fisher-btn-add-biometric').addEventListener('click', function() {
    var fisher = getLoggedInFisher();
    if (fisher) webauthnRegister(fisher.id, fisher.name);
});
$('#fisher-btn-remove-biometric').addEventListener('click', function() {
    var fisher = getLoggedInFisher();
    if (!fisher) return;
    if (!confirm('Odstranit otisk / Face ID? Budete se přihlašovat jen PINem.')) return;
    removeWebauthnCredentialForFisher(fisher.id);
    updateFisherBiometricButtons(fisher);
    updateBiometricLoginVisibility();
    showToast('Otisk / Face ID odstraněn', 'success');
});
$('#fisher-btn-change-pin').addEventListener('click', function() {
    $('#fisher-pin-new').value = '';
    $('#fisher-pin-confirm').value = '';
    openModal($('#modal-fisher-change-pin'));
});
$('#modal-close-fisher-pin').addEventListener('click', function() { closeModal($('#modal-fisher-change-pin')); });
$('#fisher-change-pin-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var fisher = getLoggedInFisher();
    if (!fisher) return;
    var newPin = $('#fisher-pin-new').value.trim();
    var conf = $('#fisher-pin-confirm').value.trim();
    if (newPin.length !== 6 || !/^\d{6}$/.test(newPin)) { showToast('PIN musí být 6 číslic', 'warning'); return; }
    if (newPin !== conf) { showToast('PINy se neshodují', 'danger'); return; }
    var used = await isPinUsedByOther(newPin, fisher.id);
    if (used) { showToast('Tento PIN už používá jiný rybář', 'danger'); return; }
    var pinHash = await hashPin(newPin);
    fisher.pinHash = pinHash;
    fisher.pinDisplay = newPin;
    try {
        await dbSet('fishers', fisher.id, fisher);
        lsSave(LS.FISHERS, fishers);
        closeModal($('#modal-fisher-change-pin'));
        showToast('PIN změněn', 'success');
    } catch (err) { showToast('Nepodařilo se uložit', 'danger'); }
});

// ════════════════════════════════════════
// NASTAVENÍ – seznam admin PINů
// ════════════════════════════════════════
function renderAdminPinsList() {
    var list = $('#admin-pins-list');
    if (!list) return;
    var hashes = getAdminPinHashes();
    if (!hashes.length) {
        list.innerHTML = '<p class="form-hint">Zatím žádný správce. Přidejte první.</p>';
        return;
    }
    var items = hashes.map(function(h, i) {
        var displayName = getAdminDisplayName(h) || ('Správce ' + (i + 1));
        var canRemove = hashes.length > 1;
        var removeBtn = canRemove ? '<button type="button" class="btn btn-danger btn-sm admin-pin-remove" data-hash="' + h + '" title="Odstranit správce">✕</button>' : '<span class="form-hint" style="font-size:.75rem;">(poslední)</span>';
        return '<div class="pin-item"><span class="pin-item-name">' + esc(displayName) + '</span>' + removeBtn + '</div>';
    }).join('');
    list.innerHTML = '<p class="form-hint" style="margin-bottom:.5rem;">Aktivní správci (' + hashes.length + '):</p>' + items;
    list.querySelectorAll('.admin-pin-remove').forEach(function(btn) {
        btn.onclick = function() {
            var h = btn.getAttribute('data-hash');
            if (!h || !confirm('Odstranit tohoto správce? Nebude se moci přihlásit.')) return;
            if (removeAdminPinHash(h)) {
                renderAdminPinsList();
                showToast('Správce odstraněn', 'success');
            } else {
                showToast('Musí zůstat alespoň jeden správce', 'warning');
            }
        };
    });
}

// ════════════════════════════════════════
// INIT
// ════════════════════════════════════════
fishers  = lsLoad(LS.FISHERS);
checkins = lsLoad(LS.CHECKINS);
catches  = lsLoad(LS.CATCHES);
visitors = lsLoad(LS.VISITORS);

var storedUrl = localStorage.getItem(LS.FB_URL);
var storedKey = localStorage.getItem(LS.FB_KEY);
var fbUrl = (storedUrl && storedUrl.trim()) ? storedUrl.trim() : FB_CONFIG.databaseURL;
var fbKey = (storedKey && storedKey.trim()) ? storedKey.trim() : FB_CONFIG.apiKey;
if (fbUrl && fbKey) initFirebase(fbUrl, fbKey);

if (!fbReady) {
    try {
        var w = localStorage.getItem(LS.WEBAUTHN);
        if (w) { var o = JSON.parse(w); cachedWebauthnCredentials = (o && typeof o === 'object') ? o : {}; }
    } catch (_) {}
}
updateBiometricLoginVisibility();
updateSyncBar();
initYearSelectors();
populateFisherSelects();
$('#ci-date').value = today();
$('#catch-date').value = today();
$('#visit-date').value = today();

var fisher = getLoggedInFisher();
var lastView = null;
try { lastView = localStorage.getItem(LS.LAST_VIEW); } catch (_) {}
if (isAdminMode() && fisher && lastView === 'fisher') {
    showFisherView(fisher);
} else if (isAdminMode()) {
    showAdminView();
    renderFishers();
} else if (fisher) {
    showFisherView(fisher);
} else {
    showLoginScreen();
}
document.addEventListener('click', function(e) {
    if (e.target.closest && e.target.closest('#link-admin-logout')) {
        e.preventDefault();
        e.stopPropagation();
        setAdminUnlocked(false);
        showLoginScreen();
        showToast('Odhlášeno ze správce');
    }
});

})();

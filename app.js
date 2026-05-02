(function () {
'use strict';

// ════════════════════════════════════════
// KONFIGURACE
// ════════════════════════════════════════
const LOCATION  = 'Hluboček';
/** Úlovky – druh ryby a rozmezí délky pro „v normě“ (upravte dle řádu u rybníka). */
const CATCH_SPECIES = [
    { id: 'Kapr', label: 'Kapr', minLen: 45, maxLen: 60, allowKept: true  },
    { id: 'Amur', label: 'Amur', minLen: 45, maxLen: 60, allowKept: false },
    { id: 'Lín',  label: 'Lín',  minLen: 45, maxLen: 60, allowKept: false }
];
function getCatchSpeciesMeta(speciesId) {
    var id = speciesId || 'Kapr';
    for (var i = 0; i < CATCH_SPECIES.length; i++) {
        if (CATCH_SPECIES[i].id === id) return CATCH_SPECIES[i];
    }
    return CATCH_SPECIES[0];
}
function catchLengthInRange(length, speciesId) {
    var m = getCatchSpeciesMeta(speciesId);
    return length >= m.minLen && length <= m.maxLen;
}
/** Lze zaznamenat odnětí ryby domů (u amura a lína jen evidence míry, bez odnesení). */
function catchSpeciesAllowsKept(speciesId) {
    return getCatchSpeciesMeta(speciesId).allowKept === true;
}
function isCatchKeptDisplayed(cat) {
    return !!(cat && cat.kept && catchSpeciesAllowsKept(cat.species));
}
const FEE_VISIT = 300;  // poplatek za návštěvu / 24 h (dle řádu; návštěva si nesmí přisvojit rybu)

const BASE_URL  = 'https://hlubocek.github.io';

// Výchozí Firebase – databáze hlubocek (uživatelé se k ní standardně připojí).
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
    LAST_VIEW: 'hlb_last_view',  // 'admin' | 'fisher' – při obnovení stránky zachovat zobrazení
    BACKUPS_INDEX: 'hlb_backups_index'  // pole klíčů hlb_backup_<timestamp>
};
/** Kolik posledních kompletních záloh držet v localStorage (navíc ke staženým souborům). */
const LOCAL_BACKUP_MAX = 10;

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
var pendingBackupRestoreMode = null;  // 'merge' | 'replace' před výběrem souboru zálohy

/** Načte pole z localStorage – Firebase ukládá i mapu {id: záznam}, musí být Object.values. */
function lsLoad(k) {
    try {
        var raw = localStorage.getItem(k);
        if (raw == null || raw === '') return [];
        var v = JSON.parse(raw);
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object') return Object.values(v);
        return [];
    } catch (_) { return []; }
}
function lsSave(k, d) { localStorage.setItem(k, JSON.stringify(d)); }
function genId()      { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }

/** Hodnota z Firebase RTDB (null | pole | mapa id → záznam) → pole záznamů. */
function firebaseValToRecords(val) {
    if (val == null) return [];
    if (Array.isArray(val)) return val.slice();
    if (typeof val === 'object') return Object.values(val);
    return [];
}
/** Sjednotí jméno (visitorName / name) a datum (date / timestamp) u návštěvy. */
function normalizeVisitorDoc(v) {
    if (!v || typeof v !== 'object') return null;
    var out = Object.assign({}, v);
    var vn = out.visitorName != null ? String(out.visitorName).trim() : '';
    if (!vn && out.name != null) vn = String(out.name).trim();
    out.visitorName = vn || '—';
    var dateStr = out.date != null ? String(out.date).trim().slice(0, 10) : '';
    if (!dateStr && out.timestamp && typeof out.timestamp === 'string' && out.timestamp.length >= 10) {
        dateStr = out.timestamp.slice(0, 10);
    }
    out.date = dateStr;
    return out;
}
function visitorsFromDb(val) {
    return firebaseValToRecords(val).map(normalizeVisitorDoc).filter(Boolean);
}

/**
 * Sloučí návštěvy podle id: nejdřív místní, pak přepíše hodnotami z cloudu (stejné id).
 * Zachová záznamy, které jsou jen v prohlížeči a v RTDB chybí — nic se nezahodí.
 */
function mergeVisitorListsById(remoteList, localList) {
    var map = {};
    localList.forEach(function(v) {
        if (v && v.id) map[v.id] = normalizeVisitorDoc(v);
    });
    remoteList.forEach(function(v) {
        if (v && v.id) map[v.id] = normalizeVisitorDoc(v);
    });
    return Object.keys(map).map(function(k) { return map[k]; });
}
function visitorsNeedFirebaseUpload(fromRemote, merged) {
    if (!merged.length) return false;
    if (!fromRemote.length) return true;
    return merged.length > fromRemote.length;
}
function pushVisitorsToFirebase(list) {
    if (!fbReady || !db || !list || !list.length) return Promise.resolve();
    var updates = {};
    for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (v && v.id) updates['visitors/' + v.id] = v;
    }
    if (!Object.keys(updates).length) return Promise.resolve();
    return db.ref().update(updates).catch(function(err) { console.error('pushVisitorsToFirebase', err); });
}
/** Nastaví globální visitors + uloží do LS; při rozdílu místní vs. remote doplní Firebase (sloučený stav). */
function applyVisitorsSnapshot(remoteVal, autoPushIfNeeded) {
    var fromRemote = visitorsFromDb(remoteVal);
    var fromLocal = visitorsFromDb(lsLoad(LS.VISITORS));
    var merged = mergeVisitorListsById(fromRemote, fromLocal);
    visitors = merged;
    lsSave(LS.VISITORS, visitors);
    if (autoPushIfNeeded && visitorsNeedFirebaseUpload(fromRemote, merged)) {
        pushVisitorsToFirebase(visitors).then(function() {
            if (visitors.length) showToast('Návštěvy sloučeny (prohlížeč + databáze) a uloženy do Firebase.', 'success');
        });
    }
    return { merged: merged, fromRemote: fromRemote };
}

// ════════════════════════════════════════
// ZÁLOHY (JSON + rotující kopie v localStorage)
// ════════════════════════════════════════
function collectFullBackupPayload() {
    return {
        exportedAt: new Date().toISOString(),
        app: 'rybari-registrace-hlubocek',
        schemaVersion: 1,
        fishers: fishers.slice(),
        checkins: checkins.slice(),
        catches: catches.slice(),
        visitors: visitors.slice()
    };
}
/** Uloží kompletní snímek do rotující fronty v localStorage (ničí nejstarší po LOCAL_BACKUP_MAX). */
function saveRollingLocalBackup(reason) {
    try {
        var payload = collectFullBackupPayload();
        payload.backupReason = reason || '';
        var json = JSON.stringify(payload);
        if (json.length > 4e6) {
            console.warn('Záloha příliš velká pro localStorage, přeskočeno.');
            return null;
        }
        var id = 'hlb_backup_' + Date.now();
        localStorage.setItem(id, json);
        var idx = [];
        try { idx = JSON.parse(localStorage.getItem(LS.BACKUPS_INDEX) || '[]'); } catch (_) { idx = []; }
        if (!Array.isArray(idx)) idx = [];
        idx.push(id);
        while (idx.length > LOCAL_BACKUP_MAX) {
            var old = idx.shift();
            try { localStorage.removeItem(old); } catch (_) {}
        }
        localStorage.setItem(LS.BACKUPS_INDEX, JSON.stringify(idx));
        return id;
    } catch (e) {
        console.error('saveRollingLocalBackup', e);
        return null;
    }
}
function downloadBackupJson(reason) {
    var payload = collectFullBackupPayload();
    payload.backupReason = reason || 'manual_download';
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    var a = document.createElement('a');
    var fname = 'hlubocek-zaloha-' + payload.exportedAt.slice(0, 19).replace(/[:]/g, '-').replace('T', '_') + '.json';
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    saveRollingLocalBackup(reason || 'manual_download');
    showToast('Záloha stažena. Kopie je také mezi posledními ' + LOCAL_BACKUP_MAX + ' zálohami v tomto prohlížeči.', 'success');
}
/** Před zničením dat v RTDB – stažení JSON + rotující kopie (volat jen po kliknutí uživatele). */
function backupBeforeDestructiveAction(reason) {
    try {
        downloadBackupJson(reason || 'pred_smazanim');
    } catch (e) {
        console.error('backupBeforeDestructiveAction', e);
    }
}

function backupPayloadToArrays(payload) {
    function arr(x) {
        if (Array.isArray(x)) return x.slice();
        if (x && typeof x === 'object') return Object.values(x);
        return [];
    }
    var vis = arr(payload.visitors).map(function(v) { return normalizeVisitorDoc(v); }).filter(Boolean);
    return {
        fishers: arr(payload.fishers),
        checkins: arr(payload.checkins),
        catches: arr(payload.catches),
        visitors: vis
    };
}
function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    var a = backupPayloadToArrays(payload);
    return a.fishers.length + a.checkins.length + a.catches.length + a.visitors.length > 0;
}
/** Sloučení záznamů podle id: stávající, pak přepíše hodnotami ze zálohy (stejné id). */
function mergeRecordArraysById(existing, incoming) {
    var map = {};
    existing.forEach(function(x) {
        if (x && x.id) map[x.id] = Object.assign({}, x);
    });
    incoming.forEach(function(x) {
        if (!x || !x.id) return;
        map[x.id] = Object.assign({}, map[x.id] || {}, x);
    });
    return Object.keys(map).map(function(k) { return map[k]; });
}
function persistCollectionsToLocalStorage() {
    lsSave(LS.FISHERS, fishers);
    lsSave(LS.CHECKINS, checkins);
    lsSave(LS.CATCHES, catches);
    lsSave(LS.VISITORS, visitors);
}
function buildFirebaseSyncUpdates() {
    var updates = {};
    fishers.forEach(function(f) { if (f && f.id) updates['fishers/' + f.id] = f; });
    checkins.forEach(function(c) { if (c && c.id) updates['checkins/' + c.id] = c; });
    catches.forEach(function(c) { if (c && c.id) updates['catches/' + c.id] = c; });
    visitors.forEach(function(v) { if (v && v.id) updates['visitors/' + v.id] = v; });
    return updates;
}
/** Firebase multi-path update po částech (limity velikosti požadavku). */
function firebaseMultiPathUpdateChunked(updates) {
    if (!fbReady || !db) return Promise.resolve();
    var keys = Object.keys(updates);
    if (!keys.length) return Promise.resolve();
    var CHUNK = 350;
    var chain = Promise.resolve();
    for (var i = 0; i < keys.length; i += CHUNK) {
        (function(slice) {
            chain = chain.then(function() {
                var batch = {};
                for (var j = 0; j < slice.length; j++) {
                    batch[slice[j]] = updates[slice[j]];
                }
                return db.ref().update(batch);
            });
        })(keys.slice(i, i + CHUNK));
    }
    return chain;
}
function offerFirebaseSyncAfterRestore() {
    if (!fbReady || !db) {
        showToast('Data obnovena v tomto prohlížeči (Firebase nepřipojena).', 'success');
        return Promise.resolve();
    }
    if (!confirm('Odeslat obnovená data do Firebase?\n\nDoporučeno — jinak může příští synchronizace z cloudu přepsat obnovené záznamy staršími kopiemi.')) {
        showToast('Obnova jen lokálně. Později použijte „Obnovit data“ nebo znovu připojte Firebase a odešlete zálohu.', 'warning');
        return Promise.resolve();
    }
    return firebaseMultiPathUpdateChunked(buildFirebaseSyncUpdates()).then(function() {
        showToast('Obnova dokončena a uložena do Firebase.', 'success');
    }).catch(function(err) {
        console.error(err);
        showToast('Obnova je uložena lokálně, upload do Firebase se nepovedl.', 'danger');
    });
}
function runRestoreFromParsedPayload(payload, mode) {
    if (!isAdminMode()) { showToast('Obnovení je dostupné v režimu správce.', 'warning'); return; }
    if (!validateBackupPayload(payload)) { showToast('Neplatná nebo prázdná záloha.', 'danger'); return; }
    if (mode === 'merge') {
        if (!confirm('Sloučit zálohu do stávajících dat? (Stejná id se přepíšou hodnotami ze zálohy, nová id se doplní.)')) return;
    } else if (mode === 'replace') {
        if (!confirm('Nahradit všechna lokální data (držitelé, docházka, úlovky, návštěvy) touto zálohou?')) return;
    }
    var a = backupPayloadToArrays(payload);
    if (mode === 'replace') {
        fishers = a.fishers.slice();
        checkins = a.checkins.slice();
        catches = a.catches.slice();
        visitors = a.visitors.slice();
    } else {
        fishers = mergeRecordArraysById(fishers, a.fishers);
        checkins = mergeRecordArraysById(checkins, a.checkins);
        catches = mergeRecordArraysById(catches, a.catches);
        visitors = mergeVisitorListsById(a.visitors, visitors);
    }
    persistCollectionsToLocalStorage();
    try { saveRollingLocalBackup('po_obnove'); } catch (_) {}
    rerender();
    updateSyncBar();
    offerFirebaseSyncAfterRestore();
}
function runRestoreFromStorageKey(storageKey, mode) {
    if (!isAdminMode()) { showToast('Obnovení je dostupné v režimu správce.', 'warning'); return; }
    var raw = localStorage.getItem(storageKey);
    if (!raw) { showToast('Tento snímek už v prohlížeči není.', 'danger'); return; }
    try {
        var payload = JSON.parse(raw);
        runRestoreFromParsedPayload(payload, mode);
    } catch (e) {
        console.error(e);
        showToast('Snímek nelze načíst.', 'danger');
    }
}
function renderSettingsBackupsList() {
    var box = document.getElementById('settings-backups-list');
    if (!box) return;
    var idx = [];
    try { idx = JSON.parse(localStorage.getItem(LS.BACKUPS_INDEX) || '[]'); } catch (_) { idx = []; }
    if (!Array.isArray(idx) || !idx.length) {
        box.innerHTML = '<p class="form-hint">Zatím žádné automatické snímky. Po synchronizaci nebo stažení zálohy se začnou ukládat.</p>';
        return;
    }
    var parts = [];
    idx.slice().reverse().forEach(function(key) {
        var raw = localStorage.getItem(key);
        if (!raw) return;
        var meta = key;
        try {
            var p = JSON.parse(raw);
            var ar = backupPayloadToArrays(p);
            var n = ar.fishers.length + ar.checkins.length + ar.catches.length + ar.visitors.length;
            meta = (p.exportedAt || '').replace('T', ' ').slice(0, 19) + ' · ' + n + ' záznamů' + (p.backupReason ? ' · ' + String(p.backupReason) : '');
        } catch (_) {}
        parts.push(
            '<div class="pin-item" style="flex-wrap:wrap;gap:.35rem;align-items:center;">' +
            '<span class="pin-item-name" style="flex:1;min-width:10rem;font-size:.82rem;">' + esc(meta) + '</span>' +
            '<button type="button" class="btn btn-secondary btn-sm backup-local-merge" data-backup-key="' + esc(key) + '">Sloučit</button>' +
            '<button type="button" class="btn btn-secondary btn-sm backup-local-replace" data-backup-key="' + esc(key) + '">Nahradit</button>' +
            '</div>'
        );
    });
    box.innerHTML = parts.length ? parts.join('') : '<p class="form-hint">Žádné platné snímky.</p>';
    box.querySelectorAll('.backup-local-merge').forEach(function(btn) {
        btn.onclick = function() {
            var k = btn.getAttribute('data-backup-key');
            if (k) runRestoreFromStorageKey(k, 'merge');
            renderSettingsBackupsList();
        };
    });
    box.querySelectorAll('.backup-local-replace').forEach(function(btn) {
        btn.onclick = function() {
            var k = btn.getAttribute('data-backup-key');
            if (k) runRestoreFromStorageKey(k, 'replace');
            renderSettingsBackupsList();
        };
    });
}

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
    db.ref('visitors').on('value', s => { applyVisitorsSnapshot(s.val(), true); rerender(); });
    db.ref('activity').limitToLast(30).on('value', s => {
        var val = s.val();
        activity = val ? Object.keys(val).map(function(k) { var v = val[k]; v._key = k; return v; }) : [];
        activity = activity.filter(function(a) { return a.type === 'registration'; }).sort(function(a, b) { return (b.at || '').localeCompare(a.at || ''); });
        rerender();
    });
    // Okamžité načtení všech dat (držitelé, úlovky, docházka, návštěvy, admin PINy) – spolehlivé na všech zařízeních
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
        applyVisitorsSnapshot(ss[3].val(), false);
        var v = ss[4].val();
        if (Array.isArray(v)) cachedAdminPinHashes = v;
        else if (v && typeof v === 'object') cachedAdminPinHashes = Object.values(v);
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        updateSyncBar();
        rerender();
        try { saveRollingLocalBackup('po_sync_rtdb'); } catch (_) {}
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
        showToast(fishers.length ? 'Data načtena (' + fishers.length + ' v evidenci)' : 'V databázi zatím nikdo není', 'success');
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
        applyVisitorsSnapshot(ss[3].val(), true);
        lsSave(LS.FISHERS, fishers); lsSave(LS.CHECKINS, checkins); lsSave(LS.CATCHES, catches); lsSave(LS.VISITORS, visitors);
        updateSyncBar();
        rerender();
        showToast('Data načtena', 'success');
    }).catch(function() { showToast('Nepodařilo se načíst data', 'danger'); });
}

function dedupeCatches(arr) {
    var seen = new Set();
    return arr.filter(function(c) {
        var key = (c.fisherId || '') + '|' + (c.date || '') + '|' + (c.length || '') + '|' + (c.kept ? '1' : '0') + '|' + (c.species || 'Kapr');
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
    if (!Array.isArray(arr) || !arr.length) return [];
    var seen = new Set();
    return arr.filter(function(v) {
        if (!v) return false;
        var key = (v.id != null && String(v.id) !== '') ? ('id:' + String(v.id))
            : ((v.fisherId || '') + '|' + (v.date || '') + '|' + (v.visitorName || ''));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
/** Kalendářní rok záznamu návštěvy: timestamp ISO, date YYYY-MM-DD, případně d.m.yyyy apod. */
function visitorRecordYear(v) {
    if (!v) return '';
    if (v.timestamp && typeof v.timestamp === 'string' && v.timestamp.length >= 4) {
        var yt = v.timestamp.slice(0, 4);
        if (/^\d{4}$/.test(yt)) return yt;
    }
    var d = v.date;
    if (d == null || d === '') return '';
    d = String(d).trim();
    var m = d.match(/^(\d{4})-\d{2}-\d{2}/);
    if (m) return m[1];
    m = d.match(/^(\d{4})[./-]/);
    if (m) return m[1];
    m = d.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    if (m) return m[3];
    m = d.match(/(\d{4})/);
    if (m) return m[1];
    return '';
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
    try {
        var t = document.getElementById('toast');
        if (!t) { console.warn('showToast: chybí #toast', msg); return; }
        t.textContent = msg;
        t.className = 'toast show' + (type ? ' toast-' + type : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function() { t.className = 'toast'; }, 3000);
    } catch (e) { console.warn('showToast', e); }
}
function setLoginStatus(msg, isError) {
    try {
        var el = document.getElementById('login-status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'login-status' + (isError ? ' is-error' : '');
    } catch (_) {}
}
function clearLoginStatus() {
    setLoginStatus('', false);
}

/** Přihlášení PINem – registrace hned zde, aby pozdější chyba v init nenechala formulář „mrtvý“. */
function onLoginFormSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    doLoginPinFlow().catch(function(err) {
        console.error('doLoginPinFlow', err);
        var btn = document.getElementById('login-submit');
        if (btn) { btn.disabled = false; btn.textContent = 'Přihlásit'; }
        setLoginStatus('Neočekávaná chyba při přihlášení. Obnovte stránku (Ctrl+F5).', true);
    });
}
(function wireLoginFormEarly() {
    var loginFormEl = document.getElementById('login-form');
    if (loginFormEl) loginFormEl.addEventListener('submit', onLoginFormSubmit);
    var loginSubmitBtn = document.getElementById('login-submit');
    if (loginSubmitBtn) {
        loginSubmitBtn.addEventListener('click', function(e) {
            e.preventDefault();
            onLoginFormSubmit(e);
        });
    }
    var loginPinField0 = document.getElementById('login-pin');
    if (loginPinField0) {
        loginPinField0.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var f = document.getElementById('login-form');
            if (f && typeof f.requestSubmit === 'function') f.requestSubmit();
            else onLoginFormSubmit(e);
        });
    }
})();

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
        await ensureLoginDataFromFirebaseOrTimeout();
        var r = await checkAdminPin(pin);
        if (!r.ok) { showToast(r.msg, 'danger'); return; }
        setAdminUnlocked(true);
        closeModal(modals.adminPin);
        if (pinEl) pinEl.value = '';
        renderFishers();
        showToast('Přihlášení: režim správce', 'success');
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
    showToast(fbReady ? 'PIN správce uložen (platí všude)' : 'PIN správce uložen', 'success');
    renderAdminPinsList();
});

// ── Helpers ──
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function initCatchSpeciesSelects() {
    var html = CATCH_SPECIES.map(function(s) {
        return '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>';
    }).join('');
    var a = $('#catch-species');
    var b = $('#fisher-catch-species');
    if (a) a.innerHTML = html;
    if (b) b.innerHTML = html;
}
function refreshCatchLengthHint(lengthEl, hintEl, speciesEl) {
    if (!lengthEl || !hintEl) return;
    var speciesId = speciesEl && speciesEl.value ? speciesEl.value : CATCH_SPECIES[0].id;
    var meta = getCatchSpeciesMeta(speciesId);
    var val = parseInt(lengthEl.value, 10);
    if (!val) { hintEl.textContent = ''; hintEl.className = 'form-hint'; return; }
    if (val >= meta.minLen && val <= meta.maxLen) {
        hintEl.className = 'form-hint hint-ok';
        hintEl.textContent = '✓ V normě (' + meta.minLen + '–' + meta.maxLen + ' cm)';
    } else {
        hintEl.className = 'form-hint hint-outside';
        hintEl.textContent = '⚠ Mimo normu (' + meta.minLen + '–' + meta.maxLen + ' cm)';
    }
}
function syncAdminCatchKeptRow() {
    var row = $('#catch-kept-row');
    var spec = $('#catch-species');
    var cb = $('#catch-kept');
    if (!row) return;
    var sid = spec && spec.value ? spec.value : CATCH_SPECIES[0].id;
    row.style.display = catchSpeciesAllowsKept(sid) ? '' : 'none';
    if (!catchSpeciesAllowsKept(sid) && cb) cb.checked = false;
}
function syncFisherCatchKeptRow() {
    var row = $('#fisher-catch-kept-row');
    var spec = $('#fisher-catch-species');
    var cb = $('#fisher-catch-kept');
    if (!row) return;
    var sid = spec && spec.value ? spec.value : CATCH_SPECIES[0].id;
    row.style.display = catchSpeciesAllowsKept(sid) ? '' : 'none';
    if (!catchSpeciesAllowsKept(sid) && cb) cb.checked = false;
}
function bindCatchLengthSpeciesHints(lengthId, hintId, speciesId, onSpeciesChange) {
    var len = $(lengthId);
    var hint = $(hintId);
    var spec = speciesId ? $(speciesId) : null;
    if (!len || !hint) return;
    function upd() { refreshCatchLengthHint(len, hint, spec); }
    len.addEventListener('input', upd);
    if (spec) {
        spec.addEventListener('change', function() {
            upd();
            if (onSpeciesChange) onSpeciesChange();
        });
    }
}
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
    if (typeof window.isSecureContext !== 'undefined' && !window.isSecureContext) {
        throw new Error('PIN vyžaduje zabezpečený kontext (HTTPS). Otevřete https://hlubocek.github.io');
    }
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
/**
 * Před přihlášením (PIN / biometrie): v InPrivate může být mezipaměť prázdná — načte držitele, správcovské PINy a mapu otisků z Firebase.
 */
async function ensureLoginDataFromFirebase() {
    if (!fbReady || !db) return;
    try {
        if (fishers.length === 0) {
            var fs = await db.ref('fishers').once('value');
            var fv = fs.val();
            if (fv) {
                fishers = Object.values(fv);
                try { lsSave(LS.FISHERS, fishers); } catch (_) {}
            }
        }
        if (!cachedAdminPinHashes.length) {
            var snap = await db.ref('config/adminPinHashes').once('value');
            var v = snap.val();
            if (v) {
                if (Array.isArray(v)) cachedAdminPinHashes = v;
                else if (typeof v === 'object') cachedAdminPinHashes = Object.values(v);
            }
            if (!cachedAdminPinHashes.length) {
                var old = await db.ref('config/pinHash').once('value');
                if (old.val()) setAdminPinHashes([old.val()]);
            }
        }
        if (!Object.keys(cachedWebauthnCredentials).length) {
            var ws = await db.ref('config/webauthnCredentials').once('value');
            var wv = ws.val();
            var fromDb = (wv && typeof wv === 'object') ? wv : {};
            var local = {};
            try {
                var raw = localStorage.getItem(LS.WEBAUTHN);
                if (raw) local = JSON.parse(raw) || {};
            } catch (_) {}
            var merged = Object.assign({}, fromDb, local);
            if (Object.keys(merged).length) setWebauthnCredentials(merged);
        }
    } catch (e) {
        console.warn('ensureLoginDataFromFirebase', e);
    }
}
/** Stejné jako ensureLoginDataFromFirebase, ale s časovým limitem (aby UI neviselo na „Ověřuji…“). */
function ensureLoginDataFromFirebaseOrTimeout(ms) {
    ms = ms || 14000;
    return new Promise(function(resolve, reject) {
        var settled = false;
        var t = setTimeout(function() {
            if (settled) return;
            settled = true;
            reject(new Error('Načtení dat pro přihlášení přesáhlo časový limit. Zkuste znovu nebo síť / blokování InPrivate.'));
        }, ms);
        Promise.resolve(ensureLoginDataFromFirebase()).then(
            function() {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                resolve();
            },
            function(e) {
                if (settled) return;
                settled = true;
                clearTimeout(t);
                reject(e);
            }
        );
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
    try {
        return !!(window.PublicKeyCredential && typeof navigator.credentials !== 'undefined' && navigator.credentials && typeof navigator.credentials.create === 'function' && typeof navigator.credentials.get === 'function' && window.crypto && window.crypto.subtle);
    } catch (_) { return false; }
}
/** Jednotný řetězec id přihlašovacího údaje (řeší rozdíly prohlížečů ArrayBuffer vs string). */
function webauthnCredentialIdToString(credId) {
    if (credId == null || credId === '') return '';
    if (typeof credId === 'string') return credId;
    try {
        if (credId instanceof ArrayBuffer) return base64urlEncode(credId);
        if (credId.buffer instanceof ArrayBuffer) return base64urlEncode(new Uint8Array(credId));
    } catch (_) {}
    return String(credId);
}
/** Najde fisherId v mapě otisků i při mírném rozdílu kódování id (string vs rawId). */
function findFisherIdForWebauthnAssertion(creds, assertion) {
    if (!creds || !assertion) return null;
    var idStr = webauthnCredentialIdToString(assertion.id);
    var rawStr = '';
    try {
        if (assertion.rawId) rawStr = base64urlEncode(new Uint8Array(assertion.rawId));
    } catch (_) {}
    if (idStr && creds[idStr]) return creds[idStr];
    if (rawStr && creds[rawStr]) return creds[rawStr];
    var want = null;
    try {
        if (assertion.rawId) want = new Uint8Array(assertion.rawId);
    } catch (_) {}
    if (!want || !want.length) return null;
    var keys = Object.keys(creds);
    for (var i = 0; i < keys.length; i++) {
        try {
            var buf = base64urlDecode(keys[i]);
            var got = new Uint8Array(buf);
            if (got.length !== want.length) continue;
            var ok = true;
            for (var j = 0; j < got.length; j++) {
                if (got[j] !== want[j]) { ok = false; break; }
            }
            if (ok) return creds[keys[i]];
        } catch (_) {}
    }
    return null;
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
        var cid = webauthnCredentialIdToString(cred.id);
        if (!cid) throw new Error('Neplatné id přihlašovacího údaje');
        addWebauthnCredential(cid, fisherId);
        updateBiometricLoginVisibility();
        updateFisherBiometricButtons(fishers.find(function(f) { return f.id === fisherId; }));
        showToast('Otisk / Face ID uložen', 'success');
    } catch (err) {
        console.error('WebAuthn register:', err);
        if (err.name === 'NotAllowedError') showToast('Registrace zrušena nebo čas vypršel', 'warning');
        else showToast('Nepodařilo se přidat otisk. Zkuste znovu.', 'danger');
    }
}
async function webauthnAuthenticate() {
    await ensureLoginDataFromFirebaseOrTimeout();
    var creds = getWebauthnCredentials();
    var ids = Object.keys(creds);
    if (!ids.length) {
        showToast('Žádný otisk není zaregistrován. Přihlaste se PINem.', 'warning');
        return;
    }
    if (!isWebAuthnSupported()) {
        showToast('Otisk / Face ID v tomto režimu prohlížeče není k dispozici. Přihlaste se PINem.', 'warning');
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
        var fisherId = findFisherIdForWebauthnAssertion(creds, assertion);
        if (!fisherId) throw new Error('Neznámý přihlašovací identifikátor');
        var fisher = fishers.find(function(f) { return f.id === fisherId; });
        if (!fisher && fbReady && db) {
            await ensureLoginDataFromFirebase();
            fisher = fishers.find(function(f) { return f.id === fisherId; });
        }
        if (!fisher) {
            showToast('Profil držitele není v evidenci. Přihlaste se PINem nebo zkontrolujte připojení k Firebase.', 'danger');
            return;
        }
        try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
        showFisherView(fisher);
        showToast('Vítejte, ' + fisher.name, 'success');
    } catch (err) {
        console.error('WebAuthn authenticate:', err);
        if (err.name === 'NotAllowedError') {
            showToast('Přihlášení otiskem zrušeno nebo zamítnuto (v anonymním okně Edge často nefunguje). Použijte PIN.', 'warning');
        } else if (err.name === 'SecurityError' || (err.message && String(err.message).indexOf('secure') >= 0)) {
            showToast('Otisk vyžaduje HTTPS a podporu prohlížeče. Použijte PIN.', 'danger');
        } else {
            showToast('Otisk se nepovedl — přihlaste se PINem (vždy funguje).', 'danger');
        }
    }
}

// ── Sync bar ──
function updateSyncBar() {
    const bar = $('#sync-bar'), icon = $('#sync-icon'), text = $('#sync-text'), btn = $('#btn-sync-setup'), refreshWrap = $('#sync-refresh-wrap');
    if (!bar || !icon || !text || !btn) return;
    if (fbReady) {
        bar.className = 'sync-bar sync-firebase';
        icon.textContent = '🔥';
        text.textContent = 'Firebase – data sdílena v reálném čase' + (fishers.length ? ' (' + fishers.length + ' v evidenci)' : '');
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

// ── Naplnit všechny select držitelů povolenky ──
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
    clearLoginStatus();
    updateBiometricLoginVisibility();
    if (fbReady && db) {
        ensureLoginDataFromFirebase().then(function() {
            updateBiometricLoginVisibility();
            try { populateFisherSelects(); } catch (_) {}
        });
    }
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
    $('#fisher-pin-hint').textContent = 'Předejte osobě s povolenkou – slouží k přihlášení. Musí být unikátní.';
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
        showToast('Tento PIN už patří k jinému záznamu', 'danger');
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
        showToast(editingFisherId ? 'Údaje uloženy' : ('Záznam vytvořen: ' + name + ' · PIN: ' + pin));
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
            empty.innerHTML = '<span class="empty-icon">👤</span><p>Zatím nejsou přidáni žádní držitelé povolenky.</p><p class="hint">Nové přidejte přes tlačítko „📱 QR odkaz na aplikaci“ (vyvěste QR u rybníka) nebo otevřete aplikaci v režimu správce.</p>';
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
    if (!f || !confirm('Odstranit záznam držitele povolenky ' + f.name + ' včetně všech dat u této osoby?')) return;
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
        showToast('Záznam odstraněn');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se odstranit záznam', 'danger');
    }
};

// ════════════════════════════════════════
// DOCHÁZKA
// ════════════════════════════════════════
$('#btn-ci-submit').addEventListener('click', async function() {
    var fid  = $('#ci-fisher').value;
    var date = $('#ci-date').value;
    if (!fid)  { showToast('Nejdříve přidejte osobu s povolenkou', 'warning'); return; }
    if (!date) { showToast('Vyberte datum', 'warning'); return; }
    var already = checkins.find(function(c) { return c.fisherId === fid && c.date === date; });
    if (already) { showToast('Pro tento den je u této osoby příchod už zapsaný', 'warning'); return; }
    var id = genId();
    var ci = { id: id, fisherId: fid, date: date, timestamp: new Date().toISOString() };
    try {
        await dbSet('checkins', id, ci);
        if (!fbReady) { checkins.push(ci); lsSave(LS.CHECKINS, checkins); }
        renderDochazka();
        showToast('✓ Příchod uložen', 'success');
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
        showToast('Položka odstraněna');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se smazat', 'danger');
    }
};

// ════════════════════════════════════════
// ÚLOVKY
// ════════════════════════════════════════

$('#btn-catch-submit').addEventListener('click', async function() {
    var fid    = $('#catch-fisher').value;
    var date   = $('#catch-date').value;
    var speciesId = $('#catch-species').value || CATCH_SPECIES[0].id;
    var length = parseInt($('#catch-length').value, 10);
    var meta   = getCatchSpeciesMeta(speciesId);
    var kept   = catchSpeciesAllowsKept(meta.id) ? $('#catch-kept').checked : false;
    if (!fid)                              { showToast('Nejdříve přidejte osobu s povolenkou', 'warning'); return; }
    if (!date)                             { showToast('Vyberte datum', 'warning'); return; }
    if (!length || length < 5 || length > 150) { showToast('Zadejte délku v cm (5–150)', 'warning'); return; }
    var id  = genId();
    var cat = {
        id: id, fisherId: fid, species: meta.id, length: length, kept: kept,
        inRange: catchLengthInRange(length, meta.id),
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
        if ($('#catch-species')) $('#catch-species').selectedIndex = 0;
        syncAdminCatchKeptRow();
        showToast('🐟 Úlovek · ' + meta.label + ' ' + length + ' cm' + (kept ? ' · s sebou domů' : ''), 'success');
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
    const keptCount = filtered.filter(c => isCatchKeptDisplayed(c)).length;

    cont.innerHTML = `
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.85rem;flex-wrap:wrap;">
            <select id="ulovky-year-sel" class="year-select" onchange="window._refreshUlovky()">
                ${years.map(y=>`<option value="${y}" ${y===selYear?'selected':''}>${y}</option>`).join('')}
            </select>
            <span style="font-size:.82rem;color:var(--text-secondary)">${filtered.length} úlovků · prům. ${filtered.length ? Math.round(filtered.reduce((s,c)=>s+c.length,0)/filtered.length) : 0} cm · ${keptCount}× domů</span>
        </div>
        ${filtered.map(cat => {
            const f = fishers.find(x => x.id === cat.fisherId);
            const sp = getCatchSpeciesMeta(cat.species);
            const inR = catchLengthInRange(cat.length, cat.species);
            return `<div class="catch-row">
                <span class="catch-fish-icon">🐟</span>
                <div class="catch-row-info">
                    <div class="catch-row-name">${f ? esc(f.name) : '?'}</div>
                    <div class="catch-row-meta">${fmtDateShort(cat.date)} · ${fmtTime(cat.timestamp)} · ${esc(sp.label)}</div>
                </div>
                <span class="catch-length ${inR?'':'outside'}">${cat.length} cm</span>
                ${isCatchKeptDisplayed(cat) ? '<span class="catch-kept-badge">domů</span>' : ''}
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
        showToast('Úlovek odstraněn');
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
    if (!fid)         { showToast('Nejdříve přidejte osobu s povolenkou', 'warning'); return; }
    if (!visitorName) { showToast('Zadejte jméno návštěvy', 'warning'); return; }
    if (!date)        { showToast('Vyberte datum', 'warning'); return; }
    var id  = genId();
    var v   = { id: id, fisherId: fid, visitorName: visitorName, date: date, fee: FEE_VISIT, timestamp: new Date().toISOString() };
    try {
        await dbSet('visitors', id, v);
        if (!fbReady) { visitors.push(v); lsSave(LS.VISITORS, visitors); }
        renderNavstevy();
        $('#visit-name').value = '';
        showToast('👥 Záznam návštěvy uložen · ' + FEE_VISIT + ' Kč', 'success');
    } catch (err) {
        console.error(err);
        showToast('Nepodařilo se zapsat návštěvu', 'danger');
    }
});

function visitorGroupDateKey(v) {
    var d = v.date && String(v.date).slice(0, 10);
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    if (v.timestamp && typeof v.timestamp === 'string' && v.timestamp.length >= 10) {
        var t = v.timestamp.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    }
    return '__neurceno__';
}
function fmtVisitGroupHeader(dateKey) {
    if (dateKey === '__neurceno__') return 'Bez data / neurčeno';
    return fmtDate(dateKey);
}

function renderNavstevy() {
    const cont = $('#navstevy-content');
    if (!cont) return;
    var list = Array.isArray(visitors) ? visitors : visitorsFromDb(visitors);
    if (!list.length) {
        cont.innerHTML = `<div class="empty-state"><span class="empty-icon">👥</span><p>Žádné záznamy návštěv v databázi.</p><p class="form-hint" style="margin-top:.65rem;max-width:28rem;">Záznamy se ukládají do Firebase (stejně jako držitelé a docházka). Pokud tu nic není, buď se ještě nezapisovaly, nebo zůstaly jen v jiném prohlížeči / záloze. Po přidání návštěvy by se měla zobrazit všem po synchronizaci.</p></div>`;
        return;
    }
    const deduped = dedupeVisitors(list);
    const sorted  = [...deduped].sort((a,b) => {
        var da = a.date || '', db = b.date || '';
        var d = db.localeCompare(da);
        if (d !== 0) return d;
        var ta = a.timestamp || '', tb = b.timestamp || '';
        return tb.localeCompare(ta);
    });
    var VISITORS_ALL_YEARS = '__all__';
    var yearsNum = [...new Set(sorted.map(v => visitorRecordYear(v)).filter(function(y) { return y && /^\d{4}$/.test(y); }))].sort().reverse();
    var yearChoices = yearsNum.length ? [VISITORS_ALL_YEARS].concat(yearsNum) : [VISITORS_ALL_YEARS];
    var prevSel = $('#navstevy-year-sel') && $('#navstevy-year-sel').value;
    var selYear = (prevSel && yearChoices.indexOf(prevSel) >= 0) ? prevSel : VISITORS_ALL_YEARS;
    var filtered = selYear === VISITORS_ALL_YEARS ? sorted.slice() : sorted.filter(function(v) { return visitorRecordYear(v) === selYear; });
    if (!filtered.length && sorted.length && selYear !== VISITORS_ALL_YEARS) {
        selYear = VISITORS_ALL_YEARS;
        filtered = sorted.slice();
    }
    const totalFee  = filtered.reduce((s,v) => s + (v.fee ?? FEE_VISIT), 0);
    const groups    = {};
    filtered.forEach(function(v) {
        var gk = visitorGroupDateKey(v);
        if (!groups[gk]) groups[gk] = [];
        groups[gk].push(v);
    });
    var groupEntries = Object.keys(groups).sort(function(a, b) {
        if (a === '__neurceno__') return 1;
        if (b === '__neurceno__') return -1;
        return b.localeCompare(a);
    }).map(function(k) { return [k, groups[k]]; });

    cont.innerHTML = `
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.85rem;flex-wrap:wrap;">
            <select id="navstevy-year-sel" class="year-select" onchange="window._refreshNavstevy()">
                ${yearChoices.map(y=>`<option value="${y}" ${y===selYear?'selected':''}>${y === VISITORS_ALL_YEARS ? 'Všechny roky' : y}</option>`).join('')}
            </select>
            <span style="font-size:.82rem;color:var(--text-secondary)">${filtered.length} návštěv · celkem <strong>${totalFee} Kč</strong></span>
        </div>
        ${groupEntries.map(([date, vs]) => `
            <div class="day-group">
                <div class="day-label">${fmtVisitGroupHeader(date)} (${vs.length}×)</div>
                ${vs.map(v => {
                    const f = fishers.find(x => x.id === v.fisherId);
                    return `<div class="visit-row">
                        <div class="visit-row-main">
                            <div class="visit-row-name">👤 ${esc(v.visitorName)}</div>
                            <div class="visit-row-meta">držitel povolenky: ${f ? esc(f.name) : '?'}</div>
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
        showToast('Položka odstraněna');
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
    const yearVisitors = visitors.filter(v => visitorRecordYear(v) === curYear);
    const totalVisitFee = yearVisitors.reduce((s,v) => s + (v.fee||0), 0);

    const maxVisits  = Math.max(1, ...fishers.map(f => yearCheckins.filter(c => c.fisherId===f.id).length));
    const maxCatches = Math.max(1, ...fishers.map(f => yearCatches.filter(c => c.fisherId===f.id).length));

    const fisherStats = [...fishers].map(f => ({
        fisher:     f,
        visits:     yearCheckins.filter(c => c.fisherId===f.id).length,
        catches:    yearCatches.filter(c => c.fisherId===f.id).length,
        keptCount:  yearCatches.filter(c => c.fisherId===f.id && isCatchKeptDisplayed(c)).length,
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
        <p class="form-hint" style="margin:.85rem 0 0;line-height:1.45;max-width:36rem;"><strong>Příchody</strong> jsou záznamy ze záložky Docházka; <strong>návštěvy</strong> jsou hosté zapsaní v záložce Návštěvy (jméno a poplatek). Součty v této tabulce nelze „rozvinout“ na jednotlivé řádky zpět — pracuje se se stejnými daty jako v přehledech. Pravidelně stahujte zálohu v nastavení.</p>
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
                        <span class="fsc-bar-val">${s.catches}${s.keptCount ? ' ('+s.keptCount+' domů)' : ''}</span>
                    </div>
                </div>
            </div>`).join('')
        : '<div class="empty-state"><p>Žádná data pro vybraný rok.</p></div>'}`;
}

function initYearSelectors() {
    const el = $('#stats-year');
    if (!el) return;
    const curYear = new Date().getFullYear();
    const years   = [curYear, curYear-1, curYear-2];
    const opts    = years.map(y => `<option value="${y}">${y}</option>`).join('');
    el.innerHTML = opts;
    el.addEventListener('change', renderStatistiky);
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
        cont.innerHTML = '<p class="form-hint">Pro přidání otisku se odhlaste a přihlaste se 6místným PINem jako držitel povolenky (ne jako správce).</p>';
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
    var restoreWrap = document.getElementById('settings-restore-wrap');
    if (restoreWrap) restoreWrap.style.display = isAdminMode() ? 'block' : 'none';
    renderSettingsBackupsList();
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
var btnDlBackup = document.getElementById('btn-download-backup');
if (btnDlBackup) btnDlBackup.addEventListener('click', function() { downloadBackupJson('nastaveni_rucni'); renderSettingsBackupsList(); });
var btnRestoreMerge = document.getElementById('btn-restore-backup-merge');
if (btnRestoreMerge) btnRestoreMerge.addEventListener('click', function() {
    if (!isAdminMode()) { showToast('Obnovení je dostupné v režimu správce.', 'warning'); return; }
    pendingBackupRestoreMode = 'merge';
    var fin = document.getElementById('backup-restore-file');
    if (fin) fin.click();
});
var btnRestoreReplace = document.getElementById('btn-restore-backup-replace');
if (btnRestoreReplace) btnRestoreReplace.addEventListener('click', function() {
    if (!isAdminMode()) { showToast('Obnovení je dostupné v režimu správce.', 'warning'); return; }
    pendingBackupRestoreMode = 'replace';
    var fin = document.getElementById('backup-restore-file');
    if (fin) fin.click();
});
var backupRestoreFile = document.getElementById('backup-restore-file');
if (backupRestoreFile) backupRestoreFile.addEventListener('change', function(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    var mode = pendingBackupRestoreMode;
    pendingBackupRestoreMode = null;
    if (!file || !mode) return;
    if (!isAdminMode()) { showToast('Obnovení je dostupné v režimu správce.', 'warning'); return; }
    var reader = new FileReader();
    reader.onload = function() {
        try {
            var payload = JSON.parse(reader.result);
            runRestoreFromParsedPayload(payload, mode);
            renderSettingsBackupsList();
        } catch (err) {
            console.error(err);
            showToast('Soubor nelze načíst jako platný JSON zálohy.', 'danger');
        }
    };
    reader.onerror = function() { showToast('Chyba čtení souboru.', 'danger'); };
    reader.readAsText(file, 'UTF-8');
});

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
    backupBeforeDestructiveAction('pred_smazanim_vseho');
    if (!confirm('Zkontrolujte složku Stažené soubory — měl se uložit JSON zálohy.\n\nPokračovat ve smazání VŠECH dat z databáze?\n\n• Všechny osoby s povolenkou\n• Všechny úlovky\n• Veškerá docházka\n• Všechny návštěvy\n\nPIN a nastavení zůstanou. Bez zálohy nepokračujte.')) return;
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
// LOGIN HANDLER (sync preventDefault + async tělo — spolehlivější v Edge / InPrivate)
// ════════════════════════════════════════
var loginBiometricBtn = document.getElementById('login-biometric');
if (loginBiometricBtn) loginBiometricBtn.addEventListener('click', function() { webauthnAuthenticate(); });

async function doLoginPinFlow() {
    var pinEl = document.getElementById('login-pin');
    var pin = (pinEl && pinEl.value) ? pinEl.value.replace(/\D/g, '') : '';
    if (!pin) {
        setLoginStatus('Zadejte PIN (6 číslic držitel, 4–8 správce).', true);
        showToast('Zadejte PIN (číslice)', 'warning');
        return;
    }
    clearLoginStatus();
    var btn = document.getElementById('login-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Ověřuji…'; }
    try {
        await ensureLoginDataFromFirebaseOrTimeout();
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
        if (!fisher && fbReady && db) {
            try {
                var fsnap = await db.ref('fishers').once('value');
                var fv = fsnap.val();
                if (fv) {
                    fishers = Object.values(fv);
                    lsSave(LS.FISHERS, fishers);
                    fisher = fishers.find(function(f) { return f.pinHash === h; });
                }
            } catch (_) {}
        }
        if (isAdmin && fisher) {
            pendingLoginFisher = fisher;
            openModal(modals.loginChoice);
            clearLoginStatus();
        } else if (isAdmin) {
            try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
            showAdminView();
            showToast('Přihlášení: režim správce', 'success');
            clearLoginStatus();
        } else if (fisher) {
            showFisherView(fisher);
            showToast('Vítejte, ' + fisher.name, 'success');
            clearLoginStatus();
        } else {
            setLoginStatus('PIN neodpovídá žádnému účtu v evidenci.', true);
            showToast('Nesprávný PIN', 'danger');
        }
    } catch (err) {
        console.error(err);
        var em = err && err.message ? String(err.message) : '';
        if (em.indexOf('HTTPS') >= 0 || em.indexOf('zabezpečen') >= 0) {
            setLoginStatus(em, true);
            showToast(em, 'danger');
        } else if (!window.crypto || !window.crypto.subtle) {
            setLoginStatus('Otevřete stránku přes HTTPS (hlubocek.github.io).', true);
            showToast('PIN vyžaduje HTTPS – otevřete https://hlubocek.github.io', 'danger');
        } else {
            setLoginStatus(em || 'Chyba při ověření. Zkuste znovu.', true);
            showToast(em || 'Chyba při ověření', 'danger');
        }
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Přihlásit'; }
    if (pinEl) pinEl.value = '';
}

// Pending login choice (když PIN platí pro oba režimy)
var loginChoiceAdminBtn = document.getElementById('login-choice-admin');
if (loginChoiceAdminBtn) loginChoiceAdminBtn.addEventListener('click', function() {
    if (pendingLoginFisher) {
        try { localStorage.removeItem(LS.FISHER_ID); } catch (_) {}
        showAdminView();
        showToast('Přihlášení: režim správce', 'success');
        closeModal(modals.loginChoice);
        pendingLoginFisher = null;
    }
});
var loginChoiceFisherBtn = document.getElementById('login-choice-fisher');
if (loginChoiceFisherBtn) loginChoiceFisherBtn.addEventListener('click', function() {
    if (pendingLoginFisher) {
        showFisherView(pendingLoginFisher);
        showToast('Vítejte, ' + pendingLoginFisher.name, 'success');
        closeModal(modals.loginChoice);
        pendingLoginFisher = null;
    }
});

// Přepnutí admin → profil držitele
$('#link-switch-to-fisher').addEventListener('click', function(e) {
    e.preventDefault();
    var adminFishers = getAdminFishers();
    if (adminFishers.length === 1) {
        showFisherView(adminFishers[0]);
        showToast('Přepnuto na profil držitele', 'success');
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

// Přepnutí držitel → správce (ikona v headeru + tlačítko v obsahu)
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
        var sp = getCatchSpeciesMeta(c.species);
        return '<div class="catch-row"><span>🐟 ' + esc(sp.label) + ' ' + c.length + ' cm</span><span>' + fmtDateShort(c.date) + '</span>' + (isCatchKeptDisplayed(c) ? ' <span class="catch-kept-badge">domů</span>' : '') + '</div>';
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
    if (already) { showToast('Příchod na dnešek je už zapsaný', 'warning'); return; }
    var id = genId();
    var ci = { id: id, fisherId: fisher.id, date: date, timestamp: new Date().toISOString() };
    try {
        await dbSet('checkins', id, ci);
        if (!fbReady) { checkins.push(ci); lsSave(LS.CHECKINS, checkins); }
        renderFisherProfile(fisher);
        showToast('✓ Příchod uložen', 'success');
    } catch (err) {
        showToast('Nepodařilo se zapsat', 'danger');
    }
});
$('#fisher-btn-catch').addEventListener('click', function() {
    $('#fisher-catch-length').value = '';
    $('#fisher-catch-length-hint').textContent = '';
    $('#fisher-catch-length-hint').className = 'form-hint';
    if ($('#fisher-catch-species')) $('#fisher-catch-species').selectedIndex = 0;
    $('#fisher-catch-kept').checked = false;
    syncFisherCatchKeptRow();
    openModal($('#modal-fisher-catch'));
});
$('#fisher-btn-visit').addEventListener('click', function() {
    $('#fisher-visit-name').value = '';
    openModal($('#modal-fisher-visit'));
});
$('#fisher-catch-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    var fisher = getLoggedInFisher();
    if (!fisher) return;
    var speciesId = ($('#fisher-catch-species') && $('#fisher-catch-species').value) || CATCH_SPECIES[0].id;
    var meta = getCatchSpeciesMeta(speciesId);
    var length = parseInt($('#fisher-catch-length').value, 10);
    var kept = catchSpeciesAllowsKept(meta.id) ? $('#fisher-catch-kept').checked : false;
    if (!length || length < 5 || length > 150) { showToast('Zadejte délku 5–150 cm', 'warning'); return; }
    var id = genId();
    var cat = { id: id, fisherId: fisher.id, species: meta.id, length: length, kept: kept, inRange: catchLengthInRange(length, meta.id), date: today(), timestamp: new Date().toISOString() };
    try {
        await dbSet('catches', id, cat);
        if (!fbReady) { catches.push(cat); lsSave(LS.CATCHES, catches); }
        closeModal($('#modal-fisher-catch'));
        renderFisherProfile(fisher);
        showToast('🐟 Úlovek · ' + meta.label + ' ' + length + ' cm' + (kept ? ' · s sebou domů' : ''), 'success');
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
        showToast('👥 Záznam návštěvy uložen · 300 Kč', 'success');
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
    if (used) { showToast('Tento PIN už patří k jinému záznamu', 'danger'); return; }
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
        list.innerHTML = '<p class="form-hint">Zatím žádný správcovský PIN. Přidejte první.</p>';
        return;
    }
    var items = hashes.map(function(h, i) {
        var displayName = getAdminDisplayName(h) || ('Správcovský přístup ' + (i + 1));
        var canRemove = hashes.length > 1;
        var removeBtn = canRemove ? '<button type="button" class="btn btn-danger btn-sm admin-pin-remove" data-hash="' + h + '" title="Odstranit správcovský PIN">✕</button>' : '<span class="form-hint" style="font-size:.75rem;">(poslední)</span>';
        return '<div class="pin-item"><span class="pin-item-name">' + esc(displayName) + '</span>' + removeBtn + '</div>';
    }).join('');
    list.innerHTML = '<p class="form-hint" style="margin-bottom:.5rem;">Aktivní správcovské PINy (' + hashes.length + '):</p>' + items;
    list.querySelectorAll('.admin-pin-remove').forEach(function(btn) {
        btn.onclick = function() {
            var h = btn.getAttribute('data-hash');
            if (!h || !confirm('Odstranit tento správcovský PIN? S ním už nepůjde přihlášení do režimu správce.')) return;
            if (removeAdminPinHash(h)) {
                renderAdminPinsList();
                showToast('Správcovský PIN odstraněn', 'success');
            } else {
                showToast('Musí zůstat alespoň jeden správcovský PIN', 'warning');
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
visitors = visitorsFromDb(lsLoad(LS.VISITORS));

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
initCatchSpeciesSelects();
bindCatchLengthSpeciesHints('#catch-length', '#catch-length-hint', '#catch-species', syncAdminCatchKeptRow);
bindCatchLengthSpeciesHints('#fisher-catch-length', '#fisher-catch-length-hint', '#fisher-catch-species', syncFisherCatchKeptRow);
syncAdminCatchKeptRow();
syncFisherCatchKeptRow();
populateFisherSelects();
var _ci = $('#ci-date'), _cd = $('#catch-date'), _vd = $('#visit-date');
if (_ci) _ci.value = today();
if (_cd) _cd.value = today();
if (_vd) _vd.value = today();

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
        showToast('Režim správce ukončen');
    }
});

})();

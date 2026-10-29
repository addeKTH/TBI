/* gui.js ---------------------------------------------------------------------
   User interface of the TBI web app (port of TBI_GUI.m): input tabs (with the
   load models in the Load tab), model, Run with progress bar, result tabs
   Tables, Rail stress, Bridge SF and Bridge disp, Save/Open of the input
   (JSON, same format as TBI_GUI.m), Excel export and printing (report, rail
   stress, bridge SF and disp, A4, "Save as PDF" in the print dialog).
   Andreas Andersson, 2026-10-28, updated 2026-10-29 (assisted by Claude)
---------------------------------------------------------------------------*/
(function () {
'use strict';

const $ = id => document.getElementById(id);
const S = (v, s) => `<i>${v}</i><sub>${s}</sub>`;

// ---------------------------------------------------------------- input fields
// tab, key, label (HTML), kind (edit, drop, check, out, blank), default value (Bryngeån), tooltip, items
const FIELDS = [
 ['Bridge','L',     'Spans <i>L</i> (m)',          'edit','48',        'span lengths, one per span, continuous deck'],
 ['Bridge','E',     '<i>E</i> (GPa)',              'edit','210',       "Young's modulus of the deck; within 15 % of 210 GPa = steel"],
 ['Bridge','A',     '<i>A</i> (m²)',               'edit','0.8',       'cross-section area (equivalent steel section for composite decks)'],
 ['Bridge','I',     '<i>I</i> (m⁴)',               'edit','1.0',       'second moment of area'],
 ['Bridge','eb',    S('e','b') + ' (m)',            'edit','2.15',      'deck neutral axis to bearings'],
 ['Bridge','h',     '<i>h</i> (m)',                'edit','3.75',      'bearings to top of rail'],
 ['Bridge','blank1','',                            'blank','',         ''],
 ['Bridge','dtype', 'Deck type',                   'drop','2 composite','EN 1991-1-5 6.1.1, Figure 6.1 (AC:2009)', ['1 steel','2 composite','3 concrete']],
 ['Bridge','alfab', S('α','b') + ' (1/K)',          'out', '',          'thermal expansion of the deck (from E)'],
 ['Bridge','Lend',  S('L','end') + ' (m)',          'edit','0.45',      'deck end beyond the end bearings, both ends; the model rounds it to s_r/6 and the bridge length to whole s_r (spans scaled), a rail seat at each deck end'],
 ['Bridge','Kh',    S('K','h') + ' (GN/m)',         'edit','0 1e4',     'longitudinal stiffness per support, 0 = movable bearing; filled in (fixed at the right end) when the number of spans changes'],
 ['Bridge','ntrack','Tracks',                      'drop','1',         'number of tracks', ['1','2']],
 ['Bridge','blank2','',                            'blank','',         ''],
 ['Bridge','blank3','',                            'blank','',         ''],
 ['Bridge','Tmode', 'Deck temp.',                  'drop','EN 1991-1-5','EN 1991-1-5 from air temperatures, or the deck temperature change typed directly', ['EN 1991-1-5','direct']],
 ['Bridge','Tmax',  S('T','max') + ' (°C)',         'edit','33',        'max shade air temperature (SS-EN 1991-1-5 NB)'],
 ['Bridge','Tmin',  S('T','min') + ' (°C)',         'edit','-42',       'min shade air temperature'],
 ['Bridge','T0',    S('T','0') + ' (°C)',           'edit','14',        'temperature when the track is fixed = neutral rail temperature (TRVINFRA-00012 R7.2)'],
 ['Bridge','dTN',   'Δ' + S('T','N') + ' s / w (K)','edit','',          'uniform deck temperature change, summer / winter'],
 ['Bridge','TRmin', S('T','R,min') + ' (°C)',       'edit','-42',       'min rail temperature, rail break check'],
 ['Bridge','dTbrk', 'Δ' + S('T','R,brk') + ' (K)',  'out', '',          'rail temperature change for the rail break check, T_R,min - T_0'],
 ['Track','ttype',  'Track',                       'drop','ballasted', 'EN 1991-2:2024 Table 8.9; ballastless sets u0, F_u, e_r and limits', ['ballasted','ballastless']],
 ['Track','profile','Rail',                        'drop','60E1',      'EN 13674-1; custom: type A and I', ['60E1','50E3','custom']],
 ['Track','Ar',     S('A','rail') + ' (cm²)',       'edit','76.7',      'rail cross-section area, per rail (2 rails per track)'],
 ['Track','Ir',     S('I','rail') + ' (cm⁴)',       'edit','3038.3',    'rail second moment of area, per rail'],
 ['Track','er',     S('e','r') + ' (m)',            'edit','0.85',      'top of rail to track slip centre'],
 ['Track','sr',     S('s','r') + ' (m)',            'edit','0.65',      'sleeper spacing'],
 ['Track','Le',     S('L','e') + ' (m)',            'edit','100',       'track on each embankment'],
 ['Track','u0',     S('u','0') + ' s / w (mm)',     'edit','2 0.5',     'elastic displacement, summer / winter (frozen)'],
 ['Track','Fu',     S('F','u') + ' s / w (kN/m)',   'edit','20 30',     'resistance of unloaded track, summer / winter'],
 ['Track','Fl',     S('F','l') + ' (kN/m)',         'edit','60',        'resistance of loaded track'],
 ['Track','Kv',     S('k','v') + ' c / u (MN/m)',   'edit','80 4',      'vertical stiffness per sleeper, 2 rails, compression / uplift'],
 ['Track','gap',    'REJ at <i>x</i> (m)',         'edit','',          'rail expansion joints, x from support 1; empty = CWR'],
 ['Track','dTR',    'Δ' + S('T','R') + ' s / w (K)','edit','',          'rail temperature change, summer / winter; empty: 0 0 for CWR, +50 -50 with rail expansion joints (UIC 774-3)'],
 ['Load','alfa',    '<i>α</i>',                    'edit','1.33',      'load classification factor'],
 ['Load','LM71',    'LM71',                        'check',true,       'LM71 on the whole bridge, locomotive from the movable bearing'],
 ['Load','SW',      'SW/0',                        'check',false,      'SW/0 (continuous decks)'],
 ['Load','dxPos',   'Δ<i>x</i> (m)',               'edit','0',         '0 = fixed load positions, > 0 = locomotive / SW/0 moved in steps'],
 ['Load','qlbk',    S('q','lbk') + ' (kN/m)',       'edit','20',        'braking'],
 ['Load','Qlbk',    S('Q','lbk,max') + ' (kN)',     'edit','6000',      'max braking force'],
 ['Load','qlak',    S('q','lak') + ' (kN/m)',       'edit','33',        'traction'],
 ['Load','Qlak',    S('Q','lak,max') + ' (kN)',     'edit','1000',      'max traction force'],
 ['Limits','sigbr', S('σ','bridge') + ' (MPa)',     'edit','-72 112',   'additional rail stress on the bridge, EN 1991-2:2024 8.5.4.5.1'],
 ['Limits','sigemb',S('σ','emb.') + ' (MPa)',       'edit','-72 112',   'additional rail stress on the embankment'],
 ['Limits','dB',    S('δ','B') + ' (mm)',           'edit','5',         'deck end displacement, braking/traction, 8.5.4.5.2'],
 ['Limits','dH',    S('δ','H') + ' (mm)',           'edit','8',         'deck end displacement, vertical traffic'],
 ['Limits','dV',    S('δ','V') + ' (mm)',           'edit','2',         'vertical deck end displacement (line speed > 160 km/h)'],
 ['Limits','wL',    '<i>L</i>/' + S('δ','max'),      'edit','600',       'largest deflection of a span from vertical traffic: delta <= L/600 (LM71, SW/0 x alpha, no dynamic factor)'],
 ['Limits','wgap',  S('w','gap') + ' (mm)',         'edit','50',        'TRVINFRA-00012 K35714']
].map(d => ({ tab: d[0], key: d[1], label: d[2], kind: d[3], val: d[4], tip: d[5], items: d[6] }));
const TABS = ['Bridge', 'Track', 'Load', 'Limits'];
const NG = 3;                                                      // label/field pairs per row
const P = {};                                                      // input elements by key
let out = null, running = false;

// ---------------------------------------------------------------- symbols
const ICON = {
 run: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#21963f"/><polygon points="9.5,7 9.5,17 17.5,12" fill="#fff"/></svg>',
 reset: '<svg viewBox="0 0 24 24"><path d="M18.06 8.5 A7 7 0 1 1 12 5" fill="none" stroke="#cc2626" stroke-width="3"/>' +
        '<polygon points="12,0.8 12,9.2 17.5,5" fill="#cc2626"/></svg>',
 open: '<svg viewBox="0 0 24 24"><polygon points="2,5 9,5 11,7 21,7 21,19 2,19" fill="#c49b35"/>' +
       '<polygon points="5,10 23,10 20,20 2,20" fill="#f5c242"/></svg>',
 save: '<svg viewBox="0 0 24 24"><polygon points="3,3 18,3 21,6 21,21 3,21" fill="#2659a6"/>' +
       '<rect x="6" y="3" width="10" height="6" fill="#d9e0ed"/><rect x="12.5" y="4.2" width="2" height="3.6" fill="#2659a6"/>' +
       '<rect x="6" y="13" width="12" height="8" fill="#fff"/></svg>',
 print: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="7" fill="#fff" stroke="#737373" stroke-width="1"/>' +
        '<rect x="2" y="8" width="20" height="10" rx="2" fill="#666b73"/><rect x="6" y="14" width="12" height="1.5" fill="#333338"/>' +
        '<rect x="7.5" y="15" width="9" height="6.5" fill="#fff" stroke="#737373" stroke-width="1"/>' +
        '<path d="M9 17.5h6M9 19.5h6" stroke="#737373" stroke-width="1"/><circle cx="18.5" cy="11" r="1" fill="#4dbf59"/></svg>',
 excel: '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="15" height="20" rx="1.5" fill="#219e59"/>' +
        '<path d="M14 7h8M14 12h8M14 17h8M18 2v20" stroke="#d9f2e0" stroke-width="1.1"/>' +
        '<rect x="2" y="6" width="13" height="13" rx="1.5" fill="#0f6636"/>' +
        '<path d="M5.6 8.3 11.4 16.7M11.4 8.3 5.6 16.7" stroke="#fff" stroke-width="2.2" stroke-linecap="butt"/></svg>'
};

// ---------------------------------------------------------------- build the input tabs
function buildInputs() {
    TABS.forEach((t, i) => {
        const tb = document.createElement('span');
        tb.className = 'tab' + (i === 0 ? ' on' : ''); tb.textContent = t; tb.dataset.p = 'in' + t;
        $('itabs').appendChild(tb);
        const pg = document.createElement('div');
        pg.className = 'page' + (i === 0 ? ' on' : ''); pg.id = 'in' + t;
        const gr = document.createElement('div'); gr.className = 'grid';
        const f = FIELDS.filter(x => x.tab === t), nr = Math.ceil(f.length / NG);
        const nrm = Math.max(...TABS.map(tt => Math.ceil(FIELDS.filter(x => x.tab === tt).length / NG)));
        gr.style.gridTemplateRows = `repeat(${nr}, 22px)`;
        pg.style.height = (nrm * 25 + 4) + 'px';
        f.forEach((d, k) => {                                    // column-wise as TBI_GUI.m
            const r = k % nr + 1, c = 2 * Math.floor(k / nr) + 1;
            const lb = document.createElement('div');
            lb.className = 'lab'; lb.innerHTML = d.label; lb.title = d.tip;
            lb.style.gridRow = r; lb.style.gridColumn = c;
            gr.appendChild(lb);
            if (d.kind === 'blank') return;
            let el;
            if (d.kind === 'drop') {
                el = document.createElement('select'); el.className = 'ed';
                for (const it of d.items) { const o = document.createElement('option'); o.textContent = it; el.appendChild(o); }
            } else if (d.kind === 'check') {
                el = document.createElement('input'); el.type = 'checkbox'; el.className = 'chk';
            } else {
                el = document.createElement('input'); el.type = 'text'; el.className = 'ed' + (d.kind === 'out' ? ' out' : '');
                if (d.kind === 'out') el.readOnly = true;
            }
            el.title = d.tip; el.style.gridRow = r; el.style.gridColumn = c + 1;
            el.addEventListener('change', () => onChange(d.key));
            gr.appendChild(el);
            P[d.key] = el;
        });
        pg.appendChild(gr);
        if (t === 'Load') {                                      // LM71 and SW/0 with dimensions (drawLoads)
            const lg = document.createElement('div'); lg.className = 'loads';
            lg.style.height = (nrm * 25 + 4 - nr * 25 - 8) + 'px';
            lg.innerHTML = '<div id="ldLM71"></div><div id="ldSW"></div>';
            pg.appendChild(lg);
        }
        $('ipages').appendChild(pg);
    });
    tabsSwitch('itabs');
    tabsSwitch('rtabs');
}
function tabsSwitch(id) {
    const bar = $(id);
    bar.addEventListener('click', e => {
        const t = e.target.closest('.tab'); if (!t) return;
        for (const x of bar.children) x.classList.toggle('on', x === t);
        for (const x of bar.children) $(x.dataset.p).classList.toggle('on', x === t);
        if (t.dataset.p === 'pDiag' && out) drawDiagrams();
        if (t.dataset.p === 'pBSF' && out) drawBridge(0);
        if (t.dataset.p === 'pBD' && out) drawBridge(1);
        if (t.dataset.p === 'inLoad') drawLoads();
    });
}
const getv = k => (P[k].type === 'checkbox' ? P[k].checked : P[k].value);
function setv(k, v) { if (P[k].type === 'checkbox') P[k].checked = !!v; else P[k].value = v; }
const vec = k => String(P[k].value).trim().split(/[\s,;]+/).filter(s => s !== '').map(Number);
const num = k => { const v = vec(k); return v.length ? v[0] : NaN; };
function numfmt(x) {                                               // 1e4 instead of 10000
    if (x !== 0 && (Math.abs(x) >= 1e4 || Math.abs(x) < 1e-3)) {
        const e = Math.floor(Math.log10(Math.abs(x)));
        return String(+(x / Math.pow(10, e)).toFixed(6)) + 'e' + e;
    }
    return String(+x.toPrecision(12));
}
const sgn = v => (v >= 0 ? '+' : '') + v.toFixed(0);
const sgnT = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0);   // report text, typographic minus

// ---------------------------------------------------------------- input changed
function onChange(key) {
    switch (key) {
    case 'L': {                                                    // number of supports changed: K_h follows,
        const ns = vec('L').length + 1; let Kh = vec('Kh');         // fixed bearing at the last (right) support
        if (Kh.length !== ns) {
            const kf = Kh.some(k => k > 0) ? Math.max(...Kh) : 1e4;
            Kh = new Array(ns - 1).fill(0).concat([kf]);
            P.Kh.value = Kh.map(numfmt).join(' ');
        }
        break;
    }
    case 'dtype': P.E.value = P.dtype.value.startsWith('3') ? '35' : '210'; break;
    case 'profile': {
        const pr = { '60E1': [76.70, 3038.3], '50E3': [63.71, 2057.8] }[P.profile.value];
        if (pr) { P.Ar.value = String(pr[0]); P.Ir.value = String(pr[1]); }
        break;
    }
    case 'ttype':
        if (P.ttype.value === 'ballastless') {
            P.u0.value = '0.5 0.5'; P.Fu.value = '40 40'; P.er.value = '0.25'; P.sigbr.value = '-112 112'; P.sigemb.value = '-112 112';
        } else {
            P.u0.value = '2 0.5'; P.Fu.value = '20 30'; P.er.value = '0.75'; P.sigbr.value = '-72 112'; P.sigemb.value = '-72 112';
        }
        P.Fl.value = '60';
        break;
    }
    // deck temperature, EN 1991-1-5 6.1.3 and Figure 6.1 (AC:2009)
    const ty = ['1 steel', '2 composite', '3 concrete'].indexOf(P.dtype.value);
    const dTe = [[16, 4, 2], [-3, 4, 8]], T0 = num('T0');
    if (P.Tmode.value === 'EN 1991-1-5') {
        P.dTN.value = sgn(num('Tmax') + dTe[0][ty] - T0) + ' ' + sgn(num('Tmin') + dTe[1][ty] - T0);
        P.dTN.readOnly = true; P.dTN.classList.add('out');
    } else { P.dTN.readOnly = false; P.dTN.classList.remove('out'); }
    P.dTbrk.value = sgn(num('TRmin') - T0);
    P.alfab.value = Math.abs(num('E') / 210 - 1) < 0.15 ? '12e-6' : '10e-6';
    drawModel();
    drawLoads();
    if (key && out) {                                              // results no longer match the input
        enable(false);
        if (!$('status').textContent) status('Input changed: results not up to date, press Run');
    }
}

function buildInp() {
    // input of TBI.analysis from the fields (engineering units -> SI)
    const Kh = vec('Kh'), nsup = vec('L').length + 1;
    if (Kh.length !== nsup) throw new Error('K_h needs ' + nsup + ' values, one per support.');
    const inp = {};
    inp.Bridge = { L: vec('L'), E: num('E') * 1e9, A: num('A'), I: num('I'), e_b: num('eb'), h: num('h'),
                   alfa: num('alfab'), L_end: num('Lend'), n_track: num('ntrack'), FL: nsup,
                   Kh: Kh.map(k => k * 1e9), dT: vec('dTN'), T0: num('T0'), type: P.dtype.value.replace(/^\d\s+/, '') };
    if (Kh.some(k => k > 0)) inp.Bridge.FL = Kh.length - Kh.slice().reverse().findIndex(k => k > 0);
    const kv = vec('Kv');
    inp.Track = { type: P.ttype.value, A: 2 * num('Ar') * 1e-4, I: 2 * num('Ir') * 1e-8, E: 210e9, alfa: 12e-6,
                  e_r: num('er'), s_r: num('sr'), Le: num('Le'), u0: vec('u0').map(v => v * 1e-3),
                  Fu: vec('Fu').map(v => v * 1e3), Fl: num('Fl') * 1e3, Kv: kv[0] * 1e6, Kv_up: kv[kv.length - 1] * 1e6,
                  dT_brk: num('dTbrk'), gap: vec('gap') };
    if (vec('dTR').length) inp.Track.dT = vec('dTR');            // empty: 0 0 (CWR) or +50 -50 (REJ)
    inp.Load = { alfa: num('alfa'), LM71: P.LM71.checked, SW: P.SW.checked, dxPos: num('dxPos'),
                 qlbk: num('qlbk') * 1e3, Qlbk_max: num('Qlbk') * 1e3, qlak: num('qlak') * 1e3, Qlak_max: num('Qlak') * 1e3 };
    inp.Limits = { sig_br: vec('sigbr'), sig_emb: vec('sigemb'), dB: num('dB'), dH: num('dH'), dV: num('dV'),
                   wL: num('wL'), wgap: num('wgap') };
    for (const [g, o] of Object.entries(inp)) for (const [k, v] of Object.entries(o))
        if ((typeof v === 'number' && isNaN(v)) || (Array.isArray(v) && v.some(isNaN)))
            throw new Error('invalid number in ' + g + '.' + k + '.');
    return inp;
}

// ---------------------------------------------------------------- model
function drawModel() {
    const box = $('model');
    try {
        const d = TBI.defaults(buildInp());
        const W = box.clientWidth, H = box.clientHeight;
        const fsz = Math.max(12, Math.round(16 * W / 1150));
        box.innerHTML = TBIPlot.model({ inp: d.inp, Model: d.Model }, W, H, fsz);
        if ($('status').textContent.startsWith('Input:')) status('');
    } catch (e) {
        status('Input: ' + e.message);
    }
}

function drawLoads() {
    // load models LM71 and SW/0 in the Load tab, only when ticked (drawn when the tab is shown)
    for (const [id, k, which] of [['ldLM71', 'LM71', 'LM71'], ['ldSW', 'SW', 'SW']]) {
        const box = $(id);
        if (!box) continue;
        const W = box.clientWidth, H = box.clientHeight;
        box.innerHTML = P[k].checked && W > 0 ? TBIPlot.loadModel(which, W, H, 9) : '';
    }
}

// ---------------------------------------------------------------- status, progress, symbols
function status(t, tip) { $('status').textContent = t; $('status').title = tip || t; }
function setProg(fr) {
    if (fr === null) { $('progFill').style.width = '0'; $('progTxt').textContent = ''; return; }
    $('progFill').style.width = Math.round(fr * 118) + 'px';
    $('progTxt').textContent = Math.round(100 * fr) + ' %';
}
function enable(on) { for (const id of ['sReport', 'sExport', 'sPrint', 'sPrintSF', 'sPrintD']) $(id).classList.toggle('off', !on); }

// ---------------------------------------------------------------- run
async function onRun() {
    if (running) return;
    let inp;
    try { inp = buildInp(); } catch (e) { status('Input: ' + e.message); return; }
    running = true; enable(false); $('sRun').classList.add('off');
    status('Running ...'); setProg(0);
    try {
        out = await TBI.analysis(inp, { progress: setProg });
    } catch (e) {
        out = null; running = false; $('sRun').classList.remove('off');
        status('Analysis: ' + e.message); return;
    }
    running = false; $('sRun').classList.remove('off');
    showResults(); enable(true);
    const nex = out.Table.filter(t => t.exceed.flat().some(Boolean)).length;
    status(`${out.Info.nRun} analyses, ${out.Info.time.toFixed(1)} s, ` + (nex ? `${nex} outside limits (red)` : 'all limits met'));
}

// ---------------------------------------------------------------- results
const GROUPS = [['stress', 'Additional rail stress (MPa)'], ['disp', 'Displacements (mm)'], ['force', 'Longitudinal bearing forces (kN)']];
function fmtVal(t, k, html) {
    const d = t.dec === undefined ? 1 : t.dec;                     // own decimals (e.g. deflection, whole mm)
    const f = t.unit === 'kN' ? v => v.toFixed(0) : t.unit === 'MPa' ? v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d)
                               : v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
    return t.val[k].map((v, i) => {
        const s = isNaN(v) ? '–' : f(v);
        return html && t.exceed[k][i] ? `<span class="ex">${s}</span>` : s;
    }).join(' / ');
}
function tablesHtml(o, report) {
    let h = '';
    GROUPS.forEach(([g, title], gi) => {
        const rows = o.Table.filter(t => t.group === g);
        if (!rows.length) return;
        h += report ? `<table><caption>Table ${gi + 4}: ${title}.</caption>` : `<div class="ttl">${title}</div><table class="res">`;
        h += '<thead><tr><th></th><th>Limit</th><th>Summer</th><th>Winter</th></tr></thead><tbody>';
        for (const t of rows)
            h += `<tr><td>${t.name}</td><td class="l">${t.lim}</td><td class="v">${fmtVal(t, 0, true)}</td><td class="v">${fmtVal(t, 1, true)}</td></tr>`;
        h += '</tbody></table>';
    });
    return h;
}
function lcOptions() {
    // load cases in the Bridge dropdowns, with the line styles (SW/0 after a run)
    for (const id of BSEL) [...$(id).options].forEach(o => { o.textContent = TBIPlot.lcname(out, Number(o.value)); });
}
function showResults() {
    lcOptions();
    $('tables').innerHTML = tablesHtml(out, false);
    drawDiagrams(); drawBridge(0); drawBridge(1);
}
const BK = ['SF', 'disp'], BPAGE = ['pBSF', 'pBD'], BBOX = ['bsfDiags', 'bdDiags'], BSEL = ['lcSF', 'lcD'];
function drawBridge(kb) {
    // deck section forces (kb 0) or displacements (kb 1) of the load case in the dropdown
    const box = $(BBOX[kb]);
    if (!out || !$(BPAGE[kb]).classList.contains('on')) { box.innerHTML = ''; return; }   // drawn when shown
    const lc = Number($(BSEL[kb]).value);
    box.innerHTML = [0, 1, 2].map(i => `<div class="diag">${TBIPlot.bridge(out, lc, i, BK[kb], 600, 236, 9, TBIPlot.BT[BK[kb]][i])}</div>`).join('');
}
function drawDiagrams() {
    const box = $('diags');
    if (!out) { box.innerHTML = ''; return; }
    if (!$('pDiag').classList.contains('on')) { box.innerHTML = ''; return; }   // drawn when shown
    box.innerHTML = [0, 1, 2].map(i => `<div class="diag">${TBIPlot.diagram(out, i, 600, 236, 9, TBIPlot.dtitle(out, i))}</div>`).join('');
}

// ---------------------------------------------------------------- reset, save, open
function onReset() {
    for (const d of FIELDS) if (d.kind !== 'out' && d.kind !== 'blank') setv(d.key, d.val);
    out = null; enable(false); lcOptions();
    $('tables').innerHTML = '<p id="hint">Press Run to compute all load cases.</p>';
    $('diags').innerHTML = '';  $('bsfDiags').innerHTML = '';  $('bdDiags').innerHTML = '';
    onChange('');
    status('Default input (Bryngeån)'); setProg(null);
}
let saveBlob = async function (blob, name, types) {
    // Chrome, Edge: Save-as dialog; embedded browsers (Electron apps) open the
    // dialog but write an empty file, so they get a plain download only
    const embedded = /Electron|Claude\//.test(navigator.userAgent);
    if (window.showSaveFilePicker && !embedded) {
        let h = null;
        try {
            h = await window.showSaveFilePicker({ suggestedName: name, types });
        } catch (e) {
            if (e.name === 'AbortError') return null;              // cancelled
        }
        if (h) {                                                   // write here, no second dialog
            let msg = '';
            try {
                const w = await h.createWritable();
                await w.write(await blob.arrayBuffer());
                await w.close();
                if ((await h.getFile()).size === blob.size) return h.name;
                msg = 'the file was written empty';                // e.g. embedded browsers
            } catch (e) {
                msg = e.name + ', ' + e.message;
            }
            status(`Could not write ${h.name} (${msg}), downloaded instead`);
            download(blob, name);
            return null;
        }
    }
    download(blob, name);
    return name;
};
function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function onSave() {
    const S = {};
    for (const d of FIELDS) if (d.kind !== 'out' && d.kind !== 'blank') S[d.key] = getv(d.key);
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    const n = await saveBlob(blob, 'TBI_input.json', [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]);
    if (n) status('Input saved: ' + n);
}
function onOpen() { $('fileIn').value = ''; $('fileIn').click(); }
$('fileIn').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    let S;
    try { S = JSON.parse(await f.text()); } catch (err) { status('Open: ' + err.message); return; }
    for (const d of FIELDS) {
        if (!(d.key in S) || d.kind === 'out' || d.kind === 'blank') continue;
        const v = S[d.key];
        if (d.kind === 'check') setv(d.key, !!v);
        else if (typeof v === 'number') setv(d.key, numfmt(v));
        else if (Array.isArray(v)) setv(d.key, v.map(numfmt).join(' '));
        else setv(d.key, v);
    }
    onChange('loaded');
    status('Input loaded: ' + f.name);
});

// ---------------------------------------------------------------- Excel
async function onExport() {
    if (!out) return;
    const plain = s => s.replace(/<sub>(.*?)<\/sub>/g, '$1').replace(/<[^>]+>/g, '');
    const sheets = [];
    const nm = { stress: 'Rail stress', disp: 'Displacements', force: 'Bearing forces' };
    for (const [g] of GROUPS) {
        const rows = [['', 'Limit', 'min/left,s', 'max/right,s', 'min/left,w', 'max/right,w', 'Unit'].map(v => ({ v, s: 'bold' }))];
        for (const t of out.Table.filter(r => r.group === g)) {
            const p = Math.pow(10, t.dec !== undefined ? t.dec : t.unit === 'kN' ? 0 : 1);   // kN whole, mm and MPa one decimal
            const rnd = v => Math.round(v * p) / p;
            const cell = (k, i) => {
                if (t.val[k].length <= i) return null;
                const v = rnd(t.val[k][i]);
                return t.exceed[k][i] ? { v, s: 'red' } : v;
            };
            rows.push([plain(t.name), t.lim.replace('−', '-').replace('–', '--'), cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1), t.unit]);
        }
        sheets.push({ name: nm[g], rows, widths: [44, 10, 11, 12, 11, 12, 6] });
    }
    // diagram data: short headers (row 1) and units (row 2): group (temp,
    // LM71, SW, brk, tra, comb), min/max, s(ummer)/w(inter); gov = governing
    // combination, T = its temperature step; x to 0.1 m
    const Ld = out.inp.Load;
    const grp = [['temp', 'temp'], ['LM71', 'LM71'], ['SW', 'SW'], ['brk', 'brk'], ['acc', 'tra'], ['comb', 'comb']]
        .filter(g => (g[0] !== 'LM71' || Ld.LM71) && (g[0] !== 'SW' || Ld.SW));
    const diag = (name, x, S, qs, us, dec, fac, bold) => {
        const hd = [{ v: 'x', s: 'bold' }], ud = ['m'], cols = [x.map(v => Math.round(v * 10) / 10)];
        const p = Math.pow(10, dec), rnd = v => (isFinite(v) ? Math.round(fac * v * p) / p : null);
        qs.forEach((q, iq) => {
            const pre = q ? q + ' ' : '', get = o => (q ? o[q] : o);
            for (const [k, n] of grp) for (let s = 0; s < 2; s++) {
                const E = get(S[k]);
                hd.push({ v: `${pre}${n} min,${'sw'[s]}`, s: 'bold' }, { v: `${pre}${n} max,${'sw'[s]}`, s: 'bold' });
                cols.push(E.min[s].map(rnd), E.max[s].map(rnd));
            }
            for (let s = 0; s < 2; s++) {
                hd.push({ v: `${pre}gov,${'sw'[s]}`, s: 'bold' }, { v: `${pre}T,${'sw'[s]}`, s: 'bold' });
                cols.push(get(S.comb.gov)[s].map(rnd), get(S.comb.govTemp)[s].map(rnd));
            }
            for (let j = 0; j < 4 * grp.length + 4; j++) ud.push(us[iq]);
        });
        const rows = [hd, ud];
        for (let i = 0; i < x.length; i++) {
            const r = cols.map(c => c[i]);
            rows.push(bold && bold.has(i) ? r.map(v => ({ v, s: 'bold' })) : r);
        }
        sheets.push({ name, rows, widths: hd.map(h => Math.max(6, String(h.v).length + 2)) });
    };
    const T = out.Track, Bk = out.Bridge, xb = Bk.x;
    diag('Rail stress diagram', T.x, T, [''], ['MPa'], 1, 1);
    const bold = new Set();                                        // deck ends and the rail seat nearest each bearing
    xb.forEach((v, i) => { if (i === 0 || i === xb.length - 1 || Bk.xsup.some(s => Math.abs(v - s) < 1e-6)) bold.add(i); });
    for (const s of Bk.xsup) {
        let im = 0; xb.forEach((v, i) => { if (Math.abs(v - s) < Math.abs(xb[im] - s)) im = i; }); bold.add(im);
    }
    diag('Bridge SF diagram', xb, Bk.F, ['M', 'V', 'N'], ['kNm', 'kN', 'kN'], 0, 1e3, bold);
    diag('Bridge disp diagram', xb, Bk.D, ['u', 'w', 'th'], ['mm', 'mm', 'mrad'], 1, 1, bold);
    const n = await saveBlob(XLSX.write(sheets), 'TBI_results.xlsx',
        [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]);
    if (n) status('Exported: ' + n);
}

// ---------------------------------------------------------------- printing
function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function printMode(cls, noDialog, name) {
    const title = document.title;                                  // default PDF file name in the print dialog
    document.title = name || (cls === 'p-report' ? 'TBI-report' : 'TBI_rail_stress');
    // A4 pages, date top right and "page (pages)" bottom centre (Chrome, Edge)
    $('pageStyle').textContent = '@page { size: A4; margin: 25mm; ' +
        `@top-right { content: "${today()}"; font: 10pt 'Times New Roman', serif; } ` +
        '@bottom-center { content: counter(page) " (" counter(pages) ")"; font: 10pt \'Times New Roman\', serif; } }';
    document.body.className = cls;
    const done = () => { document.body.className = ''; document.title = title; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    if (!noDialog) setTimeout(() => window.print(), 50);
}
function onPrintDiagrams() {
    if (!out) return;
    $('printDiag').innerHTML = [0, 1, 2].map(i =>
        `<div class="dg">${TBIPlot.diagram(out, i, 640, 310, 10, TBIPlot.dtitle(out, i))}</div>`).join('');
    printMode('p-diag', false, 'TBI_rail_stress');
}
function bridgePrintHtml(kb) {
    // deck forces (kb 0) or displacements (kb 1) of the three load cases, one A4 page each
    return [1, 2, 3].map(lc => (lc > 1 ? '<div class="pgb"></div>' : '') + [0, 1, 2].map(i =>
        `<div class="dg">${TBIPlot.bridge(out, lc, i, BK[kb], 640, 310, 10, [TBIPlot.BT[BK[kb]][i], TBIPlot.lcname(out, lc)])}</div>`).join('')).join('');
}
function onPrintBridge(kb) {
    if (!out) return;
    $('printDiag').innerHTML = bridgePrintHtml(kb);
    printMode('p-diag', false, kb ? 'TBI_bridge_disp' : 'TBI_bridge_SF');
}

const fmtN = x => String(+Number(x).toPrecision(3)).replace('-', '−');
const e6 = x => `${+(x * 1e6).toFixed(3)}·10<sup>−6</sup>`;     // thermal expansion as 12·10^-6
function sci(x) {
    if (x === 0) return '0';
    const p = Math.floor(Math.log10(Math.abs(x)));
    if (p >= -2 && p <= 3) return fmtN(x);
    return `${+(x / Math.pow(10, p)).toFixed(4)}·10<sup>${p}</sup>`;
}
function onReport() {
    if (!out) return;
    buildReport();
    printMode('p-report');
}
function buildReport() {
    const B = out.inp.Bridge, T = out.inp.Track, Ld = out.inp.Load, M = out.Model, rb = out.Track.rbreak;
    const Kh = Array.isArray(B.Kh) ? B.Kh : [B.Kh];
    let dtyp = String(B.type || '').toLowerCase();                 // steel, composite or concrete
    if (!['steel', 'composite', 'concrete'].includes(dtyp)) dtyp = 'concrete';
    const btyp = dtyp[0].toUpperCase() + dtyp.slice(1), styp = T.type === 'ballastless' ? 'ballastless' : 'ballasted';
    const t0 = (B.T0 !== undefined && B.T0 !== null && isFinite(B.T0)) ? ` from <i>T</i><sub>0</sub> = ${fmtN(B.T0)} °C` : '';
    const pos = Ld.dxPos > 0 ? `in ${out.LoadPos.xloco.length} positions, step ${fmtN(Ld.dxPos)} m` : 'from the movable end bearing';
    const vl = [];
    if (Ld.LM71) vl.push('LM71 with the locomotive ' + pos);
    if (Ld.SW) vl.push('SW/0');
    const tab = (cap, rows, head) => `<table><caption>${cap}</caption><thead><tr>${(head || ['', 'Value', 'Unit']).map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
        rows.map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
    let h = '<h1>Longitudinal Track-Bridge Interaction</h1>';
    h += '<h2>Basis</h2><p>Longitudinal track-bridge interaction according to EN 1991-2:2024, 8.5.3–8.5.4: additional rail stresses (8.5.4.5.1), ' +
         'deck displacements (8.5.4.5.2) and longitudinal bearing forces. Track resistance according to Table 8.9, uniform deck temperature ' +
         'according to 8.5.4.3, vertical traffic and braking/traction multiplied by <i>α</i>. ' +
         `Rail break gap according to CEN/TR 17231, Annex A.2, compared with ${fmtN(out.inp.Limits.wgap)} mm according to TRVINFRA-00012, K35714 ` +
         `(${rb.wCWR.toFixed(0)} mm for a break in track on an embankment, A.1).</p>`;
    h += '<h2>Structural model</h2><p>2D FE model with rail and deck as beams, see figure 1. At each rail seat the rail is connected to the deck, or to the ' +
         'ground on the embankments, by bilinear springs for unloaded and loaded track resistance and a vertical spring. Bearings are vertically fixed ' +
         'with a longitudinal spring at bearing level. Geometrically nonlinear analysis in two steps: temperature on unloaded track (step 1), then ' +
         'vertical traffic and braking or traction with loaded track resistance where vertical traffic acts (step 2). Load cases, summer and winter:</p><ul>' +
         `<li>temperature, ${dtyp} deck: Δ${S('T', 'N')} = ${sgnT(B.dT[0])} / ${sgnT(B.dT[1])} °C (summer / winter)${t0};</li>` +
         (vl.length ? `<li>${vl.join(', ')};</li>` : '') +
         `<li>braking over ${fmtN(out.LoadPos.Lbrk)} m and traction over ${fmtN(out.LoadPos.Lacc)} m from either end, both directions` +
         (B.n_track === 2 ? ', braking on track 1 with traction on track 2' : '') + ';</li>' +
         '<li>load combination: temperature (step 1), vertical traffic with braking or traction (step 2), and the same without temperature ' +
         '(at neutral temperature the track resistance has not yielded); envelope of both;</li>' +
         (out.Track.rej ? '<li>with rail expansion joints: rail temperature included, temperature given as total rail stress (the additional ' +
             'stress is not defined at a joint); the additional rail stress of the load combination only without temperature;</li>' : '') +
         `<li>rail break, winter only: deck ${sgnT(rb.dT_B)} °C, rail ${sgnT(rb.dT_R)} °C, both rails of one track broken at the bridge ends and at the largest rail tension.</li></ul>` +
         `<p>In total ${out.Info.nRun} analyses. Input in tables 1–3, results in tables 4–6 and figures 2–4.</p>`;
    h += `<div class="fig">${TBIPlot.model(out, 1150, 600, 16)}</div><div class="cap">Figure 1: 2D FE model: whole model (top), detail at support 1, ` +
         'track shear resistance per m of track and track vertical stiffness per sleeper (bottom), dimensions in m.</div>';
    // input
    h += `<h2 class="pb">Input</h2><p>${btyp} bridge, ${B.n_track} track(s), ${styp} track. In the model, the bridge length and the embankments ` +
         'are whole sleeper spacings (a rail seat at each deck end); ' + S('L', 'end') + ' is rounded to the deck element length and the spans are ' +
         'scaled to fit. <i>x</i> is measured from support 1.</p>';
    const rowsB = [['Spans, <i>L</i>', B.L.map(v => String(v)).join(' + '), 'm'],   // as given, as in figure 1 ['Cross-section area, ' + S('A', 'b'), fmtN(B.A), 'm²'],
        ['Second moment of area, ' + S('I', 'b'), fmtN(B.I), 'm⁴'], ["Young's modulus, " + S('E', 'b'), fmtN(B.E / 1e9), 'GPa'],
        ['Thermal expansion, ' + S('α', 'b'), e6(B.alfa), '1/K'], ['Neutral axis to bearings, ' + S('e', 'b'), fmtN(B.e_b), 'm'],
        ['Bearings to top of rail, <i>h</i>', fmtN(B.h), 'm'], ['Deck end beyond the end bearings, ' + S('L', 'end'), String(B.L_end), 'm'],
        ['Deck temperature change, Δ' + S('T', 'N') + ', summer / winter', sgnT(B.dT[0]) + ' / ' + sgnT(B.dT[1]), '°C']];
    Kh.forEach((k, i) => rowsB.push(typeof k === 'number' && k === 0 ? [`Support ${i + 1}, longitudinal stiffness`, 'movable', '–']
        : typeof k === 'number' ? [`Support ${i + 1}, longitudinal stiffness, ` + S('K', 'h'), sci(k / 1e9), 'GN/m'] : [`Support ${i + 1}, longitudinal stiffness`, 'nonlinear', '–']));
    h += tab('Table 1: Bridge.', rowsB);
    const rowsT = [['Rail cross-section area per rail, ' + S('A', 'r'), (T.A / 2 * 1e4).toFixed(1) + '·10<sup>−4</sup>', 'm²'],
        ['Rail second moment of area per rail, ' + S('I', 'r'), (T.I / 2 * 1e8).toFixed(1) + '·10<sup>−8</sup>', 'm⁴'],
        ["Young's modulus, " + S('E', 'r'), fmtN(T.E / 1e9), 'GPa'], ['Thermal expansion, ' + S('α', 'r'), e6(T.alfa), '1/K'],
        ['Top of rail to track slip centre, ' + S('e', 'r'), fmtN(T.e_r), 'm'], ['Sleeper spacing, ' + S('s', 'r'), fmtN(T.s_r), 'm'],
        ['Track on each embankment, ' + S('L', 'e'), fmtN(M.Le), 'm'], ['Elastic displacement, ' + S('u', '0') + ', summer / winter', fmtN(1e3 * T.u0[0]) + ' / ' + fmtN(1e3 * T.u0[1]), 'mm'],
        ['Resistance, unloaded track, ' + S('F', 'u') + ', summer / winter', fmtN(T.Fu[0] / 1e3) + ' / ' + fmtN(T.Fu[1] / 1e3), 'kN/m'],
        ['Resistance, loaded track, ' + S('F', 'l'), fmtN(T.Fl / 1e3), 'kN/m'],
        ['Vertical stiffness per sleeper, compression / uplift', fmtN(T.Kv / 1e6) + ' / ' + fmtN(T.Kv_up / 1e6), 'MN/m'],
        ['Rail temperature change, Δ' + S('T', 'R') + ', summer / winter', sgnT(T.dT[0]) + ' / ' + sgnT(T.dT[1]), '°C'],
        ['Rail temperature change, rail break', sgnT(T.dT_brk), '°C']];
    if (T.gap.length) rowsT.push(['Rail expansion joints, <i>x</i>', T.gap.map(fmtN).join(', '), 'm']);
    h += tab('Table 2: Track.', rowsT);
    const rowsL = [['Load classification factor, <i>α</i>', fmtN(Ld.alfa), '–']];
    if (Ld.LM71) rowsL.push(['LM71, distributed load / locomotive over 6.4 m', '80 / 156', 'kN/m']);
    if (Ld.SW) rowsL.push(['SW/0, 2 × 15 m, 5.3 m apart', '133', 'kN/m']);
    rowsL.push(['Braking, ' + S('q', 'lbk') + ' (max ' + S('Q', 'lbk') + ')', fmtN(Ld.qlbk / 1e3) + ' (' + fmtN(Ld.Qlbk_max / 1e3) + ')', 'kN/m (kN)']);
    rowsL.push(['Traction, ' + S('q', 'lak') + ' (max ' + S('Q', 'lak') + ')', fmtN(Ld.qlak / 1e3) + ' (' + fmtN(Ld.Qlak_max / 1e3) + ')', 'kN/m (kN)']);
    h += tab('Table 3: Traffic loads, characteristic values.', rowsL);
    // results
    const anyEx = out.Table.some(t => t.exceed.flat().some(Boolean));
    h += '<h2 class="pb">Results</h2><p>Rail stresses are additional stresses (min / max), displacements at the left / right deck end and bearing forces ' +
         'the largest magnitude (positive in +<i>x</i> on the deck). ' + (anyEx ? 'Values outside the limits are marked in bold red.' : 'All limits are met.') + '</p>';
    h += tablesHtml(out, true);
    // diagrams
    const cap = ['Additional rail stress, temperature.', 'Additional rail stress, vertical traffic (dashed) and braking/traction (solid), envelope.',
                 'Additional rail stress, governing load combination with or without temperature (solid) and its temperature step (dashed).'];
    if (Ld.SW) cap[1] = 'Additional rail stress, LM71 (dashed), SW/0 (dash-dot) and braking/traction (solid), envelope.';
    if (out.Track.rej) {
        cap[0] = 'Total rail stress, temperature; dotted: fully restrained rail.';
        cap[2] = 'Additional rail stress, governing load combination without temperature.';
    }
    h += '<div class="pb"></div>' + [0, 1, 2].map(i =>
        `<div class="fig" style="height:64mm">${TBIPlot.diagram(out, i, 700, 280, 11, '')}</div><div class="cap">Figure ${i + 2}: ${cap[i]}</div>`).join('');
    $('report').innerHTML = h;
}

// ---------------------------------------------------------------- start
function initSymbols() {
    const set = (id, ic, fn) => { $(id).innerHTML = ICON[ic]; $(id).addEventListener('click', fn); };
    set('sRun', 'run', onRun); set('sReset', 'reset', onReset); set('sOpen', 'open', onOpen);
    set('sSave', 'save', onSave); set('sReport', 'print', onReport);
    set('sExport', 'excel', onExport); set('sPrint', 'print', onPrintDiagrams);
    set('sPrintSF', 'print', () => onPrintBridge(0)); set('sPrintD', 'print', () => onPrintBridge(1));
    $('lcSF').addEventListener('change', () => drawBridge(0));
    $('lcD').addEventListener('change', () => drawBridge(1));
}
buildInputs();
initSymbols();
for (const d of FIELDS) if (d.kind !== 'out' && d.kind !== 'blank') setv(d.key, d.val);
onChange('');
let rt;
if (/[?&](report|diagrams|bridgeSF|bridgeDisp)\b/.test(location.search)) {   // test mode: run and show the print layout (headless PDF)
    onRun().then(() => {
        const q = location.search, rep = /report/.test(q);
        if (rep) buildReport();
        else if (/bridgeSF/.test(q)) $('printDiag').innerHTML = bridgePrintHtml(0);
        else if (/bridgeDisp/.test(q)) $('printDiag').innerHTML = bridgePrintHtml(1);
        else $('printDiag').innerHTML = [0, 1, 2].map(i =>
            `<div class="dg">${TBIPlot.diagram(out, i, 640, 310, 10, TBIPlot.dtitle(out, i))}</div>`).join('');
        printMode(rep ? 'p-report' : 'p-diag', true,
            rep ? '' : /bridgeSF/.test(q) ? 'TBI_bridge_SF' : /bridgeDisp/.test(q) ? 'TBI_bridge_disp' : 'TBI_rail_stress');
    });
}
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(drawModel, 150); });
window.TBIGUI = { run: onRun, reset: onReset, results: () => out, buildInp, P, saveBlob: f => (saveBlob = f), export: onExport,
                  bridgePrintHtml, drawLoads };                    // for tests
})();

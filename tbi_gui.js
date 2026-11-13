/* tbi_gui.js -----------------------------------------------------------------
   TBI-analysis according to EN 1991-2:2024, 8.5.4: user interface of the web
   version, a port of TBI_gui.m (state 2026-11-12).
   Andreas Andersson, 2026-11-13 (assisted by Claude)

   USAGE:  loaded by index.html after tbi_fem.js, tbi_plot.js, tbi_report.js
           and tbi_xlsx.js; builds the input tabs (Bridge, Track, Load,
           Limits), the model sketch and the result tabs (Tables, Rail
           stress, Bridge SF, Bridge disp) and starts with the default input
           (Bryngeån).
           TBI.gui = {run, reset, results, input, sheets} for scripts and
           tests: run() = onRun (a Promise), results() = out of the last run
           or null, input() = the fields as in the JSON file, sheets() = the
           sheets of the Excel export (input of TBI.xlsx).

   Uses (README.md): TBI.readJson, TBI.model, TBI.analysis, TBI.stop
   (tbi_fem.js), TBI.plotModel, TBI.plotLoads, TBI.plotRail, TBI.plotBridge,
   TBI.tex2nodes (tbi_plot.js), TBI.report (tbi_report.js), TBI.xlsx
   (tbi_xlsx.js).

   The fields are collected into an object with the same keys and text as
   TBI_input.json and converted by TBI.readJson, so the unit conversion is
   only in tbi_fem.js. No innerHTML anywhere: the DOM is built with
   createElement and textContent (row names of out.Table with TBI.tex2nodes).
---------------------------------------------------------------------------*/
(function () {
'use strict';


// %% 1 SETTINGS ===============================================================
const $ = id => document.getElementById(id);
const NG = 3;                                       // label/field pairs per input row
const MAXIN = 200;                                  // most characters in an input field (as vec in TBI_gui.m)
const MAXFILE = 1e6;                                // largest JSON file to open (bytes)
const TABS = ['Bridge', 'Track', 'Load', 'Limits'];
const NUM1 = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;   // one number


// Input fields: tab, key, label, kind (edit, drop, check, out = computed,
// blank = empty cell), default value (Bryngeån), tooltip; as fieldDefs in
// TBI_gui.m. A label is an array of text and V(symbol, subscript) = italic
// symbol with an upright subscript (the LaTeX labels of TBI_gui.m).
const V = (s, sub) => ({ s, sub });
const FIELDS = [
 // Bridge
 ['Bridge', 'L',      ['Spans ', V('L'), ' (m)'],        'edit', '48',
  'span lengths, one per span, or L1:dL:Ltot, a first span L1, then spans of dL up to the total length; continuous deck'],
 ['Bridge', 'E',      [V('E'), ' (GPa)'],                'edit', '210',
  "Young's modulus of the deck; within 15 % of 210 GPa = steel"],
 ['Bridge', 'A',      [V('A'), ' (m²)'],                 'edit', '0.8',
  'cross-section area (equivalent steel section for composite decks)'],
 ['Bridge', 'I',      [V('I'), ' (m⁴)'],                 'edit', '1.0',  'second moment of area'],
 ['Bridge', 'eb',     [V('e', 'b'), ' (m)'],             'edit', '2.15', 'deck neutral axis to bearings'],
 ['Bridge', 'h',      [V('h'), ' (m)'],                  'edit', '3.75', 'bearings to top of rail'],
 ['Bridge', 'blank1', [],                                'blank', '',    ''],
 ['Bridge', 'dtype',  ['Deck type'],                     'drop', '2 composite', 'EN 1991-1-5 6.1.1, Figure 6.1 (AC:2009)'],
 ['Bridge', 'alfab',  [V('α', 'b'), ' (1/K)'],           'out',  '',     'thermal expansion of the deck (from E)'],
 ['Bridge', 'Lend',   [V('L', 'end'), ' (m)'],           'edit', '0.45',
  'deck end beyond the end bearings, both ends; the model rounds it to s_r/6 and the bridge length to whole s_r ' +
  '(spans scaled), a rail seat at each deck end'],
 ['Bridge', 'Kh',     [V('K', 'h'), ' (GN/m)'],          'edit', '0 10',
  'longitudinal stiffness per support, 0 = movable bearing; filled in (fixed at the right end) when the number of ' +
  'spans changes'],
 ['Bridge', 'ntrack', ['Tracks'],                        'drop', '1',    'number of tracks'],
 ['Bridge', 'blank2', [],                                'blank', '',    ''],
 ['Bridge', 'blank3', [],                                'blank', '',    ''],
 ['Bridge', 'Tmode',  ['Deck temp.'],                    'drop', 'EN 1991-1-5',
  'EN 1991-1-5 from air temperatures, or the deck temperature change typed directly'],
 ['Bridge', 'Tmax',   [V('T', 'max'), ' (°C)'],          'edit', '33',   'max shade air temperature (SS-EN 1991-1-5 NB)'],
 ['Bridge', 'Tmin',   [V('T', 'min'), ' (°C)'],          'edit', '-42',  'min shade air temperature'],
 ['Bridge', 'T0',     [V('T', '0'), ' (°C)'],            'edit', '14',
  'temperature when the track is fixed = neutral rail temperature (TRVINFRA-00012 R7.2)'],
 ['Bridge', 'dTN',    ['Δ', V('T', 'N'), ' s / w (K)'],  'edit', '',     'uniform deck temperature change, summer / winter'],
 ['Bridge', 'TRmin',  [V('T', 'R,min'), ' (°C)'],        'edit', '-42',  'min rail temperature, rail break check'],
 ['Bridge', 'dTbrk',  ['Δ', V('T', 'R,brk'), ' (K)'],    'out',  '',
  'rail temperature change for the rail break check, T_R,min - T_0'],
 // Track
 ['Track', 'ttype',   ['Track'],                         'drop', 'ballasted',
  'EN 1991-2:2024 Table 8.9; ballastless sets u0, F_u, e_r and limits'],
 ['Track', 'profile', ['Rail'],                          'drop', '60E1', 'EN 13674-1; custom: type A and I'],
 ['Track', 'Ar',      [V('A', 'rail'), ' (cm²)'],        'edit', '76.7', 'rail cross-section area, per rail (2 rails per track)'],
 ['Track', 'Ir',      [V('I', 'rail'), ' (cm⁴)'],        'edit', '3038.3', 'rail second moment of area, per rail'],
 ['Track', 'er',      [V('e', 'r'), ' (m)'],             'edit', '0.85', 'top of rail to track slip centre'],
 ['Track', 'sr',      [V('s', 'r'), ' (m)'],             'edit', '0.65', 'sleeper spacing'],
 ['Track', 'Le',      [V('L', 'e'), ' (m)'],             'edit', '100',  'track on each embankment'],
 ['Track', 'u0',      [V('u', '0'), ' s / w (mm)'],      'edit', '2 0.5', 'elastic displacement, summer / winter (frozen)'],
 ['Track', 'Fu',      [V('F', 'u'), ' s / w (kN/m)'],    'edit', '20 30', 'resistance of unloaded track, summer / winter'],
 ['Track', 'Fl',      [V('F', 'l'), ' (kN/m)'],          'edit', '60',   'resistance of loaded track'],
 ['Track', 'Kv',      [V('k', 'v'), ' c / u (MN/m)'],    'edit', '80 4',
  'vertical stiffness per sleeper, 2 rails, compression / uplift'],
 ['Track', 'gap',     ['REJ at ', V('x'), ' (m)'],       'edit', '',
  'rail expansion joints, x from support 1; empty = CWR'],
 ['Track', 'dTR',     ['Δ', V('T', 'R'), ' s / w (K)'],  'edit', '',
  'rail temperature change, summer / winter; empty: 0 0 for CWR, +50 -50 with rail expansion joints (UIC 774-3)'],
 // Load
 ['Load', 'alfa',     [V('α')],                          'edit', '1.33', 'load classification factor'],
 ['Load', 'LM71',     ['LM71'],                          'check', true,
  'LM71 on the whole bridge, locomotive from the movable bearing'],
 ['Load', 'SW',       ['SW/0'],                          'check', false, 'SW/0 (continuous decks)'],
 ['Load', 'dxPos',    ['Δ', V('x'), ' (m)'],             'edit', '1',
  '0 = fixed load positions, > 0 = locomotive / SW/0 moved in steps; follows L: 1 m, for a total length > 200 m ' +
  'shortest span / 15 within 1 to 5 m; another value is kept'],
 ['Load', 'qlbk',     [V('q', 'lbk'), ' (kN/m)'],        'edit', '20',   'braking'],
 ['Load', 'Qlbk',     [V('Q', 'lbk,max'), ' (kN)'],      'edit', '6000', 'max braking force'],
 ['Load', 'qlak',     [V('q', 'lak'), ' (kN/m)'],        'edit', '33',   'traction'],
 ['Load', 'Qlak',     [V('Q', 'lak,max'), ' (kN)'],      'edit', '1000', 'max traction force'],
 // Limits
 ['Limits', 'sigbr',  [V('σ', 'bridge'), ' (MPa)'],      'edit', '-72 112',
  'additional rail stress on the bridge, EN 1991-2:2024 8.5.4.5.1'],
 ['Limits', 'sigemb', [V('σ', 'emb.'), ' (MPa)'],        'edit', '-72 112', 'additional rail stress on the embankment'],
 ['Limits', 'dB',     [V('δ', 'B'), ' (mm)'],            'edit', '5',
  'deck end displacement, braking/traction, 8.5.4.5.2'],
 ['Limits', 'dH',     [V('δ', 'H'), ' (mm)'],            'edit', '8',    'deck end displacement, vertical traffic'],
 ['Limits', 'dV',     [V('δ', 'V'), ' (mm)'],            'edit', '2',
  'vertical deck end displacement (line speed > 160 km/h)'],
 ['Limits', 'wL',     [V('L'), '/', V('δ', 'max')],      'edit', '600',
  'largest deflection of a span from vertical traffic: delta <= L/600 (LM71, SW/0 x alpha, no dynamic factor)'],
 ['Limits', 'wgap',   [V('w', 'gap'), ' (mm)'],          'edit', '50',   'TRVINFRA-00012 K35714'],
 ['Limits', 'nlgeom', ['P-', V('δ')],                    'check', false,
  'geometrically nonlinear beams'],
 ['Limits', 'nInc',   [V('n', 'inc')],                   'edit', '1',
  'load increments per step']
].map(d => ({ tab: d[0], key: d[1], label: d[2], kind: d[3], val: d[4], tip: d[5] }));

const ITEMS = {                                     // items of the drop-downs
    ntrack: ['1', '2'],
    Tmode: ['EN 1991-1-5', 'direct'],
    dtype: ['1 steel', '2 composite', '3 concrete'],
    ttype: ['ballasted', 'ballastless'],
    profile: ['60E1', '50E3', 'custom']
};
for (const d of FIELDS) d.items = ITEMS[d.key];
const SAVED = FIELDS.filter(d => d.kind !== 'out' && d.kind !== 'blank');   // fields of the JSON file

const P = {};                                       // input elements by key, P[key]


// %% 2-3 WINDOW AND TOOLBAR (index.html): symbols, progress bar, status line
const btn = {
    run: $('bRun'), reset: $('bReset'), load: $('bLoad'), save: $('bSave'), report: $('bReport'),
    export: $('bExport'), print: $('bPrint'), printB: [$('bPrintSF'), $('bPrintD')]
};
const RUN_TIP = 'Run: all load cases';
const STOP_TIP = 'Stop: ends the run, keeps the input';


// %% 4 INPUT TABS: Bridge, Track, Load, Limits ===============================
// Each tab is a grid of label/field pairs, filled column by column from
// FIELDS; the Load tab also shows the load models LM71 and SW/0.
function buildInputs() {
    const bar = $('itabs'), pages = $('ipages');
    TABS.forEach((t, it) => {
        const tb = document.createElement('button');
        tb.type = 'button';
        tb.className = 'tab' + (it === 0 ? ' on' : '');
        tb.textContent = t;
        tb.dataset.p = 'in' + t;
        bar.appendChild(tb);
        const pg = document.createElement('div');
        pg.className = 'page ipage' + (it === 0 ? ' on' : '');
        pg.id = 'in' + t;
        const gr = document.createElement('div');
        gr.className = 'grid';
        const f = FIELDS.filter(d => d.tab === t), nr = Math.ceil(f.length / NG);   // rows of this tab
        gr.style.gridTemplateRows = `repeat(${nr}, 22px)`;
        f.forEach((d, i) => {
            const r = i % nr + 1, c = 2 * Math.floor(i / nr) + 1;   // row, column of the label
            if (d.kind === 'blank') return;                         // empty cell
            const el = makeField(d);
            el.id = 'f_' + d.key;
            el.style.gridRow = r;
            el.style.gridColumn = c + 1;
            const lb = document.createElement('label');
            lb.className = 'lab';
            lb.htmlFor = el.id;
            lb.title = d.tip;
            lb.style.gridRow = r;
            lb.style.gridColumn = c;
            appendLabel(lb, d.label);
            gr.append(lb, el);
            P[d.key] = el;
        });
        pg.appendChild(gr);
        if (t === 'Load') {                                         // LM71 (left) and SW/0 (right)
            const lg = document.createElement('div');
            lg.className = 'loads';
            const a = document.createElement('div'), b = document.createElement('div');
            a.id = 'ldLM71';
            b.id = 'ldSW';
            lg.append(a, b);
            pg.appendChild(lg);
        }
        pages.appendChild(pg);
    });
}

function makeField(d) {
    // input element of field d: text box, drop-down, tick box or computed
    // value (read only, grey)
    let el;
    if (d.kind === 'drop') {
        el = document.createElement('select');
        el.className = 'ed';
        for (const it of d.items) {
            const o = document.createElement('option');
            o.value = it;
            o.textContent = it;
            el.appendChild(o);
        }
    } else if (d.kind === 'check') {
        el = document.createElement('input');
        el.type = 'checkbox';
        el.className = 'chk';
    } else {
        el = document.createElement('input');
        el.type = 'text';
        el.className = 'ed' + (d.kind === 'out' ? ' out' : '');
        el.maxLength = MAXIN;
        el.spellcheck = false;
        el.autocomplete = 'off';
        if (d.kind === 'out') el.readOnly = true;
    }
    el.title = d.tip;
    if (d.kind !== 'out') el.addEventListener('change', () => onChange(d.key));   // as ValueChangedFcn
    return el;
}

function appendLabel(el, parts) {
    // label parts: text, or V(symbol, subscript) = <i>symbol</i><sub>subscript</sub>
    for (const p of parts) {
        if (typeof p === 'string') {
            el.appendChild(document.createTextNode(p));
            continue;
        }
        const i = document.createElement('i');
        i.textContent = p.s;
        el.appendChild(i);
        if (p.sub) {
            const s = document.createElement('sub');
            s.textContent = p.sub;
            el.appendChild(s);
        }
    }
}

function initTabs(barId, onShow) {
    // tab bar: the clicked tab and its page are shown, onShow(pageId) draws
    // what needs a visible container
    const bar = $(barId);
    bar.addEventListener('click', e => {
        const t = e.target.closest('.tab');
        if (!t) return;
        for (const x of bar.children) {
            x.classList.toggle('on', x === t);
            $(x.dataset.p).classList.toggle('on', x === t);
        }
        onShow(t.dataset.p);
    });
}

const getv = k => (P[k].type === 'checkbox' ? P[k].checked : P[k].value);
function setv(k, v) {
    if (P[k].type === 'checkbox') P[k].checked = !!v;
    else P[k].value = v;
}


// %% 5 MODEL SKETCH (left column), drawn by tbi_plot.js ======================
// (container #model in index.html, see drawModel)


// %% 6 RESULT TABS: Tables, Rail stress, Bridge SF, Bridge disp ===============
// 6.1 Tables: three tables (rail stress, displacements, bearing forces), with
// the row names before the first run, rebuilt by setTable after a run
const UNITS = ['MPa', 'mm', 'kN'];
const TT = [
    ['Additional rail stress (MPa)', ['Temperature', 'LM71', 'Braking', 'Traction', 'Load combination, bridge',
                                      'Load combination, embankment']],
    ['Displacements (mm)', ['$\\delta_\\mathrm{B}$ braking/traction, left / right',
                            '$\\delta_\\mathrm{H}$ vertical traffic, left / right',
                            '$\\delta_\\mathrm{V}$ vertical traffic, left / right',
                            '$\\delta_\\mathrm{V}$ max deflection, vertical traffic',
                            'Deck end movement, temperature, left / right', 'Rail break gap']],
    ['Longitudinal bearing forces (kN)', ['Support 2, temperature', 'Support 2, LM71', 'Support 2, braking',
                                          'Support 2, traction', 'Support 2, load combination']]
];
const tabc = [];                                    // one container per table

// 6.2 Rail stress: three diagrams with titles
const DN = ['Temperature', 'Vertical traffic (dashed), braking/traction (solid), envelope',
            'Governing load combination (solid), temperature step (dashed)'];

// 6.3 Bridge SF and Bridge disp: load case drop-down and three diagrams
const BK = ['SF', 'disp'];                          // kind of diagram, as TBI.plotBridge
const BN = [['Bending moment (sagging positive)', 'Shear force', 'Axial force (tension positive)'],
            ['Longitudinal displacement (track slip centre)', 'Vertical displacement (up positive)',
             'Rotation (anticlockwise positive)']];
const LCN = ['Temperature, envelope', 'Vertical traffic (dashed), braking/traction (solid), envelopes',
             'Governing load combination (solid), temperature step (dashed)'];   // load cases 1-3
const PT = ['M, V and N', 'u, w and rotation'];
const BPAGE = ['pBSF', 'pBD'], BSEL = [$('lcSF'), $('lcD')];
const axD = [], dTitle = [], axB = [[], []];        // diagram containers and the rail stress titles

function buildResults() {
    for (let k = 0; k < 3; k++) {
        const c = document.createElement('div');
        $('tables').appendChild(c);
        tabc.push(c);
    }
    for (let j = 0; j < 3; j++) {
        const [t, d] = diagBox($('railDiags'), DN[j]);
        dTitle.push(t);
        axD.push(d);
    }
    for (let kb = 0; kb < 2; kb++) {
        const box = $(BPAGE[kb] === 'pBSF' ? 'bsfDiags' : 'bdDiags');
        for (let j = 0; j < 3; j++) axB[kb].push(diagBox(box, BN[kb][j])[1]);
        LCN.forEach((n, i) => {
            const o = document.createElement('option');
            o.value = String(i + 1);
            o.textContent = n;
            BSEL[kb].appendChild(o);
        });
        BSEL[kb].value = '3';
        BSEL[kb].addEventListener('change', () => drawBridge(kb));
    }
}

function diagBox(parent, title) {
    // a diagram: title line and an empty container for tbi_plot.js
    const t = document.createElement('div'), d = document.createElement('div');
    t.className = 'dtitle';
    t.textContent = title;
    d.className = 'diag';
    parent.append(t, d);
    return [t, d];
}


// %% 7 START: state, first drawing, callbacks for scripts ====================
// Variables shared by the callbacks below (besides the elements above):
let out = null;                                     // results of the last run (TBI.analysis), null = none
let dxAuto = 1;                                     // load step from the rule (dxRule); follows L while not changed by hand
let running = false;                                // a run in progress
let changedRun = false;                             // input changed during the run: its results are not shown
let stopOn = false;                                 // the Run symbol shows Stop (after 1 s of a run)


// %% ==========================================================================
//  CALLBACKS
//  ===========================================================================

// ---------------------------------------------------------------------------
// INPUT: a field changed, input check, input object, reset, open, save
// ---------------------------------------------------------------------------
function onChange(key) {
    // a field changed (key = its name, '' = all): dependent fields, computed
    // values, input check and model sketch
    if (running) changedRun = true;                 // edited during a run
    for (const d of FIELDS) {                       // a comma is a decimal point, also in the box
        if (d.kind === 'edit' && P[d.key].value.includes(',')) P[d.key].value = P[d.key].value.replace(/,/g, '.');
    }
    const sL = spanL(P.L.value).s;                  // L1:dL:Ltot: Ltot rounded to whole spans
    if (sL) P.L.value = sL;
    if (key === '' || key === 'loaded') dxAuto = dxRule(spanL(P.L.value).v);   // the value in the box is kept
    const L = spanL(P.L.value).v;
    switch (key) {
    case 'L': {                                     // number of supports changed: K_h follows (fixed bearing
        const ns = L.length + 1;                    // at the right end with its stiffness, the others movable)
        let Kh = vec(P.Kh.value);
        if (Kh.length !== ns && L.every(x => x > 0)) {
            const kp = Kh.filter(x => x > 0);
            const kf = kp.length ? Math.max(...kp) : 10;
            Kh = new Array(ns - 1).fill(0).concat([kf]);
            P.Kh.value = Kh.map(numfmt).join(' ');
        }
        if (L.every(x => x > 0)) {                  // the load step follows L unless changed by hand
            const dxNew = dxRule(L);
            if (num(P.dxPos.value) === dxAuto) P.dxPos.value = fmtG(dxNew);
            dxAuto = dxNew;
        }
        break;
    }
    case 'dtype':                                   // deck type: E of concrete or steel (equivalent steel section)
        P.E.value = P.dtype.value.startsWith('3') ? '35' : '210';
        break;
    case 'profile': {                               // rail profile: A and I per rail (EN 13674-1)
        const pr = { '60E1': [76.70, 3038.3], '50E3': [63.71, 2057.8] }[P.profile.value];
        if (pr) {
            P.Ar.value = fmtG(pr[0]);
            P.Ir.value = fmtG(pr[1]);
        }
        break;
    }
    case 'ttype':                                   // track type: EN 1991-2:2024 Table 8.9
        if (P.ttype.value === 'ballastless') {
            P.u0.value = '0.5 0.5'; P.Fu.value = '40 40'; P.er.value = '0.25';
            P.sigbr.value = '-112 112'; P.sigemb.value = '-112 112';
        } else {
            P.u0.value = '2 0.5'; P.Fu.value = '20 30'; P.er.value = '0.75';
            P.sigbr.value = '-72 112'; P.sigemb.value = '-72 112';
        }
        P.Fl.value = '60';
        break;
    }
    // computed fields: deck temperature change (EN 1991-1-5 6.1.3, Figure 6.1
    // AC:2009), rail temperature for the rail break, thermal expansion
    const ty = ITEMS.dtype.indexOf(P.dtype.value);
    const Tmax = num(P.Tmax.value), Tmin = num(P.Tmin.value), T0 = num(P.T0.value);
    const dTe = [[16, 4, 2], [-3, 4, 8]];           // T_e - T, max and min, per deck type
    if (P.Tmode.value === 'EN 1991-1-5') {
        P.dTN.value = '';
        if ([Tmax, Tmin, T0].every(isFinite)) {     // rounded as in TBI.readJson
            P.dTN.value = sgn0(roundHalf(Tmax + dTe[0][ty] - T0)) + ' ' + sgn0(roundHalf(Tmin + dTe[1][ty] - T0));
        }
        P.dTN.readOnly = true;
        P.dTN.classList.add('out');
        P.dTN.classList.remove('bad');
    } else {                                        // typed directly
        P.dTN.readOnly = false;
        P.dTN.classList.remove('out');
    }
    const TRmin = num(P.TRmin.value);
    P.dTbrk.value = isFinite(TRmin - T0) ? sgn0(roundHalf(TRmin - T0)) : '';
    P.alfab.value = Math.abs(num(P.E.value) / 210 - 1) < 0.15 ? '12e-6' : '10e-6';
    // input check: on an error no results, no model, nothing to save
    if (inputBad()) {
        clearResults();
        $('model').replaceChildren();
        btn.save.disabled = true;
        setStatus('input error', true);
        setProg(null);
        return;
    }
    btn.save.disabled = false;
    setStatus($('status').textContent === 'input error' ? '' : $('status').textContent);
    drawModel();
    drawLoads();
    if (running) {
        setStatus('Input changed during the run: its results will be discarded');
    } else if (key && out) {                        // results no longer match the input
        enableOut(false);
        if (!$('status').textContent) setStatus('Input changed: results not up to date, press Run');
    }
}

function inputBad() {
    // marks input boxes with an error light red; true if there is one
    const pos = ['L', 'E', 'A', 'I', 'Ar', 'Ir', 'sr', 'Le', 'Fl', 'Kv', 'Fu', 'u0', 'alfa'];   // must be > 0
    const nng = ['Kh', 'dxPos', 'qlbk', 'Qlbk', 'qlak', 'Qlak', 'Lend'];                        // must be >= 0
    const vct = ['L', 'Kh', 'dTN', 'u0', 'Fu', 'Kv', 'gap', 'dTR', 'sigbr', 'sigemb'];          // may have several values
    const emp = ['gap', 'dTR', 'dxPos'];                                                        // may be empty (dxPos: 0)
    const L = spanL(P.L.value).v, Lsum = sum(L);
    let tf = false;
    for (const d of FIELDS) {
        const k = d.key;
        if (d.kind !== 'edit' || (k === 'dTN' && P.dTN.readOnly)) continue;
        const v = k === 'L' ? L : vec(P[k].value);
        let b = v.some(x => !isFinite(x)) || (!v.length && !emp.includes(k)) || (v.length > 1 && !vct.includes(k));
        if (pos.includes(k)) b = b || v.some(x => x <= 0);
        if (nng.includes(k)) b = b || v.some(x => x < 0);
        if (k === 'Kh') b = b || v.length !== L.length + 1;                         // one per support
        if (['dTN', 'u0', 'Fu', 'sigbr', 'sigemb'].includes(k)) b = b || v.length !== 2;   // two values
        if (k === 'dTR') b = b || (v.length !== 0 && v.length !== 2);
        if (k === 'Kv') b = b || v.length > 2;
        if (k === 'L') b = b || Lsum < 1 || Lsum > 2000;                             // total length (m)
        // size of the model: sleeper spacing, embankment, load positions
        if (k === 'sr') b = b || v.some(x => x < 0.1 || x > 5) || nNodes() > 30000;
        if (k === 'Le') b = b || v.some(x => x > 1000) || nNodes() > 30000;
        if (k === 'dxPos') b = b || v.some(x => x > 0 && Lsum / x > 1000);
        if (k === 'nInc') b = b || v.some(x => x < 1 || x > 100 || x !== Math.round(x));   // integer 1 ... 100
        P[k].classList.toggle('bad', b);
        tf = tf || b;
    }
    return tf;
}

function nNodes() {
    // about the number of nodes of the model (rails and deck, s_r/2)
    const d = num(P.sr.value) / 2, Lb = sum(spanL(P.L.value).v);
    const n = num(P.ntrack.value) * (Lb + 2 * num(P.Le.value)) / d + Lb / d;
    return isFinite(n) ? n : 0;
}

function fieldsObject() {
    // the input fields as in TBI_input.json: text as in the boxes, tick boxes
    // true/false, in the order of the fields
    const S = {};
    for (const d of SAVED) S[d.key] = getv(d.key);
    return S;
}

function readInput() {
    // {inp, opt} of TBI.readJson from the fields (engineering units -> SI,
    // defaults and the temperature rule in tbi_fem.js only)
    return TBI.readJson(fieldsObject());
}

function onReset() {
    // Reset: default input (Bryngeån), results cleared
    for (const d of SAVED) setv(d.key, d.val);
    clearResults();
    onChange('');
    setStatus('Default input (Bryngeån)');
    setProg(null);
}

function onLoad() {
    // Open: a JSON file chosen in the browser's file dialog (loadFile)
    const fi = $('fileIn');
    fi.value = '';                                  // the same file again also fires 'change'
    fi.click();
}

async function loadFile(f) {
    // input fields from a JSON file (fields not in the file keep their value);
    // only keys of FIELDS are read and only values of the right type are taken
    let S;
    try {
        if (f.size > MAXFILE) throw new Error('The file is larger than 1 MB.');
        S = JSON.parse(await f.text());
        if (Object.prototype.toString.call(S) !== '[object Object]') throw new Error('The file holds no input fields.');
    } catch (e) {
        setStatus('Load input: ' + errMsg(e), true);
        return;
    }
    const has = k => Object.prototype.hasOwnProperty.call(S, k);
    for (const d of SAVED) {
        if (!has(d.key)) continue;
        const v = S[d.key];
        if (d.kind === 'check') {
            if (typeof v === 'boolean' || (typeof v === 'number' && isFinite(v))) setv(d.key, !!v);
        } else if (d.kind === 'drop') {
            if (typeof v === 'string' && d.items.includes(v)) setv(d.key, v);
        } else if (typeof v === 'string') {
            setv(d.key, v);                         // too long or not a number: the box turns red
        } else if (typeof v === 'number' && isFinite(v)) {
            setv(d.key, numfmt(v));
        } else if (Array.isArray(v) && v.length <= 1000 && v.every(x => typeof x === 'number' && isFinite(x))) {
            setv(d.key, v.map(numfmt).join(' '));
        }
    }
    clearResults();                                 // results of the earlier input removed
    onChange('loaded');
    if ($('status').textContent !== 'input error') setStatus('Input loaded: ' + f.name);
}

async function onSave() {
    // Save: input fields to a JSON file (text as in the boxes, as TBI_gui.m)
    if (btn.save.disabled) return;
    const blob = new Blob([JSON.stringify(fieldsObject(), null, 2)], { type: 'application/json' });
    const n = await saveBlob(blob, 'TBI_input.json', [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]);
    if (n) setStatus('Input saved: ' + n);
}


// ---------------------------------------------------------------------------
// MODEL: model sketch and load models
// ---------------------------------------------------------------------------
function drawModel() {
    // model sketch as in the report: input completed with the defaults and
    // geometry of tbi_fem.js, no analysis
    const el = $('model');
    try {
        const m = TBI.model(readInput().inp);
        el.replaceChildren();
        TBI.plotModel(el, m);
        setStatus('');
    } catch (e) {
        el.replaceChildren();
        setStatus('Input: ' + errMsg(e));
    }
}

function drawLoads() {
    // load models LM71 and SW/0 (EN 1991-2) in the Load tab when ticked;
    // drawn only while the tab is shown (the containers need a size)
    for (const [id, k] of [['ldLM71', 'LM71'], ['ldSW', 'SW']]) {
        const el = $(id);
        el.replaceChildren();
        if (!P[k].checked || el.clientWidth === 0) continue;
        try {
            TBI.plotLoads(el, k);
        } catch (e) {
            setStatus('Load models: ' + errMsg(e));
        }
    }
}


// ---------------------------------------------------------------------------
// RUN: analysis with progress bar and Stop
// ---------------------------------------------------------------------------
async function onRun() {
    // Run: all load cases with TBI.analysis, then tables and diagrams; after
    // 1 s the Run symbol becomes Stop, and a second click comes in here
    if (running) {
        if (stopOn) {
            TBI.stop();                             // TBI.analysis rejects with Error('stopped')
            setStatus('Stopping ...');
        }
        return;
    }
    if (inputBad()) return;
    let rj;
    try {
        rj = readInput();
    } catch (e) {
        setStatus('Input: ' + errMsg(e), true);
        return;
    }
    const jo = rj.opt || {};
    const opt = {
        nlgeom: jo.nlgeom !== undefined ? !!jo.nlgeom : P.nlgeom.checked,
        nInc: jo.nInc !== undefined ? Number(jo.nInc) : num(P.nInc.value),
        progress: runProgress,
        workers: nWorkers()
    };
    btn.run.disabled = true;
    enableOut(false);
    setStatus('Running ...');
    setProg(0);
    running = true;
    stopOn = false;
    changedRun = false;
    const tStop = setTimeout(() => {                // Stop symbol after 1 s
        if (!running) return;
        stopOn = true;
        btn.run.classList.add('stop');
        btn.run.title = STOP_TIP;
        btn.run.disabled = false;
    }, 1000);
    let res;
    try {
        res = await TBI.analysis(rj.inp, opt);
    } catch (e) {
        clearTimeout(tStop);
        runEnd();
        clearResults();
        setProg(null);
        if (errMsg(e) === 'stopped') setStatus('Stopped');
        else setStatus('Analysis: ' + errMsg(e), true);
        return;
    }
    clearTimeout(tStop);
    runEnd();
    if (changedRun) {                               // input changed while running: results discarded
        clearResults();
        setProg(null);
        setStatus('Input changed during the run: results discarded, press Run');
        return;
    }
    out = res;
    try {
        showResults();
    } catch (e) {                                   // a drawing failed: the results are kept, the tables shown
        setStatus('Results: ' + errMsg(e), true);
        enableOut(true);
        return;
    }
    enableOut(true);
    setProg(1);
    const nex = out.Table.filter(t => flat(t.exceed).some(Boolean)).length;
    const msg = nex === 0 ? 'all limits met' : `${nex} outside limits (red)`;
    setStatus(`${out.Info.nRun} analyses, ${Number(out.Info.time).toFixed(1)} s, ${msg}`);
}

function runProgress(fr) {
    // called by TBI.analysis after each stage (fr = share done)
    setProg(fr);
}

function runEnd() {
    // the run is over: Run symbol back
    running = false;
    stopOn = false;
    btn.run.classList.remove('stop');
    btn.run.title = RUN_TIP;
    btn.run.disabled = false;
}

function nWorkers() {
    // Web Workers need the page served over http(s); from a file: on the main thread
    if (location.protocol === 'file:' || typeof Worker === 'undefined') return 0;
    return Math.max(1, Math.min(16, (navigator.hardwareConcurrency || 4) - 1));
}

function setProg(fr) {
    // progress bar: fr = share done (0...1), null = empty
    if (fr === null || !isFinite(fr)) {
        $('progFill').style.width = '0';
        $('progTxt').textContent = '';
        return;
    }
    fr = Math.min(1, Math.max(0, fr));
    $('progFill').style.width = (100 * fr).toFixed(1) + '%';
    $('progTxt').textContent = Math.round(100 * fr) + ' %';
}


// ---------------------------------------------------------------------------
// RESULTS: tables and diagrams in the result tabs
// ---------------------------------------------------------------------------
function showResults() {
    // result tables (by unit) and all diagrams of out
    UNITS.forEach((u, k) => {
        const Tk = out.Table.filter(t => t.unit === u);
        const rows = Tk.map(t => ({
            name: t.name,
            lim: limText(t.lim),
            vals: [fmtv(t, 0), fmtv(t, 1)],
            ex: [t.exceed.some(r => r[0]), t.exceed.some(r => r[1])]   // [row][k]: any row of season k
        }));
        setTable(k, rows);
    });
    for (let j = 0; j < 3; j++) dTitle[j].textContent = dtitle(j);
    for (let kb = 0; kb < 2; kb++) {
        for (const o of BSEL[kb].options) o.textContent = lcname(Number(o.value));
    }
    drawRail();
    drawBridge();
}

function setTable(k, rows) {
    // result table k (0 rail stress, 1 displacements, 2 bearing forces):
    // rows = [{name (LaTeX), lim, vals [summer, winter], ex [summer, winter]}],
    // values outside the limit red bold; bearing forces right-aligned among
    // themselves, the block centred in the cell
    const tb = document.createElement('table');
    tb.className = 'res';
    const hr = tb.createTHead().insertRow();
    [TT[k][0], 'Limit', 'Summer', 'Winter'].forEach((h, i) => {   // table title in the header row
        const th = document.createElement('th');
        if (i === 0) th.className = 'tl';
        th.textContent = h;
        hr.appendChild(th);
    });
    let w = 0;                                      // widest value (characters)
    if (k === 2) for (const r of rows) for (const s of r.vals) w = Math.max(w, s.length);
    const body = tb.createTBody();
    for (const r of rows) {
        const tr = body.insertRow();
        const tn = tr.insertCell();
        tn.className = 'tname';
        texInto(tn, r.name);
        const tl = tr.insertCell();
        tl.className = 'l';
        tl.textContent = r.lim;
        for (let s = 0; s < 2; s++) {
            const td = tr.insertCell();
            td.className = 'v';
            let el = td;
            if (w && r.vals[s]) {
                el = document.createElement('span');
                el.className = 'rn';
                el.style.width = w + 'ch';
                td.appendChild(el);
            }
            el.textContent = r.vals[s];
            if (r.ex[s]) el.classList.add('ex');
        }
    }
    tabc[k].replaceChildren(tb);
}

function emptyTables() {
    // the three tables with the row names only (before the first run)
    for (let k = 0; k < 3; k++) {
        setTable(k, TT[k][1].map(n => ({ name: n, lim: '', vals: ['', ''], ex: [false, false] })));
    }
}

function clearResults() {
    // no results: empty tables and diagrams, nothing to export or print
    out = null;
    emptyTables();
    for (let j = 0; j < 3; j++) {
        axD[j].replaceChildren();
        dTitle[j].textContent = DN[j];
        axB[0][j].replaceChildren();
        axB[1][j].replaceChildren();
    }
    for (let kb = 0; kb < 2; kb++) {
        for (const o of BSEL[kb].options) o.textContent = LCN[Number(o.value) - 1];
    }
    enableOut(false);
}

function enableOut(on) {
    // report, export and prints need results
    for (const b of [btn.report, btn.export, btn.print, ...btn.printB]) b.disabled = !on;
}

function drawRail() {
    // rail stress diagrams of out; drawn only while the tab is shown (the
    // containers need a size), again when the tab is chosen
    if (!out || !$('pRail').classList.contains('on')) return;
    for (const d of axD) d.replaceChildren();
    TBI.plotRail(axD, out);
}

function drawBridge(kb) {
    // deck forces (kb = 0) or displacements (kb = 1) of the load case chosen
    // in the drop-down; without kb both (each only while its tab is shown)
    if (!out) return;
    for (const jb of (kb === undefined ? [0, 1] : [kb])) {
        if (!$(BPAGE[jb]).classList.contains('on')) continue;
        for (const d of axB[jb]) d.replaceChildren();
        try {
            TBI.plotBridge(axB[jb], out, Number(BSEL[jb].value), BK[jb]);
        } catch (e) {
            setStatus('Bridge ' + BK[jb] + ': ' + errMsg(e), true);
        }
    }
}

function dtitle(j) {
    // title of rail stress diagram j for the current results (with SW/0 or
    // rail expansion joints the line styles or quantities differ)
    if (!out) return DN[j];
    const rej = !!(out.Track && out.Track.rej);     // REJ: total stress, combination at neutral temperature
    if (j === 0 && rej) return 'Temperature, total rail stress (dotted: fully restrained rail)';
    if (j === 1 && out.inp.Load.SW) return 'LM71 (dashed), SW/0 (dash-dot), braking/traction (solid), envelope';
    if (j === 2 && rej) return 'Governing load combination without temperature';
    return DN[j];
}

function lcname(lc) {
    // name of load case lc (1-3) in the Bridge drop-downs, with the line styles
    if (lc === 2 && out && out.inp.Load.SW) {
        return 'LM71 (dashed), SW/0 (dash-dot), braking/traction (solid), envelopes';
    }
    return LCN[lc - 1];
}

function onShowResultTab(p) {
    // a result tab was chosen: its diagrams need a visible container
    if (p === 'pRail') drawRail();
    if (p === 'pBSF') drawBridge(0);
    if (p === 'pBD') drawBridge(1);
}


// ---------------------------------------------------------------------------
// OUTPUT: prints (A4, save as PDF in the print dialog), report, Excel export
// ---------------------------------------------------------------------------
function onPrint() {
    // Rail stress print: the three diagrams on one A4 page
    if (!out) return;
    const box = $('printDiag');
    box.replaceChildren();
    document.body.classList.add('p-diag');          // laid out (off screen) so that the drawings get a size
    const els = [0, 1, 2].map(j => printBox(box, dtitle(j), ''));
    try {
        TBI.plotRail(els, out);
    } catch (e) {
        printEnd();
        setStatus('Print: ' + errMsg(e), true);
        return;
    }
    printMode('TBI_rail_stress');
}

function onPrintBridge(kb) {
    // Bridge print: deck forces (kb = 0) or displacements (kb = 1) of the
    // three load cases, one A4 page each
    if (!out) return;
    const box = $('printDiag');
    box.replaceChildren();
    document.body.classList.add('p-diag');
    try {
        for (let lc = 1; lc <= 3; lc++) {
            if (lc > 1) {
                const pb = document.createElement('div');
                pb.className = 'pgb';
                box.appendChild(pb);
            }
            const els = [0, 1, 2].map(j => printBox(box, BN[kb][j], lcname(lc)));
            TBI.plotBridge(els, out, lc, BK[kb]);
        }
    } catch (e) {
        printEnd();
        setStatus('Print: ' + errMsg(e), true);
        return;
    }
    printMode(kb ? 'TBI_bridge_disp' : 'TBI_bridge_SF');
}

function printBox(parent, title, sub) {
    // a diagram of a print page: title, subtitle and container
    const t = document.createElement('div');
    t.className = 'pt';
    t.textContent = title;
    parent.appendChild(t);
    if (sub) {
        const s = document.createElement('div');
        s.className = 'ps';
        s.textContent = sub;
        parent.appendChild(s);
    }
    const d = document.createElement('div');
    d.className = 'dg';
    parent.appendChild(d);
    return d;
}

function onReport() {
    // Report: the report of the last run (tbi_report.js) printed alone; the
    // PDF is saved in the print dialog
    if (!out) return;
    const box = $('report');
    box.replaceChildren();
    document.body.classList.add('p-report');
    try {
        const el = TBI.report(out);
        if (el) box.appendChild(el);
    } catch (e) {
        printEnd();
        setStatus('Report: ' + errMsg(e), true);
        return;
    }
    printMode('TBI-analysis');
}

let printTitle = null;                              // page title while printing (default PDF file name)
function printMode(name) {
    // print the section of the body class p-report or p-diag; the page title
    // is the default PDF file name in the print dialog
    printTitle = document.title;
    document.title = name;
    window.addEventListener('afterprint', printEnd, { once: true });
    setStatus('Printing: ' + name);
    requestAnimationFrame(() => window.print());
}

function printEnd() {
    // print dialog closed (or the print failed): screen layout back
    document.body.classList.remove('p-report', 'p-diag');
    if (printTitle !== null) document.title = printTitle;
    printTitle = null;
    $('printDiag').replaceChildren();
    $('report').replaceChildren();
}

async function onExport() {
    // Export: results to Excel, the three tables (values outside the limits
    // red bold) and the diagram data
    if (!out) return;
    let blob;
    try {
        blob = TBI.xlsx(exportSheets(out));
    } catch (e) {
        setStatus('Export: ' + errMsg(e), true);
        return;
    }
    const n = await saveBlob(blob, 'TBI_results.xlsx',
        [{ description: 'Excel', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }]);
    if (n) setStatus('Exported: ' + n);
}

function exportSheets(o) {
    // the sheets of the Excel export, as onExport in TBI_gui.m
    const sheets = [];
    // sheets 1-3: the result tables; columns min/left and max/right per season
    const sh = ['Rail stress', 'Displacements', 'Bearing forces'];
    UNITS.forEach((u, k) => {
        const B = v => ({ v, s: 'bold' });
        const rows = [['', 'Limit', 'min/left,s', 'max/right,s', 'min/left,w', 'max/right,w', 'Unit'].map(B)];
        for (const t of o.Table.filter(r => r.unit === u)) {
            const dec = hasDec(t) ? t.dec : (u === 'kN' ? 0 : 1);   // kN whole, mm and MPa one decimal
            const cell = (i, s) => {                // row i (min/left, max/right), season s
                if (i >= t.val.length) return null;
                const v = rnd(t.val[i][s], dec);
                return t.exceed[i] && t.exceed[i][s] ? { v, s: 'red' } : v;
            };
            rows.push([plainName(t.name), limText(t.lim), cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1), u]);
        }
        sheets.push({ name: sh[k], rows, widths: [48, 12, 11, 12, 11, 12, 6] });
    });
    // sheets 4-6: diagram data, short headers (row 1) and units (row 2):
    // group (temp, LM71, SW, brk, tra, comb), min/max, s(ummer)/w(inter);
    // gov = governing combination, T = its temperature step
    const Ld = o.inp.Load;
    const grp = [['temp', 'temp'], ['LM71', 'LM71'], ['SW', 'SW'], ['brk', 'brk'], ['acc', 'tra'], ['comb', 'comb']]
        .filter(g => (g[0] !== 'LM71' || Ld.LM71) && (g[0] !== 'SW' || Ld.SW));
    const Tk = o.Track, Bk = o.Bridge, xb = Bk.x;
    sheets.push(diagSheet('Rail stress diagram', Tk.x, Tk, [''], ['MPa'], 1, 1, grp, null));   // 0.1 MPa
    const bold = new Set();                         // bridge: bearings and deck ends in bold
    xb.forEach((x, i) => {
        if (i === 0 || i === xb.length - 1 || Bk.xsup.some(s => Math.abs(x - s) < 1e-6)) bold.add(i);
    });
    for (const s of Bk.xsup) {                      // bearing between two seats: nearest seat
        let im = 0;
        xb.forEach((x, i) => { if (Math.abs(x - s) < Math.abs(xb[im] - s)) im = i; });
        bold.add(im);
    }
    sheets.push(diagSheet('Bridge SF diagram', xb, Bk.F, ['M', 'V', 'N'], ['kNm', 'kN', 'kN'], 0, 1e3, grp, bold));
    sheets.push(diagSheet('Bridge disp diagram', xb, Bk.D, ['u', 'w', 'th'], ['mm', 'mm', 'mrad'], 1, 1, grp, bold));
    return sheets;
}

function diagSheet(name, x, S, qs, us, dec, fac, grp, bold) {
    // diagram columns of S (out.Track or out.Bridge.F/D): for each quantity
    // qs (field, '' = S itself) and group: min/max for summer and winter, then
    // gov and T; values x fac rounded to dec decimals; x to 0.1 m; rows in
    // bold (index set) for bearings and deck ends
    const hd = ['x'], ud = ['m'], cols = [x.map(v => rnd(v, 1))];
    const sw = 'sw';                                // summer, winter
    qs.forEach((q, iq) => {
        const pre = q ? q + ' ' : '', get = G => (q ? G[q] : G);
        for (const [g, n] of grp) {
            const G = get(S[g]);
            for (let s = 0; s < 2; s++) {
                hd.push(`${pre}${n} min,${sw[s]}`, `${pre}${n} max,${sw[s]}`);
                cols.push(G.min[s].map(v => rnd(fac * v, dec)), G.max[s].map(v => rnd(fac * v, dec)));
            }
        }
        for (let s = 0; s < 2; s++) {
            hd.push(`${pre}gov,${sw[s]}`, `${pre}T,${sw[s]}`);
            cols.push(get(S.comb.gov)[s].map(v => rnd(fac * v, dec)), get(S.comb.govTemp)[s].map(v => rnd(fac * v, dec)));
        }
        for (let j = 0; j < 4 * grp.length + 4; j++) ud.push(us[iq]);
    });
    const rows = [hd.map(v => ({ v, s: 'bold' })), ud];
    for (let i = 0; i < x.length; i++) {
        const r = cols.map(c => c[i]);
        rows.push(bold && bold.has(i) ? r.map(v => ({ v, s: 'bold' })) : r);
    }
    return { name, rows, widths: hd.map(h => Math.max(7, h.length + 2)) };
}

async function saveBlob(blob, name, types) {
    // Save-as dialog where the browser has one (Chrome, Edge), else a
    // download; returns the file name, or null when cancelled or failed.
    // Embedded browsers (Electron apps) open the dialog but write an empty
    // file, so they get a plain download only.
    const embedded = /Electron|Claude\//.test(navigator.userAgent);
    if (window.showSaveFilePicker && !embedded) {
        let h;
        try {
            h = await window.showSaveFilePicker({ suggestedName: name, types });
        } catch (e) {
            if (e && e.name === 'AbortError') return null;   // cancelled
            h = null;                                        // no dialog: download below
        }
        if (h) {
            try {
                const w = await h.createWritable();
                await w.write(blob);
                await w.close();
                return h.name;
            } catch (e) {                           // e.g. the file is open in another program
                setStatus(`Save: cannot write ${h.name} (${errMsg(e)})`, true);
                return null;
            }
        }
    }
    try {
        download(blob, name);
    } catch (e) {
        setStatus('Save: ' + errMsg(e), true);
        return null;
    }
    return name;
}

function download(blob, name) {
    // download through a temporary link to an object URL, released afterwards
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);   // after the browser has taken the file
}

function setStatus(text, err) {
    // status line; err = error (red)
    const s = $('status');
    s.textContent = text;
    s.title = text;
    s.classList.toggle('err', !!err);
}


// %% ==========================================================================
//  LOCAL FUNCTIONS (no shared variables)
//  ===========================================================================

// ---------------------------------------------------------------------------
// Reading numbers from the input fields (numbers only, no eval)
// ---------------------------------------------------------------------------
function num(text) {
    // one number from a field's text; NaN if it is not one number
    const v = vec(text);
    return v.length === 1 ? v[0] : NaN;
}

function vec(text) {
    // numbers from a field's text ("30 40 30"): space and ; separate, a comma
    // is a decimal point, a:b and a:s:b give a series; NaN for what is not a
    // number, for more than 200 characters or more than 1000 values
    const s = String(text).replace(/,/g, '.').replace(/\s*:\s*/g, ':');
    if (s.length > MAXIN) return [NaN];
    const t = s.trim().split(/[\s;]+/).filter(x => x !== '');
    const v = [];
    for (const tk of t) {
        const p = tk.split(':');
        if (p.length > 3 || !p.every(x => NUM1.test(x))) {
            if (p.length > 1) return [NaN];
            v.push(NaN);
            continue;
        }
        if (p.length === 1) {
            v.push(Number(p[0]));
            continue;
        }
        const q = p.map(Number), a = q[0], b = q[q.length - 1], st = q.length === 3 ? q[1] : 1;
        if (st === 0 || (b - a) / st >= 1000 || v.length > 1000) return [NaN];
        const n = Math.floor((b - a) / st + 1e-10) + 1;   // as MATLAB's colon (none if the direction is wrong)
        for (let i = 0; i < n; i++) v.push(round10(a + i * st));
    }
    return v.length > 1000 ? [NaN] : v;
}

function spanL(text) {
    // span lengths from the field L: L1:dL:Ltot = a first span L1, then spans
    // of dL up to the total length Ltot, returned in s rounded down to whole
    // spans (10:10:59 gives 10:10:50), else s empty; otherwise as vec; NaN if
    // not readable; at most 1000 spans
    const t = String(text).replace(/,/g, '.').trim().replace(/\s*:\s*/g, ':');
    if (!t.includes(':')) return { v: vec(text), s: '' };
    const bad = { v: [NaN], s: '' };
    const p = t.split(':');
    if (t.length > MAXIN || p.length !== 3 || !p.every(x => NUM1.test(x))) return bad;
    const q = p.map(Number);
    if (!(q[0] > 0 && q[1] > 0 && q[2] >= q[0])) return bad;
    const n = Math.floor((q[2] - q[0]) / q[1] + 1e-9);
    if (n + 1 > 1000) return bad;
    return { v: [q[0], ...new Array(n).fill(q[1])], s: `${fmtG(q[0])}:${fmtG(q[1])}:${fmtG(round10(q[0] + n * q[1]))}` };
}

function dxRule(L) {
    // default load step (m), as defaultDx in TBI_fem.m: 1, for a total length
    // > 200 m the shortest span / 15 within 1 to 5
    if (L.length && L.every(x => x > 0) && sum(L) > 200) {
        return Math.min(5, Math.max(1, roundHalf(Math.min(...L) / 15 * 100) / 100));
    }
    return 1;
}

const sum = a => a.reduce((s, x) => s + x, 0);
const flat = a => (Array.isArray(a) ? a.flat(Infinity) : [a]);
const round10 = x => Number(x.toFixed(10));
const hasDec = t => typeof t.dec === 'number' && isFinite(t.dec);

function roundHalf(x) {
    // MATLAB's round: halves away from zero
    return Math.sign(x) * Math.round(Math.abs(x));
}

function rnd(v, d) {
    // v rounded to d decimals (MATLAB round(v, d)); null for NaN (empty cell)
    if (typeof v !== 'number' || !isFinite(v)) return null;
    const p = Math.pow(10, d);
    return roundHalf(v * p) / p;
}


// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------
function numfmt(x) {
    // short text of a number: 1e4 instead of 10000 (powers of ten from 1e4)
    if (x !== 0 && (Math.abs(x) >= 1e4 || Math.abs(x) < 1e-3)) {
        const e = Math.floor(Math.log10(Math.abs(x)));
        return fmtG(Number((x / Math.pow(10, e)).toFixed(6))) + 'e' + e;
    }
    return fmtG(x);
}

function fmtG(x) {
    // about sprintf('%g', x): six significant digits, no trailing zeros
    return String(Number(Number(x).toPrecision(6)));
}

function sgn0(v) {
    // sprintf('%+.0f', v) for a rounded value
    return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(0);
}

function fmtv(t, k) {
    // table value of season k as text: two rows = "min / max" (or left / right);
    // val is [row][k]
    let f;
    if (hasDec(t)) f = v => v.toFixed(t.dec);       // own decimals (deflection: whole mm)
    else if (t.unit === 'kN') f = v => v.toFixed(0);
    else if (t.unit === 'MPa') f = v => (v >= 0 ? '+' : '') + v.toFixed(1);
    else f = v => v.toFixed(1);
    return t.val.map(r => (typeof r[k] === 'number' && isFinite(r[k]) ? f(r[k]) : '–')).join(' / ');
}

function limText(s) {
    // limit of out.Table as plain text: no $, -- as en dash
    return String(s).replace(/\$/g, '').replace(/--/g, '–');
}

function plainName(s) {
    // LaTeX label as plain text (Excel, and the table names when
    // TBI.tex2html is missing)
    const rep = [[/\\mathrm\{([^}]*)\}/g, '$1'], [/\\delta_(\w+)/g, 'δ$1'], [/\\delta/g, 'δ'], [/\\Delta/g, 'Δ'],
                 [/\\sigma/g, 'σ'], [/\\alpha/g, 'α'], [/\^\\circ/g, '°'], [/\$\^2\$/g, '²'], [/\$\^4\$/g, '⁴'],
                 [/\\,/g, ' '], [/\$/g, ''], [/_\{?(\w+)\}?/g, '$1']];
    for (const [re, to] of rep) s = String(s).replace(re, to);
    return s;
}

function texInto(el, name) {
    // a row name of out.Table (LaTeX subset) into el, as DOM nodes (no innerHTML)
    el.textContent = '';
    if (typeof TBI.tex2nodes === 'function') el.appendChild(TBI.tex2nodes(name));
    else el.textContent = plainName(name);
}

function errMsg(e) {
    return e && e.message ? e.message : String(e);
}


// %% START ====================================================================
buildInputs();
buildResults();
initTabs('itabs', p => { if (p === 'inLoad') drawLoads(); });
initTabs('rtabs', onShowResultTab);
btn.run.addEventListener('click', onRun);
btn.reset.addEventListener('click', onReset);
btn.load.addEventListener('click', onLoad);
btn.save.addEventListener('click', onSave);
btn.report.addEventListener('click', onReport);
btn.export.addEventListener('click', onExport);
btn.print.addEventListener('click', onPrint);
btn.printB.forEach((b, kb) => b.addEventListener('click', () => onPrintBridge(kb)));
$('fileIn').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFile(f);
});
for (const d of SAVED) setv(d.key, d.val);
emptyTables();
onChange('');                                       // computed fields, input check, model sketch
if (!$('status').textContent) setStatus('Bryngeån (default input)');   // unless the model reported an error
TBI.gui = { run: onRun, reset: onReset, results: () => out, input: fieldsObject,
            sheets: () => (out ? exportSheets(out) : null) };

})();

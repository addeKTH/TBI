/* tbi_fem.js -----------------------------------------------------------------
   TBI-analysis according to EN 1991-2:2024, 8.5.4: FE model and analysis.
   JavaScript port of TBI_fem.m (MATLAB), same sections and function names.
   Andreas Andersson, 2026-11-13 (assisted by Claude)
   -----------------------------------------------------------------------------
   USAGE (global object TBI, see README.md for the output structure):
     const {inp, opt} = TBI.readJson(obj)     fields of the GUI / TBI_input.json
     const out0 = TBI.model(inp)              input with defaults and the model geometry
     const out = await TBI.analysis(inp, opt) all load cases, envelopes and the table
     TBI.stop()                               ends a running analysis
   opt.nlgeom   = geometrically nonlinear beams (von Karman strain) (false)
   opt.nInc     = load increments per step, integer >= 1 (1)
   opt.progress = function called with the share done 0...1
   opt.workers  = number of Web Workers (default: processor cores - 1, at most 16;
                  0 = all load cases on the main thread)

   MODEL (as TBI_fem.m): 2D FE model, rail(s) and deck as beams with rigid
   offsets, track springs at every sleeper (unloaded / loaded resistance,
   vertical) and horizontal bearing and end-screen springs. Step 1 temperature
   on unloaded track, step 2 traffic, braking and traction on loaded track.
   Full Newton-Raphson with consistent tangent and backtracking line search,
   bisection of the increment. The tangent is a symmetric band matrix on the
   free degrees of freedom, numbered with the nodes sorted by x (as MATLAB).

   Arrays: MATLAB columns summer / winter are the first index [k] here
   (k = 0 summer, 1 winter); node, element and spring numbers are 0-based.
---------------------------------------------------------------------------*/
(function (root) {
'use strict';

const TBI = root.TBI = root.TBI || {};


/* ===========================================================================
   0 SMALL HELPERS
   ======================================================================== */
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const isNum = v => typeof v === 'number';
const nanArr = n => new Float64Array(n).fill(NaN);
const seasons = f => [f(0), f(1)];                               // [summer, winter]
const g6 = v => String(Number(Number(v).toPrecision(6)));         // like MATLAB %g for input values
const sgn0 = v => (v >= 0 ? '+' : '-') + Math.round(Math.abs(v)); // like MATLAB %+.0f

function setdef(S, defs) {
    // set the fields that are missing (as setdef in TBI_fem.m)
    const o = Object.assign({}, S);
    for (const k of Object.keys(defs)) if (!has(o, k)) o[k] = defs[k];
    return o;
}

function roundTo(v, d) {
    // MATLAB round(v, d): half away from zero
    const p = Math.pow(10, d);
    return Math.sign(v) * Math.round(Math.abs(v) * p) / p;
}

function nanMin(a, b) { return isNaN(a) ? b : (isNaN(b) ? a : Math.min(a, b)); }
function nanMax(a, b) { return isNaN(a) ? b : (isNaN(b) ? a : Math.max(a, b)); }

function norm(v, idx) {
    // Euclidean norm of v, or of v[idx[i]]
    let s = 0;
    if (idx) for (let i = 0; i < idx.length; i++) s += v[idx[i]] * v[idx[i]];
    else for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
}

function inputError(msg) { const e = new Error(msg); e.id = 'TBI_fem:input'; return e; }


/* ===========================================================================
   1 INPUT
   ======================================================================== */
function setDefaults(inp0) {
    // complete the input with default values and check it (deep copy, the
    // input itself is not changed)
    const inp = JSON.parse(JSON.stringify(inp0 || {}));
    if (!has(inp, 'Bridge')) throw inputError('inp.Bridge is missing.');
    const miss = ['L', 'E', 'A', 'I', 'e_b', 'h'].filter(f => !has(inp.Bridge, f));
    if (miss.length) throw inputError('Required input missing: inp.Bridge.' + miss.join(', inp.Bridge.'));
    for (const f of ['Track', 'Load', 'Limits', 'Info']) if (!has(inp, f)) inp[f] = {};

    let B = inp.Bridge;
    B.L = [].concat(B.L);
    const nsup = B.L.length + 1;
    if (has(B, 'Kh') && !has(B, 'FL')) {                         // FL = last support with longitudinal stiffness
        const Kc = [].concat(B.Kh);
        for (let i = Kc.length - 1; i >= 0; i--) if (!(isNum(Kc[i]) && Kc[i] === 0)) { B.FL = i + 1; break; }
    }
    const steel = Math.abs(B.E / 210e9 - 1) < 0.15;
    B = setdef(B, { type: steel ? 'steel' : 'concrete', alfa: steel ? 12e-6 : 10e-6, L_end: 0, n_track: 1,
                    FL: nsup, dT: [35, -35], endsprings: [], nDeck: 6 });
    if (!has(B, 'Kh')) { B.Kh = new Array(nsup).fill(0); B.Kh[B.FL - 1] = 1e10; }
    B.Kh = [].concat(B.Kh);
    B.endsprings = [].concat(B.endsprings || []);                // one end screen may come as an object
    inp.Bridge = B;

    let T = setdef(inp.Track, { type: 'ballasted' });
    const bl = ['ballastless', 'nonballasted', 'non-ballasted'].includes(String(T.type).toLowerCase());
    T.type = bl ? 'ballastless' : 'ballasted';
    T = setdef(T, { A: 2 * 76.70e-4, I: 2 * 3038.3e-8, E: 210e9, alfa: 12e-6, s_r: 0.65, Le: 100,
                    Fl: 60e3, Kv: 80e6, Kv_up: 4e6, gap: [], loaded: 'additive', dT_brk: -50 });
    if (bl) T = setdef(T, { e_r: 0.25, u0: [0.5e-3, 0.5e-3], Fu: [40e3, 40e3] });   // EN 1991-2:2024 Table 8.9
    else    T = setdef(T, { e_r: 0.75, u0: [2e-3, 0.5e-3], Fu: [20e3, 30e3] });
    T.gap = [].concat(T.gap == null ? [] : T.gap);
    T = setdef(T, { dT: T.gap.length ? [50, -50] : [0, 0] });
    inp.Track = T;

    if (has(inp.Load, 'dxPos') && [].concat(inp.Load.dxPos).length === 0) inp.Load.dxPos = 0;   // [] = fixed positions
    inp.Load = setdef(inp.Load, { alfa: 1.33, LM71: true, SW: B.L.length > 1, dxPos: defaultDx(B.L),
                                  qlbk: 20e3, Qlbk_max: 6000e3, qlak: 33e3, Qlak_max: 1000e3 });
    for (const f of ['LM71', 'SW']) {                             // true/false also when given as 1/0
        const v = inp.Load[f];
        if (!(typeof v === 'boolean' || isNum(v))) throw inputError('Load.' + f + ' must be true or false.');
        inp.Load[f] = Boolean(v);
    }
    const sl = bl ? [-112, 112] : [-72, 112];
    inp.Limits = setdef(inp.Limits, { sig_br: sl, sig_emb: sl, dB: 5, dH: 8, dV: 2, wL: 600, wgap: 50 });
    inp.Info = setdef(inp.Info, { name: 'Bridge', author: '' });
    checkInput(inp, nsup);
    return inp;
}

function defaultDx(L) {
    // default load step (m): 1, for a total length > 200 m the shortest span / 15
    // within 1...5
    const s = L.reduce((a, b) => a + b, 0);
    if (L.length && L.every(v => v > 0) && s > 200) return Math.min(5, Math.max(1, roundTo(Math.min(...L) / 15, 2)));
    return 1;
}

function checkInput(inp, nsup) {
    // all input problems in one error message
    const B = inp.Bridge, T = inp.Track, Ld = inp.Load, m = [];
    const arr = v => [].concat(v);
    const pos = v => arr(v).length > 0 && arr(v).every(x => isNum(x) && isFinite(x) && x > 0);
    const nneg = v => arr(v).length > 0 && arr(v).every(x => isNum(x) && isFinite(x) && x >= 0);
    if (!pos(B.L)) m.push('spans L must be > 0');
    for (const f of ['E', 'A', 'I', 'h']) if (!pos(B[f])) m.push('Bridge.' + f + ' must be > 0');
    if (!nneg(B.e_b)) m.push('e_b must be >= 0');
    if (!nneg(B.L_end)) m.push('L_end must be >= 0');
    if (![1, 2].includes(B.n_track)) m.push('n_track must be 1 or 2');
    if (!(isNum(B.nDeck) && B.nDeck >= 1 && B.nDeck === Math.round(B.nDeck))) m.push('nDeck must be an integer >= 1');
    if (arr(B.dT).length !== 2 || !arr(B.dT).every(isFinite)) m.push('deck temperature change dT needs two finite values (summer, winter)');
    if (B.Kh.length !== nsup) m.push('K_h needs ' + nsup + ' values (one per support), ' + B.Kh.length + ' given');
    else if (B.Kh.some(k => isNum(k) && !nneg(k))) m.push('K_h must be >= 0');
    for (const f of ['s_r', 'A', 'I', 'E', 'Kv', 'Kv_up']) if (!pos(T[f])) m.push('Track.' + f + ' must be > 0');
    if (!pos(T.u0) || !pos(T.Fu) || !pos(T.Fl)) m.push('track resistance u0, F_u and F_l must be > 0');
    if (arr(T.u0).length !== 2 || arr(T.Fu).length !== 2) m.push('u0 and F_u need two values (summer, winter)');
    if (arr(T.Fu).some(v => T.Fl < v)) m.push('loaded track resistance F_l must be >= F_u');
    if (arr(T.dT).length !== 2) m.push('rail temperature change dT needs two values (summer, winter)');
    if (arr(inp.Limits.sig_br).length !== 2 || arr(inp.Limits.sig_emb).length !== 2)
        m.push('rail stress limits need two values (compression, tension)');
    if (pos(T.s_r) && !(nneg(T.Le) && T.Le >= 5 * T.s_r))
        m.push('L_e must be at least 5 s_r (' + (5 * T.s_r).toFixed(1) + ' m); 100 m is recommended');
    if (!nneg(T.e_r)) m.push('e_r must be >= 0');
    if (!arr(T.dT).concat([T.dT_brk]).every(v => isNum(v) && isFinite(v))) m.push('rail temperature changes must be finite');
    if (!pos(Ld.alfa)) m.push('alpha must be > 0');
    for (const f of ['qlbk', 'Qlbk_max', 'qlak', 'Qlak_max', 'dxPos'])
        if (!nneg(Ld[f])) m.push('Load.' + f + ' must be >= 0');
    if (m.length) { const s = m.join('; '); throw inputError(s[0].toUpperCase() + s.slice(1) + '.'); }
}

function readJson(S) {
    // input fields of TBI_input.json / the GUI (text as in the input boxes,
    // engineering units) to inp (SI units); missing fields get the defaults of
    // setDefaults; opt = options of the GUI in the file (nlgeom, nInc)
    if (S === null || typeof S !== 'object' || Array.isArray(S)) throw new Error('The input file holds no input fields.');
    const h = k => has(S, k);
    const inp = { Bridge: {}, Track: {}, Load: {}, Limits: {} };
    const B = inp.Bridge, T = inp.Track, Ld = inp.Load, Lim = inp.Limits;
    // bridge
    B.L = spans(S.L);
    B.E = one(S.E) * 1e9;
    B.A = one(S.A);
    B.I = one(S.I);
    B.e_b = one(S.eb);
    B.h = one(S.h);
    if (h('Lend')) B.L_end = one(S.Lend);
    if (h('ntrack')) B.n_track = one(S.ntrack);
    if (h('Kh')) {
        B.Kh = nums(S.Kh).map(v => v * 1e9);
        const i = B.Kh.map(v => v > 0).lastIndexOf(true);
        if (i >= 0) B.FL = i + 1;
    }
    if (h('dtype')) B.type = String(S.dtype).replace(/^\d\s+/, '');
    // temperatures: from the air temperatures (EN 1991-1-5 Figure 6.1, deck
    // type 1 steel, 2 composite, 3 concrete) or the deck temperature change as typed
    if (h('T0')) B.T0 = one(S.T0);
    if ((!h('Tmode') || S.Tmode === 'EN 1991-1-5') && ['dtype', 'Tmax', 'Tmin', 'T0'].every(h)) {
        const it = ['1 steel', '2 composite', '3 concrete'].indexOf(S.dtype);
        if (it < 0) throw new Error('Unknown deck type "' + S.dtype + '" in the input file.');
        const dTe = [[16, 4, 2], [-3, 4, 8]];                       // T_e - T, max and min, per deck type (K)
        B.dT = [Math.round(one(S.Tmax) + dTe[0][it] - one(S.T0)), Math.round(one(S.Tmin) + dTe[1][it] - one(S.T0))];
    } else if (h('dTN')) {
        B.dT = nums(S.dTN);
    }
    if (h('TRmin') && h('T0')) T.dT_brk = Math.round(one(S.TRmin) - one(S.T0));
    // track
    if (h('ttype')) T.type = String(S.ttype);
    if (h('Ar')) T.A = 2 * one(S.Ar) * 1e-4;
    if (h('Ir')) T.I = 2 * one(S.Ir) * 1e-8;
    if (h('er')) T.e_r = one(S.er);
    if (h('sr')) T.s_r = one(S.sr);
    if (h('Le')) T.Le = one(S.Le);
    if (h('u0')) T.u0 = nums(S.u0).map(v => v * 1e-3);
    if (h('Fu')) T.Fu = nums(S.Fu).map(v => v * 1e3);
    if (h('Fl')) T.Fl = one(S.Fl) * 1e3;
    if (h('Kv')) {
        const kv = nums(S.Kv);
        if (!kv.length) throw new Error('Kv (vertical rail support stiffness) is empty in the input file.');
        T.Kv = kv[0] * 1e6;  T.Kv_up = kv[kv.length - 1] * 1e6;
    }
    if (h('gap')) T.gap = nums(S.gap);
    if (h('dTR') && nums(S.dTR).length) T.dT = nums(S.dTR);
    // loads
    if (h('alfa')) Ld.alfa = one(S.alfa);
    if (h('LM71')) Ld.LM71 = Boolean(S.LM71);
    if (h('SW')) Ld.SW = Boolean(S.SW);
    if (h('dxPos')) { const dx = nums(S.dxPos); Ld.dxPos = dx.length ? one(S.dxPos) : 0; }   // empty box = 0
    if (h('qlbk')) Ld.qlbk = one(S.qlbk) * 1e3;
    if (h('Qlbk')) Ld.Qlbk_max = one(S.Qlbk) * 1e3;
    if (h('qlak')) Ld.qlak = one(S.qlak) * 1e3;
    if (h('Qlak')) Ld.Qlak_max = one(S.Qlak) * 1e3;
    // limits
    if (h('sigbr')) Lim.sig_br = nums(S.sigbr);
    if (h('sigemb')) Lim.sig_emb = nums(S.sigemb);
    for (const k of ['dB', 'dH', 'dV', 'wL', 'wgap']) if (h(k)) Lim[k] = one(S[k]);
    // options
    const opt = {};
    if (h('nlgeom') && (typeof S.nlgeom === 'boolean' || isNum(S.nlgeom))) opt.nlgeom = Boolean(S.nlgeom);
    if (h('nInc')) { const n = nums(S.nInc); if (n.length) opt.nInc = n[0]; }   // corrected by fixInc if invalid
    return { inp, opt };
}

function nums(t) {
    // numbers of an input box: space or ; separate, comma = decimal point,
    // a:s:b a series (no eval)
    if (isNum(t) || typeof t === 'boolean') return [Number(t)];
    if (Array.isArray(t)) return t.map(Number);
    const s = String(t == null ? '' : t).replace(/,/g, '.').replace(/\s*:\s*/g, ':').trim();
    const v = [];
    if (!s) return v;
    for (const p of s.split(/[\s;]+/)) {
        const q = p.split(':').map(x => (x.trim() === '' ? NaN : Number(x)));
        if (q.some(isNaN) || q.length > 3) throw new Error('Not a number in the input file: "' + t + '".');
        if (q.length === 1) { v.push(q[0]); continue; }
        const st = q.length === 3 ? q[1] : 1, last = q[q.length - 1];
        if (!(st > 0)) throw new Error('Not a valid series in the input file: "' + t + '".');
        for (let x = q[0], i = 0; x <= last + 1e-9 * Math.abs(st) && i < 100000; i++, x = q[0] + i * st) v.push(roundTo(x, 10));
    }
    return v;
}

function one(t) {
    // one number of an input box
    const v = nums(t);
    if (v.length !== 1) throw new Error('One number expected in the input file, got "' + t + '".');
    return v[0];
}

function spans(t) {
    // span lengths; L1:dL:Ltot = first span L1, then spans dL up to Ltot
    if (isNum(t) || Array.isArray(t)) return nums(t);
    const s = String(t == null ? '' : t).replace(/,/g, '.').trim().replace(/\s*:\s*/g, ':');
    if (!s.includes(':')) return nums(t);
    const q = s.split(':').map(Number);
    if (q.length !== 3 || q.some(isNaN) || !(q[0] > 0 && q[1] > 0 && q[2] >= q[0]))
        throw new Error('Spans L1:dL:Ltot expected, got "' + s + '".');
    if ((q[2] - q[0]) / q[1] > 1000) throw new Error('More than 1000 spans in "' + s + '".');
    return [q[0]].concat(new Array(Math.floor((q[2] - q[0]) / q[1] + 1e-9)).fill(q[1]));
}

function fixInc(n) {
    // number of load increments per step: an integer >= 1; other values are
    // corrected (not a finite number: 1, below 1: 1, non-integer: rounded)
    const v = Number(n);
    const m = isFinite(v) ? Math.max(1, Math.round(v)) : 1;
    if (m !== n) console.warn('TBI_fem: opt.nInc must be an integer >= 1; ' + m + ' is used.');
    return m;
}


/* ===========================================================================
   2 MODEL
   ======================================================================== */
function buildModel(inp, nlgeom) {
    // geometry, nodes, elements, springs and the band structure of the tangent
    // matrix; x from support 1 throughout
    const B = inp.Bridge, T = inp.Track, nt = B.n_track;

    // geometry: rail elements s_r/2, deck elements s_r/nDeck; L_end rounded to
    // a deck element, bridge and embankments to whole sleeper spacings (a rail
    // seat at each deck end), spans scaled to fit
    const s_r = T.s_r, dL = s_r / 2, dLd = s_r / B.nDeck;
    const sum = a => a.reduce((x, y) => x + y, 0);
    const Ls = dLd * Math.round(B.L_end / dLd);
    const Le = s_r * Math.round(T.Le / s_r);
    let L, Lb;
    if (B.nDeck === 2) {                                         // spans rounded, the first takes the rest
        L = B.L.map(v => dLd * Math.round(v / dLd));
        Lb = s_r * Math.round((sum(L) + 2 * Ls) / s_r);
        L[0] -= sum(L) + 2 * Ls - Lb;
    } else {
        Lb = s_r * Math.round((sum(B.L) + 2 * Ls) / s_r);
        let c = 0;
        const cs = B.L.map(v => { c += v; return dLd * Math.round(c * (Lb - 2 * Ls) / sum(B.L) / dLd); });
        cs[cs.length - 1] = Lb - 2 * Ls;
        L = cs.map((v, i) => v - (i ? cs[i - 1] : 0));
    }
    const xsup = [0];  for (const v of L) xsup.push(xsup[xsup.length - 1] + v);   // bearings
    const xB = [-Ls, Lb - Ls];                                   // deck ends
    const x0r = -Ls - Le;                                        // left rail end
    const h = Math.max(2e-3, B.h), e_b = Math.max(1e-3, B.e_b);
    const e_r = T.e_r, e_r2 = h - e_r - e_b;                     // deck neutral axis to the slip centre
    if (e_r2 < 0) throw inputError('h - e_r - e_b = ' + e_r2.toFixed(3) + ' m < 0: the track slip centre lies below the deck neutral axis.');
    const xg = T.gap;
    const bad = xg.filter(x => x <= x0r + 2 * s_r || x >= Lb - Ls + Le - 2 * s_r);
    if (bad.length) throw inputError('Rail expansion joint at x = ' + bad.join(', ') + ' m outside the track model (' +
        (x0r + 2 * s_r).toFixed(1) + ' ... ' + (Lb - Ls + Le - 2 * s_r).toFixed(1) + ' m).');

    // nodes: rails (per track), then the deck
    const nr = Math.round((2 * Le + Lb) / dL) + 1, nd = Math.round(Lb / dLd) + 1;
    const nn = nt * nr + nd, ndof = 3 * nn;
    const xr = Float64Array.from({ length: nr }, (_, i) => x0r + i * dL);
    const xd = Float64Array.from({ length: nd }, (_, i) => -Ls + i * dLd);
    const rnode = (k, x) => k * nr + Math.round((x - x0r) / dL);
    const dnode = x => nt * nr + Math.round((x + Ls) / dLd);

    // elements: rails (track 1, 2) and deck; element e connects node n1[e] and n1[e]+1
    const ner = nr - 1, ned = nd - 1, ne = nt * ner + ned;
    const E = { ne, n1: new Int32Array(ne), grp: new Uint8Array(ne), isR: new Uint8Array(ne), alive: new Uint8Array(ne).fill(1),
                EA: new Float64Array(ne), EI: new Float64Array(ne), alfa: new Float64Array(ne),
                len: [dL, dLd], Gm: [geomMatrix(dL), geomMatrix(dLd)], Kb: [bendMatrix(dL), bendMatrix(dLd)] };
    for (let e = 0; e < ne; e++) {
        const rail = e < nt * ner;
        E.n1[e] = rail ? Math.floor(e / ner) * nr + (e % ner) : nt * nr + (e - nt * ner);
        E.grp[e] = rail ? 0 : 1;  E.isR[e] = rail ? 1 : 0;
        E.EA[e] = rail ? T.E * T.A : B.E * B.A;
        E.EI[e] = rail ? T.E * T.I : B.E * B.I;
        E.alfa[e] = rail ? T.alfa : B.alfa;
    }
    const gapEl = xg.map(x => Math.round((x - x0r) / dL));        // rail expansion joint: element removed
    for (let k = 0; k < nt; k++) for (const g of gapEl) { E.alive[k * ner + g] = 0; E.EA[k * ner + g] = 0; E.EI[k * ner + g] = 0; }

    // springs: per track and sleeper set 1 (unloaded), set 2 (loaded) and the
    // vertical spring; bearings; end screens. Relative displacement = sum of
    // coef * U(dof); law index, scale (per m of track: s_r), kind (1 set 1,
    // 2 set 2, 3 vertical, 4 bearing, 5 end screen), track, sleeper / support
    const nsl = Math.round((2 * Le + Lb) / s_r);
    const xs = Float64Array.from({ length: nsl + 1 }, (_, i) => x0r + i * s_r);   // sleepers
    const onBrS = Array.from(xs, x => x >= xB[0] - 1e-9 && x <= xB[1] + 1e-9);
    const Sp = [];
    const add = (d, c, law, scl, kind, trk, p, partner) => Sp.push({ d, c, law, scl, kind, trk, p, partner });
    for (let k = 0; k < nt; k++) {
        for (let p = 0; p <= nsl; p++) {
            const r = rnode(k, xs[p]);
            let hd = [3 * r, 3 * r + 2], hc = [1, e_r];          // rail slip point u + e_r*theta
            let vd = [3 * r + 1], vc = [1];
            if (onBrS[p]) {                                      // minus the deck slip point
                const q = dnode(xs[p]);
                hd = hd.concat([3 * q, 3 * q + 2]);  hc = hc.concat([-1, e_r2]);
                vd = vd.concat([3 * q + 1]);  vc = vc.concat([-1]);
            }
            add(hd, hc, onBrS[p] ? 1 : 0, s_r, 1, k, p, -1);
            add(hd, hc, onBrS[p] ? 3 : 2, s_r, 2, k, p, Sp.length - 1);
            add(vd, vc, 4, 1, 3, k, p, -1);
        }
    }
    const fixed = [];
    let nLaw = 5;
    xsup.forEach((x, i) => {                                     // bearings: u at bearing level
        const q = dnode(x);  fixed.push(3 * q + 1);
        add([3 * q, 3 * q + 2], [1, e_b], nLaw++, 1, 4, -1, i, -1);
    });
    B.endsprings.forEach((Es, j) => {                            // end screens, + towards the soil
        const left = String(Es.side).toLowerCase() === 'left';
        const q = dnode(left ? xB[0] : xB[1]), sg = left ? -1 : 1;
        add([3 * q, 3 * q + 2], [sg, -sg * (Es.z - e_b)], nLaw++, 1, 5, -1, j, -1);
    });
    for (let k = 0; k < nt; k++) for (const n of [rnode(k, xr[0]), rnode(k, xr[nr - 1])]) fixed.push(3 * n, 3 * n + 1, 3 * n + 2);

    // spring laws per season (0 summer, 1 winter), same order in both
    const law = [0, 1].map(k => {
        const lw = new Array(nLaw);
        const def1 = ['bilinear', T.u0[k], T.Fu[k]];
        lw[0] = pickLaw(T, 'law1', def1);
        lw[2] = pickLaw(T, 'law2', set2Law(T, 'law1', def1, k));
        lw[1] = pickLaw(T, 'lawBr1', lw[0]);
        lw[3] = pickLaw(T, 'lawBr2', has(T, 'lawBr1') ? set2Law(T, 'lawBr1', null, k) : lw[2]);
        lw[4] = pickLaw(T, 'lawV', ['curve', [[-1, -T.Kv], [0, 0], [1, T.Kv_up]], 'elastic']);
        B.Kh.forEach((x, i) => { lw[5 + i] = springLaw(x); });
        B.endsprings.forEach((Es, j) => { lw[5 + B.Kh.length + j] = springLaw(Es.law); });
        return lw;
    });
    const shifted = String(T.loaded).toLowerCase() === 'shifted';
    if (shifted && ['law1', 'law2', 'lawBr1', 'lawBr2'].some(f => has(T, f)))
        console.warn("TBI_fem: Track.loaded = 'shifted' uses u0, F_u and F_l of Table 8.9 for the loaded track; " +
                     'the given track laws apply to the unloaded track only.');

    // springs as flat arrays (at most 4 DOFs each)
    const ns = Sp.length;
    const S = { ns, nd: new Uint8Array(ns), dof: new Int32Array(4 * ns), coef: new Float64Array(4 * ns),
                law: new Int32Array(ns), scl: new Float64Array(ns), kind: new Uint8Array(ns), trk: new Int32Array(ns),
                p: new Int32Array(ns), partner: new Int32Array(ns), shifted };
    Sp.forEach((s, i) => {
        S.nd[i] = s.d.length;
        s.d.forEach((d, a) => { S.dof[4 * i + a] = d; S.coef[4 * i + a] = s.c[a]; });
        S.law[i] = s.law;  S.scl[i] = s.scl;  S.kind[i] = s.kind;  S.trk[i] = s.trk;  S.p[i] = s.p;  S.partner[i] = s.partner;
    });
    const kreg = law.map(lw => Float64Array.from(S.law, (g, i) => 1e-6 * Math.abs(lw[g].k0) * S.scl[i]));   // tangent regularisation

    // band structure: free DOFs numbered with the nodes sorted by x (ties by node number)
    const free = new Uint8Array(ndof).fill(1);
    for (const d of fixed) free[d] = 0;
    const xn = new Float64Array(nn);
    for (let k = 0; k < nt; k++) for (let i = 0; i < nr; i++) xn[k * nr + i] = xr[i];
    for (let i = 0; i < nd; i++) xn[nt * nr + i] = xd[i];
    const order = Array.from({ length: nn }, (_, i) => i).sort((a, b) => xn[a] - xn[b] || a - b);
    const eq = new Int32Array(ndof).fill(-1), eqDof = [];
    for (const n of order) for (let c = 0; c < 3; c++) { const d = 3 * n + c; if (free[d]) { eq[d] = eqDof.length; eqDof.push(d); } }
    const nf = eqDof.length;
    let bw = 0;                                                  // half band width (equations)
    for (let e = 0; e < ne; e++) {
        let lo = Infinity, hi = -Infinity;
        for (let a = 0; a < 6; a++) { const q = eq[3 * E.n1[e] + a]; if (q >= 0) { lo = Math.min(lo, q); hi = Math.max(hi, q); } }
        if (hi > lo) bw = Math.max(bw, hi - lo);
    }
    for (let i = 0; i < ns; i++) {
        let lo = Infinity, hi = -Infinity;
        for (let a = 0; a < S.nd[i]; a++) { const q = eq[S.dof[4 * i + a]]; if (q >= 0) { lo = Math.min(lo, q); hi = Math.max(hi, q); } }
        if (hi > lo) bw = Math.max(bw, hi - lo);
    }

    // result points: rail seats (every second rail node), deck at the rail seats
    const seatR = [];  for (let i = 0; i < nr; i += 2) seatR.push(i);
    const seatD = [];  for (let i = 0; i < nd; i += B.nDeck) seatD.push(i);
    const mdl = { nt, nr, nd, ner, ned, ndof, nn, free, eq, eqDof: Int32Array.from(eqDof), nf, bw, E, S, law, kreg,
                  xRail: xr, xs, x0r, dL, dLd, s_r, Ls, Le, Lb, xB, xsup, e_r2, T, B, gapEl, nlgeom: Boolean(nlgeom), nInc: 1,
                  seatR, xSeat: seatR.map(i => xr[i]), seatD, xDeck: seatD.map(i => xd[i]) };
    mdl.onBr = mdl.xSeat.map(x => x > xB[0] - 1e-9 && x < xB[1] + 1e-9);
    mdl.out = { Lb, Ls, Le, L, xsup, s_r, dL, dLd, e_r2, x0: Ls };
    if (!mdl.nlgeom) mdl.lin = linStiff(mdl, E.EA, E.EI);            // linear beams: stiffness assembled once
    return mdl;
}

function geomMatrix(l) {
    // int(H'' H') dx of the cubic shape functions (membrane strain from w), 4 x 4 row-wise
    const a = 30 * l, l2 = l * l;
    return [36, 3 * l, -36, 3 * l, 3 * l, 4 * l2, -3 * l, -l2, -36, -3 * l, 36, -3 * l, 3 * l, -l2, -3 * l, 4 * l2].map(v => v / a);
}

function bendMatrix(l) {
    // bending stiffness per EI, 4 x 4 row-wise
    const l2 = l * l, l3 = l2 * l;
    return [12, 6 * l, -12, 6 * l, 6 * l, 4 * l2, -6 * l, 2 * l2, -12, -6 * l, 12, -6 * l, 6 * l, 2 * l2, -6 * l, 4 * l2].map(v => v / l3);
}

function set2Law(T, f1, def1, k) {
    // default set 2 (loaded track, added to set 1) for the set-1 law Track[f1]
    // (def1 if not given): for a bilinear law ['bilinear', u0, F] the increment
    // ['bilinear', u0, F_l - F], so that set 1 + set 2 reach F_l at u0; another
    // set-1 law: the Table 8.9 increment, with a warning
    const f2 = f1 === 'law1' ? 'law2' : 'lawBr2';
    const x = has(T, f1) ? T[f1] : def1;
    if (Array.isArray(x) && x.length === 3 && String(x[0]).toLowerCase() === 'bilinear')
        return T.Fl > x[2] ? ['bilinear', x[1], T.Fl - x[2]] : ['linear', 0];
    if (k === 0 && !has(T, f2))
        console.warn('TBI_fem: Track.' + f1 + ' is not a bilinear law: the loaded track (set 2) uses the increment of ' +
                     'Table 8.9 (F_l - F_u at u0); give Track.' + f2 + ' to define it.');
    return T.Fl > T.Fu[k] ? ['bilinear', T.u0[k], T.Fl - T.Fu[k]] : ['linear', 0];
}

function pickLaw(T, field, def) {
    // spring law from Track[field] if given, else from def
    return springLaw(has(T, field) ? T[field] : def);
}


/* ===========================================================================
   3 LOAD CASES
   ======================================================================== */
function loadArrangements(inp, mdl) {
    // positions of LM71 and SW/0, braking and traction cases
    const B = inp.Bridge, Ld = inp.Load, xB = mdl.xB, xsup = mdl.xsup, Lb = mdl.Lb;
    const LA = { alfa: Ld.alfa, xB, s_r: inp.Track.s_r, dTB: B.dT, dTR: inp.Track.dT,
                 aLoco: 6.4, qvk: 80e3, qLoco: 4 * 250e3 / 6.4 - 80e3,      // LM71 (m, N/m)
                 aSW: 15, cSW: 5.3, qSW: 133e3, qlbk: Ld.qlbk, qlak: Ld.qlak };   // SW/0
    const lSW = 2 * 15 + 5.3;
    const mov = [B.Kh[0], B.Kh[B.Kh.length - 1]].map(k => isNum(k) && k === 0);   // movable end bearings
    if (!mov[0] && mov[1]) { LA.xloco = [xsup[xsup.length - 1] - LA.aLoco]; LA.xSW = [xsup[xsup.length - 1] - lSW]; }
    else { LA.xloco = [xsup[0]]; LA.xSW = [xsup[0]]; }
    if (Ld.dxPos > 0) {                                          // moving loads: start of the load (m)
        LA.xloco = colon(xB[0], Ld.dxPos, Math.max(xB[0], xB[1] - LA.aLoco));
        if (xB[1] - LA.aLoco - LA.xloco[LA.xloco.length - 1] > 1e-6) LA.xloco.push(xB[1] - LA.aLoco);
        LA.xSW = colon(xB[0] - lSW, Ld.dxPos, xB[1]).filter(x => vertSeg(LA, 'SW/0', x).length > 0);
    }
    LA.Lbrk = Math.min(Lb, Ld.Qlbk_max / Ld.qlbk);              // loaded lengths (m)
    LA.Lacc = Math.min(Lb, Ld.Qlak_max / Ld.qlak);
    // horizontal cases: braking (track 1) and traction (track 2 if two tracks),
    // both directions; shorter than the bridge: from the left or to the right end
    const sideB = LA.Lbrk < Lb - 1e-6 ? ['L', 'R'] : ['L'];
    const sideA = LA.Lacc < Lb - 1e-6 ? ['L', 'R'] : ['L'];
    const dname = ['to the right', 'to the left'], dsg = [1, -1];
    const bname = { L: sideB.length === 1 ? '' : ' from the left end', R: ' to the right end' };
    const aname = { L: ' from the left end', R: ' from the right end' };
    const H = [];
    for (let d = 0; d < 2; d++) {
        for (const s of sideB) H.push({ name: 'braking ' + dname[d] + bname[s], fb: dsg[d], fa: 0, sb: s, sa: 'L' });
        for (const s of sideA) H.push({ name: 'traction ' + dname[d] + aname[s], fb: 0, fa: dsg[d], sb: 'L', sa: s });
        if (B.n_track === 2)                                     // simultaneous: braking track 1, traction track 2
            for (const sb of sideB) for (const s of sideA)
                H.push({ name: 'braking' + bname[sb] + ' and traction ' + dname[d] + ', traction' + aname[s],
                         fb: dsg[d], fa: dsg[d], sb, sa: s });
    }
    LA.H = H;
    return LA;
}

function colon(a, d, b) {
    // MATLAB a:d:b
    const v = [], n = Math.floor((b - a) / d + 1e-10);
    for (let i = 0; i <= n; i++) v.push(a + i * d);
    return v;
}

function vertSeg(LA, type, x) {
    // vertical load segments [start, end, q] (N/m incl. alfa) on the bridge for a
    // load starting at x
    const xB = LA.xB, cl = v => Math.min(Math.max(v, xB[0]), xB[1]);
    if (type === 'LM71')
        return [[xB[0], xB[1], LA.alfa * LA.qvk], [Math.max(xB[0], x), Math.min(xB[1], x + LA.aLoco), LA.alfa * LA.qLoco]];
    const parts = [[x, x + LA.aSW], [x + LA.aSW + LA.cSW, x + 2 * LA.aSW + LA.cSW]].map(p => p.map(cl));
    return parts.filter(p => p[1] - p[0] >= 2 * LA.s_r).map(p => [p[0], p[1], LA.alfa * LA.qSW]);   // parts < 2 s_r dropped
}

function horzCase(LA, hc, k, temp, vert, loaded, env) {
    // load case with braking and/or traction hc within env (default the
    // bridge); temp = 1 with the season's temperature, 0 without
    env = env || LA.xB;
    const c = newCase(k, temp * LA.dTB[k], temp * LA.dTR[k], temp, vert, loaded);
    const place = (sd, Lh) => (sd === 'L' ? [env[0], Math.min(env[1], env[0] + Lh)] : [Math.max(env[0], env[1] - Lh), env[1]]);
    if (hc.fb !== 0) c.brk = [place(hc.sb, LA.Lbrk).concat(LA.alfa * LA.qlbk * hc.fb)];
    if (hc.fa !== 0) c.acc = [place(hc.sa, LA.Lacc).concat(LA.alfa * LA.qlak * hc.fa)];
    return c;
}

function newCase(k, dTB, dTR, temp, vert, loaded) {
    // one load case of season k (0 summer, 1 winter): dTB, dTR = deck and rail
    // temperature change (K), temp = temperature included (1/0, for the
    // additional stress), vert = vertical load [[start, end, q]] (all tracks),
    // loaded = extent of loaded track [[start, end]]; added later: brk / acc =
    // braking (track 1) / traction (track 2 if two tracks) [[start, end, q]],
    // railBreak = x of a rail break in step 2, keepState = return the state after step 1
    return { k, dTB, dTR, temp, vert: vert || [], loaded: loaded || [], brk: [], acc: [], railBreak: null, keepState: false };
}


/* ===========================================================================
   4 SOLVER: one load case, steps 1 and 2
   ======================================================================== */
function solveCase(mdl, c, S1) {
    // solve one load case c (newCase); S1 = state after an identical step 1
    // (same season and temperatures) to start step 2 from, null = solve step 1
    const E = mdl.E, S = mdl.S, k = c.k, nt = mdl.nt, ner = mdl.ner, T = mdl.T, ne = E.ne, ns = S.ns;
    const P = { mdl, E, S, nlgeom: mdl.nlgeom, nInc: mdl.nInc, laws: mdl.law[k], kreg: mdl.kreg[k],
                EA: Float64Array.from(E.EA), EI: Float64Array.from(E.EI), eth: new Float64Array(ne),
                shiftPar: [T.u0[k], T.Fu[k], T.Fl], dref: new Float64Array(ns), FA: new Float64Array(ns),
                kill: new Uint8Array(ne), fK: null };
    for (let e = 0; e < ne; e++) P.eth[e] = E.alfa[e] * (E.isR[e] ? c.dTR : c.dTB);   // free thermal strain
    if (c.railBreak !== null && c.railBreak !== undefined) {     // rail break: element of track 1
        const e = Math.round((c.railBreak - mdl.x0r) / mdl.dL);
        if (e >= 0 && e < ner && E.alive[e]) P.kill[e] = 1;
    }
    const anyKill = P.kill.some(v => v);

    // traffic: equivalent nodal forces on the rail elements
    const fe = new Float64Array(6 * ne);
    for (let t = 0; t < nt; t++)
        for (const v of c.vert) lineLoad(fe, t * ner, ner, mdl.dL, v[0] - mdl.x0r, v[1] - mdl.x0r, v[2], 'z');
    for (const b of c.brk) lineLoad(fe, 0, ner, mdl.dL, b[0] - mdl.x0r, b[1] - mdl.x0r, b[2], 'x');
    const ta = Math.min(nt, 2) - 1;
    for (const a of c.acc) lineLoad(fe, ta * ner, ner, mdl.dL, a[0] - mdl.x0r, a[1] - mdl.x0r, a[2], 'x');
    const Ftr = new Float64Array(mdl.ndof);
    for (let e = 0; e < ne; e++) {
        if (!E.alive[e]) continue;
        const d0 = 3 * E.n1[e];
        for (let a = 0; a < 6; a++) Ftr[d0 + a] += fe[6 * e + a];
    }

    // springs active in step 1 (all but set 2) and step 2 (set 2 where loaded)
    const act = new Uint8Array(ns);
    for (const l of c.loaded) {
        const p1 = Math.ceil((l[0] - mdl.x0r) / mdl.s_r - 1e-9), p2 = Math.floor((l[1] - mdl.x0r) / mdl.s_r + 1e-9);
        for (let i = 0; i < ns; i++) if (S.p[i] >= p1 && S.p[i] <= p2) act[i] = 1;
    }
    const on1 = Uint8Array.from(S.kind, v => (v !== 2 ? 1 : 0));
    const on2 = Uint8Array.from(on1, (v, i) => (v || (S.kind[i] === 2 && act[i]) ? 1 : 0));

    // step 1: temperature (load path: temperature factor 0 -> 1)
    let st = { U: new Float64Array(mdl.ndof), dp: new Float64Array(ns), al: new Float64Array(ns) };
    if (S1) st = { U: Float64Array.from(S1.U), dp: Float64Array.from(S1.dp), al: Float64Array.from(S1.al) };
    else st = solveStep(P, st, on1, [0, 1], [0, 0], Ftr);
    const U1 = Float64Array.from(st.U);
    const B1 = beam(P, U1, 1, false, 1);
    const f1 = springs(P, U1, st.dp, st.al, on1).f;
    const r = { state: null };
    if (c.keepState) r.state = { U: U1, dp: Float64Array.from(st.dp), al: Float64Array.from(st.al) };

    // step 2: traffic, braking, traction, loaded track (set 2 born strain-free),
    // rail break (element removed, its force released over the step)
    for (let i = 0; i < ns; i++) {
        if (!(S.kind[i] === 2 && act[i])) continue;
        P.dref[i] = relDisp(S, i, U1);
        if (S.shifted) { const j = S.partner[i]; P.FA[i] = f1[j] / S.scl[j]; }
    }
    if (anyKill) {
        P.fK = new Float64Array(6 * ne);
        for (let e = 0; e < ne; e++) if (P.kill[e]) { for (let a = 0; a < 6; a++) P.fK[6 * e + a] = B1.fe[6 * e + a]; P.EA[e] = 0; P.EI[e] = 0; }
    }
    st = solveStep(P, st, on2, [1, 1], [0, 1], Ftr);
    const U2 = st.U;
    const B2 = beam(P, U2, 1, false, 1);
    const f2 = springs(P, U2, st.dp, st.al, on2).f;

    // results: rail stress (MPa, per node = element starting there), at the
    // seats, rail break gap, deck at the rail seats, bearing forces
    const N = [B1.N, B2.N];
    r.S = [];
    for (let t = 0; t < nt; t++) {
        const s = [0, 1].map(stp => {
            const v = new Float64Array(mdl.nr);
            for (let i = 0; i < ner; i++) {
                const e = t * ner + i;
                v[i] = (!E.alive[e] || (stp === 1 && P.kill[e])) ? NaN : N[stp][e] / T.A / 1e6;
            }
            v[mdl.nr - 1] = v[ner - 1];
            return v;
        });
        if (t === 0) r.Snode = s;
        r.S.push(s.map(v => atSeats(v)));
    }
    const ur = i => U2[3 * i];                                   // rail track 1, u, step 2
    r.wbrk = NaN;
    if (anyKill) {
        const ib = P.kill.indexOf(1);
        r.wbrk = 1e3 * (ur(ib + 1) - ur(ib) - mdl.dL * T.alfa * c.dTR);
    }
    r.gap = Float64Array.from(mdl.gapEl, g => 1e3 * (ur(g + 1) - ur(g)));
    const qn = mdl.seatD.map(i => nt * mdl.nr + i), ed0 = nt * ner, nb = qn.length;
    r.F = {};
    for (const f of ['u', 'w', 'th', 'N', 'M', 'V']) r.F[f] = [new Float64Array(nb), new Float64Array(nb)];
    [[U1, B1], [U2, B2]].forEach(([U, Bs], stp) => {
        mdl.seatD.forEach((j, i) => {
            const q = qn[i];
            r.F.u[stp][i] = 1e3 * (U[3 * q] - mdl.e_r2 * U[3 * q + 2]);   // at the track slip centre (mm)
            r.F.w[stp][i] = 1e3 * U[3 * q + 1];
            r.F.th[stp][i] = 1e3 * U[3 * q + 2];
            const last = j === mdl.ned, e = ed0 + (last ? mdl.ned - 1 : j);   // per node: element starting there
            r.F.N[stp][i] = Bs.N[e] / 1e6;
            r.F.V[stp][i] = (last ? -Bs.fe[6 * e + 4] : Bs.fe[6 * e + 1]) / 1e6;
            r.F.M[stp][i] = (last ? Bs.fe[6 * e + 5] : -Bs.fe[6 * e + 2]) / 1e6;
        });
    });
    r.Rh = [[], []];                                             // force from the support on the deck (kN)
    for (let i = 0; i < ns; i++) if (S.kind[i] === 4) { r.Rh[0].push(-f1[i] / 1e3); r.Rh[1].push(-f2[i] / 1e3); }
    return r;
}

function solveStep(P, st, on, tF, qF, Ftr) {
    // one step: temperature factor tF[0] -> tF[1], traffic factor qF[0] ->
    // qF[1]; Newton-Raphson per increment, bisection if it does not converge
    const mdl = P.mdl;
    let lam = 0, dlam = 1 / P.nInc, nbis = 0;                    // equal increments (opt.nInc)
    if (!P.nlgeom) P.lin = linBeam(P);                           // beams linear: assembled once per step
    const Fref = Math.max(norm(Ftr, mdl.eqDof) * qF[1], norm(beam(P, new Float64Array(mdl.ndof), tF[1], false, 1).fint),
                          P.fK ? norm(P.fK) : 0, 1);
    while (lam < 1 - 1e-12) {
        const dl = Math.min(dlam, 1 - lam), lt = lam + dl;
        const tf = tF[0] + lt * (tF[1] - tF[0]);
        const rel = P.kill.some(v => v) ? lt : 1;                 // release of a broken rail element
        const Fx = Float64Array.from(Ftr, v => (qF[0] + lt * (qF[1] - qF[0])) * v);
        const res = newton(P, st, Fx, tf, rel, on, Fref);
        if (res.ok) { st = res; lam = lt; }
        else {
            if (++nbis > 8) throw new Error('No convergence after 8 bisections (lambda = ' + lam.toFixed(4) + ').');
            dlam = dl / 2;
        }
    }
    return st;
}

function newton(P, st, Fx, tf, rel, on, Fref) {
    // full Newton-Raphson with consistent tangent and backtracking line search
    const mdl = P.mdl, nf = mdl.nf, eqDof = mdl.eqDof;
    let U = Float64Array.from(st.U);
    let sp = springs(P, U, st.dp, st.al, on);
    let R = residual(P, U, sp.f, Fx, tf, rel), rn = norm(R, eqDof);
    let ok = rn <= 1e-9 * Fref, it = 0;
    while (!ok && it < 60) {
        it++;
        const K = tangent(P, U, tf, rel, sp.kt, on);
        const b = Float64Array.from(eqDof, d => R[d]);
        if (!bandSolve(K, nf, mdl.bw, b)) return { ok: false };   // singular tangent: bisect
        let eta = 1, Ut, Rt, rt;
        for (let ls = 0; ls <= 8; ls++) {                        // halve the step while the residual grows
            Ut = Float64Array.from(U);
            for (let i = 0; i < nf; i++) Ut[eqDof[i]] += eta * b[i];
            sp = springs(P, Ut, st.dp, st.al, on);
            Rt = residual(P, Ut, sp.f, Fx, tf, rel);
            rt = norm(Rt, eqDof);
            if (rt <= rn || ls === 8) break;
            eta /= 2;
        }
        U = Ut;  R = Rt;  rn = rt;
        // converged: small residual, or a negligible update at the round-off
        // floor (stiff springs, short deck elements)
        const nd = eta * norm(b), nu = Math.max(norm(U), 1e-6);
        ok = rn <= 1e-9 * Fref || (nd <= 1e-10 * nu && rn <= 1e-6 * Fref) || (nd <= 1e-8 * nu && rn <= 1e-4 * Fref);
    }
    return ok ? { ok: true, U, dp: sp.dp, al: sp.al } : { ok: false };
}

function residual(P, U, f, Fx, tf, rel) {
    // out-of-balance force Fx - (beams + springs), all DOFs (only the free are used)
    const fint = P.lin ? beamForceLin(P, U, tf, rel) : beam(P, U, tf, false, rel).fint;
    const R = Float64Array.from(Fx);
    for (let d = 0; d < R.length; d++) R[d] -= fint[d];
    const S = P.S;
    for (let i = 0; i < S.ns; i++) {
        if (f[i] === 0) continue;
        for (let a = 0; a < S.nd[i]; a++) R[S.dof[4 * i + a]] -= S.coef[4 * i + a] * f[i];
    }
    return R;
}

function tangent(P, U, tf, rel, kt, on) {
    // tangent stiffness on the free DOFs as a symmetric band matrix (upper band,
    // row-wise: K[i*(bw+1) + (j-i)], j >= i): beams plus the spring entries
    const mdl = P.mdl, S = P.S, eq = mdl.eq, w = mdl.bw + 1;
    const K = P.lin ? Float64Array.from(P.lin.Kf) : beam(P, U, tf, true, rel).Kf;
    for (let i = 0; i < S.ns; i++) {
        const ks = kt[i] + P.kreg[i] * on[i];
        if (ks === 0) continue;
        for (let a = 0; a < S.nd[i]; a++) {
            const p = eq[S.dof[4 * i + a]];
            if (p < 0) continue;
            for (let b = 0; b < S.nd[i]; b++) {
                const q = eq[S.dof[4 * i + b]];
                if (q >= p) K[p * w + (q - p)] += ks * S.coef[4 * i + a] * S.coef[4 * i + b];
            }
        }
    }
    return K;
}

function beam(P, U, tf, needK, rel) {
    // internal forces of all beam elements with thermal strain tf*eth: element
    // forces fe (6 per element), axial forces N and the assembled vector fint;
    // the band tangent Kf if needK; a broken rail element adds its step 1 force
    // times (1 - rel)
    const mdl = P.mdl, E = P.E, ne = E.ne, eq = mdl.eq, w = mdl.bw + 1;
    const N = new Float64Array(ne), fe = new Float64Array(6 * ne), fint = new Float64Array(mdl.ndof);
    const Kf = needK ? new Float64Array(mdl.nf * w) : null;
    const iw = [1, 2, 4, 5], bg = new Float64Array(6), kg = new Float64Array(36), dw = new Float64Array(4), Gd = new Float64Array(4);
    for (let e = 0; e < ne; e++) {
        const g = E.grp[e], l = E.len[g], Kb = E.Kb[g], Gm = E.Gm[g], d0 = 3 * E.n1[e], nl = P.nlgeom ? 1 : 0;
        for (let i = 0; i < 4; i++) dw[i] = U[d0 + iw[i]];
        for (let i = 0; i < 4; i++) { let s = 0; for (let j = 0; j < 4; j++) s += dw[j] * Gm[4 * j + i] * nl; Gd[i] = s; }
        let wGw = 0;
        for (let i = 0; i < 4; i++) wGw += dw[i] * Gd[i];
        const eps = (U[d0 + 3] - U[d0]) / l + 0.5 / l * wGw;      // von Karman, averaged
        const Ng = P.EA[e] * (eps - tf * P.eth[e]);
        bg[0] = -1 / l; bg[1] = Gd[0] / l; bg[2] = Gd[1] / l; bg[3] = 1 / l; bg[4] = Gd[2] / l; bg[5] = Gd[3] / l;   // d(eps)/d(u)
        N[e] = Ng;
        for (let a = 0; a < 6; a++) fe[6 * e + a] = Ng * l * bg[a];
        for (let i = 0; i < 4; i++) { let s = 0; for (let j = 0; j < 4; j++) s += dw[j] * Kb[4 * j + i]; fe[6 * e + iw[i]] += P.EI[e] * s; }
        if (rel < 1 && P.kill[e] && P.fK) for (let a = 0; a < 6; a++) fe[6 * e + a] += (1 - rel) * P.fK[6 * e + a];
        for (let a = 0; a < 6; a++) fint[d0 + a] += fe[6 * e + a];
        if (needK) {
            for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) kg[6 * a + b] = P.EA[e] * l * bg[a] * bg[b];
            for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++)
                kg[6 * iw[i] + iw[j]] += P.EI[e] * Kb[4 * i + j] + Ng * Gm[4 * i + j] * nl;
            addElement(Kf, w, eq, d0, kg);
        }
    }
    return { fint, N, fe, Kf };
}

function addElement(Kf, w, eq, d0, kg) {
    // add a 6 x 6 element matrix (DOFs d0 ... d0+5) to the upper band
    for (let a = 0; a < 6; a++) {
        const p = eq[d0 + a];
        if (p < 0) continue;
        for (let b = 0; b < 6; b++) {
            const q = eq[d0 + b];
            if (q >= p) Kf[p * w + (q - p)] += kg[6 * a + b];
        }
    }
}

function linStiff(mdl, EA, EI) {
    // linear beam stiffness on the free DOFs (band), from EA and EI
    const P = { mdl, E: mdl.E, nlgeom: false, EA, EI, eth: new Float64Array(mdl.E.ne), kill: new Uint8Array(mdl.E.ne), fK: null };
    return { Kf: beam(P, new Float64Array(mdl.ndof), 0, true, 1).Kf };
}

function linBeam(P) {
    // linear kinematics: beam stiffness (band), thermal forces (tf = 1) and the
    // step 1 forces of a broken rail element, once per step (EA, EI change only
    // between steps); the stiffness is taken from the model unless a rail
    // element is broken
    const mdl = P.mdl, anyKill = P.kill.some(v => v);
    const L = anyKill ? linStiff(mdl, P.EA, P.EI) : { Kf: mdl.lin.Kf };
    L.f0 = beam(P, new Float64Array(mdl.ndof), 1, false, 1).fint;
    L.fK = new Float64Array(mdl.ndof);
    if (P.fK) for (let e = 0; e < P.E.ne; e++) for (let a = 0; a < 6; a++) L.fK[3 * P.E.n1[e] + a] += P.fK[6 * e + a];
    return L;
}

function beamForceLin(P, U, tf, rel) {
    // internal beam forces with linear kinematics: K*U + tf*f0 (+ released
    // forces of a broken element), on the free DOFs (U = 0 on the fixed DOFs)
    const mdl = P.mdl, nf = mdl.nf, bw = mdl.bw, w = bw + 1, K = P.lin.Kf, eqDof = mdl.eqDof;
    const fint = new Float64Array(mdl.ndof);
    for (let i = 0; i < nf; i++) {                               // symmetric band times vector
        const ui = U[eqDof[i]], row = i * w;
        let s = K[row] * ui;
        const jEnd = Math.min(nf - 1, i + bw);
        for (let j = i + 1; j <= jEnd; j++) {
            const kij = K[row + j - i];
            if (kij === 0) continue;
            s += kij * U[eqDof[j]];
            fint[eqDof[j]] += kij * ui;
        }
        fint[eqDof[i]] += s;
    }
    for (let d = 0; d < fint.length; d++) fint[d] += tf * P.lin.f0[d] + (rel < 1 ? (1 - rel) * P.lin.fK[d] : 0);
    return fint;
}

function bandSolve(a, n, b, x) {
    // solves K x = rhs in place (x = rhs on entry) by LDL' of the symmetric band
    // matrix a (upper band row-wise, overwritten); false if a pivot is zero
    const w = b + 1;
    for (let k = 0; k < n; k++) {
        const piv = a[k * w];
        if (piv === 0 || !isFinite(piv)) return false;
        const iEnd = Math.min(n - 1, k + b), rowK = k * w;
        for (let i = k + 1; i <= iEnd; i++) {
            const aki = a[rowK + i - k];
            if (aki === 0) continue;
            const f = aki / piv, rowI = i * w;
            for (let j = i; j <= iEnd; j++) a[rowI + j - i] -= f * a[rowK + j - k];
            x[i] -= f * x[k];
        }
    }
    for (let k = n - 1; k >= 0; k--) {
        let s = x[k];
        const jEnd = Math.min(n - 1, k + b), rowK = k * w;
        for (let j = k + 1; j <= jEnd; j++) s -= a[rowK + j - k] * x[j];
        x[k] = s / a[rowK];
    }
    return true;
}

function relDisp(S, i, U) {
    // relative displacement of spring i (without its reference value)
    let d = 0;
    for (let a = 0; a < S.nd[i]; a++) d += S.coef[4 * i + a] * U[S.dof[4 * i + a]];
    return d;
}

function springs(P, U, dp0, al0, on) {
    // spring forces and tangents (N, N/m) of the active springs, trial plastic state
    const S = P.S, ns = S.ns;
    const f = new Float64Array(ns), kt = new Float64Array(ns), dp = Float64Array.from(dp0), al = Float64Array.from(al0);
    for (let i = 0; i < ns; i++) {
        if (!on[i]) continue;
        const g = S.law[i], lw = P.laws[g], d = relDisp(S, i, U) - P.dref[i];
        let fg, kg;
        if (S.shifted && (g === 2 || g === 3)) {                 // set 2 from the state after step 1
            [fg, kg] = shiftedLaw(d, P.FA[i], P.shiftPar);
        } else if (lw.type === 'lin') {
            fg = lw.k * d;  kg = lw.k;
        } else if (lw.type === 'elastic') {
            [fg, kg] = elasticLaw(d, lw);
        } else {
            const r = plasticLaw(d, dp[i], al[i], lw);
            fg = r.f;  kg = r.kt;  dp[i] = r.dp;  al[i] = r.al;
        }
        f[i] = fg * S.scl[i];  kt[i] = kg * S.scl[i];
    }
    return { f, kt, dp, al };
}

function lineLoad(fe, e0, ne, dL, X1, X2, q, comp) {
    // equivalent nodal loads of a uniform line load q (N/m) from X1 to X2 (from
    // the start of the element row) on the elements e0 ... e0+ne-1 of length dL;
    // 'z' = vertical downward, 'x' = longitudinal in +x; 3-point Gauss
    const a0 = Math.min(X1, X2), b0 = Math.max(X1, X2);
    if (b0 - a0 <= 0 || q === 0) return;
    const g = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)], wg = [5 / 9, 8 / 9, 5 / 9];
    for (let e = Math.max(1, Math.floor(a0 / dL) + 1); e <= Math.min(ne, Math.ceil(b0 / dL)); e++) {
        const x0 = (e - 1) * dL, a = Math.max(a0, x0) - x0, b = Math.min(b0, x0 + dL) - x0;
        if (b <= a) continue;
        const o = 6 * (e0 + e - 1);
        for (let i = 0; i < 3; i++) {
            const xi = (a + (b - a) * (1 + g[i]) / 2) / dL, ws = (b - a) / 2 * wg[i];
            if (comp === 'z') {
                fe[o + 1] -= q * ws * (1 - 3 * xi * xi + 2 * xi ** 3);
                fe[o + 2] -= q * ws * dL * (xi - 2 * xi * xi + xi ** 3);
                fe[o + 4] -= q * ws * (3 * xi * xi - 2 * xi ** 3);
                fe[o + 5] -= q * ws * dL * (-xi * xi + xi ** 3);
            } else {
                fe[o] += q * ws * (1 - xi);
                fe[o + 3] += q * ws * xi;
            }
        }
    }
}


/* ===========================================================================
   SPRING LAWS
   ======================================================================== */
function springLaw(x) {
    // force-displacement law of a spring from a spec or a linear stiffness:
    //   k                                   linear (N/m)
    //   ['linear', k]
    //   ['bilinear', u0, F]                 elastic-perfectly plastic
    //   ['bilinear', u0, F, 'elastic']      nonlinear elastic, symmetric
    //   ['curve', tab]                      nonlinear elastic curve, tab = [[u, F], ...]
    //   ['curve', tab, 'elastic', d0]       curve from the point d0: F(d+d0) - F(d0)
    //   ['curve', tab, 'plastic']           elastoplastic backbone from [0, 0], isotropic hardening
    // Track springs per m of track (N/m/m). Relative displacement: rail minus
    // deck/ground (vertical: + uplift), deck minus ground for supports, towards
    // the soil for end screens. Constant force outside a curve.
    if (x && typeof x === 'object' && !Array.isArray(x) && x.type) return x;   // already a law
    if (!Array.isArray(x)) x = ['linear', x];
    const t = String(x[0]).toLowerCase(), arg = i => (x.length > i ? x[i] : undefined);
    if (t === 'linear') return { type: 'lin', k: Number(x[1]), k0: Number(x[1]) };
    if (t === 'bilinear') {
        if (String(arg(3)).toLowerCase() === 'elastic') return elasticCurve([[-x[1], -x[2]], [0, 0], [x[1], x[2]]], 0);
        return plasticCurve([[0, 0], [x[1], x[2]]]);
    }
    if (t === 'curve') {
        if (String(arg(2)).toLowerCase() === 'plastic') return plasticCurve(x[1]);
        return elasticCurve(x[1], arg(3) !== undefined ? Number(x[3]) : 0);
    }
    throw new Error("Unknown spring law '" + x[0] + "'.");
}

function elasticCurve(tab, d0) {
    // nonlinear elastic curve, constant outside the table
    const u = tab.map(r => Number(r[0])), F = tab.map(r => Number(r[1]));
    for (let i = 1; i < u.length; i++) if (!(u[i] > u[i - 1])) throw new Error('u must be strictly ascending.');
    const s = u.slice(1).map((v, i) => (F[i + 1] - F[i]) / (v - u[i]));
    const dc = Math.min(Math.max(d0, u[0]), u[u.length - 1]);
    let F0 = F[F.length - 1];
    for (let i = 0; i < s.length; i++) if (dc <= u[i + 1]) { F0 = F[i] + s[i] * (dc - u[i]); break; }   // interp1
    let k0 = 0;
    for (let i = 0; i < s.length; i++) if (u[i] <= d0 && d0 < u[i + 1]) { k0 = s[i]; break; }
    return { type: 'elastic', u, F, s, d0, F0, k0 };
}

function plasticCurve(tab) {
    // elastoplastic backbone: yield force sy at the accumulated plastic
    // displacement a, hardening H per segment (0 beyond the last point)
    const u = tab.map(r => Number(r[0])), F = tab.map(r => Number(r[1]));
    if (u[0] !== 0 || F[0] !== 0) throw new Error('The backbone must start at [0 0].');
    if (u.length < 2 || u.some((v, i) => i > 0 && !(v > u[i - 1]))) throw new Error('u must be strictly ascending.');
    const k0 = F[1] / u[1];
    const a = u.slice(1).map((v, i) => v - F[i + 1] / k0), sy = F.slice(1);
    const H = sy.map((v, i) => (i < sy.length - 1 ? (sy[i + 1] - v) / (a[i + 1] - a[i]) : 0)).map(v => (isFinite(v) ? v : 0));
    return { type: 'plastic', k0, a, sy, H };
}

function elasticLaw(d, lw) {
    // force and tangent of a nonlinear elastic curve (as discretize in MATLAB:
    // the last bin includes its right edge)
    const dd = d + lw.d0, u = lw.u, F = lw.F, n = u.length;
    if (dd < u[0]) return [F[0] - lw.F0, 0];
    if (dd > u[n - 1]) return [F[n - 1] - lw.F0, 0];
    if (dd === u[n - 1]) return [F[n - 1] - lw.F0, lw.s[n - 2]];
    let j = 0;
    while (j < n - 2 && dd >= u[j + 1]) j++;
    return [F[j] + lw.s[j] * (dd - u[j]) - lw.F0, lw.s[j]];
}

function plasticLaw(d, dp, al, lw) {
    // 1D elastoplasticity, isotropic hardening on a piecewise linear backbone,
    // closed-form return mapping, consistent tangent
    const k0 = lw.k0, A = lw.a, H = lw.H;
    const ft = k0 * (d - dp), sg = ft < 0 ? -1 : 1, mag = Math.abs(ft);
    if (!(mag > yieldForce(al, lw) * (1 + 1e-12) + 1e-12)) return { f: ft, kt: k0, dp, al };
    let cur = al, da = 0, Hf = 0;
    for (let pass = 0; pass <= A.length; pass++) {               // walk the segments
        const j = segIndex(cur, A), aEnd = j < A.length - 1 ? A[j + 1] : Infinity;
        const dd = (mag - k0 * (cur - al) - yieldForce(cur, lw)) / (k0 + H[j]);
        if (cur + dd <= aEnd) { da = cur + dd - al; Hf = H[j]; break; }
        cur = aEnd;
    }
    const an = al + da;
    return { f: sg * yieldForce(an, lw), kt: k0 * Hf / (k0 + Hf), dp: dp + sg * da, al: an };
}

function segIndex(x, A) {
    // backbone segment: A[j] <= x < A[j+1], the last one beyond
    let j = 0;
    while (j < A.length - 1 && x >= A[j + 1]) j++;
    return j;
}

function yieldForce(x, lw) {
    // yield force at the accumulated plastic displacement x
    const j = segIndex(x, lw.a);
    return lw.sy[j] + lw.H[j] * (x - lw.a[j]);
}

function shiftedLaw(du, FA, p) {
    // set 2 of the 'shifted' loaded resistance: total from the state after
    // step 1 (FA) along F_l/u0, minus set 1; p = [u0, F_u, F_l]
    let T = FA + p[2] / p[0] * du;  const inT = Math.abs(T) < p[2];  T = Math.max(Math.min(T, p[2]), -p[2]);
    let F1 = FA + p[1] / p[0] * du; const inF = Math.abs(F1) < p[1]; F1 = Math.max(Math.min(F1, p[1]), -p[1]);
    return [T - F1, p[2] / p[0] * inT - p[1] / p[0] * inF];
}


/* ===========================================================================
   5 RESULTS
   ======================================================================== */
function atSeats(s) {
    // rail stress at the rail seats (every second rail node): mean of the
    // elements on both sides, NaN ignored
    const out = [];
    for (let i = 0; i < s.length; i += 2) {
        const a = s[Math.max(i - 1, 0)], b = s[i];
        out.push(isNaN(a) ? b : (isNaN(b) ? a : (a + b) / 2));
    }
    return out;
}

function addEnv(G, r, k, sub) {
    // envelope of the additional rail stress in step 2 over the tracks
    for (const St of r.S) {
        const s = St[1];
        for (let i = 0; i < s.length; i++) {
            G.min[k][i] = nanMin(G.min[k][i], s[i] - sub);
            G.max[k][i] = nanMax(G.max[k][i], s[i] - sub);
        }
    }
}

function addEnvB(G, r, k) {
    // envelopes of the deck forces and displacements in step 2
    for (const q of Object.keys(r.F)) {
        const v = r.F[q][1];
        for (let i = 0; i < v.length; i++) {
            G[q].min[k][i] = nanMin(G[q].min[k][i], v[i]);
            G[q].max[k][i] = nanMax(G[q].max[k][i], v[i]);
        }
    }
}

function smax(a, b) {
    // element-wise value with the largest magnitude, sign kept; equal magnitudes
    // (within 1e-5 relative, at least 1e-3; e.g. braking in both directions) give
    // the positive value, so the sign does not depend on round-off
    return a.map((x, i) => {
        const y = b[i], tol = Math.max(1e-3, 1e-5 * Math.max(Math.abs(x), Math.abs(y)));
        if (Math.abs(Math.abs(y) - Math.abs(x)) <= tol) return Math.max(x, y);
        return Math.abs(y) > Math.abs(x) + tol ? y : x;
    });
}

function resultTable(out) {
    // summary table; val and exceed as [row][k] (rows min / max or left / right)
    const Tk = out.Track, Bk = out.Bridge, Lim = out.inp.Limits, Ld = out.inp.Load;
    const br = Tk.onBr, all1 = br.map(() => true), notBr = br.map(v => !v);
    const mm = (G, sel) => [0, 1].map(row => [0, 1].map(k => {   // [min; max] over the selected seats
        let v = NaN;
        for (let i = 0; i < sel.length; i++) if (sel[i]) v = row ? nanMax(v, G.max[k][i]) : nanMin(v, G.min[k][i]);
        return v;
    }));
    const byRow = A => [0, 1].map(row => [A[0][row], A[1][row]]);   // [k][end] -> [end][k]
    const Tb = [];
    const add = (name, unit, lim, val, limv, dec) => Tb.push({ name, unit, lim, val, limv, exceed: null, dec: dec === undefined ? null : dec });
    const sl = l => '$' + sgn0(l[0]) + '$ / $' + sgn0(l[1]) + '$';
    const none = [-Infinity, Infinity];
    const same = Lim.sig_br[0] === Lim.sig_emb[0] && Lim.sig_br[1] === Lim.sig_emb[1];
    let cn = 'Load combination';
    if (Tk.rej) {                                                // REJ: temperature as total stress
        add('Temperature (total stress)', 'MPa', '--', mm(Tk.temp, all1), none);
        cn = 'Load combination w/o temperature';
    } else if (same) {
        add('Temperature', 'MPa', sl(Lim.sig_emb), mm(Tk.temp, all1), Lim.sig_emb);
    } else {                                                     // different limits on the bridge and the embankment
        add('Temperature, bridge', 'MPa', sl(Lim.sig_br), mm(Tk.temp, br), Lim.sig_br);
        add('Temperature, embankment', 'MPa', sl(Lim.sig_emb), mm(Tk.temp, notBr), Lim.sig_emb);
    }
    if (Ld.LM71) add('LM71', 'MPa', '--', mm(Tk.LM71, all1), none);
    if (Ld.SW) add('SW/0', 'MPa', '--', mm(Tk.SW, all1), none);
    add('Braking', 'MPa', '--', mm(Tk.brk, all1), none);
    add('Traction', 'MPa', '--', mm(Tk.acc, all1), none);
    add(cn + ', bridge', 'MPa', sl(Lim.sig_br), mm(Tk.comb, br), Lim.sig_br);
    add(cn + ', embankment', 'MPa', sl(Lim.sig_emb), mm(Tk.comb, notBr), Lim.sig_emb);
    add('$\\delta_\\mathrm{B}$ braking/traction, left / right', 'mm', g6(Lim.dB),
        byRow(Bk.dB.map((v, k) => v.map((x, j) => Math.max(x, Bk.dA[k][j])))), [-Infinity, Lim.dB]);
    if (Ld.LM71 || Ld.SW) {
        add('$\\delta_\\mathrm{H}$ vertical traffic, left / right', 'mm', g6(Lim.dH), byRow(Bk.dH), [-Infinity, Lim.dH]);
        if (out.Model.Ls > 0) add('$\\delta_\\mathrm{V}$ vertical traffic, left / right', 'mm', g6(Lim.dV), byRow(Bk.dV), [-Infinity, Lim.dV]);
        const Ls = Bk.xsup.slice(1).map((x, i) => x - Bk.xsup[i]);
        let ig = 0, best = -Infinity;                            // span with the largest deflection / L
        Ls.forEach((l, s) => { const v = Math.max(Bk.wV[0][s] / l, Bk.wV[1][s] / l); if (v > best) { best = v; ig = s; } });
        const wl = Math.round(1e3 * Ls[ig] / Lim.wL);
        add('$\\delta_\\mathrm{V}$ max deflection, vertical traffic', 'mm', '$L$/' + g6(Lim.wL) + ' = ' + wl,
            [[roundTo(Bk.wV[0][ig], 0), roundTo(Bk.wV[1][ig], 0)]], [-Infinity, wl], 0);
    }
    add('Deck end movement, temperature, left / right', 'mm', '--', byRow(Bk.dTemp), none);
    const grp = [['temp', 'temperature'], ['LM71', 'LM71'], ['SW', 'SW/0'], ['brk', 'braking'], ['acc', 'traction'], ['comb', 'load combination']]
        .filter((g, i) => [true, Ld.LM71, Ld.SW, true, true, true][i]);
    out.inp.Bridge.Kh.forEach((kh, i) => {
        if (isNum(kh) && kh === 0) return;                       // movable bearing
        for (const g of grp) add('Support ' + (i + 1) + ', ' + g[1], 'kN', '--', [[Bk.Rh[g[0]][0][i], Bk.Rh[g[0]][1][i]]], none);
    });
    out.inp.Track.gap.forEach((x, ig) => add('Opening of REJ ' + (ig + 1) + ', temperature', 'mm', '--', [[Tk.gap.temp[0][ig], Tk.gap.temp[1][ig]]], none));
    add('Rail break gap', 'mm', g6(Lim.wgap), [[NaN, Tk.rbreak.wmax]], [-Infinity, Lim.wgap]);
    for (const t of Tb) {                                        // compared at the printed precision
        const d = t.dec === null ? 1 : t.dec;
        t.exceed = t.val.map(row => row.map(v => { const r = roundTo(v, d); return r < t.limv[0] || r > t.limv[1]; }));
    }
    return Tb;
}


/* ===========================================================================
   6 ANALYSIS (TBI_fem.m main function), load cases in Web Workers
   ======================================================================== */
const SRC = (typeof document !== 'undefined' && document.currentScript) ? document.currentScript.src : null;
let pool = null;                                                 // Promise -> [Worker] or null
let runId = 0, stopped = false;

function makePool(n) {
    // n workers from tbi_worker.js next to this file; null where workers cannot
    // be used (no Worker, page opened as a file)
    if (!SRC || typeof Worker === 'undefined' || /^file:/i.test(SRC)) return Promise.resolve(null);
    const url = new URL('tbi_worker.js' + new URL(SRC).search, SRC).href;   // same version (?v=) as this file
    const start = () => new Promise(res => {
        let w;
        try { w = new Worker(url); } catch (e) { res(null); return; }
        const to = setTimeout(() => { w.terminate(); res(null); }, 5000);
        w.onmessage = e => { if (e.data && e.data.ready) { clearTimeout(to); res(w); } };
        w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); clearTimeout(to); w.terminate(); res(null); };
    });
    return Promise.all(Array.from({ length: n }, start)).then(ws => { ws = ws.filter(Boolean); return ws.length ? ws : null; });
}

function getWorkers(n) {
    // the pool of workers, kept between runs
    if (n === 0) return Promise.resolve(null);
    if (!pool) {
        const nc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        pool = makePool(n || Math.max(1, Math.min(16, nc - 1)));
    }
    return pool;
}

function makeRunner(mdl, inp, opt, workers, onDone) {
    // runs lists of [case, state] on the workers (model built once per worker and
    // run) or on the main thread; results in the order of the list
    const rid = ++runId;
    let ready = null;
    if (workers) ready = Promise.all(workers.map(w => new Promise((res, rej) => {
        w.onmessage = e => { const m = e.data; if (m.rid === rid && m.model) (m.error ? rej(new Error(m.error)) : res()); };
        w.postMessage({ type: 'model', rid, inp, nlgeom: opt.nlgeom, nInc: opt.nInc });
    })));
    return async function run(jobs) {
        const res = new Array(jobs.length);
        if (!workers) {                                          // main thread, yield now and then for the GUI
            let t = Date.now();
            for (let i = 0; i < jobs.length; i++) {
                if (stopped) throw new Error('stopped');
                res[i] = solveCase(mdl, jobs[i][0], jobs[i][1]);
                onDone();
                if (Date.now() - t > 150) { await new Promise(r => setTimeout(r, 0)); t = Date.now(); }
            }
            return res;
        }
        await ready;
        return new Promise((resolve, reject) => {
            let next = 0, left = jobs.length, stop = false;
            if (!left) { resolve(res); return; }
            const send = w => {
                if (stop || next >= jobs.length) return;
                const i = next++;
                w.postMessage({ type: 'case', rid, id: i, c: jobs[i][0], S1: jobs[i][1] });
            };
            for (const w of workers) {
                w.onmessage = e => {
                    const m = e.data;
                    if (stop || !m || m.rid !== rid || m.model) return;
                    if (m.error) { stop = true; reject(new Error(m.error)); return; }
                    if (stopped) { stop = true; workers.forEach(x => x.terminate()); pool = null; reject(new Error('stopped')); return; }
                    res[m.id] = m.r;  left--;  onDone();
                    if (!left) resolve(res); else send(w);
                };
                w.onerror = ev => {
                    if (ev && ev.preventDefault) ev.preventDefault();
                    if (stop) return;
                    stop = true;  workers.forEach(x => x.terminate());  pool = null;
                    reject(new Error('A worker failed' + (ev && ev.message ? ': ' + ev.message : '') + '; run again.'));
                };
            }
            workers.forEach(send);
        });
    };
}

async function analysis(inp0, opt0) {
    // all load cases, envelopes, governing combinations and the result table
    // (TBI_fem.m sections 1-8)
    const t0 = Date.now();
    const opt = Object.assign({ nlgeom: false, nInc: 1, progress: null, workers: undefined }, opt0 || {});
    opt.nlgeom = Boolean(opt.nlgeom);
    opt.nInc = fixInc(opt.nInc);
    stopped = false;

    // 1 INPUT AND MODEL
    const inp = setDefaults(inp0);
    const mdl = buildModel(inp, opt.nlgeom);
    mdl.nInc = opt.nInc;
    const out = { inp, Model: mdl.out };
    const B = inp.Bridge, T = inp.Track, Ld = inp.Load, Lim = inp.Limits;
    const nt = B.n_track, xB = mdl.xB, Lb = mdl.Lb, xsup = mdl.xsup, nsup = xsup.length;
    const sig_emb = T.dT.map(d => -T.E * T.alfa * d / 1e6);     // fully restrained rail (MPa)
    const rej = T.gap.length > 0;                                // rail expansion joints: temperature as total stress
    const sub = sig_emb.map(v => (rej ? 0 : v));                 // subtracted from the total rail stress (MPa)
    const groups = ['temp', 'LM71', 'SW', 'brk', 'acc', 'comb'];

    // 2 LOAD ARRANGEMENTS
    const LA = loadArrangements(inp, mdl);
    const nV = (Ld.LM71 ? LA.xloco.length : 0) + (Ld.SW ? LA.xSW.length : 0);
    let nRun = 0, nTot = 6 + 2 * nV + 2 * LA.H.length + 4 * 5 * LA.H.length, tProg = 0;
    const progress = f => { if (opt.progress) opt.progress(f); };
    const onDone = () => {
        nRun++;
        const t = Date.now();
        if (t - tProg > 150) { tProg = t; progress(Math.min(0.99, nRun / nTot)); }
    };
    const workers = await getWorkers(opt.workers);
    const run = makeRunner(mdl, inp, opt, workers, onDone);

    // 3 TEMPERATURE (step 1 kept per season for the combinations) and the
    // step 1 of the rail break (winter, rail break temperature)
    const nx = mdl.seatR.length, nb = mdl.seatD.length, ng = T.gap.length;
    const env = n => ({ min: [nanArr(n), nanArr(n)], max: [nanArr(n), nanArr(n)] });
    const G = {}, GB = {}, Rh = {};
    for (const g of groups) {
        G[g] = env(nx);  Rh[g] = [new Array(nsup).fill(0), new Array(nsup).fill(0)];
        GB[g] = {};  for (const q of ['N', 'M', 'V', 'u', 'w', 'th']) GB[g][q] = env(nb);
    }
    const jobs1 = [0, 1].map(k => { const c = newCase(k, B.dT[k], T.dT[k], 1); c.keepState = true; return [c, null]; });
    const cBrk = newCase(1, B.dT[1], T.dT_brk, 1);  cBrk.keepState = true;
    const R1 = await run(jobs1.concat([[cBrk, null]]));
    const S1 = [R1[0].state, R1[1].state], dTemp = [[0, 0], [0, 0]];
    const gapOpen = { temp: [[], []], combMin: [new Array(ng).fill(Infinity), new Array(ng).fill(Infinity)],
                      combMax: [new Array(ng).fill(-Infinity), new Array(ng).fill(-Infinity)] };
    for (let k = 0; k < 2; k++) {
        const r = R1[k];
        addEnv(G.temp, r, k, sub[k]);
        addEnvB(GB.temp, r, k);
        Rh.temp[k] = r.Rh[1].slice();
        dTemp[k] = [r.F.u[1][0], r.F.u[1][nb - 1]];
        gapOpen.temp[k] = Array.from(r.gap);
    }
    progress(0.02);

    // 4 RAIL BREAK, CEN/TR 17231 A.2: winter, unloaded track, both rails of
    // track 1 broken in step 2 at the deck ends and where the tension is largest
    const r0 = R1[2], s1 = r0.Snode[0];
    let im = 0, best = -Infinity;                                // largest tension, the first of equal values (plateau)
    for (let i = 0; i < mdl.nr - 1; i++) {
        const xe = mdl.xRail[i];
        const okb = Math.abs(xe - (xB[0] + xB[1]) / 2) <= Lb / 2 + mdl.Le / 2 && isFinite(s1[i]);
        const v = okb ? roundTo(s1[i], 6) : -1e9;
        if (v > best) { best = v; im = i; }
    }
    let xc = [...new Set([xB[0], xB[1], mdl.xRail[im]].map(x => mdl.dL * Math.round((x + mdl.Ls) / mdl.dL) - mdl.Ls))].sort((a, b) => a - b);
    if (rej) xc = xc.filter(x => T.gap.every(g => Math.abs(x - g) > 2 * T.s_r));   // not next to a REJ

    // 5 VERTICAL TRAFFIC: LM71 and SW/0 in all positions, and 6 BRAKING AND
    // TRACTION on loaded track, no vertical load (independent: one list)
    const V = [];
    for (let k = 0; k < 2; k++) {
        if (Ld.LM71) for (const x of LA.xloco) V.push({ type: 'LM71', x, k });
        if (Ld.SW) for (const x of LA.xSW) V.push({ type: 'SW/0', x, k });
    }
    const H = LA.H, nH = H.length;
    const jobsB = xc.map(x => { const c = Object.assign({}, cBrk, { keepState: false, railBreak: x }); return [c, r0.state]; });
    const jobsV = V.map(v => { const sg = vertSeg(LA, v.type, v.x); return [newCase(v.k, 0, 0, 0, sg, sg.map(s => s.slice(0, 2))), null]; });
    const jobsH = [];
    for (let j = 0; j < nH; j++) for (let k = 0; k < 2; k++) jobsH.push([horzCase(LA, H[j], k, 0, [], [xB]), null]);
    nTot = 3 + xc.length + jobsV.length + jobsH.length + 2 * 2 * nH * 5;
    const R2 = await run(jobsB.concat(jobsV, jobsH));
    const Rb = R2.slice(0, xc.length), Rv = R2.slice(xc.length, xc.length + jobsV.length), Rhz = R2.slice(xc.length + jobsV.length);

    const atS = v => atSeats(v);
    const w = Rb.map(q => q.wbrk), wmax = Math.max(...w);
    let jm = 0;  w.forEach((v, j) => { if (v >= wmax - 1e-3) jm = j; });   // equal gaps (1e-3 mm): the last position
    const Brk = { x: xc, w, wmax, xmax: xc[jm], S0: atS(r0.Snode[0]), S: atS(Rb[jm].Snode[1]),
                  dT_R: T.dT_brk, dT_B: B.dT[1], wCWR: 1e3 * Math.pow(T.alfa * T.dT_brk, 2) * T.A * T.E / T.Fu[1] };

    const dH = [[0, 0], [0, 0]], dV = [[0, 0], [0, 0]], wV = [new Array(nsup - 1).fill(0), new Array(nsup - 1).fill(0)];
    const inSp = mdl.xDeck.map(x => xsup.slice(1).map((xs2, s) => x >= xsup[s] - 1e-9 && x <= xs2 + 1e-9));   // rail seats per span
    const crit = [];
    const cname = ['largest compression', 'largest tension', '$\\delta_\\mathrm{H}$ left end', '$\\delta_\\mathrm{H}$ right end',
                   'bearing force support ' + B.FL];
    const season = ['summer', 'winter'];
    for (const vt of ['LM71', 'SW/0']) {
        const gname = vt.replace('/0', '');                       // load group LM71, SW
        for (let k = 0; k < 2; k++) {
            const iv = V.map((v, i) => i).filter(i => V[i].type === vt && V[i].k === k);
            if (!iv.length) continue;
            const qv = [];                                       // criteria per position
            for (const i of iv) {
                const r = Rv[i];
                addEnv(G[gname], r, k, 0);
                addEnvB(GB[gname], r, k);
                Rh[gname][k] = smax(Rh[gname][k], r.Rh[1]);
                for (let s = 0; s < nsup - 1; s++)
                    for (let q = 0; q < nb; q++) if (inSp[q][s]) wV[k][s] = Math.max(wV[k][s], -r.F.w[1][q]);
                const uEnd = [Math.abs(r.F.u[1][0]), Math.abs(r.F.u[1][nb - 1])];
                dH[k] = dH[k].map((v, j) => Math.max(v, uEnd[j]));
                dV[k] = dV[k].map((v, j) => Math.max(v, Math.abs(r.F.w[1][j ? nb - 1 : 0])));
                let smin = Infinity, smx = -Infinity;
                for (const St of r.S) for (const v of St[1]) { if (v < smin) smin = v; if (v > smx) smx = v; }
                qv.push([-smin, smx, uEnd[0], uEnd[1], Math.abs(r.Rh[1][B.FL - 1])]);
            }
            for (let m = 0; m < 5; m++) {                         // first critical position per criterion
                let ib = 0;
                qv.forEach((q, n) => { if (q[m] > qv[ib][m]) ib = n; });
                const x = V[iv[ib]].x, sg = vertSeg(LA, vt, x);
                crit.push({ type: vt, x, crit: cname[m], season: season[k], seg: sg,
                            env: [Math.min(...sg.map(s => s[0])), Math.max(...sg.map(s => s[1]))] });
            }
        }
    }
    const seen = new Set();
    let cv = crit.filter(c => { const key = c.type + '_' + c.x.toFixed(4); if (seen.has(key)) return false; seen.add(key); return true; });
    if (!cv.length) cv = [{ type: 'no vertical load', x: 0, crit: '', season: '', seg: [], env: xB }];   // loaded track on the bridge

    const dB = [[0, 0], [0, 0]], dA = [[0, 0], [0, 0]];
    for (let j = 0; j < nH; j++) {
        for (let k = 0; k < 2; k++) {
            const r = Rhz[2 * j + k], d = [Math.abs(r.F.u[1][0]), Math.abs(r.F.u[1][nb - 1])];
            const g = H[j].fb !== 0 ? 'brk' : 'acc', D = H[j].fb !== 0 ? dB : dA;
            D[k] = D[k].map((v, e) => Math.max(v, d[e]));
            addEnv(G[g], r, k, 0);
            addEnvB(GB[g], r, k);
            Rh[g][k] = smax(Rh[g][k], r.Rh[1]);
        }
    }
    progress(0.55);

    // 7 COMBINATIONS: temperature (step 1) + vertical traffic in the critical
    // positions + braking or traction (step 2), with and without temperature;
    // with rail expansion joints the rail stress only from the runs without
    // temperature, the deck of the governing case from its run with temperature
    const jobsC = [], idx = [];
    for (let k = 0; k < 2; k++) for (let c2 = 0; c2 < cv.length; c2++) for (let j = 0; j < nH; j++) for (let m = 0; m < 2; m++) {
        const seg = cv[c2].seg;
        const cc = horzCase(LA, H[j], k, m === 0 ? 1 : 0, seg, seg.map(s => s.slice(0, 2)), cv[c2].env);
        if (!seg.length) cc.loaded = [xB];
        jobsC.push([cc, m === 0 ? S1[k] : null]);  idx.push({ k, c2, j, m });
    }
    const Rc = await run(jobsC);
    const RcAt = (m, j, c2, k) => Rc[((k * cv.length + c2) * nH + j) * 2 + m];
    const gov = [nanArr(nx), nanArr(nx)], govT = [nanArr(nx), nanArr(nx)];
    const qB = ['N', 'M', 'V', 'u', 'w', 'th'];
    const govB = {}, govBT = {};
    for (const q of qB) { govB[q] = [nanArr(nb), nanArr(nb)]; govBT[q] = [nanArr(nb), nanArr(nb)]; }
    const comb = [{ vert: '', H: '', u: 0, temp: true }, { vert: '', H: '', u: 0, temp: true }];
    const onBr = mdl.onBr;
    for (let k = 0; k < 2; k++) {
        let ub = -Infinity;
        for (let c2 = 0; c2 < cv.length; c2++) for (let j = 0; j < nH; j++) for (let m = 0; m < 2; m++) {
            const r = RcAt(m, j, c2, k);
            addEnvB(GB.comb, r, k);
            Rh.comb[k] = smax(Rh.comb[k], r.Rh[1]);
            for (let i = 0; i < ng; i++) {
                gapOpen.combMin[k][i] = Math.min(gapOpen.combMin[k][i], r.gap[i]);
                gapOpen.combMax[k][i] = Math.max(gapOpen.combMax[k][i], r.gap[i]);
            }
            if (rej && m === 0) continue;                        // REJ: total stress, not checked
            const sr = m === 0 ? sub[k] : 0;
            addEnv(G.comb, r, k, sr);
            for (let t = 0; t < nt; t++) {
                const s = r.S[t][1].map(v => v - sr);
                let u = -Infinity;                               // utilisation of the limits
                const um = (v, l) => { if (!isNaN(v)) u = Math.max(u, v / l); };
                let a = [Infinity, -Infinity, Infinity, -Infinity];
                s.forEach((v, i) => {
                    if (isNaN(v)) return;
                    if (onBr[i]) { a[0] = Math.min(a[0], v); a[1] = Math.max(a[1], v); }
                    else { a[2] = Math.min(a[2], v); a[3] = Math.max(a[3], v); }
                });
                a = a.map(v => (isFinite(v) ? v : NaN));
                um(a[0], Lim.sig_br[0]); um(a[1], Lim.sig_br[1]); um(a[2], Lim.sig_emb[0]); um(a[3], Lim.sig_emb[1]);
                if (u > ub) {
                    ub = u;  gov[k] = Float64Array.from(s);
                    let Fc;
                    if (rej) Fc = RcAt(0, j, c2, k).F;
                    else { Fc = r.F;  govT[k] = Float64Array.from(r.S[t][0], v => v - sr); }
                    for (const q of qB) { govB[q][k] = Float64Array.from(Fc[q][1]); govBT[q][k] = Float64Array.from(Fc[q][0]); }
                    comb[k] = { vert: cv[c2].type + ', x = ' + cv[c2].x.toFixed(2) + ' m (' + cv[c2].crit + ')', H: H[j].name, u, temp: m === 0 };
                }
            }
        }
    }

    // 8 OUTPUT
    const arr = a => Array.from(a);
    const envOut = E => ({ min: E.min.map(arr), max: E.max.map(arr) });
    out.Track = { x: mdl.xSeat, onBr, sig_emb, rej };
    for (const g of groups) out.Track[g] = envOut(G[g]);
    out.Track.comb.gov = gov.map(arr);  out.Track.comb.govTemp = govT.map(arr);
    out.Track.gap = gapOpen;
    out.Track.rbreak = Brk;
    out.Bridge = { x: mdl.xDeck, xF: mdl.xDeck, xsup, dTemp, dB, dA, dH, dV, wV, Rh };
    const F = {}, D = {};
    for (const g of groups) {
        F[g] = {};  D[g] = {};
        for (const q of ['N', 'M', 'V']) F[g][q] = envOut(GB[g][q]);
        for (const q of ['u', 'w', 'th']) D[g][q] = envOut(GB[g][q]);
    }
    F.comb.gov = {};  F.comb.govTemp = {};  D.comb.gov = {};  D.comb.govTemp = {};
    for (const q of ['N', 'M', 'V']) { F.comb.gov[q] = govB[q].map(arr); F.comb.govTemp[q] = govBT[q].map(arr); }
    for (const q of ['u', 'w', 'th']) { D.comb.gov[q] = govB[q].map(arr); D.comb.govTemp[q] = govBT[q].map(arr); }
    out.Bridge.F = F;  out.Bridge.D = D;
    out.LoadPos = { vert: crit.map(c => ({ type: c.type, x: c.x, crit: c.crit, season: c.season })), H, comb,
                    Lbrk: LA.Lbrk, Lacc: LA.Lacc, xloco: LA.xloco, xSW: LA.xSW };
    out.Table = resultTable(out);
    nRun = 3 + xc.length + jobsV.length + jobsH.length + jobsC.length;
    out.Info = { nRun, time: (Date.now() - t0) / 1e3, nlgeom: opt.nlgeom, nInc: opt.nInc };
    progress(1);
    return out;
}

function model(inp0, nlgeom) {
    // input with defaults and the geometry as rounded in the model (no analysis)
    const inp = setDefaults(inp0);
    const mdl = buildModel(inp, nlgeom);
    return { inp, Model: mdl.out };
}


/* ===========================================================================
   EXPORTS
   ======================================================================== */
Object.assign(TBI, {
    readJson, setDefaults, model, analysis, fixInc, springLaw,
    stop: () => { stopped = true; },
    // for tbi_worker.js and tests
    _buildModel: buildModel, _solveCase: solveCase, _loadArrangements: loadArrangements, _resultTable: resultTable
});

})(typeof self !== 'undefined' ? self : this);

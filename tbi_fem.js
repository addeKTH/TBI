/* tbi_fem.js -----------------------------------------------------------------
   Longitudinal track-bridge interaction (TBI), EN 1991-2:2024 8.5.4.
   Browser port of TBI_fem.m (MATLAB): stand-alone 2D FE model and the
   complete analysis (all load cases, envelopes, critical positions).
   Andreas Andersson, 2026-10-28 (assisted by Claude)

   MODEL: rail(s) and deck as beams in the vertical plane (u, w, theta per
   node), element length s_r/2, von Karman membrane strain averaged over the
   element, rigid offsets deck neutral axis - bearings (e_b) and - track slip
   centre, and rail - slip centre (e_r). At every sleeper: horizontal shear
   springs for unloaded (set 1) and loaded track (set 2, born in step 2 where
   vertical traffic acts) and a vertical spring, to the deck on the bridge and
   to fixed ground on the embankments. Bearings: vertically fixed, horizontal
   spring at bearing level. Rail ends fixed. Full Newton-Raphson with
   consistent tangent, line search and bisection of the load increment.
     Step 1: temperature of deck (and rail), unloaded track resistance.
     Step 2: + vertical traffic, braking, acceleration, loaded resistance.

   USAGE:
     TBI.defaults(inp)                  -> {inp, Model}   input completed with defaults
     await TBI.analysis(inp, opt)       -> out            all load cases
     TBI.solve(Track, Bridge, Load, opt)-> one load case (low level)
   opt.progress = function(fraction 0..1), called about every 0.2 s.
   opt.workers = 0 runs on the main thread; otherwise the load cases are
   solved in parallel in Web Workers when the browser allows it.
   opt.solver.state1 (TBI.solve) restarts step 2 from a saved step 1 (R.state1).

   INPUT (SI units, default values as TBI_fem.m):
     inp.Bridge: L (array, m), E (Pa), A (m2), I (m4), e_b, h (m) required;
       type, alfa, L_end, n_track, FL (1-based), Kh (array N/m or law specs),
       dT [summer, winter] (K), endsprings [{side, z, law}]
     inp.Track: type ('ballasted'/'ballastless'), A, I, E, alfa, e_r, s_r, Le,
       u0 [s, w] (m), Fu [s, w] (N/m), Fl (N/m), Kv, Kv_up (N/m), dT [s, w] (K),
       gap (array of x, m), dT_brk (K), loaded ('additive'/'shifted'),
       law1, law2, lawBr1, lawBr2, lawV (law specs)
     inp.Load: alfa, LM71, SW, dxPos, qlbk, Qlbk_max, qlak, Qlak_max
     inp.Limits: sig_br, sig_emb [compression, tension] (MPa), dB, dH, dV, wgap (mm)
   Law specs: number (linear stiffness) or ['linear', k], ['bilinear', u0, F],
     ['bilinear', u0, F, 'elastic'], ['curve', [[u, F], ...]],
     ['curve', tab, 'elastic', d0], ['curve', tab, 'plastic'].

   OUTPUT of analysis: out.inp, out.Model {Lb, Ls, Le, L, xsup, s_r, dL},
     out.Track {x (rail seats), onBr, sig_emb, temp/LM71/SW/brk/acc/comb:
       {min, max} as [season][seat] (MPa), comb.gov, comb.govTemp, gap, rbreak},
     out.Bridge {x, xsup, dTemp, dB, dA, dH, dV as [season][left, right] (mm),
       Rh.{group} as [season][support] (kN)}, out.LoadPos, out.Table, out.Info.
   Arrays indexed [season] are 0 = summer, 1 = winter.
---------------------------------------------------------------------------*/
(function (root) {
'use strict';

const TBI = {};

// ---------------------------------------------------------------- helpers
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const clone = o => JSON.parse(JSON.stringify(o));
function setdef(S, defs) {
    for (const k in defs) if (!has(S, k)) S[k] = defs[k];
    return S;
}
const isMovable = k => typeof k === 'number' && k === 0;
const asArray = v => (Array.isArray(v) ? v.slice() : (v == null ? [] : [v]));

// ------------------------------------------------------------ DEFAULTS
TBI.defaults = function (inp0) {
    const inp = clone(inp0 || {});
    if (!inp.Bridge) throw new Error('inp.Bridge is missing.');
    const miss = ['L', 'E', 'A', 'I', 'e_b', 'h'].filter(k => !has(inp.Bridge, k));
    if (miss.length) throw new Error('Required input missing: Bridge.' + miss.join(', Bridge.'));
    for (const f of ['Track', 'Load', 'Limits', 'Info']) if (!inp[f]) inp[f] = {};

    const B = inp.Bridge;
    B.L = asArray(B.L);
    const nsup = B.L.length + 1;
    let typ, a;
    if (Math.abs(B.E / 210e9 - 1) < 0.15) { typ = 'steel'; a = 12e-6; } else { typ = 'concrete'; a = 10e-6; }
    if (has(B, 'Ls') && !has(B, 'L_end')) B.L_end = B.Ls;
    delete B.Ls; delete B.Ls_dV;
    setdef(B, { type: typ, alfa: a, L_end: 0, n_track: 1, FL: nsup, dT: [35, -35], endsprings: [] });
    if (!has(B, 'Kh')) { B.Kh = new Array(nsup).fill(0); B.Kh[B.FL - 1] = 1e13; }
    B.endsprings = asArray(B.endsprings);                         // single object (e.g. from JSON) -> array

    const T = setdef(inp.Track, { type: 'ballasted' });
    if (has(T, 'Fh') && !has(T, 'Fu')) T.Fu = T.Fh;
    if (has(T, 'Fh2') && !has(T, 'Fl')) T.Fl = T.Fh2;
    delete T.Fh; delete T.Fh2;
    const bl = ['ballastless', 'nonballasted', 'nonballated', 'non-ballasted', 'ballastfritt']
        .includes(String(T.type).toLowerCase());
    T.type = bl ? 'ballastless' : 'ballasted';
    setdef(T, { A: 2 * 76.70e-4, I: 2 * 3038.3e-8, E: 210e9, alfa: 12e-6, s_r: 0.65, Le: 100,
                Fl: 60e3, Kv: 80e6, Kv_up: 4e6, gap: [], loaded: 'additive' });
    T.gap = asArray(T.gap);
    if (bl) setdef(T, { e_r: 0.25, u0: [0.5e-3, 0.5e-3], Fu: [40e3, 40e3] });
    else    setdef(T, { e_r: 0.75, u0: [2e-3, 0.5e-3], Fu: [20e3, 30e3] });
    setdef(T, { dT: T.gap.length ? [50, -50] : [0, 0], dT_brk: -50 });

    setdef(inp.Load, { alfa: 1.33, LM71: true, SW: B.L.length > 1, dxPos: 0,
                       qlbk: 20e3, Qlbk_max: 6000e3, qlak: 33e3, Qlak_max: 1000e3 });
    const sl = bl ? [-112, 112] : [-72, 112];
    setdef(inp.Limits, { sig_br: sl.slice(), sig_emb: sl.slice(), dB: 5, dH: 8, dV: 2, wgap: 50 });
    setdef(inp.Info, { name: 'Bro', author: '' });

    const { Tr, Br } = lowlevel(inp, 0);
    const g = geom(Tr, Br);
    const M = { Lb: g.L_b, Ls: g.L_s, Le: g.L_e, L: g.L, s_r: T.s_r, dL: g.dL,
                e_r2: B.h - T.e_r - B.e_b };
    M.xsup = [g.L_s];
    for (const l of g.L) M.xsup.push(M.xsup[M.xsup.length - 1] + l);
    if (M.e_r2 < 0)
        throw new Error('h - e_r - e_b = ' + M.e_r2.toFixed(3) +
                        ' m < 0: the track slip centre lies below the deck neutral axis.');
    return { inp, Model: M };
};

function lowlevel(inp, k) {
    // input of TBI.solve for season k (0 summer, 1 winter)
    const T = inp.Track, B = inp.Bridge;
    const Tr = { A: T.A, I: T.I, E: T.E, alfa: T.alfa, e: T.e_r, s_r: T.s_r, Le: T.Le,
                 u0: T.u0[k], Fh: T.Fu[k], Fh2: T.Fl, Kv: T.Kv, Kv_up: T.Kv_up,
                 loaded: T.loaded, T0: 0, gap: T.gap.slice() };
    for (const f of ['law1', 'law2', 'lawBr1', 'lawBr2', 'lawV']) if (has(T, f)) Tr[f] = T[f];
    const Br = { n_track: B.n_track, A: B.A, I: B.I, E: B.E, alfa: B.alfa, e: B.e_b, h: B.h,
                 L: B.L.slice(), Ls: B.L_end, T0: 0, Kh: B.Kh };
    if (B.endsprings && B.endsprings.length) Br.endsprings = B.endsprings;
    return { Tr, Br };
}

function geom(Track, Bridge) {
    // element s_r/2; L_end and spans to s_r/2; bridge and embankments in
    // whole sleeper spacings (the first span takes the difference)
    const s_r = Track.s_r, dL = s_r / 2;
    const L_s = dL * Math.round(Bridge.Ls / dL);
    const L = Bridge.L.map(l => dL * Math.round(l / dL));
    const sum = L.reduce((a, b) => a + b, 0);
    const L_b = s_r * Math.round((sum + 2 * L_s) / s_r);
    L[0] -= (sum + 2 * L_s) - L_b;
    const L_e = s_r * Math.round(Track.Le / s_r);
    return { dL, L_s, L, L_b, L_e };
}

// ------------------------------------------------------------ SPRING LAWS
function mklaw(x) {
    if (x && typeof x === 'object' && !Array.isArray(x) && x.type) return x;
    if (Array.isArray(x)) return law(...x);
    return law('linear', x);
}

function law(type, ...a) {
    switch (String(type).toLowerCase()) {
    case 'linear': return { type: 'lin', k: a[0], k0: a[0] };
    case 'bilinear': {
        const u0 = a[0], F = a[1], beh = a.length > 2 ? a[2] : 'plastic';
        return String(beh).toLowerCase() === 'plastic'
            ? plasticCurve([[0, 0], [u0, F]])
            : elasticCurve([[-u0, -F], [0, 0], [u0, F]], 0);
    }
    case 'curve': {
        const tab = a[0], beh = a.length > 1 ? a[1] : 'elastic';
        if (String(beh).toLowerCase() === 'plastic') return plasticCurve(tab);
        return elasticCurve(tab, a.length > 2 ? a[2] : 0);
    }
    default: throw new Error("Unknown law type '" + type + "'.");
    }
}

function elasticCurve(tab, d0) {
    const u = tab.map(r => r[0]), F = tab.map(r => r[1]);
    for (let i = 1; i < u.length; i++) if (u[i] <= u[i - 1]) throw new Error('u must be strictly ascending.');
    const s = [];
    for (let i = 0; i < u.length - 1; i++) s.push((F[i + 1] - F[i]) / (u[i + 1] - u[i]));
    const dc = Math.min(Math.max(d0, u[0]), u[u.length - 1]);
    let F0 = F[F.length - 1];
    for (let i = 0; i < u.length - 1; i++)
        if (dc >= u[i] && dc <= u[i + 1]) { F0 = F[i] + s[i] * (dc - u[i]); break; }
    let k0 = 0;
    for (let i = 0; i < u.length - 1; i++) if (u[i] <= d0 && d0 < u[i + 1]) { k0 = s[i]; break; }
    return { type: 'elastic', u, F, s, d0, F0, k0 };
}

function plasticCurve(tab) {
    const u = tab.map(r => r[0]), F = tab.map(r => r[1]);
    if (u[0] !== 0 || F[0] !== 0) throw new Error('The backbone must start at [0 0].');
    for (let i = 1; i < u.length; i++) if (u[i] <= u[i - 1]) throw new Error('u must be strictly ascending.');
    const k0 = F[1] / u[1];
    const A = [], sy = [], H = [];
    for (let i = 1; i < u.length; i++) { A.push(u[i] - F[i] / k0); sy.push(F[i]); }
    for (let i = 0; i < A.length - 1; i++) {
        const h = (sy[i + 1] - sy[i]) / (A[i + 1] - A[i]);
        H.push(isFinite(h) ? h : 0);
    }
    H.push(0);
    return { type: 'plastic', k0, a: A, sy, H };
}

function elasticLaw(d, lw) {
    // nonlinear elastic curve, constant outside the table
    const dd = d + lw.d0, u = lw.u, F = lw.F, n = u.length;
    let f, kt;
    if (dd < u[0]) { f = F[0]; kt = 0; }
    else if (dd >= u[n - 1]) { f = F[n - 1]; kt = dd === u[n - 1] ? lw.s[n - 2] : 0; }
    else {
        let j = 0;
        while (j < n - 2 && dd >= u[j + 1]) j++;
        f = F[j] + lw.s[j] * (dd - u[j]); kt = lw.s[j];
    }
    return [f - lw.F0, kt];
}

function segIndex(x, A) {
    const m = A.length;
    if (!(x >= A[0])) return 0;
    let j = 0;
    while (j < m - 1 && x >= A[j + 1]) j++;
    return j;
}
function yieldF(x, lw) {
    const j = segIndex(x, lw.a);
    return lw.sy[j] + lw.H[j] * (x - lw.a[j]);
}

function plasticLaw(d, dp, al, lw) {
    // 1D elastoplasticity with isotropic hardening on a piecewise linear
    // backbone, closed-form return mapping, consistent tangent
    const k0 = lw.k0, A = lw.a, H = lw.H, m = A.length;
    const ftr = k0 * (d - dp);
    let sg = Math.sign(ftr); if (sg === 0) sg = 1;
    const mag = Math.abs(ftr);
    if (!(mag > yieldF(al, lw) * (1 + 1e-12) + 1e-12)) return [ftr, k0, dp, al];
    const a0 = al;
    let cur = a0, da = 0, Hf = 0;
    for (let pass = 0; pass <= m; pass++) {
        const j = segIndex(cur, A), Hj = H[j];
        const aEnd = j < m - 1 ? A[j + 1] : Infinity;
        const rc = mag - k0 * (cur - a0);
        const dd = (rc - yieldF(cur, lw)) / (k0 + Hj);
        if (cur + dd <= aEnd) { da = cur + dd - a0; Hf = Hj; break; }
        cur = aEnd;
    }
    const an = a0 + da;
    return [sg * yieldF(an, lw), k0 * Hf / (k0 + Hf), dp + sg * da, an];
}

function shiftedLaw(du, FA, u0, Fh, Fh2) {
    let T = FA + Fh2 / u0 * du;  const inT = Math.abs(T) < Fh2;  T = Math.max(Math.min(T, Fh2), -Fh2);
    let F1 = FA + Fh / u0 * du;  const inF = Math.abs(F1) < Fh;  F1 = Math.max(Math.min(F1, Fh), -Fh);
    return [T - F1, Fh2 / u0 * inT - Fh / u0 * inF];
}

// ------------------------------------------------------------ BAND SOLVER
// symmetric band matrix, upper band stored row-wise: a[i*(b+1) + (j-i)]
function bandSolve(a, n, b, rhs) {
    const w = b + 1;
    for (let k = 0; k < n; k++) {
        const piv = a[k * w];
        if (piv === 0 || !isFinite(piv)) throw new Error('Singular stiffness matrix (equation ' + k + ').');
        const iEnd = Math.min(n - 1, k + b);
        for (let i = k + 1; i <= iEnd; i++) {
            const aki = a[k * w + (i - k)];
            if (aki === 0) continue;
            const f = aki / piv;
            const rowI = i * w, rowK = k * w;
            for (let j = i; j <= iEnd; j++) a[rowI + (j - i)] -= f * a[rowK + (j - k)];
            rhs[i] -= f * rhs[k];
        }
    }
    const x = new Float64Array(n);
    for (let k = n - 1; k >= 0; k--) {
        let s = rhs[k];
        const jEnd = Math.min(n - 1, k + b);
        for (let j = k + 1; j <= jEnd; j++) s -= a[k * w + (j - k)] * x[j];
        x[k] = s / a[k * w];
    }
    return x;
}

// ------------------------------------------------------------ LOADS
function lineload(fe, e0, ne, dL, X, q, comp) {
    // equivalent nodal loads of a uniform line load q (N/m) between global
    // positions X[0]..X[1] on elements e0..e0+ne-1 (element e starts at e*dL)
    const x1 = Math.min(X[0], X[1]), x2 = Math.max(X[0], X[1]);
    if (x2 - x1 <= 0 || q === 0) return;
    const g = [-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)], wq = [5 / 9, 8 / 9, 5 / 9];
    const e1 = Math.max(1, Math.floor(x1 / dL) + 1), e2 = Math.min(ne, Math.ceil(x2 / dL));
    for (let e = e1; e <= e2; e++) {
        const x0 = (e - 1) * dL;
        const a = Math.max(x1, x0) - x0, b = Math.min(x2, x0 + dL) - x0;
        if (b <= a) continue;
        const row = fe[e0 + e - 1];
        for (let i = 0; i < 3; i++) {
            const s = a + (b - a) * (1 + g[i]) / 2, ws = (b - a) / 2 * wq[i], xi = s / dL;
            if (comp === 'z') {
                row[1] += -q * ws * (1 - 3 * xi * xi + 2 * xi * xi * xi);
                row[2] += -q * ws * dL * (xi - 2 * xi * xi + xi * xi * xi);
                row[4] += -q * ws * (3 * xi * xi - 2 * xi * xi * xi);
                row[5] += -q * ws * dL * (-xi * xi + xi * xi * xi);
            } else {
                row[0] += q * ws * (1 - xi);
                row[3] += q * ws * xi;
            }
        }
    }
}

// ------------------------------------------------------------ ONE LOAD CASE
TBI.solve = function (Track, Bridge, Load, Opt0) {
    const Opt = Object.assign({ geomNL: true, nInc: [1, 1], tol: 1e-9, maxIt: 60, maxBisect: 8,
                                lineSearch: true, solviaOffset: false, roundLoads: false }, Opt0 || {});
    const { dL, L_s, L, L_b, L_e } = geom(Track, Bridge);
    const s_r = Track.s_r, Ltot = 2 * L_e + L_b;
    const h = Math.max(2e-3, Bridge.h), e_b = Math.max(1e-3, Bridge.e);
    const e_r1 = Track.e, e_r2 = h - e_r1 - e_b;
    const nt = Bridge.n_track || 1;
    const K_v = has(Track, 'Kpad') ? Track.Kpad : Track.Kv;
    const shifted = String(Track.loaded || '').toLowerCase() === 'shifted';

    const nr = Math.round(Ltot / dL) + 1, nd = Math.round(L_b / dL) + 1;
    const nn = nt * nr + nd, ndof = 3 * nn;
    const rn = (k, x) => k * nr + Math.round(x / dL);              // rail node (0-based) of track k at global x
    const dn = x => nt * nr + Math.round((x - L_e) / dL);          // deck node at global x
    const xsup = [L_e + L_s];
    for (const l of L) xsup.push(xsup[xsup.length - 1] + l);
    const nsup = xsup.length;

    // equation numbers: nodes sorted by x (rails and deck interleaved) -> narrow band
    const nodeX = new Float64Array(nn), nodeKind = new Int32Array(nn);
    for (let k = 0; k < nt; k++) for (let i = 0; i < nr; i++) { nodeX[k * nr + i] = i * dL; nodeKind[k * nr + i] = k; }
    for (let i = 0; i < nd; i++) { nodeX[nt * nr + i] = L_e + i * dL; nodeKind[nt * nr + i] = nt; }
    const order = Array.from({ length: nn }, (_, i) => i)
        .sort((p, q) => (nodeX[p] - nodeX[q]) || (nodeKind[p] - nodeKind[q]));
    const eqOfNode = new Int32Array(nn);
    order.forEach((node, i) => { eqOfNode[node] = i; });
    const eq = d => 3 * eqOfNode[Math.floor(d / 3)] + (d % 3);  // dof (node*3+c) -> equation
    const dof = (node, c) => 3 * node + c;

    // elements
    const ner = nr - 1, ned = nd - 1, ne = nt * ner + ned;
    const eN1 = new Int32Array(ne), EA = new Float64Array(ne), EI = new Float64Array(ne), eth = new Float64Array(ne);
    for (let k = 0; k < nt; k++) for (let i = 0; i < ner; i++) {
        const e = k * ner + i;
        eN1[e] = k * nr + i; EA[e] = Track.E * Track.A; EI[e] = Track.E * Track.I;
        eth[e] = Track.alfa * (Load.TR - Track.T0);
    }
    for (let i = 0; i < ned; i++) {
        const e = nt * ner + i;
        eN1[e] = nt * nr + i; EA[e] = Bridge.E * Bridge.A; EI[e] = Bridge.E * Bridge.I;
        eth[e] = Bridge.alfa * (Load.TD - Bridge.T0);
    }
    const alive = new Uint8Array(ne).fill(1);
    for (const g of (Track.gap || []))
        for (let k = 0; k < nt; k++) alive[k * ner + Math.round((g + L_e) / dL)] = 0;
    for (let e = 0; e < ne; e++) if (!alive[e]) { EA[e] = 0; EI[e] = 0; }
    const kill = new Uint8Array(ne);
    let anyKill = false;
    if (has(Track, 'brk') && Track.brk !== null && !(Array.isArray(Track.brk) && !Track.brk.length)) {
        for (const xb of asArray(Track.brk)) {
            const e = Math.round((xb + L_e) / dL);
            if (alive[e]) { kill[e] = 1; anyKill = true; }
        }
    }
    const fK = Array.from({ length: ne }, () => new Float64Array(6));
    let relF = 1;
    const eD = Array.from({ length: ne }, (_, e) => {
        const n1 = eN1[e];
        return [dof(n1, 0), dof(n1, 1), dof(n1, 2), dof(n1 + 1, 0), dof(n1 + 1, 1), dof(n1 + 1, 2)];
    });
    const iw = [1, 2, 4, 5], l = dL;
    const Gm = [[36, 3 * l, -36, 3 * l], [3 * l, 4 * l * l, -3 * l, -l * l],
                [-36, -3 * l, 36, -3 * l], [3 * l, -l * l, -3 * l, 4 * l * l]].map(r => r.map(v => v / (30 * l)));
    const Kb = [[12, 6 * l, -12, 6 * l], [6 * l, 4 * l * l, -6 * l, 2 * l * l],
                [-12, -6 * l, 12, -6 * l], [6 * l, 2 * l * l, -6 * l, 4 * l * l]].map(r => r.map(v => v / (l * l * l)));

    // traffic loads (step 2), equivalent nodal forces per element
    const ftr = Array.from({ length: ne }, () => new Float64Array(6));
    const rl = Opt.roundLoads ? (X => X.map(x => dL * Math.round(x / dL))) : (X => X);
    const seg = [];
    for (let k = 0; k < nt; k++) {
        let sk = Load.Seg || [];
        if (sk.length && Array.isArray(sk[0]) && Array.isArray(sk[0][0])) sk = sk[k];   // one table per track
        seg.push(sk.filter(r => r[2] !== 0));
        for (const r of seg[k]) lineload(ftr, k * ner, ner, dL, rl([L_e + r[0], L_e + r[1]]), r[2], 'z');
    }
    for (const r of (Load.BrkPos || [])) lineload(ftr, 0, ner, dL, rl([L_e + r[0], L_e + r[1]]), Load.qlbk, 'x');
    const kAcc = Math.min(nt, 2) - 1;
    for (const r of (Load.AccPos || [])) lineload(ftr, kAcc * ner, ner, dL, rl([L_e + r[0], L_e + r[1]]), Load.qlak, 'x');
    for (let e = 0; e < ne; e++) if (!alive[e]) ftr[e].fill(0);
    const Ftr = new Float64Array(ndof);
    for (let e = 0; e < ne; e++) for (let i = 0; i < 6; i++) Ftr[eD[e][i]] += ftr[e][i];
    const tF = [0, 1, 1], qF = [0, 0, 1];

    // springs
    const nseg = Math.round(Ltot / s_r);
    const xs = Array.from({ length: nseg + 1 }, (_, p) => p * s_r);
    const onBr = xs.map(x => x >= L_e - 1e-9 && x <= L_e + L_b + 1e-9);
    const law1 = has(Track, 'law1') ? mklaw(Track.law1) : law('bilinear', Track.u0, Track.Fh);
    const law2 = has(Track, 'law2') ? mklaw(Track.law2) : law('bilinear', Track.u0, Track.Fh2 - Track.Fh);
    const lawB1 = has(Track, 'lawBr1') ? mklaw(Track.lawBr1) : law1;
    const lawB2 = has(Track, 'lawBr2') ? mklaw(Track.lawBr2) : law2;
    let lawV;
    if (has(Track, 'lawV')) lawV = mklaw(Track.lawV);
    else if (has(Track, 'Kv_up') && Track.Kv_up !== null) lawV = law('curve', [[-1, -K_v], [0, 0], [1, Track.Kv_up]], 'elastic');
    else lawV = law('linear', K_v);
    const laws = [law1, lawB1, law2, lawB2, lawV];                // law ids 0..4
    const act = Array.from({ length: nt }, () => new Uint8Array(nseg + 1));
    const ext = (Load.LoadedPos && Load.LoadedPos.length)
        ? Array.from({ length: nt }, () => Load.LoadedPos) : seg.map(s => s.map(r => [r[0], r[1]]));
    for (let k = 0; k < nt; k++) for (const r of ext[k]) {
        const a1 = Math.max(0, Math.ceil((L_e + r[0]) / s_r - 1e-9));
        const a2 = Math.min(nseg, Math.floor((L_e + r[1]) / s_r + 1e-9));
        for (let p = a1; p <= a2; p++) act[k][p] = 1;
    }
    const sp = [];                                                // {d: dofs, c: coefs, id, sc, birth, kind, trk, pos, partner}
    const addSpring = (d, c, id, sc, birth, kind, trk, pos, partner) =>
        { sp.push({ d, c, id, sc, birth, kind, trk, pos, partner }); return sp.length - 1; };
    for (let k = 0; k < nt; k++) for (let p = 0; p <= nseg; p++) {
        const r = rn(k, xs[p]);
        const hd = [dof(r, 0), dof(r, 2)], hc = [1, e_r1];
        const vd = [dof(r, 1)], vc = [1];
        if (Opt.solviaOffset) { vd.push(dof(r, 2)); vc.push(dL); }
        if (onBr[p]) {
            const q = dn(xs[p]);
            hd.push(dof(q, 0), dof(q, 2)); hc.push(-1, e_r2);
            vd.push(dof(q, 1)); vc.push(-1);
        }
        const i1 = addSpring(hd, hc, onBr[p] ? 1 : 0, s_r, 1, 1, k, p, -1);
        if (act[k][p]) addSpring(hd, hc, onBr[p] ? 3 : 2, s_r, 2, 2, k, p, i1);
        addSpring(vd, vc, 4, 1, 1, 3, k, p, -1);
    }
    const fixed = [];
    for (let i = 0; i < nsup; i++) {
        const q = dn(xsup[i]);
        fixed.push(dof(q, 1));
        const kh = Bridge.Kh;
        laws.push(Array.isArray(kh) ? mklaw(kh[i]) : law('linear', kh));
        addSpring([dof(q, 0), dof(q, 2)], [1, e_b], laws.length - 1, 1, 1, 4, -1, i, -1);
    }
    for (const E of (Bridge.endsprings || [])) {
        const left = String(E.side).toLowerCase() === 'left';
        const q = left ? dn(L_e) : dn(L_e + L_b), sg = left ? -1 : 1;
        laws.push(mklaw(E.law));
        addSpring([dof(q, 0), dof(q, 2)], [sg, -sg * (E.z - e_b)], laws.length - 1, 1, 1, 5, -1, 0, -1);
    }
    if (shifted && !(has(Track, 'u0') && has(Track, 'Fh') && has(Track, 'Fh2')))
        throw new Error("'shifted' needs Track.u0, Fh and Fh2 (bilinear resistance).");
    const ns = sp.length;
    const kreg = sp.map(s => 1e-6 * Math.abs(laws[s.id].k0) * s.sc);
    for (let k = 0; k < nt; k++) for (const x of [0, Ltot]) { const r = rn(k, x); fixed.push(dof(r, 0), dof(r, 1), dof(r, 2)); }
    const isFree = new Uint8Array(ndof).fill(1);
    for (const d of fixed) isFree[d] = 0;

    // band width (equations)
    let bw = 0;
    for (let e = 0; e < ne; e++) {
        const q = eD[e].map(eq);
        bw = Math.max(bw, Math.max(...q) - Math.min(...q));
    }
    for (const s of sp) { const q = s.d.map(eq); bw = Math.max(bw, Math.max(...q) - Math.min(...q)); }
    const W = bw + 1;

    // ---- element internal forces and tangent
    function elem(U, tf, Kband) {
        const fint = new Float64Array(ndof), N = new Float64Array(ne);
        const fes = Kband === 'fe' ? [] : null;
        for (let e = 0; e < ne; e++) {
            const ed = eD[e];
            const de = ed.map(d => U[d]);
            const dw = [de[1], de[2], de[4], de[5]];
            const Gd = [0, 0, 0, 0];
            let eps = (de[3] - de[0]) / l;
            if (Opt.geomNL) {
                for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) Gd[i] += Gm[i][j] * dw[j];
                eps += 0.5 / l * (dw[0] * Gd[0] + dw[1] * Gd[1] + dw[2] * Gd[2] + dw[3] * Gd[3]);
            }
            const Ne = EA[e] * (eps - tf * eth[e]);
            N[e] = Ne;
            const be = [-1 / l, Gd[0] / l, Gd[1] / l, 1 / l, Gd[2] / l, Gd[3] / l];
            const fe = be.map(v => Ne * l * v);
            for (let i = 0; i < 4; i++) {
                let s = 0;
                for (let j = 0; j < 4; j++) s += Kb[i][j] * dw[j];
                fe[iw[i]] += EI[e] * s;
            }
            if (relF < 1 && kill[e]) for (let i = 0; i < 6; i++) fe[i] += (1 - relF) * fK[e][i];
            for (let i = 0; i < 6; i++) fint[ed[i]] += fe[i];
            if (fes) fes.push(fe);
            if (Kband && Kband !== 'fe' && EA[e] !== 0) {
                const ke = [];
                for (let i = 0; i < 6; i++) { ke.push(new Float64Array(6)); for (let j = 0; j < 6; j++) ke[i][j] = EA[e] * l * be[i] * be[j]; }
                for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
                    ke[iw[i]][iw[j]] += EI[e] * Kb[i][j] + (Opt.geomNL ? Ne * Gm[i][j] : 0);
                }
                const q = ed.map(eq);
                for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
                    if (q[j] >= q[i]) Kband[q[i] * W + (q[j] - q[i])] += ke[i][j];
                }
            }
        }
        return { fint, N, fes };
    }

    // ---- springs: forces, tangents, trial plastic state
    function springs(U, dp, al, on, dref, FA) {
        const f = new Float64Array(ns), kt = new Float64Array(ns);
        const dpT = Float64Array.from(dp), alT = Float64Array.from(al);
        for (let i = 0; i < ns; i++) {
            if (!on[i]) continue;
            const s = sp[i];
            let dd = -dref[i];
            for (let j = 0; j < s.d.length; j++) dd += s.c[j] * U[s.d[j]];
            const lw = laws[s.id];
            let fg, kg;
            if (shifted && (s.id === 2 || s.id === 3)) [fg, kg] = shiftedLaw(dd, FA[i], Track.u0, Track.Fh, Track.Fh2);
            else if (lw.type === 'lin') { fg = lw.k * dd; kg = lw.k; }
            else if (lw.type === 'elastic') [fg, kg] = elasticLaw(dd, lw);
            else [fg, kg, dpT[i], alT[i]] = plasticLaw(dd, dp[i], al[i], lw);
            f[i] = fg * s.sc; kt[i] = kg * s.sc;
        }
        return { f, kt, dpT, alT };
    }

    const norm = (v, free) => { let s = 0; for (let i = 0; i < v.length; i++) if (!free || isFree[i]) s += v[i] * v[i]; return Math.sqrt(s); };
    function residual(Fx, fint, f) {
        const R = new Float64Array(ndof);
        for (let i = 0; i < ndof; i++) R[i] = Fx[i] - fint[i];
        for (let i = 0; i < ns; i++) { if (f[i] === 0) continue; const s = sp[i]; for (let j = 0; j < s.d.length; j++) R[s.d[j]] -= s.c[j] * f[i]; }
        return R;
    }

    // ---- Newton-Raphson
    function newton(U, dp, al, Fx, tf, on, Fref, dref, FA) {
        let sres = springs(U, dp, al, on, dref, FA);
        let el = elem(U, tf, null);
        let R = residual(Fx, el.fint, sres.f), rn0 = norm(R, true);
        let ok = rn0 <= Opt.tol * Fref, it = 0;
        while (!ok && it < Opt.maxIt) {
            it++;
            const K = new Float64Array(ndof * W);
            elem(U, tf, K);
            for (let i = 0; i < ns; i++) {
                const kk = sres.kt[i] + (on[i] ? kreg[i] : 0);
                if (kk === 0) continue;
                const s = sp[i];
                for (let a = 0; a < s.d.length; a++) for (let b = 0; b < s.d.length; b++) {
                    const qa = eq(s.d[a]), qb = eq(s.d[b]);
                    if (qb >= qa) K[qa * W + (qb - qa)] += kk * s.c[a] * s.c[b];
                }
            }
            const rhs = new Float64Array(ndof);
            for (let d = 0; d < ndof; d++) {
                const q = eq(d);
                if (isFree[d]) rhs[q] = R[d];
                else {                                            // fixed dof: identity row/column
                    for (let j = 0; j < W; j++) K[q * W + j] = 0;
                    for (let i = Math.max(0, q - bw); i < q; i++) K[i * W + (q - i)] = 0;
                    K[q * W] = 1; rhs[q] = 0;
                }
            }
            const x = bandSolve(K, ndof, bw, rhs);
            const du = new Float64Array(ndof);
            for (let d = 0; d < ndof; d++) du[d] = x[eq(d)];
            let eta = 1, Ut = U.map((v, i) => v + du[i]);
            sres = springs(Ut, dp, al, on, dref, FA);
            el = elem(Ut, tf, null);
            let Rt = residual(Fx, el.fint, sres.f), rt = norm(Rt, true);
            if (Opt.lineSearch) {
                let nls = 0;
                while (rt > rn0 && nls < 8) {
                    eta /= 2; nls++;
                    Ut = U.map((v, i) => v + eta * du[i]);
                    sres = springs(Ut, dp, al, on, dref, FA);
                    el = elem(Ut, tf, null);
                    Rt = residual(Fx, el.fint, sres.f); rt = norm(Rt, true);
                }
            }
            U = Ut; R = Rt; rn0 = rt;
            ok = rn0 <= Opt.tol * Fref ||
                 (eta * norm(du, false) <= 1e-10 * Math.max(norm(U, false), 1e-6) && rn0 <= 1e-6 * Fref);
        }
        return { U, dp: sres.dpT, al: sres.alT, ok, it };
    }

    function solveStep(U, dp, al, st, on, nInc, dref, FA) {
        let lam = 0, dlam = 1 / nInc, itTot = 0, ninc = 0, nbis = 0;
        relF = 1;
        const z = new Float64Array(ndof);
        let fkn = 0;
        for (let e = 0; e < ne; e++) for (let i = 0; i < 6; i++) fkn += fK[e][i] * fK[e][i];
        const Fref = Math.max(norm(Ftr, true) * qF[st], norm(elem(z, tF[st], null).fint, false), Math.sqrt(fkn), 1);
        while (lam < 1 - 1e-12) {
            const dl = Math.min(dlam, 1 - lam), lt = lam + dl;
            const tf = tF[st - 1] + lt * (tF[st] - tF[st - 1]);
            if (st === 2) relF = lt;
            const qf = qF[st - 1] + lt * (qF[st] - qF[st - 1]);
            const Fx = Ftr.map(v => qf * v);
            const r = newton(U, dp, al, Fx, tf, on, Fref, dref, FA);
            itTot += r.it;
            if (r.ok) { U = r.U; dp = r.dp; al = r.al; lam = lt; ninc++; }
            else {
                nbis++;
                if (nbis > Opt.maxBisect)
                    throw new Error('No convergence after ' + (nbis - 1) + ' bisections (step ' + st + ', lambda = ' + lam.toFixed(4) + ').');
                dlam = dl / 2;
            }
        }
        return { U, dp, al, it: itTot, ninc };
    }

    // ---- steps 1 and 2
    let U = new Float64Array(ndof), dp = new Float64Array(ns), al = new Float64Array(ns);
    const dref = new Float64Array(ns), FA = new Float64Array(ns);
    const Ust = [], Fsp = [];
    const Info = { inc: [0, 0], it: [0, 0], nsp: ns, ndof, band: bw };
    // step 1 does not depend on the traffic loads or on the loaded springs
    // (set 2): its state can be saved and reused by load cases with the same
    // model and temperature (Opt.state1, returned as R.state1)
    const b1 = [];
    for (let i = 0; i < ns; i++) if (sp[i].birth === 1) b1.push(i);
    const S1 = Opt.state1;
    const reuse1 = S1 && S1.ndof === ndof && S1.n1 === b1.length;    // a rail break acts only in step 2
    let state1 = null;
    for (let st = 1; st <= 2; st++) {
        const on = sp.map(s => s.birth <= st);
        if (st > 1) {
            const born = sp.map(s => s.birth === st);
            for (let i = 0; i < ns; i++) if (born[i]) {
                let v = 0; const s = sp[i];
                for (let j = 0; j < s.d.length; j++) v += s.c[j] * U[s.d[j]];
                dref[i] = v;
            }
            if (shifted && born.some(Boolean)) {
                const f1 = springs(U, dp, al, sp.map(s => s.birth <= 1), dref, FA).f;
                for (let i = 0; i < ns; i++) if (born[i]) FA[i] = f1[sp[i].partner] / sp[sp[i].partner].sc;
            }
            if (anyKill) {
                const fe1 = elem(U, tF[st - 1], 'fe').fes;
                for (let e = 0; e < ne; e++) if (kill[e]) { fK[e] = Float64Array.from(fe1[e]); EA[e] = 0; EI[e] = 0; }
            }
        }
        const nInc = Opt.nInc[Math.min(st, Opt.nInc.length) - 1];
        let r;
        if (st === 1 && reuse1) {
            r = { U: Float64Array.from(S1.U), dp: new Float64Array(ns), al: new Float64Array(ns), it: S1.it, ninc: S1.ninc };
            b1.forEach((i, j) => { r.dp[i] = S1.dp[j]; r.al[i] = S1.al[j]; });
        } else r = solveStep(U, dp, al, st, on, nInc, dref, FA);
        U = r.U; dp = r.dp; al = r.al;
        if (st === 1)
            state1 = { ndof, n1: b1.length, U: Float64Array.from(U), dp: Float64Array.from(b1, i => dp[i]),
                       al: Float64Array.from(b1, i => al[i]), it: r.it, ninc: r.ninc };
        relF = 1;
        Ust.push(U);
        Fsp.push(springs(U, dp, al, on, dref, FA).f);
        Info.inc[st - 1] = r.ninc; Info.it[st - 1] = r.it;
    }

    // ---- results
    const xr = Array.from({ length: nr }, (_, i) => i * dL);
    const ResTr = [];
    for (let k = 0; k < nt; k++) {
        const T = { x: xr, dx: [], Sr: [] };
        for (let st = 0; st < 2; st++) {
            T.dx.push(xr.map((_, i) => Ust[st][dof(k * nr + i, 0)]));
            const N = elem(Ust[st], tF[st + 1], null).N;
            const s = [];
            for (let i = 0; i < ner; i++) {
                const e = k * ner + i;
                s.push(!alive[e] || (st === 1 && kill[e]) ? NaN : N[e] / Track.A);
            }
            s.push(s[s.length - 1]);
            T.Sr.push(s);
        }
        if (k === 0 && anyKill) {
            for (let i = 0; i < ner; i++) if (kill[i]) {
                T.wbrk = T.dx[1][i + 1] - T.dx[1][i] - dL * Track.alfa * (Load.TR - Track.T0);
            }
        }
        ResTr.push(T);
    }
    const qn = [];
    for (let i = 0; i < nd; i += 2) qn.push(nt * nr + i);
    const ResBr = {
        x: qn.map((_, j) => 2 * j * dL),
        dx: Ust.map(Us => qn.map(q => Us[dof(q, 0)] - e_r2 * Us[dof(q, 2)])),
        dy: Ust.map(Us => qn.map(q => Us[dof(q, 1)])),
        thsup: Ust.map(Us => xsup.map(x => Us[dof(dn(x), 2)])),
        Rh: Fsp.map(f => sp.map((s, i) => (s.kind === 4 ? -f[i] : null)).filter(v => v !== null)),
        Res: Fsp.map(f => sp.map((s, i) => (s.kind === 5 ? f[i] : null)).filter(v => v !== null))
    };
    return { ResTr1: ResTr[0], ResTr2: nt === 2 ? ResTr[1] : null, ResBr, Info, state1 };
};

// ------------------------------------------------------------ COMPLETE ANALYSIS
function atSeats(S) {
    // rail stress at the rail seats (every second rail node): mean of the
    // elements on both sides of the seat (NaN ignored)
    const out = [];
    for (let i = 0; i < S.length; i += 2) {
        const a = S[Math.max(i - 1, 0)], b = S[i];
        const v = [a, b].filter(x => !isNaN(x));
        out.push(v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN);
    }
    return out;
}

function smax(a, b) { return a.map((v, i) => (Math.abs(b[i]) > Math.abs(v) ? b[i] : v)); }

function clipseg(rows, Lb, q, lmin) {
    return rows.map(r => [Math.min(Math.max(r[0], 0), Lb), Math.min(Math.max(r[1], 0), Lb)])
               .filter(r => r[1] - r[0] >= lmin).map(r => [r[0], r[1], q]);
}

const tick = () => new Promise(r => setTimeout(r, 0));

// ------------------------------------------------------------ PARALLEL RUNS
// The load cases are solved in Web Workers (one per core, kept between runs).
// Without workers (no Worker support, page opened as a file, opt.workers = 0)
// they run on the main thread, which yields to the browser only when the
// progress bar is updated (about every 0.2 s).
const SRC = (typeof document !== 'undefined' && document.currentScript) ? document.currentScript.src : null;
const DT_PROG = 200;                                              // ms between progress updates
let pool = null;                                                  // Promise -> [Worker] or null
let runId = 0;

function makePool(n) {
    if (!SRC || typeof Worker === 'undefined' || typeof Blob === 'undefined' || /^file:/i.test(SRC))
        return Promise.resolve(null);
    const code = 'importScripts(' + JSON.stringify(SRC) + ');\n' +
        'postMessage({ ready: true });\n' +
        'onmessage = function (e) {\n' +
        '    var m = e.data;\n' +
        '    try { postMessage({ rid: m.rid, id: m.id, R: TBI.solve(m.Tr, m.Br, m.Lk, m.Os) }); }\n' +
        '    catch (err) { postMessage({ rid: m.rid, id: m.id, error: String((err && err.message) || err) }); }\n' +
        '};\n';
    let url;
    try { url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); }
    catch (e) { return Promise.resolve(null); }
    const start = () => new Promise(res => {
        let w;
        try { w = new Worker(url); } catch (e) { res(null); return; }
        const to = setTimeout(() => { w.terminate(); res(null); }, 5000);
        w.onmessage = e => { if (e.data && e.data.ready) { clearTimeout(to); res(w); } };
        w.onerror = ev => { if (ev && ev.preventDefault) ev.preventDefault(); clearTimeout(to); w.terminate(); res(null); };
    });
    return Promise.all(Array.from({ length: n }, start)).then(ws => {
        ws = ws.filter(Boolean);
        return ws.length ? ws : null;
    });
}

function getWorkers(opt) {
    if (opt.workers === 0 || opt.workers === false) return Promise.resolve(null);
    if (!pool) {
        const nc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
        pool = makePool(Math.max(1, Math.min(16, nc - 1)));
    }
    return pool;
}

// jobs: [{Tr, Br, Lk, Os}] -> results in the same order; done() after every job
async function runJobs(jobs, workers, done) {
    const res = new Array(jobs.length);
    const solveHere = async idx => {
        for (const i of idx) {
            const j = jobs[i];
            res[i] = TBI.solve(j.Tr, j.Br, j.Lk, j.Os);
            await done();
        }
    };
    if (!workers || !jobs.length) { await solveHere(jobs.map((_, i) => i)); return res; }
    const rid = ++runId;
    const lost = await new Promise((resolve, reject) => {
        let next = 0, left = jobs.length, stop = false;
        const send = w => {
            if (stop || next >= jobs.length) return;
            const i = next++, j = jobs[i];
            w.postMessage({ rid, id: i, Tr: j.Tr, Br: j.Br, Lk: j.Lk, Os: j.Os });
        };
        for (const w of workers) {
            w.onmessage = e => {
                const m = e.data;
                if (stop || !m || m.rid !== rid) return;
                if (m.error) { stop = true; reject(new Error(m.error)); return; }
                res[m.id] = m.R; left--;
                done();
                if (!left) resolve(null); else send(w);
            };
            w.onerror = ev => {                                   // worker lost: finish on the main thread
                if (ev && ev.preventDefault) ev.preventDefault();
                if (stop) return;
                stop = true;
                workers.forEach(x => x.terminate());
                pool = Promise.resolve(null);
                resolve(res.map((r, i) => (r ? -1 : i)).filter(i => i >= 0));
            };
        }
        workers.forEach(send);
    });
    if (lost) await solveHere(lost);
    return res;
}

TBI.analysis = async function (inp0, opt) {
    opt = opt || {};
    const t0 = performance.now();
    const { inp, Model: M } = TBI.defaults(inp0);
    const B = inp.Bridge, T = inp.Track, Ld = inp.Load, Lim = inp.Limits;
    const Lb = M.Lb, nsup = M.xsup.length, nt = B.n_track, alfa = Ld.alfa;
    const sig_emb = T.dT.map(d => -T.E * T.alfa * d / 1e6);
    const TrS = [0, 1].map(k => lowlevel(inp, k));
    const Os = Object.assign({}, opt.solver || {});
    const workers = await getWorkers(opt);
    let nRun = 0;

    // load arrangements
    const qvk = 80e3, aLoco = 6.4, qloco = 4 * 250e3 / aLoco - qvk;
    const qSW = 133e3, aSW = 15, cSW = 5.3, lSW = 2 * aSW + cSW;
    const segLM = x => [[0, Lb, alfa * qvk], [Math.max(0, x), Math.min(Lb, x + aLoco), alfa * qloco]];
    const segSW = x => clipseg([[x, x + aSW], [x + aSW + cSW, x + lSW]], Lb, alfa * qSW, 2 * T.s_r);
    const Kh = Array.isArray(B.Kh) ? B.Kh : new Array(nsup).fill(B.Kh);
    const mov = [isMovable(Kh[0]), isMovable(Kh[nsup - 1])];
    let xl, x0;
    if (!mov[0] && mov[1]) { xl = [M.xsup[nsup - 1] - aLoco]; x0 = [M.xsup[nsup - 1] - lSW]; }
    else { xl = [M.xsup[0]]; x0 = [M.xsup[0]]; }
    if (Ld.dxPos > 0) {
        xl = [];
        for (let x = 0; x <= Math.max(0, Lb - aLoco) + 1e-9; x += Ld.dxPos) xl.push(x);
        if (Lb - aLoco - xl[xl.length - 1] > 1e-6) xl.push(Lb - aLoco);
        x0 = [];
        for (let x = -lSW; x <= Lb + 1e-9; x += Ld.dxPos) if (segSW(x).length) x0.push(x);
    }
    const Lbrk = Math.min(Lb, Ld.Qlbk_max / Ld.qlbk), Lacc = Math.min(Lb, Ld.Qlak_max / Ld.qlak);
    const H = [];
    const sideB = Lbrk < Lb - 1e-6 ? ['v', 'h'] : ['v'], sideA = Lacc < Lb - 1e-6 ? ['v', 'h'] : ['v'];
    const dtxt = ['towards right', 'towards left'], dsg = [1, -1];
    const btxt = { v: sideB.length === 1 ? '' : ' from left end', h: ' to right end' };
    const atxt = { v: ' from left end', h: ' from right end' };
    for (let d = 0; d < 2; d++) {
        for (const s of sideB) H.push({ name: 'braking ' + dtxt[d] + btxt[s], fb: dsg[d], fa: 0, sb: s, sa: 'v' });
        for (const s of sideA) {
            H.push({ name: 'traction ' + dtxt[d] + atxt[s], fb: 0, fa: dsg[d], sb: 'v', sa: s });
            if (nt === 2) H.push({ name: 'braking and traction ' + dtxt[d] + ', traction' + atxt[s], fb: dsg[d], fa: dsg[d], sb: 'v', sa: s });
        }
    }
    const place = (sd, Lh, env) => (sd === 'v' ? [env[0], Math.min(env[1], env[0] + Lh)] : [Math.max(env[0], env[1] - Lh), env[1]]);
    const hpos = (hh, env) => [hh.fb !== 0 ? [place(hh.sb, Lbrk, env)] : [], hh.fa !== 0 ? [place(hh.sa, Lacc, env)] : []];

    // progress, at most every DT_PROG ms (also the yield of the main thread)
    const nV = 2 * ((Ld.LM71 ? xl.length : 0) + (Ld.SW ? x0.length : 0));
    let nTot = 3 + 3 + nV + 2 * H.length + 2 * 5 * H.length, pdone = 0, tProg = performance.now();
    async function done() {
        nRun++;
        if (performance.now() - tProg < DT_PROG) return;
        if (opt.progress) {
            pdone = Math.max(pdone, Math.min(nRun / nTot, 0.99));
            opt.progress(pdone);
        }
        if (!workers) await tick();
        tProg = performance.now();
    }

    // one load case: job for TBI.solve and the processing of its result
    const job = (k, temp, Seg, Lpos, bp, ap, fb, fa, S1) => ({
        k, temp, Tr: TrS[k].Tr, Br: TrS[k].Br,
        Lk: { TD: temp * B.dT[k], TR: temp * T.dT[k], Seg, LoadedPos: Lpos,
              qlbk: alfa * Ld.qlbk * fb, BrkPos: bp, qlak: alfa * Ld.qlak * fa, AccPos: ap },
        Os: S1 ? Object.assign({}, Os, { state1: S1 }) : Os });
    function post(R, jb) {
        const k = jb.k, temp = jb.temp;
        const r = { x: [], state1: R.state1 };
        for (let i = 0; i < R.ResTr1.x.length; i += 2) r.x.push(R.ResTr1.x[i] - M.Le);
        r.S = [R.ResTr1.Sr.map(s => atSeats(s).map(v => v / 1e6 - temp * sig_emb[k]))];   // [track][step][seat]
        if (nt === 2) r.S.push(R.ResTr2.Sr.map(s => atSeats(s).map(v => v / 1e6 - temp * sig_emb[k])));
        r.dx = R.ResBr.dx; r.dy = R.ResBr.dy; r.xb = R.ResBr.x; r.Rh = R.ResBr.Rh.map(v => v.map(f => f / 1e3));
        r.gap = T.gap.map(g => {
            const ie = Math.round((g + M.Le) / M.dL);
            return 1e3 * (R.ResTr1.dx[1][ie + 1] - R.ResTr1.dx[1][ie]);
        });
        return r;
    }

    // ---- round 1: temperature, rail break (intact rail), vertical traffic
    // sweeps, braking/acceleration; all independent
    const Lw = { TD: B.dT[1], TR: T.dT_brk, Seg: [], LoadedPos: [], qlbk: 0, BrkPos: [], qlak: 0, AccPos: [] };
    const sweeps = [];
    if (Ld.LM71) sweeps.push({ typ: 'LM71', xp: xl, segf: segLM, envf: () => [[0, Lb]], g: 'LM71' });
    if (Ld.SW) sweeps.push({ typ: 'SW/0', xp: x0, segf: segSW, envf: segSW, g: 'SW' });
    const J1 = [job(0, 1, [], [], [], [], 0, 0), job(1, 1, [], [], [], [], 0, 0),
                { Tr: TrS[1].Tr, Br: TrS[1].Br, Lk: Lw, Os }];
    for (const sw of sweeps) for (let kv = 0; kv < 2; kv++) for (const xx of sw.xp) {
        const sg = sw.segf(xx);
        J1.push(job(kv, 0, sg, sg.map(s => [s[0], s[1]]), [], [], 0, 0));
    }
    const iH = J1.length;
    for (let k = 0; k < 2; k++) for (const hh of H) {
        const [bp, ap] = hpos(hh, [0, Lb]);
        J1.push(job(k, 0, [], [[0, Lb]], bp, ap, hh.fb, hh.fa));
    }
    const R1all = await runJobs(J1, workers, done);

    // temperature
    const tempR = [post(R1all[0], J1[0]), post(R1all[1], J1[1])];
    let r = tempR[0];
    const x = r.x, nr = x.length;
    const onBr = x.map(v => v > -1e-9 && v < Lb + 1e-9);
    const groups = ['temp', 'LM71', 'SW', 'brk', 'acc', 'comb'];
    const G = {}, Rh = {};
    for (const g of groups) {
        G[g] = { min: [new Array(nr).fill(NaN), new Array(nr).fill(NaN)], max: [new Array(nr).fill(NaN), new Array(nr).fill(NaN)] };
        Rh[g] = [new Array(nsup).fill(0), new Array(nsup).fill(0)];
    }
    const z2 = () => [[0, 0], [0, 0]];
    const dTemp = z2(), dB = z2(), dA = z2(), dH = z2(), dV = z2();
    const ng = T.gap.length;
    const gapOpen = { temp: [new Array(ng).fill(0), new Array(ng).fill(0)],
                      combMin: [new Array(ng).fill(Infinity), new Array(ng).fill(Infinity)],
                      combMax: [new Array(ng).fill(-Infinity), new Array(ng).fill(-Infinity)] };
    const addEnv = (E, S, k) => {
        for (const St of S) {
            const s = St[1];
            for (let i = 0; i < s.length; i++) {
                if (isNaN(s[i])) continue;
                if (!(s[i] >= E.min[k][i])) E.min[k][i] = s[i];
                if (!(s[i] <= E.max[k][i])) E.max[k][i] = s[i];
            }
        }
    };
    const ends = a => [a[0], a[a.length - 1]];
    for (let k = 0; k < 2; k++) {
        r = tempR[k];
        addEnv(G.temp, r.S, k);
        Rh.temp[k] = r.Rh[1].slice();
        dTemp[k] = ends(r.dx[1]).map(v => 1e3 * v);
        gapOpen.temp[k] = r.gap.slice();
    }

    // rail break, CEN/TR 17231 A.2: candidate positions from the intact rail
    const R1 = R1all[2];
    const xr1 = R1.ResTr1.x.map(v => v - M.Le), s1 = R1.ResTr1.Sr[0].slice();
    s1[s1.length - 1] = NaN;
    let im = -1, best = -Infinity;
    for (let i = 0; i < s1.length; i++) {
        if (!isFinite(s1[i]) || Math.abs(xr1[i] - Lb / 2) > Lb / 2 + M.Le / 2) continue;
        if (s1[i] > best) { best = s1[i]; im = i; }
    }
    let xc = [0, Lb].concat(im >= 0 ? [xr1[im]] : []).map(v => M.dL * Math.round(v / M.dL));
    xc = Array.from(new Set(xc.map(v => +v.toFixed(9)))).sort((a, b) => a - b);
    if (T.gap.length) xc = xc.filter(v => T.gap.every(g => Math.abs(v - g) > 2 * T.s_r));
    const Brk = { x: xc, w: [], S0: atSeats(R1.ResTr1.Sr[0]).map(v => v / 1e6), S: [], dT_R: T.dT_brk, dT_B: B.dT[1],
                  wCWR: 1e3 * Math.pow(T.alfa * T.dT_brk, 2) * T.A * T.E / T.Fu[1] };

    // vertical traffic: LM71 and SW/0, envelopes and critical positions
    const crit = [];
    const kname = ['largest compression', 'largest tension', 'δH left end', 'δH right end', 'bearing force support ' + B.FL];
    const season = ['summer', 'winter'];
    let ij = 3;
    for (const sw of sweeps) {
        const { typ, xp, segf, envf, g } = sw;
        const qv = [[], []];
        for (let kv = 0; kv < 2; kv++) {
            for (let iv = 0; iv < xp.length; iv++, ij++) {
                const rv = post(R1all[ij], J1[ij]);
                addEnv(G[g], rv.S, kv);
                Rh[g][kv] = smax(Rh[g][kv], rv.Rh[1]);
                const dhv = ends(rv.dx[1]).map(v => 1e3 * v);
                dH[kv] = dH[kv].map((v, i) => Math.max(v, Math.abs(dhv[i])));
                dV[kv] = dV[kv].map((v, i) => Math.max(v, 1e3 * Math.abs(ends(rv.dy[1])[i])));
                let mn = Infinity, mx = -Infinity;
                for (const St of rv.S) for (const v of St[1]) { if (v < mn) mn = v; if (v > mx) mx = v; }
                qv[kv].push([mn, mx, Math.abs(dhv[0]), Math.abs(dhv[1]), Math.abs(rv.Rh[1][B.FL - 1])]);
            }
            const ic = [0, 0, 0, 0, 0];
            for (let iv = 1; iv < xp.length; iv++) {
                if (qv[kv][iv][0] < qv[kv][ic[0]][0]) ic[0] = iv;
                for (let mv = 1; mv < 5; mv++) if (qv[kv][iv][mv] > qv[kv][ic[mv]][mv]) ic[mv] = iv;
            }
            for (let mv = 0; mv < 5; mv++) {
                const xx = xp[ic[mv]], sg = segf(xx), env = envf(xx);
                crit.push({ typ, x: xx, krit: kname[mv], season: season[kv], seg: sg, Lpos: sg.map(s => [s[0], s[1]]),
                            env: [Math.min(...env.map(e => e[0])), Math.max(...env.map(e => e[1]))] });
            }
        }
    }
    const seen = new Set();
    let cv = crit.filter(c => { const key = c.typ + '_' + c.x.toFixed(4); if (seen.has(key)) return false; seen.add(key); return true; });
    if (!cv.length) cv = [{ typ: 'no vertical load', x: 0, krit: '', season: '', seg: [], Lpos: [[0, Lb]], env: [0, Lb] }];

    // braking and acceleration on loaded track, no vertical load
    ij = iH;
    for (let k = 0; k < 2; k++) for (const hh of H) {
        const rr = post(R1all[ij], J1[ij]); ij++;
        const d = ends(rr.dx[1]).map(v => 1e3 * Math.abs(v));
        if (hh.fb !== 0) { addEnv(G.brk, rr.S, k); dB[k] = dB[k].map((v, i) => Math.max(v, d[i])); Rh.brk[k] = smax(Rh.brk[k], rr.Rh[1]); }
        else             { addEnv(G.acc, rr.S, k); dA[k] = dA[k].map((v, i) => Math.max(v, d[i])); Rh.acc[k] = smax(Rh.acc[k], rr.Rh[1]); }
        r = rr;
    }

    // ---- round 2: broken rail and load combinations, temperature step
    // taken from round 1 (identical step 1)
    const J2 = [];
    for (const xb of xc)
        J2.push({ Tr: Object.assign({}, TrS[1].Tr, { brk: xb }), Br: TrS[1].Br, Lk: Lw,
                  Os: Object.assign({}, Os, { state1: R1.state1 }) });
    const iC = J2.length, CH = [];
    for (let k = 0; k < 2; k++) for (const c of cv) for (const hh of H) {
        const [bp, ap] = hpos(hh, c.env);
        J2.push(job(k, 1, c.seg, c.Lpos, bp, ap, hh.fb, hh.fa, tempR[k].state1));
        CH.push({ k, c, hh });
    }
    nTot = nRun + J2.length;
    const R2all = await runJobs(J2, workers, done);

    for (let j = 0; j < xc.length; j++) {
        const Rb = R2all[j];
        Brk.w.push(1e3 * Rb.ResTr1.wbrk);
        if (Brk.w[j] >= Math.max(...Brk.w)) { Brk.S = atSeats(Rb.ResTr1.Sr[1]).map(v => v / 1e6); Brk.xmax = xc[j]; }
    }
    Brk.wmax = Brk.w.length ? Math.max(...Brk.w) : NaN;

    // combination: temperature (step 1) + vertical traffic in the critical
    // positions + braking/acceleration (step 2)
    const gov = [new Array(nr).fill(NaN), new Array(nr).fill(NaN)], govT = [new Array(nr).fill(NaN), new Array(nr).fill(NaN)];
    const komb = [{ vert: '', H: '', u: 0 }, { vert: '', H: '', u: 0 }];
    const ub = [-Infinity, -Infinity];
    CH.forEach(({ k, c, hh }, j) => {
        const rr = post(R2all[iC + j], J2[iC + j]);
        addEnv(G.comb, rr.S, k);
        Rh.comb[k] = smax(Rh.comb[k], rr.Rh[1]);
        gapOpen.combMin[k] = gapOpen.combMin[k].map((v, i) => Math.min(v, rr.gap[i]));
        gapOpen.combMax[k] = gapOpen.combMax[k].map((v, i) => Math.max(v, rr.gap[i]));
        for (const St of rr.S) {
            const s = St[1];
            let mnB = Infinity, mxB = -Infinity, mnE = Infinity, mxE = -Infinity;
            for (let i = 0; i < s.length; i++) {
                if (isNaN(s[i])) continue;
                if (onBr[i]) { mnB = Math.min(mnB, s[i]); mxB = Math.max(mxB, s[i]); }
                else         { mnE = Math.min(mnE, s[i]); mxE = Math.max(mxE, s[i]); }
            }
            const u = Math.max(mnB / Lim.sig_br[0], mxB / Lim.sig_br[1], mnE / Lim.sig_emb[0], mxE / Lim.sig_emb[1]);
            if (u > ub[k]) {
                ub[k] = u; gov[k] = s.slice(); govT[k] = St[0].slice();
                komb[k] = { vert: c.typ + ', x = ' + c.x.toFixed(2) + ' m (' + c.krit + ')', H: hh.name, u };
            }
        }
        r = rr;
    });

    const out = { inp, Model: M };
    out.Track = { x, onBr, sig_emb };
    for (const g of groups) out.Track[g] = G[g];
    out.Track.comb.gov = gov; out.Track.comb.govTemp = govT;
    out.Track.gap = gapOpen;
    out.Track.rbreak = Brk;
    out.Bridge = { x: r.xb, xsup: M.xsup, dTemp, dB, dA, dH, dV, Rh };
    out.LoadPos = { vert: crit, H, komb, Lbrk, Lacc, xloco: xl, xSW: x0 };
    out.Table = table(out);
    out.Info = { nRun, time: (performance.now() - t0) / 1e3, workers: workers ? workers.length : 0 };
    if (opt.progress) opt.progress(1);
    return out;
};

// ------------------------------------------------------------ SUMMARY TABLE
// rows: {group ('stress', 'disp', 'force'), name (HTML), unit, lim (text),
// val [season][values], limv [lower, upper], exceed [season][values]}
function table(out) {
    const Tk = out.Track, Bk = out.Bridge, Lim = out.inp.Limits, B = out.inp.Bridge, Ld = out.inp.Load;
    const br = Tk.onBr, rows = [];
    const mm = (G, sel) => [0, 1].map(k => {
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i < sel.length; i++) if (sel[i]) {
            if (G.min[k][i] < mn) mn = G.min[k][i];
            if (G.max[k][i] > mx) mx = G.max[k][i];
        }
        return [mn === Infinity ? NaN : mn, mx === -Infinity ? NaN : mx];
    });
    const sl = l => (l[0] >= 0 ? '+' : '−') + Math.abs(l[0]) + ' / ' + (l[1] >= 0 ? '+' : '−') + Math.abs(l[1]);
    const add = (group, name, unit, lim, val, limv) => rows.push({ group, name, unit, lim, val, limv: limv || [-Infinity, Infinity] });
    const all = br.map(() => true), emb = br.map(b => !b);
    add('stress', 'Temperature', 'MPa', sl(Lim.sig_emb), mm(Tk.temp, all), Lim.sig_emb);
    if (Ld.LM71) add('stress', 'LM71', 'MPa', '–', mm(Tk.LM71, all));
    if (Ld.SW)   add('stress', 'SW/0', 'MPa', '–', mm(Tk.SW, all));
    add('stress', 'Braking', 'MPa', '–', mm(Tk.brk, all));
    add('stress', 'Traction', 'MPa', '–', mm(Tk.acc, all));
    add('stress', 'Load combination, bridge', 'MPa', sl(Lim.sig_br), mm(Tk.comb, br), Lim.sig_br);
    add('stress', 'Load combination, embankment', 'MPa', sl(Lim.sig_emb), mm(Tk.comb, emb), Lim.sig_emb);
    add('disp', '<i>δ</i><sub>B</sub> braking/traction, left / right', 'mm', String(Lim.dB),
        [0, 1].map(k => Bk.dB[k].map((v, i) => Math.max(v, Bk.dA[k][i]))), [-Infinity, Lim.dB]);
    if (Ld.LM71 || Ld.SW) {
        add('disp', '<i>δ</i><sub>H</sub> vertical traffic, left / right', 'mm', String(Lim.dH), Bk.dH, [-Infinity, Lim.dH]);
        if (out.Model.Ls > 0)
            add('disp', '<i>δ</i><sub>V</sub> vertical traffic, left / right', 'mm', String(Lim.dV), Bk.dV, [-Infinity, Lim.dV]);
    }
    add('disp', 'Deck end movement, temperature, left / right', 'mm', '–', Bk.dTemp);
    out.inp.Track.gap.forEach((g, i) =>
        add('disp', 'Opening of rail expansion joint ' + (i + 1) + ', temperature', 'mm', '–',
            [0, 1].map(k => [Tk.gap.temp[k][i]])));
    add('disp', 'Rail break gap', 'mm', String(Lim.wgap), [[NaN], [Tk.rbreak.wmax]], [-Infinity, Lim.wgap]);
    const Kh = Array.isArray(B.Kh) ? B.Kh : [B.Kh];
    const grp = [['temp', 'temperature'], ['LM71', 'LM71'], ['SW', 'SW/0'], ['brk', 'braking'], ['acc', 'traction'], ['comb', 'load combination']]
        .filter(g => (g[0] !== 'LM71' || Ld.LM71) && (g[0] !== 'SW' || Ld.SW));
    Kh.forEach((k, i) => {
        if (isMovable(k)) return;
        for (const g of grp) add('force', 'Support ' + (i + 1) + ', ' + g[1], 'kN', '–', [0, 1].map(s => [Bk.Rh[g[0]][s][i]]));
    });
    for (const t of rows)
        t.exceed = t.val.map(v => v.map(x => { const y = Math.round(x * 10) / 10; return y < t.limv[0] || y > t.limv[1]; }));
    return rows;
}

TBI.table = table;
TBI.law = law;
root.TBI = TBI;
})(typeof window !== 'undefined' ? window : globalThis);

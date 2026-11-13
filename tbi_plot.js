/* tbi_plot.js ----------------------------------------------------------------
   TBI-analysis according to EN 1991-2:2024, 8.5.4
   SVG drawings based on output from tbi_fem.js: model sketch, load models,
   rail stress diagrams and deck diagrams (port of TBI_plot.m, and drawLoads
   of TBI_gui.m)
   Andreas Andersson, 2026-11-13 (assisted by Claude)
-------------------------------------------------------------------------------
   USAGE:
     TBI.plotModel(el, out, opt)          dimensioned model sketch; out may be
                                          TBI.model(inp) (only inp and Model)
     TBI.plotLoads(el, which, opt)        load model, which = 'LM71' or 'SW'
     TBI.plotRail(els, out, opt)          additional rail stress, 3 diagrams
     TBI.plotBridge(els, out, lc, kind, opt)  deck M, V, N (kind 'SF') or u, w,
                                          theta (kind 'disp') for load case lc:
                                          1 temperature, 2 vertical traffic and
                                          braking/traction (envelopes), 3
                                          governing load combination and its
                                          temperature step
     TBI.tex2html(s)                      LaTeX subset of out.Table to safe HTML
     TBI.tex2nodes(s)                     the same as a DocumentFragment

   INPUT:
     el, els = container element(s); the contents are replaced by one <svg>
               each (els = three elements)
     opt     = {width, height, fontSize} (optional): size of the drawing in
               user units (= px at 100 %) and font size in points (4/3 units);
               plotModel: width = width of el (1150 if not shown), height =
               width*600/1150, font as TBI_plot.m (16 pt at 1150); plotRail,
               plotBridge: 600 x 236, 9 pt; plotLoads: 400 x 150, 9 pt
   OUTPUT:
     the <svg> element(s); tex2html: HTML string; tex2nodes: DocumentFragment

   x from support 1; summer red, winter blue. The SVG has a viewBox and width
   100 %, so it scales with its container and prints as vector graphics.
-----------------------------------------------------------------------------*/
(function () {
'use strict';

const root = typeof window !== 'undefined' ? window : globalThis;
const TBI = root.TBI = root.TBI || {};

const NS   = 'http://www.w3.org/2000/svg';
const PT   = 4 / 3;                                               // user units (px) per point, as MATLAB on screen
const FONT = "'Times New Roman', Times, serif";                  // LaTeX text in TBI_plot.m
const SANS = "Helvetica, Arial, sans-serif";                     // tex text of the GUI load sketches
const RED  = '#ff0000', BLUE = '#0000ff', COL = [RED, BLUE];    // summer, winter
const GREY = '#808080';
let clipId = 0;                                                  // unique clip path ids in the document
const f2 = v => String(Math.round(v * 100) / 100);


//% ========================================================================
//  RAIL STRESS
//  ========================================================================
function plotRail(els, out, opt) {
    // three diagrams of the additional rail stress along the track
    const T = out.Track, M = out.Model, Lim = out.inp.Limits, x = T.x, Ld = out.inp.Load;
    const xl  = [-60 - M.x0, M.Lb + 60 - M.x0];                  // x range (m)
    const lim = Lim.sig_emb;                                     // summer: compression, winter: tension
    const o   = diagOpt(opt);
    const svgs = [];

    const xs = x.filter((v, i) => T.onBr[i]);
    const xb = [Math.min(...xs), Math.max(...xs)];               // bridge part of the rail
    // limit lines: bridge and embankment limits (summer compression, winter tension)
    const limLine = (a, k, lb, le) => a.line([xl[0], xb[0], xb[0], xb[1], xb[1], xl[1]], [le, le, lb, lb, le, le],
                                             { color: COL[k], dash: ':', lw: 0.5, clip: true });

    // 1 temperature (with rail expansion joints the total stress)
    let a = diagAxes(o);
    let limT = lim, limB = Lim.sig_br;
    if (T.rej) { limT = T.sig_emb; limB = limT; }
    let yl = railLimits([T.temp.min, T.temp.max, limT, limB], 120);
    a.setLim(xl, yl);
    railSupports(a, yl, M.xsup);
    for (let k = 0; k < 2; k++) {
        a.line(x, T.temp.min[k], { color: COL[k], lw: 1, clip: true });
        if (T.temp.max[k].some((v, i) => v !== T.temp.min[k][i])) a.line(x, T.temp.max[k], { color: COL[k], lw: 1, clip: true });
        limLine(a, k, limB[k], limT[k]);
    }
    railFinish(a, o);
    svgs.push(a.svg.root);

    // 2 LM71, SW/0 and braking/traction
    a = diagAxes(o);
    const hmin = [0, 1].map(k => T.brk.min[k].map((v, i) => Math.min(v, T.acc.min[k][i])));
    const hmax = [0, 1].map(k => T.brk.max[k].map((v, i) => Math.max(v, T.acc.max[k][i])));
    const sw = Ld.SW ? [T.SW.min, T.SW.max] : [];
    const lm = Ld.LM71 ? [T.LM71.min, T.LM71.max] : [];         // TBI_plot.m: always (NaN without LM71)
    yl = railLimits([lm, sw, hmin, hmax], 0);
    a.setLim(xl, yl);
    railSupports(a, yl, M.xsup);
    for (let k = 0; k < 2; k++) {
        if (Ld.LM71) for (const y of [T.LM71.min[k], T.LM71.max[k]]) a.line(x, y, { color: COL[k], dash: '--', lw: 0.5, clip: true });
        if (Ld.SW)   for (const y of [T.SW.min[k], T.SW.max[k]])     a.line(x, y, { color: COL[k], dash: '-.', lw: 0.5, clip: true });
        a.line(x, hmin[k], { color: COL[k], lw: 1, clip: true });
        a.line(x, hmax[k], { color: COL[k], lw: 1, clip: true });
    }
    railFinish(a, o);
    svgs.push(a.svg.root);

    // 3 governing load combination
    a = diagAxes(o);
    yl = railLimits([T.comb.gov, T.comb.govTemp, lim, Lim.sig_br], 120);
    a.setLim(xl, yl);
    railSupports(a, yl, M.xsup);
    for (let k = 0; k < 2; k++) {
        a.line(x, T.comb.govTemp[k], { color: COL[k], dash: '--', lw: 0.5, clip: true });
        a.line(x, T.comb.gov[k], { color: COL[k], lw: 1, clip: true });
        limLine(a, k, Lim.sig_br[k], lim[k]);
    }
    railFinish(a, o);
    svgs.push(a.svg.root);

    if (els) svgs.forEach((s, i) => { if (els[i]) els[i].replaceChildren(s); });
    return svgs;
}


function railLimits(v, ymin) {
    // symmetric y range in steps of 20 MPa, at least ymin
    let a = 0;
    for (const w of flat(v)) if (isFinite(w)) a = Math.max(a, Math.abs(w));
    const y = Math.max(ymin, 20, 20 * Math.ceil(1.1 * a / 20));
    return [-y, y];
}


function railSupports(a, yl, xsup) {
    // supports as dotted grey lines, drawn first (below the curves)
    for (const xs of xsup) a.line([xs, xs], yl, { color: GREY, dash: ':', lw: 0.5 });
}


function railFinish(a, o) {
    // axes, labels and legend of a rail stress diagram
    const yl = a.ylim, dy = 20 * Math.max(1, Math.round((yl[1] - yl[0]) / 6 / 20));
    const yt = [];
    for (let v = yl[0]; v <= yl[1] + 1e-9; v += dy) yt.push(v);
    a.frame(niceTicks(a.xlim, 10), yt, '$x$ (m)', '$\\sigma_\\mathrm{R}$ (MPa)', o.fontSize);
    legendNE(a, o.fontSize);
}


//% ========================================================================
//  DECK SECTION FORCES AND DISPLACEMENTS
//  ========================================================================
function plotBridge(els, out, lc, kind, opt) {
    // three diagrams of the deck for load case lc, kind 'SF' or 'disp'
    let F, qn, yn;
    if (String(kind).toLowerCase() === 'disp') {
        F = out.Bridge.D;  qn = ['u', 'w', 'th'];  yn = ['$u$ (mm)', '$w$ (mm)', '$\\theta$ (mrad)'];
    } else {
        F = out.Bridge.F;  qn = ['M', 'V', 'N'];   yn = ['$M$ (MNm)', '$V$ (MN)', '$N$ (MN)'];
    }
    const x = out.Bridge.xF, M = out.Model, Ld = out.inp.Load;
    const xl = [-M.x0 - 0.03 * M.Lb, M.Lb - M.x0 + 0.03 * M.Lb];   // the bridge (m)
    const o = diagOpt(opt);
    const svgs = [];
    for (let i = 0; i < 3; i++) {
        const q = qn[i], L = [];                                 // lines {y, dash, lw, k}
        for (let k = 0; k < 2; k++) {
            if (lc === 1) {
                const e = F.temp[q];
                L.push({ y: e.min[k], lw: 1, k });
                if (e.max[k].some((v, j) => v !== e.min[k][j])) L.push({ y: e.max[k], lw: 1, k });
            } else if (lc === 2) {
                if (Ld.LM71) for (const y of [F.LM71[q].min[k], F.LM71[q].max[k]]) L.push({ y, dash: '--', lw: 0.5, k });
                if (Ld.SW)   for (const y of [F.SW[q].min[k], F.SW[q].max[k]])     L.push({ y, dash: '-.', lw: 0.5, k });
                L.push({ y: F.brk[q].min[k].map((v, j) => Math.min(v, F.acc[q].min[k][j])), lw: 1, k });
                L.push({ y: F.brk[q].max[k].map((v, j) => Math.max(v, F.acc[q].max[k][j])), lw: 1, k });
            } else {
                L.push({ y: F.comb.govTemp[q][k], dash: '--', lw: 0.5, k });
                L.push({ y: F.comb.gov[q][k], lw: 1, k });
            }
        }
        const a = diagAxes(o);
        const yl = bridgeLimits(L.map(l => l.y));
        a.setLim(xl, yl);
        a.line(xl, [0, 0], { lw: 0.5 });                         // zero line
        for (const xs of out.Bridge.xsup) a.line([xs, xs], yl, { color: GREY, dash: ':', lw: 0.5 });
        for (const l of L) a.line(x, l.y, { color: COL[l.k], dash: l.dash, lw: l.lw, clip: true });
        bridgeFinish(a, o, yn[i]);
        svgs.push(a.svg.root);
    }
    if (els) svgs.forEach((s, i) => { if (els[i]) els[i].replaceChildren(s); });
    return svgs;
}


function bridgeLimits(v) {
    // y range with 10 % margin, zero included
    let lo = 0, hi = 0;
    for (const w of flat(v)) if (isFinite(w)) { lo = Math.min(lo, w); hi = Math.max(hi, w); }
    const d = Math.max(hi - lo, 1e-3);
    return [lo - 0.1 * d, hi + 0.1 * d];
}


function bridgeFinish(a, o, ylab) {
    // axes, labels and legend of a deck diagram (MATLAB's automatic ticks)
    a.frame(niceTicks(a.xlim, 10), niceTicks(a.ylim, 6), '$x$ (m)', ylab, o.fontSize);
    legendNE(a, o.fontSize);
}


//% ========================================================================
//  MODEL SKETCH
//  ========================================================================
function plotModel(el, out, opt) {
    // dimensioned sketch of the 2D model, as the model figure of the reports
    opt = opt || {};
    const B = out.inp.Bridge, T = out.inp.Track, M = out.Model;
    const W = opt.width || (el && el.clientWidth) || 1150;      // drawing as large as the container (px)
    const H = opt.height || W * 600 / 1150;
    const fsz = opt.fontSize || Math.max(12, Math.round(16 * W / 1150));   // 16 pt = ca 9 pt at 160 mm; readable on screen
    const svg = new Svg(W, H, FONT);
    const lw = 2.0;                                              // line width, rail
    const nsup = M.xsup.length;
    const Kh = khList(B.Kh, nsup);
    const fixd = Kh.map(k => !(typeof k === 'number' && k === 0));   // bearing with longitudinal stiffness
    const lbl  = fixd.map(f => (f ? 'FL' : 'RL'));
    // symbol: roller (K_h = 0), fixed (K_h >= 10 GN/m), else fixed bearing with a horizontal spring
    const btyp = Kh.map((k, i) => (!fixd[i] ? 'roller' : typeof k === 'number' && k >= 10e9 ? 'fixed' : 'spring'));

    // a) whole model ---------------------------------------------------------
    const ov = M.Ls;                                             // L_end as in the model (m)
    const we = 7, wb = 30;                                       // drawn length of an embankment and the bridge
    const x0 = we, sc = wb / (M.xsup[nsup - 1] - M.xsup[0] + 2 * ov);
    const xs = M.xsup.map(v => x0 + sc * (ov + v - M.xsup[0]));  // bearings
    const xe = [x0, x0 + wb];                                    // deck ends
    const xt = 2 * we + wb;                                      // right end of the model
    let yR = 5.0, yB = 3.9, yS = yB - 1.2;                       // rail, deck, bearing level
    const yM = -1.6;                                             // dimension line
    const a = new Ax(svg, [0.01, 0.56, 0.98, 0.43], [-0.5, xt + 0.5], [yM - 1.5, 6.3], true);
    a.line([0, xt], [yR, yR], { lw });
    a.line(xe, [yB, yB], { lw: 4 });
    for (let x = 0; x <= xt + 1e-9; x += 1) {                    // rail seats (schematic)
        const y0 = x >= xe[0] && x <= xe[1] ? yB : yR - 0.55;
        a.line([x, x], [y0, yR], { lw: 0.5 });
    }
    for (let i = 0; i < nsup; i++) {
        a.line([xs[i], xs[i]], [yS, yB], { lw: 0.75 });
        bearing(a, btyp[i], xs[i], yS, 1.0, 1, fsz);
        a.text(xs[i], yS - 1.15, `${i + 1} (${lbl[i]})`, { size: fsz - 2, ha: 'center', va: 'top', plain: true });
    }
    const xo = xs[0] - sc * M.Ls;                                // left deck end in the drawing
    for (const g0 of T.gap || []) {                              // rail expansion joints, from the left deck end
        const g = g0 + M.x0;
        let xg;
        if (g < 0)         xg = xo + g * we / M.Le;              // embankments drawn shorter than the bridge
        else if (g > M.Lb) xg = xe[1] + (g - M.Lb) * we / M.Le;
        else               xg = xo + sc * g;
        a.line([xg - 0.35, xg + 0.35], [yR, yR], { color: '#fff', lw: lw + 1.5 });   // rail interrupted
        a.line([xg - 0.55, xg + 0.15], [yR + 0.12, yR + 0.12], { lw });              // overlapping rail ends
        a.line([xg - 0.15, xg + 0.55], [yR - 0.12, yR - 0.12], { lw });
        a.text(xg, yR + 0.35, 'REJ', { size: fsz - 2, ha: 'center', va: 'bottom', plain: true });
    }
    arrowX(a, xs[0], -0.6, 1.2, 1);                              // x from support 1
    a.text(xs[0] + 1.35, -0.6, '$x$', { size: fsz });
    dimH(a, [0, xe[0]], yM, `$${fmtG(T.Le)}$`, fsz, true);       // lengths as given in the input
    dimH(a, [xe[1], xt], yM, `$${fmtG(T.Le)}$`, fsz, true);      // (the model rounds them)
    const xd = uniqueSorted(xe.concat(xs));                      // deck ends and bearings
    for (let i = 0; i < xd.length - 1; i++) {
        const j = i - (M.Ls > 1e-9 ? 1 : 0);                     // span index (first segment = L_end)
        let txt = '';
        if (j >= 0 && j < B.L.length && B.L.length <= 10) txt = `$${fmtG(B.L[j])}$`;
        dimH(a, [xd[i], xd[i + 1]], yM, txt, fsz - 2);
    }
    const pxa = a.sx;                                            // units per data unit in a) (axis equal)

    // b) detail at support 1; own scales in x and y, the levels follow e_b,
    // h - e_r - e_b and e_r (drawn gaps at least gmin) -----------------------
    const Hd = 5.0, gmin = 0.45;                                 // drawn height bearing to rail, smallest gap
    let g = [B.e_b, B.h - T.e_r - B.e_b, T.e_r].map(v => Math.max(v / B.h * Hd, gmin));
    const gs = g[0] + g[1] + g[2];
    g = g.map(v => v * Hd / gs);
    yS = 0;  yB = yS + g[0];  const yT = yB + g[1];  yR = yT + g[2];   // bearing, neutral axis, slip centre, rail
    const ds = 2.2;                                              // sleeper spacing in the sketch
    const xdk = 0;                                               // deck end
    const Ls = M.Ls;
    const xs0 = xdk + Math.min(Ls, 3 * M.s_r) / M.s_r * ds;      // bearing 1 (at most 3 s_r from the end)
    const xss = [-1, 0, 1, 2, 3].map(i => xdk + ds * i);         // rail seats, one on the embankment
    const xL = xss[0] - 1.0, xRt = xss[4] + 1.6;
    const xeb = xss[0] - 1.9;                                    // e_b and e_r left of the embankment spring
    const xh = xeb - 5.5;                                        // h further left
    const b = new Ax(svg, [0.00, 0.00, 0.54, 0.60], [xh - 5.0, xRt + 3.2], [yS - 3.3, yR + 1.4], false);
    const asp = b.sx / b.sy;                                     // y units per x unit, same drawn length
    const sb = pxa / b.sx;                                       // bearing as large as in a)
    b.line([xL, xRt], [yR, yR], { lw });
    b.line([xdk, xRt], [yB, yB], { lw: 4 });
    b.line([xdk, xdk], [yB - asp * 0.25, yB + asp * 0.25], { lw: 1 });
    for (const x of xss) {
        const y0 = x < xdk ? yB - 0.1 * asp : yB;
        b.line([x, x], [yR, yT], { lw: 0.5 });
        springV(b, x, [y0, yT], 0.15);
        b.line([x + 0.9, x + 0.9], [y0, yT], { lw: 0.5 });
        springH(b, [x, x + 0.9], yT, 0.12 * asp);
        if (x < xdk) ground(b, [x - 0.2, x + 1.1], y0, asp);
    }
    b.text(xss[4] + 1.05, yT, '$k_\\mathrm{t,h}$', { size: fsz });
    b.text(xss[4] + 1.05, (yB + yT) / 2, '$k_\\mathrm{t,v}$', { size: fsz });
    b.line([xs0, xs0], [yB, yS], { lw: 0.75 });
    bearing(b, btyp[0], xs0, yS, sb, asp, fsz);
    b.text(xs0, yS - asp * 1.3 * sb, `support 1 (${lbl[0]})`, { size: fsz, ha: 'center', va: 'top', plain: true });
    dimH(b, [xss[1], xss[2]], yR + 0.6, `$s_\\mathrm{r}$ = $${M.s_r.toFixed(2)}$`, fsz, false, asp);
    dimV(b, xeb, [yS, yB], `$e_\\mathrm{b}$ = $${B.e_b.toFixed(2)}$`, fsz, asp);   // bearing to neutral axis
    dimV(b, xeb, [yT, yR], `$e_\\mathrm{r}$ = $${T.e_r.toFixed(2)}$`, fsz, asp);   // slip centre to top of rail
    dimV(b, xh, [yS, yR], `$h$ = $${B.h.toFixed(2)}$`, fsz, asp);                 // bearing to top of rail
    const gp = 0.6;                                              // gap between extension lines and the model
    b.line([xh - 0.2, xs0 - 0.45 * sb - gp], [yS, yS], { lw: 0.5 });              // extension lines: bearing,
    b.line([xeb - 0.2, xss[0] - 0.2 - gp], [yB, yB], { lw: 0.5, dash: ':' });     //   neutral axis,
    b.line([xeb - 0.2, xss[0] - gp], [yT, yT], { lw: 0.5, dash: ':' });           //   slip centre,
    b.line([xh - 0.2, xL - gp], [yR, yR], { lw: 0.5 });                           //   top of rail
    if (Ls > 1e-9) {                                             // L_end: deck end to bearing 1 (value as given)
        const yL = yS + 0.45 * (yB - yS);
        b.line([xdk, xdk], [yB - asp * 0.25, yL - asp * 0.3], { lw: 0.5 });
        dimH(b, [xdk, xs0], yL, '', fsz, false, asp);
        b.text(xs0 + 0.4, yL, `$L_\\mathrm{end}$ = $${fmtG(B.L_end)}$`, { size: fsz });
    }
    const yx = yS - 2.95;                                        // x axis from support 1, below the label
    b.line([xs0, xs0], [yx - asp * 0.25, yx + asp * 0.25], { lw: 0.5 });
    arrowX(b, xs0, yx, 1.6, asp);
    b.text(xs0 + 1.75, yx, '$x$', { size: fsz });

    // c) track shear resistance (Table 8.9) ----------------------------------
    const u0 = T.u0.map(v => 1e3 * v), Fu = T.Fu.map(v => v / 1e3), Fl = T.Fl / 1e3;
    const um = 2 * Math.max(...u0), Fm = 1.6 * Fl;
    const c = new Ax(svg, [0.60, 0.19, 0.18, 0.34], [0, um * 1.12], [0, Fm], false);
    for (let j = 0; j < 2; j++) {
        c.line([0, u0[j], um], [0, Fl, Fl], { color: COL[j], lw: 1.25 });
        c.line([0, u0[j], um], [0, Fu[j], Fu[j]], { color: COL[j], lw: 1.25, dash: '--' });
    }
    arrowAxes(c, um * 1.12, Fm, '$u$ (mm)', '$F_\\mathrm{h}$ (kN/m)', fsz);
    for (let j = 0; j < 2; j++) {
        c.text(u0[j], -0.07 * Fm, `$${u0[j].toFixed(1)}$`, { color: COL[j], size: fsz - 2, ha: 'center', va: 'top' });
        c.text(-0.03 * um, Fu[j], `$${Fu[j].toFixed(0)}$`, { color: COL[j], size: fsz - 2, ha: 'right' });
    }
    c.text(-0.03 * um, Fl, `$${Fl.toFixed(0)}$`, { size: fsz - 2, ha: 'right' });
    c.text(0.72 * um, 0.95 * Fm, ['loaded (solid)', 'unloaded (dashed)', { t: 'summer', color: RED }, { t: 'winter', color: BLUE }],
           { size: fsz - 4, va: 'top', plain: true });
    c.text(0.5 * um, -0.24 * Fm, ['track shear', 'resistance'], { size: fsz - 1, ha: 'center', va: 'top', plain: true });

    // d) vertical spring per sleeper -----------------------------------------
    const d = new Ax(svg, [0.82, 0.19, 0.16, 0.34], [-1.15, 1.15], [-1.2, 0.7], false);
    const wm = 1, kc = T.Kv / 1e6, ku = T.Kv_up / 1e6;           // normalised displacement
    const yu = Math.min(ku / kc, 0.5), xu = wm * yu / Math.max(ku / kc, Number.EPSILON);   // uplift line inside the axes
    d.line([-wm, 0, xu], [-1, 0, yu], { lw: 1.25 });
    const ha = [0.035 * 2.3, 0.07 * 1.9], hb = [0.025 * 1.9, 0.012 * 2.3];   // arrowheads as in arrowAxes
    d.line([-wm, wm - ha[0]], [0, 0], { lw: 0.75 });
    d.line([0, 0], [-1.15, 0.6 - ha[1]], { lw: 0.75 });
    d.fill([wm, wm - ha[0], wm - ha[0]], [0, hb[0], -hb[0]], '#000');
    d.fill([0, hb[1], -hb[1]], [0.6, 0.6 - ha[1], 0.6 - ha[1]], '#000');
    d.text(wm * 1.1, -0.08, '$w$', { size: fsz, va: 'top' });
    d.text(0.06, 0.62, '$F_\\mathrm{v}$', { size: fsz });
    d.text(-0.55 * wm, -0.35, `$${kc.toFixed(0)}$ MN/m`, { size: fsz - 2, ha: 'right' });
    if (yu < 0.3) {
        d.text(1.15 * wm, yu + 0.1, `$${ku.toFixed(0)}$ MN/m`, { size: fsz - 2, ha: 'right', va: 'bottom' });
    } else {                                                     // steep line: label right of it
        d.text(0.15 * wm, 0.12, `$${ku.toFixed(0)}$ MN/m`, { size: fsz - 2, ha: 'left', va: 'bottom' });
    }
    d.text(-0.5 * wm, -0.9, 'compression', { size: fsz - 4, ha: 'center', plain: true });
    d.text(0.5 * wm, -0.25, 'uplift', { size: fsz - 4, ha: 'center', plain: true });
    d.text(0, -1.2 - 0.24 * 1.9, ['track vertical', 'stiffness'], { size: fsz - 1, ha: 'center', va: 'top', plain: true });

    if (el) el.replaceChildren(svg.root);
    return svg.root;
}


function arrowAxes(ax, xm, ym, xlab, ylab, fsz) {
    // own axes with arrowheads from the origin, labels at the ends
    const ha = [0.035 * xm, 0.07 * ym], hb = [0.025 * ym, 0.012 * xm];
    ax.fill([xm, xm - ha[0], xm - ha[0]], [0, hb[0], -hb[0]], '#000');
    ax.fill([0, hb[1], -hb[1]], [ym, ym - ha[1], ym - ha[1]], '#000');
    ax.line([0, xm - ha[0]], [0, 0], { lw: 0.75 });
    ax.line([0, 0], [0, ym - ha[1]], { lw: 0.75 });
    ax.text(xm, -0.07 * ym, xlab, { size: fsz, ha: 'center', va: 'top' });
    ax.text(0.04 * xm, ym, ylab, { size: fsz, ha: 'left' });
}


function arrowX(ax, x, y, len, a) {
    // horizontal arrow (quiver with MaxHeadSize 0.6) from x to x + len at y
    const hl = 0.3 * len, hw = 0.14 * a;
    ax.line([x, x + len - hl], [y, y], { lw: 0.75 });
    ax.fill([x + len, x + len - hl, x + len - hl], [y, y + hw, y - hw], '#000');
}


function springH(ax, x, y, a) {
    // horizontal spring between x[0] and x[1] at height y, amplitude a
    const n = 4, l = 0.2 * (x[1] - x[0]), xx = [], yy = [];
    for (let i = 0; i <= 2 * n; i++) {
        xx.push(x[0] + l + i * (x[1] - x[0] - 2 * l) / (2 * n));
        yy.push(i === 0 || i === 2 * n ? y : y + a * (i % 2 ? 1 : -1));
    }
    ax.line([x[0], xx[0]], [y, y], { lw: 0.75 });
    ax.line(xx, yy, { lw: 0.75 });
    ax.line([xx[2 * n], x[1]], [y, y], { lw: 0.75 });
}


function springV(ax, x, y, a) {
    // vertical spring at x between y[0] and y[1], amplitude a
    const n = 4, l = 0.2 * (y[1] - y[0]), xx = [], yy = [];
    for (let i = 0; i <= 2 * n; i++) {
        yy.push(y[0] + l + i * (y[1] - y[0] - 2 * l) / (2 * n));
        xx.push(i === 0 || i === 2 * n ? x : x + a * (i % 2 ? 1 : -1));
    }
    ax.line([x, x], [y[0], yy[0]], { lw: 0.75 });
    ax.line(xx, yy, { lw: 0.75 });
    ax.line([x, x], [yy[2 * n], y[1]], { lw: 0.75 });
}


function bearing(ax, kind, x, y, s, a, fsz) {
    // bearing symbol with the tip at (x,y), size s, a = y units per x unit:
    // roller, fixed, or spring = on rollers held by a horizontal spring (K_h)
    if (kind === 'roller') return roller(ax, x, y, s, a);
    if (kind === 'fixed') return fixedBearing(ax, x, y, s, a);
    roller(ax, x, y, s, a);
    const xw = x + 1.7 * s, yw = y - a * 0.35 * s;               // spring at mid height
    springH(ax, [x + 0.3 * s, xw], yw, 0.12 * s * a);
    ax.line([xw, xw], [yw - a * s * 0.45, yw + a * s * 0.45], { lw: 1.0 });   // wall with hatching
    for (let k = 0; k <= 4; k++) {
        const yy = yw + a * s * (-0.4 + 0.2 * k);
        ax.line([xw, xw + 0.2 * s], [yy, yy - a * 0.15 * s], { lw: 0.5 });
    }
    ax.text((x + xw) / 2, yw + a * 0.2 * s, '$K_\\mathrm{h}$', { size: fsz - 4, ha: 'center', va: 'bottom' });
}


function roller(ax, x, y, s, a) {
    // movable bearing with the tip at (x,y), size s
    ax.fill([x - 0.45 * s, x, x + 0.45 * s], [y - a * 0.75 * s, y, y - a * 0.75 * s], '#fff', '#000', 0.75);
    ax.marker(x, y, 4);
    const r = 0.13 * s;
    for (const xx of [x - 0.22 * s, x + 0.22 * s]) {
        const px = [], py = [];
        for (let i = 0; i < 30; i++) {
            const th = 2 * Math.PI * i / 29;
            px.push(xx + r * Math.cos(th));
            py.push(y + a * (-s * 0.75 - r + r * Math.sin(th)));
        }
        ax.line(px, py, { lw: 0.75 });
    }
}


function fixedBearing(ax, x, y, s, a) {
    // fixed bearing with the tip at (x,y), size s, on hatched ground
    ax.fill([x - 0.45 * s, x, x + 0.45 * s], [y - a * 0.75 * s, y, y - a * 0.75 * s], '#fff', '#000', 0.75);
    ax.marker(x, y, 4);
    const yg = y - a * 0.75 * s;
    ax.line([x - 0.7 * s, x + 0.7 * s], [yg, yg], { lw: 1.2 });
    for (let k = 0; k <= 6; k++) {
        const xx = x + s * (-0.6 + 0.2 * k);
        ax.line([xx, xx - 0.18 * s], [yg, yg - a * 0.25 * s], { lw: 0.5 });
    }
}


function ground(ax, x, y, a) {
    // ground with hatching between x[0] and x[1] at height y
    ax.line(x, [y, y], { lw: 0.75 });
    for (let xx = x[0] + 0.1; xx <= x[1] + 1e-9; xx += 0.3) ax.line([xx, xx - 0.15], [y, y - a * 0.2], { lw: 0.5 });
}


function dimH(ax, x, y, txt, fsz, broken, a) {
    // horizontal dimension line between x[0] and x[1] with ticks, broken
    // (double slash) if broken; a = y units per x unit (1 with axis equal)
    a = a || 1;
    let xt;
    if (broken) {
        const xm = (x[0] + x[1]) / 2 + 1.5, g = 0.25;
        ax.line([x[0], xm - g], [y, y], { lw: 0.5 });
        ax.line([xm + g, x[1]], [y, y], { lw: 0.5 });
        for (const dx of [-g, g]) ax.line([xm + dx - 0.15, xm + dx + 0.15], [y - a * 0.35, y + a * 0.35], { lw: 0.75 });
        xt = (x[0] + x[1]) / 2 - 1.0;
    } else {
        ax.line(x, [y, y], { lw: 0.5 });
        xt = (x[0] + x[1]) / 2;
    }
    for (const xx of x) {
        ax.line([xx - 0.12, xx + 0.12], [y - a * 0.2, y + a * 0.2], { lw: 0.75 });
        ax.line([xx, xx], [y - a * 0.3, y + a * 0.3], { lw: 0.5 });
    }
    if (!txt) return;
    if (a === 1) ax.text(xt, y + 0.45, txt, { size: fsz, ha: 'center' });
    else ax.text(xt, y + a * 0.3, txt, { size: fsz, ha: 'center', va: 'bottom' });   // other scales: just above the line
}


function dimV(ax, x, y, txt, fsz, a) {
    // vertical dimension line between y[0] and y[1] with ticks, text to the left
    ax.line([x, x], y, { lw: 0.5 });
    for (const yy of y) ax.line([x - 0.2, x + 0.2], [yy - a * 0.12, yy + a * 0.12], { lw: 0.75 });
    ax.text(x - 0.25, (y[0] + y[1]) / 2, txt, { size: fsz, ha: 'right' });
}


//% ========================================================================
//  LOAD MODELS (TBI_gui.m, drawLoads)
//  ========================================================================
function plotLoads(el, which, opt) {
    // load model LM71 or SW/0 (EN 1991-2); characteristic values (multiplied
    // by alpha in the analysis); LM71 = 80 kN/m unlimited and the locomotive
    // 4 x 250 kN / 6.4 m = 156 kN/m; SW/0 = 2 x 15 m of 133 kN/m, 5.3 m apart
    opt = opt || {};
    const W = opt.width || 400, H = opt.height || 150, fs = opt.fontSize || 9;
    const svg = new Svg(W, H, SANS);
    const rc = '#d90000';                                        // train loads red
    if (String(which).toUpperCase() === 'LM71') {
        const aa = new Ax(svg, [0, 0, 1, 1], [-3.5, 9.9], [-1.15, 2.45], false);
        const hq = 0.55, hp = hq * 156 / 80;
        aa.line([-3.2, 9.6], [0, 0], { lw: 1 });
        for (const xr of [[-3.2, 0], [6.4, 9.6]]) {
            aa.line(xr, [hq, hq], { color: rc, lw: 0.75 });
            for (let i = 0; i < 4; i++) pil(aa, xr[0] + i * (xr[1] - xr[0]) / 3, hq, 0, 0.12, 0.12, rc);
        }
        aa.line([0, 6.4], [hp, hp], { color: rc, lw: 0.75 });
        for (let i = 0; i < 7; i++) pil(aa, i * 6.4 / 6, hp, 0, 0.12, 0.12, rc);
        aa.text(3.2, hp + 0.08, '156 kN/m', { size: fs, ha: 'center', va: 'bottom', plain: true });
        aa.text(-1.6, hq + 0.08, '80 kN/m', { size: fs, ha: 'center', va: 'bottom', plain: true });
        aa.text(8.0, hq + 0.08, '80 kN/m', { size: fs, ha: 'center', va: 'bottom', plain: true });
        aa.text(-3.4, hp + 0.45, 'LM71', { size: fs + 1, weight: 'bold', va: 'bottom', plain: true });
        aa.text(9.6, hp + 0.45, 'unlimited', { size: fs - 1, ha: 'right', va: 'bottom', color: '#595959', plain: true });
        dimline(aa, [0, 6.4], -0.45, ['6.4'], fs - 1);
    } else {
        const aa = new Ax(svg, [0, 0, 1, 1], [-2.5, 37.8], [-1.15, 2.45], false);
        const hq = 0.75;
        aa.line([-2, 37.3], [0, 0], { lw: 1 });
        for (const xr of [[0, 15], [20.3, 35.3]]) {
            aa.line(xr, [hq, hq], { color: rc, lw: 0.75 });
            for (let i = 0; i < 7; i++) pil(aa, xr[0] + i * (xr[1] - xr[0]) / 6, hq, 0, 0.35, 0.12, rc);
            aa.text((xr[0] + xr[1]) / 2, hq + 0.08, '133 kN/m', { size: fs, ha: 'center', va: 'bottom', plain: true });
        }
        aa.text(-2.3, 1.7, 'SW/0', { size: fs + 1, weight: 'bold', va: 'bottom', plain: true });
        dimline(aa, [0, 15, 20.3, 35.3], -0.45, ['15', '5.3', '15'], fs - 1);
    }
    if (el) el.replaceChildren(svg.root);
    return svg.root;
}


function pil(a, x, y0, y1, hw, hh, c) {
    // vertical load arrow at x from y0 down to y1, head half width hw and
    // height hh (data units), colour c
    a.line([x, x], [y0, y1 + hh], { color: c, lw: 0.75 });
    a.fill([x - hw, x, x + hw], [y1 + hh, y1, y1 + hh], c);
}


function dimline(a, xs, y, txt, fs) {
    // horizontal dimension line at height y, ticks at xs, texts txt between
    // them (below the line)
    a.line([xs[0], xs[xs.length - 1]], [y, y], { lw: 0.5 });
    const dx = 0.012 * (a.xlim[1] - a.xlim[0]), dy = 0.10;
    for (const x of xs) {
        a.line([x - dx, x + dx], [y - dy, y + dy], { lw: 0.75 });
        a.line([x, x], [y - 0.15, y + 0.3], { lw: 0.5 });
    }
    txt.forEach((t, i) => a.text((xs[i] + xs[i + 1]) / 2, y - 0.12, t, { size: fs, ha: 'center', va: 'top', plain: true }));
}


//% ========================================================================
//  SVG HELPERS
//  ========================================================================
function node(tag, attrs, parent) {
    // SVG element with attributes (no HTML strings)
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
}


class Svg {
    // drawing of W x H user units on a white background, scaled to the
    // container width (viewBox), vector graphics when printed
    constructor(W, H, font) {
        this.W = W;  this.H = H;
        this.root = node('svg', { viewBox: `0 0 ${f2(W)} ${f2(H)}`, width: '100%', preserveAspectRatio: 'xMidYMid meet',
                                  'font-family': font || FONT, role: 'img' });
        this.defs = node('defs', {}, this.root);
        node('rect', { x: 0, y: 0, width: f2(W), height: f2(H), fill: '#fff' }, this.root);
    }
}


class Ax {
    // axes: data -> user units at the normalised position pos = [left bottom
    // width height] (as MATLAB); equal = 'axis equal' (box centred)
    constructor(svg, pos, xlim, ylim, equal) {
        this.svg = svg;
        const bx = pos[0] * svg.W, bw = pos[2] * svg.W, bh = pos[3] * svg.H;
        const by = (1 - pos[1] - pos[3]) * svg.H;
        this.box = [bx, by, bw, bh];
        this.equal = equal;
        this.clipRef = null;
        this.setLim(xlim, ylim);
    }
    setLim(xlim, ylim) {
        const [bx, by, bw, bh] = this.box;
        this.xlim = xlim;  this.ylim = ylim;
        const xr = xlim[1] - xlim[0], yr = ylim[1] - ylim[0];
        if (this.equal) {
            const s = Math.min(bw / xr, bh / yr);
            this.sx = this.sy = s;
            this.x0 = bx + (bw - xr * s) / 2;  this.y0 = by + (bh - yr * s) / 2;
        } else {
            this.sx = bw / xr;  this.sy = bh / yr;  this.x0 = bx;  this.y0 = by;
        }
    }
    X(x) { return this.x0 + (x - this.xlim[0]) * this.sx; }
    Y(y) { return this.y0 + (this.ylim[1] - y) * this.sy; }
    clip() {
        // clip path of the axes box (MATLAB clips the curves to the axes)
        if (!this.clipRef) {
            const id = 'tbiclip' + (++clipId);
            const cp = node('clipPath', { id }, this.svg.defs);
            const [bx, by, bw, bh] = this.box;
            node('rect', { x: f2(bx), y: f2(by), width: f2(bw), height: f2(bh) }, cp);
            this.clipRef = `url(#${id})`;
        }
        return this.clipRef;
    }
    line(xs, ys, opt) {
        // polyline; NaN breaks the line; opt: color, lw (pt), dash ('--', ':', '-.'), clip
        opt = opt || {};
        let d = '', pen = false;
        for (let i = 0; i < xs.length; i++) {
            if (!isFinite(xs[i]) || !isFinite(ys[i])) { pen = false;  continue; }
            d += (pen ? 'L' : 'M') + f2(this.X(xs[i])) + ' ' + f2(this.Y(ys[i]));
            pen = true;
        }
        if (!d) return null;
        const lw = (opt.lw === undefined ? 0.5 : opt.lw) * PT;
        const at = { d, fill: 'none', stroke: opt.color || '#000', 'stroke-width': f2(lw), 'stroke-linejoin': 'round' };
        const dash = { '--': [6, 4], ':': [1.5, 3], '-.': [6, 3, 1.5, 3] }[opt.dash];
        if (dash) at['stroke-dasharray'] = dash.map(v => f2(v * Math.max(lw, 0.8))).join(' ');
        if (opt.clip) at['clip-path'] = this.clip();
        return node('path', at, this.svg.root);
    }
    fill(xs, ys, color, stroke, lw) {
        const at = { points: xs.map((x, i) => f2(this.X(x)) + ',' + f2(this.Y(ys[i]))).join(' '), fill: color };
        if (stroke) { at.stroke = stroke;  at['stroke-width'] = f2((lw || 0.75) * PT);  at['stroke-linejoin'] = 'round'; }
        return node('polygon', at, this.svg.root);
    }
    marker(x, y, sizePt) {
        // 'ko' with white face
        node('circle', { cx: f2(this.X(x)), cy: f2(this.Y(y)), r: f2(sizePt / 2 * PT), fill: '#fff', stroke: '#000',
                         'stroke-width': f2(0.5 * PT) }, this.svg.root);
    }
    text(x, y, str, opt) {
        return textNode(this.svg.root, this.X(x), this.Y(y), str, opt);
    }
    frame(xt, yt, xlab, ylab, fs) {
        // box with ticks inside on all sides, tick labels and axis labels
        const [bx, by, bw, bh] = this.box, g = this.svg.root, sw = f2(0.5 * PT);
        node('rect', { x: f2(bx), y: f2(by), width: f2(bw), height: f2(bh), fill: 'none', stroke: '#000', 'stroke-width': sw }, g);
        const tl = 0.01 * Math.max(bw, bh);
        for (const v of xt) {
            const px = this.X(v);
            node('path', { d: `M${f2(px)} ${f2(by + bh)}v${f2(-tl)}M${f2(px)} ${f2(by)}v${f2(tl)}`, stroke: '#000', 'stroke-width': sw }, g);
            textNode(g, px, by + bh + 0.35 * fs * PT, fmtTick(v), { size: fs - 1, ha: 'center', va: 'top', plain: true });
        }
        for (const v of yt) {
            const py = this.Y(v);
            node('path', { d: `M${f2(bx)} ${f2(py)}h${f2(tl)}M${f2(bx + bw)} ${f2(py)}h${f2(-tl)}`, stroke: '#000', 'stroke-width': sw }, g);
            textNode(g, bx - 0.35 * fs * PT, py, fmtTick(v), { size: fs - 1, ha: 'right', plain: true });
        }
        textNode(g, bx + bw / 2, by + bh + 1.6 * fs * PT, xlab, { size: fs, ha: 'center', va: 'top' });
        const gr = node('g', { transform: `translate(${f2(bx - 3.3 * fs * PT)} ${f2(by + bh / 2)}) rotate(-90)` }, g);
        textNode(gr, 0, 0, ylab, { size: fs, ha: 'center' });
    }
}


function diagOpt(opt) {
    // size and font of a diagram: 600 x 236 units, 9 pt (as the GUI)
    opt = opt || {};
    return { width: opt.width || 600, height: opt.height || 236, fontSize: opt.fontSize || 9 };
}


function diagAxes(o) {
    // drawing with one axes box; margins for tick and axis labels
    const svg = new Svg(o.width, o.height, FONT), u = o.fontSize * PT;
    const left = 4.3 * u, right = 0.8 * u, top = 0.7 * u, bottom = 3.0 * u;
    return new Ax(svg, [left / o.width, bottom / o.height, (o.width - left - right) / o.width,
                        (o.height - top - bottom) / o.height], [0, 1], [0, 1], false);
}


function legendNE(a, fs) {
    // legend summer / winter in the upper right corner, no box
    const [bx, by, bw] = a.box, u = fs * PT, g = a.svg.root;
    const lx = bx + bw - 5.6 * u, ly = by + 0.9 * u;
    ['summer', 'winter'].forEach((n, i) => {
        const yy = ly + i * 1.2 * u;
        node('path', { d: `M${f2(lx)} ${f2(yy)}h${f2(2.0 * u)}`, stroke: COL[i], 'stroke-width': f2(1 * PT) }, g);
        textNode(g, lx + 2.4 * u, yy, n, { size: fs - 1, plain: true });
    });
}


function niceTicks(lim, n) {
    // about n ticks in steps of 1, 2, 2.5 or 5 x 10^k (MATLAB-like automatic ticks)
    const raw = (lim[1] - lim[0]) / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    let st = 10 * p;
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) { st = m * p;  break; }
    const t = [];
    for (let k = Math.ceil(lim[0] / st - 1e-9); k * st <= lim[1] + 1e-9 * st; k++) t.push(+(k * st).toPrecision(12));
    return t;
}


const fmtTick = v => (Math.abs(v) < 1e-12 ? '0' : (v < 0 ? '−' : '') + String(+Math.abs(v).toPrecision(10)));


function textNode(parent, px, py, str, opt) {
    // text at (px,py) in user units: str = LaTeX subset (or plain text with
    // opt.plain), or an array of lines (strings or {t, color}); opt: size (pt),
    // ha 'left'/'center'/'right', va 'middle'/'top'/'bottom', color, weight
    opt = opt || {};
    const fs = (opt.size || 10) * PT;
    const lines = Array.isArray(str) ? str : [str];
    const n = lines.length, lh = 1.15 * fs;
    let y0;                                                      // baseline of the first line
    switch (opt.va || 'middle') {
    case 'top':    y0 = py + 0.80 * fs;  break;
    case 'bottom': y0 = py - 0.25 * fs - (n - 1) * lh;  break;
    default:       y0 = py + 0.32 * fs - (n - 1) * lh / 2;
    }
    const at = { x: f2(px), y: f2(y0), 'font-size': f2(fs), 'text-anchor': { left: 'start', center: 'middle', right: 'end' }[opt.ha || 'left'],
                 fill: opt.color || '#000' };
    if (opt.weight) at['font-weight'] = opt.weight;
    const t = node('text', at, parent);
    lines.forEach((ln, k) => {
        const s = typeof ln === 'object' && ln !== null ? ln.t : ln;
        const ls = node('tspan', { x: f2(px), y: f2(y0 + k * lh) }, t);
        if (ln && ln.color) ls.setAttribute('fill', ln.color);
        const runs = opt.plain ? [{ t: String(s), it: false, pos: 0 }] : parseTex(s);
        let shift = 0;
        for (const r of runs) {
            const ts = node('tspan', {}, ls);
            if (r.it) ts.setAttribute('font-style', 'italic');
            const target = r.pos === 1 ? 0.28 * fs : r.pos === -1 ? -0.38 * fs : 0;
            if (r.pos) ts.setAttribute('font-size', f2(0.72 * fs));
            if (target !== shift) ts.setAttribute('dy', f2(target - shift));
            shift = target;
            ts.textContent = r.t;
        }
    });
    return t;
}


//% ========================================================================
//  LaTeX SUBSET (table names, limits, labels)
//  ========================================================================
const GREEK = { alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
                theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
                tau: 'τ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
                Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ',
                Psi: 'Ψ', Omega: 'Ω' };
const SYM = { cdot: ' · ', times: ' × ', pm: '±', mp: '∓', le: ' ≤ ', leq: ' ≤ ', ge: ' ≥ ', geq: ' ≥ ',
              approx: ' ≈ ', infty: '∞', circ: '°', prime: '′', ldots: '…', quad: ' ', ',': ' ',
              ';': ' ', ' ': ' ', '!': '', '%': '%', '$': '$', '{': '{', '}': '}', '_': '_', '&': '&', '#': '#' };
const FONTCMD = { mathrm: false, text: false, textrm: false, mathit: true, mathbf: false, operatorname: false };


function parseTex(s) {
    // runs {t, it (italic), pos (0, 1 subscript, -1 superscript)} of a string
    // with $...$ math: letters italic, \mathrm upright, _ and ^, Greek, a few
    // symbols; outside math -- = en dash, ~ = no-break space. Unknown commands
    // are kept as text. The result is plain text: it is never parsed as HTML.
    const runs = [];
    const push = (t, it, pos) => {
        if (!t) return;
        const r = runs[runs.length - 1];
        if (r && r.it === it && r.pos === pos) r.t += t;
        else runs.push({ t, it, pos });
    };
    const group = (m, i) => {
        // argument at i: {...} (balanced), \command or one character -> [a, b, end]
        while (m[i] === ' ') i++;
        if (m[i] === '{') {
            let lev = 1, j = i + 1;
            for (; j < m.length && lev; j++) { if (m[j] === '{') lev++;  else if (m[j] === '}') lev--; }
            return [i + 1, lev ? j : j - 1, j];
        }
        if (m[i] === '\\') {
            const w = /^[A-Za-z]+/.exec(m.slice(i + 1));
            let e = i + 1 + (w ? w[0].length : 1);
            if (w && w[0] in FONTCMD) e = group(m, e)[2];          // _\mathrm{B}: the command with its argument
            return [i, e, e];
        }
        return [i, i + 1, i + 1];
    };
    const math = (m, i0, i1, ital, pos) => {
        let i = i0;
        while (i < i1) {
            const c = m[i];
            if (c === '\\') {
                const w = /^[A-Za-z]+/.exec(m.slice(i + 1, i1));
                let name;
                if (w) { name = w[0];  i += 1 + name.length;  while (m[i] === ' ' && i < i1) i++; }   // spaces end a control word
                else   { name = m[i + 1] || '';  i += 2; }
                if (name in FONTCMD) {
                    const [a, b, e] = group(m, i);
                    math(m, a, Math.min(b, i1), FONTCMD[name], pos);
                    i = e;
                } else if (GREEK[name]) push(GREEK[name], ital && name[0] === name[0].toLowerCase(), pos);
                else if (name in SYM)   push(SYM[name], false, pos);
                else                    push(name, false, pos);
                continue;
            }
            if (c === '_' || c === '^') {
                const [a, b, e] = group(m, i + 1);
                if (c === '^' && m.slice(a, b) === '\\circ') push('°', false, pos);     // ^\circ = degree sign
                else math(m, a, Math.min(b, i1), ital, c === '_' ? 1 : -1);
                i = e;
                continue;
            }
            if (c === '{') {
                const [a, b, e] = group(m, i);
                math(m, a, Math.min(b, i1), ital, pos);
                i = e;
                continue;
            }
            if (c === '}') { i++;  continue; }
            if (/[A-Za-z]/.test(c)) push(c, ital, pos);
            else if (c === '-')     push('−', false, pos);     // minus sign
            else                    push(c, false, pos);
            i++;
        }
    };
    String(s === undefined || s === null ? '' : s).split('$').forEach((p, n) => {
        if (n % 2 === 0) push(p.replace(/---/g, '—').replace(/--/g, '–').replace(/~/g, ' '), false, 0);
        else math(p, 0, p.length, true, 0);
    });
    return runs;
}


function tex2html(s) {
    // LaTeX subset to safe HTML: every text run is escaped, only <i>, <sub>
    // and <sup> are added (for innerHTML of the GUI tables)
    const esc = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return parseTex(s).map(r => {
        let h = esc(r.t);
        if (r.it) h = '<i>' + h + '</i>';
        if (r.pos === 1) h = '<sub>' + h + '</sub>';
        else if (r.pos === -1) h = '<sup>' + h + '</sup>';
        return h;
    }).join('');
}


function tex2nodes(s) {
    // LaTeX subset as DOM nodes (text nodes, <i>, <sub>, <sup>)
    const fr = document.createDocumentFragment();
    for (const r of parseTex(s)) {
        let e = document.createTextNode(r.t);
        if (r.it) { const i = document.createElement('i');  i.appendChild(e);  e = i; }
        if (r.pos) { const p = document.createElement(r.pos === 1 ? 'sub' : 'sup');  p.appendChild(e);  e = p; }
        fr.appendChild(e);
    }
    return fr;
}


//% ========================================================================
//  SMALL HELPERS
//  ========================================================================
function flat(v) {
    // all numbers of nested arrays
    const r = [];
    const go = a => { if (Array.isArray(a)) a.forEach(go);  else if (typeof a === 'number') r.push(a); };
    go(v);
    return r;
}


function khList(Kh, nsup) {
    // K_h per support: a number (N/m) or a spring law (nonlinear)
    if (Array.isArray(Kh) && Kh.length === nsup) return Kh;
    if (typeof Kh === 'number') return new Array(nsup).fill(Kh);
    return Array.isArray(Kh) ? Kh : new Array(nsup).fill(Kh);
}


function uniqueSorted(v) {
    const s = v.slice().sort((p, q) => p - q), r = [];
    for (const x of s) if (!r.length || Math.abs(x - r[r.length - 1]) > 1e-9) r.push(x);
    return r;
}


function fmtG(x) {
    // number as MATLAB sprintf('%g', x): 6 significant digits
    if (!isFinite(x)) return isNaN(x) ? 'NaN' : (x > 0 ? 'Inf' : '-Inf');
    if (x === 0) return '0';
    const r = +x.toPrecision(6), e = Math.floor(Math.log10(Math.abs(r)));
    if (e < -4 || e >= 6) {
        let [m, ex] = r.toExponential(5).split('e');
        m = m.replace(/\.?0+$/, '');
        const n = Math.abs(+ex);
        return m + 'e' + (+ex < 0 ? '-' : '+') + (n < 10 ? '0' : '') + n;
    }
    return String(r);
}


TBI.plotModel  = plotModel;
TBI.plotLoads  = plotLoads;
TBI.plotRail   = plotRail;
TBI.plotBridge = plotBridge;
TBI.tex2html   = tex2html;
TBI.tex2nodes  = tex2nodes;
})();

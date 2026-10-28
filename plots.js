/* plots.js -------------------------------------------------------------------
   SVG drawings of the TBI web app: the model sketch (port of PlotModel.m)
   and the rail stress diagrams (port of PlotResults.m).
   Andreas Andersson, 2026-10-28 (assisted by Claude)

   USAGE:
     TBIPlot.model(out, W, H, fsz)     -> SVG string, W x H user units, font
                                          size fsz in points (as MATLAB)
     TBIPlot.diagram(out, i, W, H, fsz)-> SVG string of diagram i (0 temperature,
                                          1 vertical traffic and braking/traction,
                                          2 governing load combination)
   Text markup in labels: <i>..</i> italic, <sub>..</sub>, <sup>..</sup>.
   Points are converted to user units with 4/3 (96 dpi), as MATLAB on screen.
---------------------------------------------------------------------------*/
(function (root) {
'use strict';

let clipId = 0;                                                    // unique clip path ids
const PT = 4 / 3;                                                  // user units per point
const FONT = "'Times New Roman', Times, serif";
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f2 = v => (Math.round(v * 100) / 100).toString();

// ---------------------------------------------------------------- canvas
class Svg {
    constructor(W, H) { this.W = W; this.H = H; this.el = []; }
    add(s) { this.el.push(s); }
    toString() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f2(this.W)} ${f2(this.H)}" ` +
               `width="100%" height="100%" preserveAspectRatio="xMidYMid meet" font-family="${FONT}">` +
               this.el.join('') + '</svg>';
    }
}

// axes: data -> user units; equal = MATLAB 'axis equal' (box centred)
class Ax {
    constructor(svg, pos, xlim, ylim, equal) {
        this.svg = svg; this.xlim = xlim; this.ylim = ylim;
        const bx = pos[0] * svg.W, bw = pos[2] * svg.W, bh = pos[3] * svg.H;
        const by = (1 - pos[1] - pos[3]) * svg.H;
        const xr = xlim[1] - xlim[0], yr = ylim[1] - ylim[0];
        if (equal) {
            const s = Math.min(bw / xr, bh / yr);
            this.sx = this.sy = s;
            this.x0 = bx + (bw - xr * s) / 2; this.y0 = by + (bh - yr * s) / 2;
        } else {
            this.sx = bw / xr; this.sy = bh / yr; this.x0 = bx; this.y0 = by;
        }
        this.box = [bx, by, bw, bh];
    }
    X(x) { return this.x0 + (x - this.xlim[0]) * this.sx; }
    Y(y) { return this.y0 + (this.ylim[1] - y) * this.sy; }
    // polyline; NaN breaks the line; opt: color, lw (pt), dash ('-', '--', ':', '-.')
    line(xs, ys, opt) {
        opt = opt || {};
        let d = '', pen = false;
        for (let i = 0; i < xs.length; i++) {
            if (!isFinite(xs[i]) || !isFinite(ys[i])) { pen = false; continue; }
            d += (pen ? 'L' : 'M') + f2(this.X(xs[i])) + ' ' + f2(this.Y(ys[i]));
            pen = true;
        }
        if (!d) return;
        const lw = (opt.lw === undefined ? 0.5 : opt.lw) * PT;
        const dash = { '--': [6, 4], ':': [1.5, 3], '-.': [6, 3, 1.5, 3] }[opt.dash];
        const da = dash ? ` stroke-dasharray="${dash.map(v => f2(v * Math.max(lw, 0.8))).join(' ')}"` : '';
        this.svg.add(`<path d="${d}" fill="none" stroke="${opt.color || '#000'}" stroke-width="${f2(lw)}"${da} ` +
                     `stroke-linejoin="round"${opt.clip ? ` clip-path="url(#${opt.clip})"` : ''}/>`);
    }
    fill(xs, ys, color, stroke, lw) {
        const pts = xs.map((x, i) => f2(this.X(x)) + ',' + f2(this.Y(ys[i]))).join(' ');
        const st = stroke ? ` stroke="${stroke}" stroke-width="${f2((lw || 0.75) * PT)}"` : '';
        this.svg.add(`<polygon points="${pts}" fill="${color}"${st}/>`);
    }
    marker(x, y, sizePt) {                                          // 'ko' with white face
        this.svg.add(`<circle cx="${f2(this.X(x))}" cy="${f2(this.Y(y))}" r="${f2(sizePt / 2 * PT)}" fill="#fff" stroke="#000" stroke-width="${f2(0.5 * PT)}"/>`);
    }
    // text: ha 'left'/'center'/'right', va 'middle'/'top'/'bottom'/'baseline'
    text(x, y, str, opt) {
        opt = opt || {};
        this.svg.add(textSvg(this.X(x), this.Y(y), str, opt));
    }
}

// SVG text with <i>, <sub>, <sup> markup; lines = array of strings
function textSvg(px, py, str, opt) {
    const fs = (opt.size || 10) * PT;
    const lines = Array.isArray(str) ? str : [str];
    const anchor = { left: 'start', center: 'middle', right: 'end' }[opt.ha || 'left'];
    const lh = 1.15 * fs, n = lines.length;
    let y0;                                                        // baseline of the first line
    switch (opt.va || 'middle') {
    case 'top':      y0 = py + 0.80 * fs; break;
    case 'bottom':   y0 = py - 0.25 * fs - (n - 1) * lh; break;
    case 'baseline': y0 = py; break;
    default:         y0 = py + 0.32 * fs - (n - 1) * lh / 2;
    }
    let s = `<text x="${f2(px)}" y="${f2(y0)}" font-size="${f2(fs)}" text-anchor="${anchor}" fill="${opt.color || '#000'}">`;
    lines.forEach((ln, k) => {
        let col = null, t = ln;
        const m = /^\{color:([^}]+)\}/.exec(t);
        if (m) { col = m[1]; t = t.slice(m[0].length); }
        s += `<tspan x="${f2(px)}" y="${f2(y0 + k * lh)}"${col ? ` fill="${col}"` : ''}>` + markup(t, fs) + '</tspan>';
    });
    return s + '</text>';
}

function markup(t, fs) {
    // <i>, <sub>, <sup> -> tspans; shifts with dy and restored afterwards
    let out = '', shift = 0;
    const re = /<(\/?)(i|sub|sup)>/g;
    let last = 0, m, it = false, sub = 0;
    const chunk = txt => {
        if (!txt) return;
        const sz = sub ? ` font-size="${f2(0.72 * fs)}"` : '';
        const target = sub === 1 ? 0.28 * fs : sub === -1 ? -0.38 * fs : 0;
        const dy = target - shift; shift = target;
        out += `<tspan${it ? ' font-style="italic"' : ''}${sz}${dy ? ` dy="${f2(dy)}"` : ''}>${esc(txt)}</tspan>`;
    };
    while ((m = re.exec(t))) {
        chunk(t.slice(last, m.index));
        last = re.lastIndex;
        if (m[2] === 'i') it = !m[1];
        else if (m[2] === 'sub') sub = m[1] ? 0 : 1;
        else sub = m[1] ? 0 : -1;
    }
    chunk(t.slice(last));
    if (shift) out += `<tspan dy="${f2(-shift)}">​</tspan>`;
    return out;
}

// ---------------------------------------------------------------- symbols (PlotModel.m)
function fjader_h(ax, x, y, a) {
    const n = 4, l = 0.2 * (x[1] - x[0]);
    const xx = [], yy = [];
    for (let i = 0; i <= 2 * n; i++) { xx.push(x[0] + l + i * (x[1] - x[0] - 2 * l) / (2 * n)); yy.push(i === 0 || i === 2 * n ? y : y + a * (i % 2 ? 1 : -1)); }
    ax.line([x[0], xx[0]], [y, y], { lw: 0.75 }); ax.line(xx, yy, { lw: 0.75 }); ax.line([xx[2 * n], x[1]], [y, y], { lw: 0.75 });
}
function fjader_v(ax, x, y, a) {
    const n = 4, l = 0.2 * (y[1] - y[0]);
    const xx = [], yy = [];
    for (let i = 0; i <= 2 * n; i++) { yy.push(y[0] + l + i * (y[1] - y[0] - 2 * l) / (2 * n)); xx.push(i === 0 || i === 2 * n ? x : x + a * (i % 2 ? 1 : -1)); }
    ax.line([x, x], [y[0], yy[0]], { lw: 0.75 }); ax.line(xx, yy, { lw: 0.75 }); ax.line([x, x], [yy[2 * n], y[1]], { lw: 0.75 });
}
function stod(ax, x, y, s, a) {
    a = a || 1;
    ax.fill([x - 0.45 * s, x, x + 0.45 * s], [y - a * 0.75 * s, y, y - a * 0.75 * s], '#fff', '#000', 0.75);
    ax.marker(x, y, 4);
    const r = 0.13 * s;
    for (const xx of [x - 0.22 * s, x + 0.22 * s]) {
        const px = [], py = [];
        for (let i = 0; i <= 30; i++) { const th = 2 * Math.PI * i / 30; px.push(xx + r * Math.cos(th)); py.push(y + a * (-s * 0.75 - r + r * Math.sin(th))); }
        ax.line(px, py, { lw: 0.75 });
    }
}
function fast(ax, x, y, s, a) {
    a = a || 1;
    ax.fill([x - 0.45 * s, x, x + 0.45 * s], [y - a * 0.75 * s, y, y - a * 0.75 * s], '#fff', '#000', 0.75);
    ax.marker(x, y, 4);
    const yg = y - a * 0.75 * s;
    ax.line([x - 0.7 * s, x + 0.7 * s], [yg, yg], { lw: 1.2 });
    for (let xx = x - 0.6 * s; xx <= x + 0.7 * s + 1e-9; xx += 0.2 * s) ax.line([xx, xx - 0.18 * s], [yg, yg - a * 0.25 * s], { lw: 0.5 });
}
function mark(ax, x, y, a) {
    a = a || 1;
    ax.line(x, [y, y], { lw: 0.75 });
    for (let xx = x[0] + 0.1; xx <= x[1] + 1e-9; xx += 0.3) ax.line([xx, xx - 0.15], [y, y - a * 0.2], { lw: 0.5 });
}
function matt(ax, x, y, txt, fsz, bruten, a) {
    a = a || 1;
    let xt;
    if (bruten) {
        const xm = (x[0] + x[1]) / 2 + 1.5, g = 0.25;
        ax.line([x[0], xm - g], [y, y]); ax.line([xm + g, x[1]], [y, y]);
        for (const dx of [-g, g]) ax.line([xm + dx - 0.15, xm + dx + 0.15], [y - a * 0.35, y + a * 0.35], { lw: 0.75 });
        xt = (x[0] + x[1]) / 2 - 1.0;
    } else { ax.line(x, [y, y]); xt = (x[0] + x[1]) / 2; }
    for (const xx of x) { ax.line([xx - 0.12, xx + 0.12], [y - a * 0.2, y + a * 0.2], { lw: 0.75 }); ax.line([xx, xx], [y - a * 0.3, y + a * 0.3]); }
    if (!txt) return;
    if (a === 1) ax.text(xt, y + 0.45, txt, { size: fsz, ha: 'center' });
    else ax.text(xt, y + a * 0.3, txt, { size: fsz, ha: 'center', va: 'bottom' });
}
function mattv(ax, x, y, txt, fsz, sida, a) {
    a = a || 1;
    ax.line([x, x], y);
    for (const yy of y) ax.line([x - 0.2, x + 0.2], [yy - a * 0.12, yy + a * 0.12], { lw: 0.75 });
    if (!txt) return;
    const left = sida === 'left';
    ax.text(x + (left ? -0.25 : 0.25), (y[0] + y[1]) / 2, txt, { size: fsz, ha: left ? 'right' : 'left' });
}
function arrowsAxes(ax, xm, ym, xlab, ylab, fsz) {
    const ha = [0.035 * xm, 0.07 * ym], hb = [0.025 * ym, 0.012 * xm];
    ax.fill([xm, xm - ha[0], xm - ha[0]], [0, hb[0], -hb[0]], '#000');
    ax.fill([0, hb[1], -hb[1]], [ym, ym - ha[1], ym - ha[1]], '#000');
    ax.line([0, xm - ha[0]], [0, 0], { lw: 0.75 });
    ax.line([0, 0], [0, ym - ha[1]], { lw: 0.75 });
    ax.text(xm, -0.07 * ym, xlab, { size: fsz, ha: 'center', va: 'top' });
    ax.text(0.04 * xm, ym, ylab, { size: fsz, ha: 'left' });
}
const sub = (v, s) => `<i>${v}</i><sub>${s}</sub>`;

// ---------------------------------------------------------------- MODEL (PlotModel.m)
function model(out, W, H, fsz) {
    const B = out.inp.Bridge, T = out.inp.Track, M = out.Model;
    const svg = new Svg(W, H);
    svg.add(`<rect x="0" y="0" width="${f2(W)}" height="${f2(H)}" fill="#fff"/>`);
    const lw = 2.0, nsup = M.xsup.length;
    const Kh = Array.isArray(B.Kh) ? B.Kh : new Array(nsup).fill(B.Kh);
    const fixd = Kh.map(k => !(typeof k === 'number' && k === 0));
    const lbl = fixd.map(f => (f ? 'FL' : 'RL'));

    // a) whole model
    const ov = M.Ls, we = 7, wb = 30, x0 = we;
    const sc = wb / (M.xsup[nsup - 1] - M.xsup[0] + 2 * ov);
    const xs = M.xsup.map(x => x0 + sc * (ov + x - M.xsup[0]));
    const xe = [x0, x0 + wb], xt = 2 * we + wb;
    let yR = 5.0, yB = 3.9, yS = yB - 1.2;
    const yM = -1.6;
    const a = new Ax(svg, [0.01, 0.56, 0.98, 0.43], [-0.5, xt + 0.5], [yM - 1.5, 6.3], true);
    a.line([0, xt], [yR, yR], { lw });
    a.line(xe, [yB, yB], { lw: 4 });
    for (let x = 0; x <= xt + 1e-9; x += 1) {
        const y0 = x >= xe[0] && x <= xe[1] ? yB : yR - 0.55;
        a.line([x, x], [y0, yR]);
    }
    for (let i = 0; i < nsup; i++) {
        a.line([xs[i], xs[i]], [yS, yB], { lw: 0.75 });
        if (fixd[i]) fast(a, xs[i], yS, 1.0); else stod(a, xs[i], yS, 1.0);
        a.text(xs[i], yS - 1.15, `${i + 1} (${lbl[i]})`, { size: fsz - 2, ha: 'center', va: 'top' });
    }
    mattv(a, xs[0] + 1.1, [yS, yB], sub('e', 'b'), fsz, 'right');
    a.line([xs[0] + 0.2, xs[0] + 1.3], [yS, yS]);
    const xo = xs[0] - sc * M.Ls;
    for (const g of T.gap) {                                      // rail expansion joints
        const xg = g < 0 ? xo + g * we / M.Le : g > M.Lb ? xe[1] + (g - M.Lb) * we / M.Le : xo + sc * g;
        a.line([xg - 0.35, xg + 0.35], [yR, yR], { lw: lw + 1.5, color: '#fff' });
        a.line([xg - 0.55, xg + 0.15], [yR + 0.12, yR + 0.12], { lw });
        a.line([xg - 0.15, xg + 0.55], [yR - 0.12, yR - 0.12], { lw });
        a.text(xg, yR + 0.35, 'REJ', { size: fsz - 2, ha: 'center', va: 'bottom' });
    }
    a.line([xo, xo + 1.2 - 0.36], [-0.6, -0.6], { lw: 0.75 });      // x axis arrow
    a.fill([xo + 1.2, xo + 1.2 - 0.36, xo + 1.2 - 0.36], [-0.6, -0.6 + 0.14, -0.6 - 0.14], '#000');
    a.text(xo + 1.35, -0.6, '<i>x</i>', { size: fsz });
    matt(a, [0, xe[0]], yM, M.Le.toFixed(1), fsz, true);
    matt(a, [xe[1], xt], yM, M.Le.toFixed(1), fsz, true);
    const xd = Array.from(new Set(xe.concat(xs).map(v => +v.toFixed(9)))).sort((p, q) => p - q);
    for (let i = 0; i < xd.length - 1; i++) {
        const len = (xd[i + 1] - xd[i]) / sc;
        let txt = len.toFixed(1);
        if (xd.length > 11 || Math.abs(len - ov) < 1e-9) txt = '';
        matt(a, [xd[i], xd[i + 1]], yM, txt, fsz - 2);
    }
    const pxa = a.sx;

    // b) detail at support 1, own scales in x and y
    const Hd = 5.0, gmin = 0.45;
    let gg = [B.e_b, B.h - T.e_r - B.e_b, T.e_r].map(v => Math.max(v / B.h * Hd, gmin));
    const gs = gg.reduce((p, q) => p + q, 0); gg = gg.map(v => v * Hd / gs);
    yS = 0; yB = yS + gg[0]; const yT = yB + gg[1]; yR = yT + gg[2];
    const ds = 2.2, xdk = 0, Ls = M.Ls;
    const xs0 = xdk + Math.min(Ls, 3 * M.s_r) / M.s_r * ds;
    const xss = [-1, 0, 1, 2, 3].map(i => xdk + ds * i);
    const xL = xss[0] - 1.0, xRt = xss[4] + 1.6;
    const xeb = xss[0] - 0.7, xh = xeb - 5.5;
    const b = new Ax(svg, [0.00, 0.00, 0.54, 0.60], [xh - 5.0, xRt + 3.2], [yS - 2.5, yR + 1.4], false);
    const asp = b.sx / b.sy, sb = pxa / b.sx;
    b.line([xL, xRt], [yR, yR], { lw });
    b.line([xdk, xRt], [yB, yB], { lw: 4 });
    b.line([xdk, xdk], [yB - asp * 0.25, yB + asp * 0.25], { lw: 1 });
    for (const x of xss) {
        const y0 = x < xdk ? yB - 0.1 * asp : yB;
        b.line([x, x], [yR, yT]);
        fjader_v(b, x, [y0, yT], 0.15);
        b.line([x + 0.9, x + 0.9], [y0, yT]);
        fjader_h(b, [x, x + 0.9], yT, 0.12 * asp);
        if (x < xdk) mark(b, [x - 0.2, x + 1.1], y0, asp);
    }
    b.text(xss[4] + 1.05, yT, sub('k', 't,h'), { size: fsz });
    b.text(xss[4] + 1.05, (yB + yT) / 2, sub('k', 't,v'), { size: fsz });
    b.line([xs0, xs0], [yB, yS], { lw: 0.75 });
    if (fixd[0]) fast(b, xs0, yS, sb, asp); else stod(b, xs0, yS, sb, asp);
    b.text(xs0, yS - asp * 1.3 * sb, `support 1 (${lbl[0]})`, { size: fsz, ha: 'center', va: 'top' });
    matt(b, [xss[1], xss[2]], yR + 0.6, sub('s', 'r') + ' = ' + M.s_r.toFixed(2), fsz, false, asp);
    mattv(b, xeb, [yS, yB], sub('e', 'b') + ' = ' + B.e_b.toFixed(2), fsz, 'left', asp);
    mattv(b, xeb, [yT, yR], sub('e', 'r') + ' = ' + T.e_r.toFixed(2), fsz, 'left', asp);
    mattv(b, xh, [yS, yR], '<i>h</i> = ' + B.h.toFixed(2), fsz, 'left', asp);
    b.line([xh - 0.2, xs0 - 0.35], [yS, yS]);
    b.line([xeb - 0.2, xss[0] - 0.3], [yB, yB], { dash: ':' });
    b.line([xeb - 0.2, xss[0] - 0.1], [yT, yT], { dash: ':' });
    b.line([xh - 0.2, xL], [yR, yR]);
    if (Ls > 1e-9) {
        const yL = yS + 0.45 * (yB - yS);
        b.line([xdk, xdk], [yB - asp * 0.25, yL - asp * 0.3]);
        matt(b, [xdk, xs0], yL, '', fsz, false, asp);
        b.text(xs0 + 0.4, yL, sub('L', 'end') + ' = ' + Number(Ls.toPrecision(3)), { size: fsz });
    }

    // c) track shear resistance
    const u0 = T.u0.map(v => 1e3 * v), Fu = T.Fu.map(v => v / 1e3), Fl = T.Fl / 1e3;
    const um = 2 * Math.max(...u0), Fm = 1.6 * Fl, cl = ['#ff0000', '#0000ff'];
    const c = new Ax(svg, [0.60, 0.19, 0.18, 0.34], [0, um * 1.12], [0, Fm], false);
    for (let j = 0; j < 2; j++) {
        c.line([0, u0[j], um], [0, Fl, Fl], { color: cl[j], lw: 1.25 });
        c.line([0, u0[j], um], [0, Fu[j], Fu[j]], { color: cl[j], lw: 1.25, dash: '--' });
    }
    arrowsAxes(c, um * 1.12, Fm, '<i>u</i> (mm)', sub('F', 'h') + ' (kN/m)', fsz);
    for (let j = 0; j < 2; j++) {
        c.text(u0[j], -0.07 * Fm, u0[j].toFixed(1), { color: cl[j], size: fsz - 2, ha: 'center', va: 'top' });
        c.text(-0.03 * um, Fu[j], Fu[j].toFixed(0), { color: cl[j], size: fsz - 2, ha: 'right' });
    }
    c.text(-0.03 * um, Fl, Fl.toFixed(0), { size: fsz - 2, ha: 'right' });
    c.text(0.72 * um, 0.95 * Fm, ['loaded (solid)', 'unloaded (dashed)', '{color:#ff0000}summer', '{color:#0000ff}winter'],
           { size: fsz - 4, va: 'top' });
    c.text(0.5 * um, -0.24 * Fm, ['track shear', 'resistance'], { size: fsz - 1, ha: 'center', va: 'top' });

    // d) vertical spring per sleeper
    const wm = 1, kc = T.Kv / 1e6, ku = T.Kv_up / 1e6;
    const d = new Ax(svg, [0.82, 0.19, 0.16, 0.34], [-wm * 1.15, wm * 1.15], [-1.2, 0.7], false);
    const yu = Math.min(ku / kc, 0.5), xu = ku > 0 ? wm * yu / (ku / kc) : wm;   // uplift line inside the axes
    d.line([-wm, 0, xu], [-1, 0, yu], { lw: 1.25 });
    const ha = [0.035 * 2.3, 0.07 * 1.9], hb = [0.025 * 1.9, 0.012 * 2.3];
    d.line([-wm, wm - ha[0]], [0, 0], { lw: 0.75 }); d.line([0, 0], [-1.15, 0.6 - ha[1]], { lw: 0.75 });
    d.fill([wm, wm - ha[0], wm - ha[0]], [0, hb[0], -hb[0]], '#000');
    d.fill([0, hb[1], -hb[1]], [0.6, 0.6 - ha[1], 0.6 - ha[1]], '#000');
    d.text(wm * 1.1, -0.08, '<i>w</i>', { size: fsz, va: 'top' });
    d.text(0.06, 0.62, sub('F', 'v'), { size: fsz });
    d.text(-0.55 * wm, -0.35, kc.toFixed(0) + ' MN/m', { size: fsz - 2, ha: 'right' });
    if (yu < 0.3) d.text(1.15 * wm, yu + 0.1, ku.toFixed(0) + ' MN/m', { size: fsz - 2, ha: 'right', va: 'bottom' });
    else d.text(0.15 * wm, 0.12, ku.toFixed(0) + ' MN/m', { size: fsz - 2, ha: 'left', va: 'bottom' });   // steep line: label right of it, clear of F_v
    d.text(-0.5 * wm, -0.9, 'compression', { size: fsz - 4, ha: 'center' });
    d.text(0.5 * wm, -0.25, 'uplift', { size: fsz - 4, ha: 'center' });
    d.text(0, -1.2 - 0.24 * 1.9, ['track vertical', 'stiffness'], { size: fsz - 1, ha: 'center', va: 'top' });
    return svg.toString();
}

// ---------------------------------------------------------------- DIAGRAMS (PlotResults.m)
// titles; with SW/0 the middle diagram has dash-dot lines
const dtitle = (out, i) => (i === 1 && out.inp.Load.SW
    ? 'LM71 (dashed), SW/0 (dash-dot), braking/traction (solid), envelope' : DTITLE[i]);
const DTITLE = ['Temperature', 'Vertical traffic (dashed), braking/traction (solid), envelope',
                'Governing load combination (solid), temperature step (dashed)'];

function ylimits(arrs, ymin) {
    let a = 0;
    for (const v of arrs.flat(Infinity)) if (isFinite(v)) a = Math.max(a, Math.abs(v));
    const y = Math.max(ymin, 20, 20 * Math.ceil(1.1 * a / 20));
    return [-y, y];
}

function diagram(out, k, W, H, fsz, title) {
    const T = out.Track, M = out.Model, Lim = out.inp.Limits, Ld = out.inp.Load;
    const x = T.x, xl = [-60, M.Lb + 60], col = ['#ff0000', '#0000ff'];
    const lim = [Lim.sig_emb[0], Lim.sig_emb[1]];
    const svg = new Svg(W, H);
    const fs = fsz, cid = 'clip' + (++clipId);
    const top = title ? 1.9 * fs * PT : 0.6 * fs * PT;
    const left = 4.2 * fs * PT, right = 0.6 * fs * PT, bottom = 3.0 * fs * PT;
    const pos = [left / W, bottom / H, (W - left - right) / W, (H - top - bottom) / H];
    let yl, draw;
    if (k === 0) {
        yl = ylimits([T.temp.min, T.temp.max], 120);
        draw = ax => {
            for (let s = 0; s < 2; s++) {
                ax.line(x, T.temp.min[s], { color: col[s], lw: 1, clip: cid });
                if (T.temp.max[s].some((v, i) => v !== T.temp.min[s][i])) ax.line(x, T.temp.max[s], { color: col[s], lw: 1, clip: cid });
                ax.line(xl, [lim[s], lim[s]], { color: col[s], dash: ':' });
            }
        };
    } else if (k === 1) {
        const hmin = [0, 1].map(s => T.brk.min[s].map((v, i) => Math.min(v, T.acc.min[s][i])));
        const hmax = [0, 1].map(s => T.brk.max[s].map((v, i) => Math.max(v, T.acc.max[s][i])));
        yl = ylimits([Ld.LM71 ? [T.LM71.min, T.LM71.max] : [], hmin, hmax], 0);
        draw = ax => {
            for (let s = 0; s < 2; s++) {
                if (Ld.LM71) { ax.line(x, T.LM71.min[s], { color: col[s], dash: '--', clip: cid }); ax.line(x, T.LM71.max[s], { color: col[s], dash: '--', clip: cid }); }
                if (Ld.SW)   { ax.line(x, T.SW.min[s], { color: col[s], dash: '-.', clip: cid }); ax.line(x, T.SW.max[s], { color: col[s], dash: '-.', clip: cid }); }
                ax.line(x, hmin[s], { color: col[s], lw: 1, clip: cid }); ax.line(x, hmax[s], { color: col[s], lw: 1, clip: cid });
            }
        };
    } else {
        yl = ylimits([T.comb.gov, T.comb.govTemp], 120);
        draw = ax => {
            for (let s = 0; s < 2; s++) {
                ax.line(x, T.comb.govTemp[s], { color: col[s], dash: '--', clip: cid });
                ax.line(x, T.comb.gov[s], { color: col[s], lw: 1, clip: cid });
                ax.line(xl, [lim[s], lim[s]], { color: col[s], dash: ':' });
            }
        };
    }
    const ax = new Ax(svg, pos, xl, yl, false);
    const [bx, by, bw, bh] = ax.box;
    svg.add(`<defs><clipPath id="${cid}"><rect x="${f2(bx)}" y="${f2(by)}" width="${f2(bw)}" height="${f2(bh)}"/></clipPath></defs>`);
    for (const xsup of M.xsup) ax.line([xsup, xsup], yl, { color: '#808080', dash: ':' });   // supports
    draw(ax);
    // box, ticks and tick labels
    svg.add(`<rect x="${f2(bx)}" y="${f2(by)}" width="${f2(bw)}" height="${f2(bh)}" fill="none" stroke="#000" stroke-width="${f2(0.5 * PT)}"/>`);
    const tl = 0.01 * Math.max(bw, bh);
    const xstep = niceStep(xl[1] - xl[0], 10);
    for (let v = Math.ceil(xl[0] / xstep) * xstep; v <= xl[1] + 1e-9; v += xstep) {
        const px = ax.X(v);
        svg.add(`<path d="M${f2(px)} ${f2(by + bh)}v${f2(-tl)}M${f2(px)} ${f2(by)}v${f2(tl)}" stroke="#000" stroke-width="${f2(0.5 * PT)}"/>`);
        svg.add(textSvg(px, by + bh + 0.35 * fs * PT, fmtTick(v), { size: fs - 1, ha: 'center', va: 'top' }));
    }
    const dy = 20 * Math.max(1, Math.round((yl[1] - yl[0]) / 6 / 20));
    for (let v = yl[0]; v <= yl[1] + 1e-9; v += dy) {
        const py = ax.Y(v);
        svg.add(`<path d="M${f2(bx)} ${f2(py)}h${f2(tl)}M${f2(bx + bw)} ${f2(py)}h${f2(-tl)}" stroke="#000" stroke-width="${f2(0.5 * PT)}"/>`);
        svg.add(textSvg(bx - 0.35 * fs * PT, py, fmtTick(v), { size: fs - 1, ha: 'right' }));
    }
    svg.add(textSvg(bx + bw / 2, by + bh + 1.6 * fs * PT, '<i>x</i> (m)', { size: fs, ha: 'center', va: 'top' }));
    svg.add(`<g transform="translate(${f2(bx - 3.2 * fs * PT)} ${f2(by + bh / 2)}) rotate(-90)">` +
            textSvg(0, 0, '<i>σ</i><sub>R</sub> (MPa)', { size: fs, ha: 'center' }) + '</g>');
    if (title) svg.add(textSvg(bx + bw / 2, by - 0.5 * fs * PT, title, { size: fs, ha: 'center', va: 'bottom' }));
    // legend, upper right inside the box
    const lx = bx + bw - 6.2 * fs * PT, ly = by + 0.9 * fs * PT;
    ['summer', 'winter'].forEach((n, i) => {
        const yy = ly + i * 1.2 * fs * PT;
        svg.add(`<path d="M${f2(lx)} ${f2(yy)}h${f2(2.2 * fs * PT)}" stroke="${col[i]}" stroke-width="${f2(1 * PT)}"/>`);
        svg.add(textSvg(lx + 2.6 * fs * PT, yy, n, { size: fs - 1 }));
    });
    return svg.toString();
}

function niceStep(range, n) {
    const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
}
const fmtTick = v => (Math.abs(v) < 1e-9 ? '0' : (v < 0 ? '−' : '') + String(+Math.abs(v).toFixed(6)));

root.TBIPlot = { model, diagram, DTITLE, dtitle, textSvg, markup };
})(typeof window !== 'undefined' ? window : globalThis);

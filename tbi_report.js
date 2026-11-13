/* tbi_report.js --------------------------------------------------------------
   TBI-analysis according to EN 1991-2:2024, 8.5.4
   makes a short technical report as a printable HTML page based on output
   from tbi_fem.js (port of TBI_report.m; save as PDF in the print dialog)
   Andreas Andersson, 2026-11-13 (assisted by Claude)
-------------------------------------------------------------------------------
   USAGE: el = TBI.report(out)

   INPUT:
     out = output of TBI.analysis(inp) (see README.md)
   OUTPUT:
     el  = <div class="report"> with the whole report: title, Basis,
           Structural model (figure 1), Input (tables 1-3, new page), Results
           (tables 4-6, new page), rail stress diagrams (figures 2-4, new page)

   Needs tbi_plot.js (TBI.plotModel, TBI.plotRail, TBI.tex2nodes). Styles in
   tbi.css: h1, h2, p, ul, table, caption, .pb (page break before), .fig
   (figure, 160 mm wide), .cap (figure caption), .ex (value outside the
   limit, bold red). The date and page numbers of TBI_report.m's page header
   and footer belong to the @page rule of the print style.
   Built with createElement/textContent only; text with $...$ goes through
   TBI.tex2nodes (plain text runs, never parsed as HTML).
-----------------------------------------------------------------------------*/
(function () {
'use strict';

const root = typeof window !== 'undefined' ? window : globalThis;
const TBI = root.TBI = root.TBI || {};


function report(out) {
    const B = out.inp.Bridge, T = out.inp.Track, Ld = out.inp.Load, M = out.Model;
    const nsup = M.xsup.length;
    const Kh = Array.isArray(B.Kh) && B.Kh.length === nsup ? B.Kh : new Array(nsup).fill(B.Kh);
    let btyp = String(B.type || '').toLowerCase();               // steel, composite or concrete
    if (!['steel', 'composite', 'concrete'].includes(btyp)) btyp = 'concrete';
    const styp = /^ballastless$/i.test(String(T.type)) ? 'ballastless' : 'ballasted';
    const rb  = !!out.Track.rbreak;
    const rej = !!out.Track.rej;                                 // rail expansion joints
    const ES  = endScreens(B.endsprings);

    const rep = el('div', 'report');
    el('h1', '', rep, 'Longitudinal Track-Bridge Interaction');

    // basis and model --------------------------------------------------------
    el('h2', '', rep, 'Basis');
    let s = 'Longitudinal track-bridge interaction according to EN 1991-2:2024, 8.5.3–8.5.4: additional rail stresses (8.5.4.5.1), ' +
            'deck displacements (8.5.4.5.2) and longitudinal bearing forces. Track resistance according to Table 8.9, ' +
            'uniform deck temperature according to 8.5.4.3, vertical traffic and braking/traction multiplied by $\\alpha$.';
    if (rb) {
        let src = 'the given limit';                             // TRVINFRA-00012 K35714 is 50 mm
        if (out.inp.Limits.wgap === 50) src = 'TRVINFRA-00012, K35714';
        s += ` Rail break gap according to CEN/TR 17231, Annex A.2, compared with ${num(out.inp.Limits.wgap)} mm according to ${src} ` +
             `(${out.Track.rbreak.wCWR.toFixed(0)} mm for a break in track on an embankment, A.1).`;
    }
    par(rep, s);

    el('h2', '', rep, 'Structural model');
    s = '2D FE model with rail and deck as beams, see figure 1. At each rail seat the rail is connected to the deck, or to the ground ' +
        'on the embankments, by bilinear springs for unloaded and loaded track resistance and a vertical spring. Bearings are vertically fixed with a ' +
        'longitudinal spring at bearing level. Nonlinear analysis in two steps: temperature on unloaded track (step 1), then vertical ' +
        'traffic and braking or traction with loaded track resistance where vertical traffic acts (step 2).';
    if (ES.length) {                                             // end screens (backfill behind the deck ends)
        const sd = [...new Set(ES.map(e => String(e.side).toLowerCase()))].join(' and ');
        s += ` End screens at the ${plain(sd)} deck end${ES.length > 1 ? 's' : ''} are longitudinal springs between the deck and the ground ` +
             '(soil pressure), see table 1.';
    }
    if (out.Info && out.Info.nlgeom) {                           // P-delta (GUI tick box, opt.nlgeom)
        s += ' Geometrically nonlinear beams (P-$\\delta$, von Kármán strain), so the deflection from vertical traffic also shortens the deck.';
    }
    par(rep, s + ' Load cases, summer and winter:');
    const ul = el('ul', '', rep);
    const t0 = B.T0 !== undefined && B.T0 !== null && isFinite(B.T0) ? ` from $T_0$ = $${fmtG(B.T0)}$ °C` : '';
    item(ul, `temperature, ${btyp} deck: $\\Delta T_\\mathrm{N}$ = $${sgnG(B.dT[0])}$ / $${sgnG(B.dT[1])}$ °C (summer / winter)${t0};`);
    const pos = Ld.dxPos > 0 ? `in ${out.LoadPos.xloco.length} positions, step ${num(Ld.dxPos)} m` : 'from the movable end bearing';
    const vl = [];
    if (Ld.LM71) vl.push(`LM71 with the locomotive ${pos}`);
    if (Ld.SW)   vl.push('SW/0');
    if (vl.length) item(ul, vl.join(', ') + ';');
    item(ul, `braking over ${num(out.LoadPos.Lbrk)} m and traction over ${num(out.LoadPos.Lacc)} m from either end, both directions` +
             (B.n_track === 2 ? ', braking on track 1 with traction on track 2' : '') + ';');
    item(ul, 'load combination: temperature (step 1), vertical traffic with braking or traction (step 2), and the same ' +
             'without temperature (at neutral temperature the track resistance has not yielded); envelope of both;');
    if (rej) {
        item(ul, 'with rail expansion joints: rail temperature included, temperature given as total rail stress ' +
                 '(the additional stress is not defined at a joint); the additional rail stress of the load combination only ' +
                 'without temperature;');
    }
    if (rb) {
        item(ul, `rail break, winter only: deck $${sgnG(out.Track.rbreak.dT_B)}$ °C, rail $${sgnG(out.Track.rbreak.dT_R)}$ °C, ` +
                 'both rails of one track broken at the bridge ends and at the largest rail tension.');
    }
    const units = out.Table.map(t => t.unit);
    const tlast = units.includes('kN') ? 6 : 5;                  // no fixed bearing: no force table
    par(rep, `In total ${out.Info.nRun} analyses. Input in tables 1–3, results in tables 4–${tlast} and figures 2–4.`);
    const f1 = el('div', 'fig', rep);
    TBI.plotModel(f1, out, { width: 1150, height: 600, fontSize: 16 });   // ca 9 pt at 160 mm
    caption(rep, 'Figure 1: 2D FE model: whole model (top), detail at support 1, track shear resistance per m of track and ' +
                 'track vertical stiffness per sleeper (bottom), dimensions in m.');

    // input, one page ---------------------------------------------------------
    el('h2', 'pb', rep, 'Input');
    par(rep, `${upper1(btyp)} bridge, ${B.n_track} track(s), ${styp} track. In the model, the bridge length and the embankments are ` +
             'whole sleeper spacings (a rail seat at each deck end); $L_\\mathrm{end}$ is rounded to the deck element length and the ' +
             'spans are scaled to fit. $x$ is measured from support 1.');
    let rows = [
        ['Spans, $L$', B.L.map(fmtG).join(' + '), 'm'],                    // as given, as in figure 1
        ['Cross-section area, $A_\\mathrm{b}$', num(B.A), 'm$^2$'],
        ['Second moment of area, $I_\\mathrm{b}$', num(B.I), 'm$^4$'],
        ["Young's modulus, $E_\\mathrm{b}$", num(B.E / 1e9), 'GPa'],
        ['Thermal expansion, $\\alpha_\\mathrm{b}$', e6(B.alfa), '1/K'],
        ['Neutral axis to bearings, $e_\\mathrm{b}$', num(B.e_b), 'm'],
        ['Bearings to top of rail, $h$', num(B.h), 'm'],
        ['Deck end beyond the end bearings, $L_\\mathrm{end}$', fmtG(B.L_end), 'm'],
        ['Deck temperature change, $\\Delta T_\\mathrm{N}$, summer / winter', `$${sgnG(B.dT[0])}$ / $${sgnG(B.dT[1])}$`, '°C']];
    Kh.forEach((k, i) => {
        if (typeof k === 'number' && k === 0) rows.push([`Support ${i + 1}, longitudinal stiffness`, 'movable', '--']);
        else if (typeof k === 'number')       rows.push([`Support ${i + 1}, longitudinal stiffness, $K_\\mathrm{h}$`, sci(k / 1e9), 'GN/m']);
        else                                  rows.push([`Support ${i + 1}, longitudinal stiffness`, 'nonlinear', '--']);
    });
    for (const e of ES) {                                        // end screens: side, level, stiffness
        const zt = `${plain(String(e.side).toLowerCase())} end, at ${num(e.z)} m above the bearings`;
        if (typeof e.law === 'number') rows.push([`End screen, ${zt}`, num(e.law / 1e6), 'MN/m']);
        else                           rows.push([`End screen, ${zt}`, 'nonlinear', '--']);
    }
    rep.appendChild(table('Table 1: Bridge.', rows));
    rows = [
        ['Rail cross-section area per rail, $A_\\mathrm{r}$', `$${(T.A / 2 * 1e4).toFixed(1)} \\cdot 10^{-4}$`, 'm$^2$'],
        ['Rail second moment of area per rail, $I_\\mathrm{r}$', `$${(T.I / 2 * 1e8).toFixed(1)} \\cdot 10^{-8}$`, 'm$^4$'],
        ["Young's modulus, $E_\\mathrm{r}$", num(T.E / 1e9), 'GPa'],
        ['Thermal expansion, $\\alpha_\\mathrm{r}$', e6(T.alfa), '1/K'],
        ['Top of rail to track slip centre, $e_\\mathrm{r}$', num(T.e_r), 'm'],
        ['Sleeper spacing, $s_\\mathrm{r}$', num(T.s_r), 'm'],
        ['Track on each embankment, $L_\\mathrm{e}$', num(M.Le), 'm'],
        ['Elastic displacement, $u_0$, summer / winter', `${num(1e3 * T.u0[0])} / ${num(1e3 * T.u0[1])}`, 'mm'],
        ['Resistance, unloaded track, $F_\\mathrm{u}$, summer / winter', `${num(T.Fu[0] / 1e3)} / ${num(T.Fu[1] / 1e3)}`, 'kN/m'],
        ['Resistance, loaded track, $F_\\mathrm{l}$', num(T.Fl / 1e3), 'kN/m'],
        ['Vertical stiffness per sleeper, compression / uplift', `${num(T.Kv / 1e6)} / ${num(T.Kv_up / 1e6)}`, 'MN/m'],
        ['Rail temperature change, $\\Delta T_\\mathrm{R}$, summer / winter', `$${sgnG(T.dT[0])}$ / $${sgnG(T.dT[1])}$`, '°C']];
    if (T.dT_brk !== undefined && T.dT_brk !== null) rows.push(['Rail temperature change, rail break', `$${sgnG(T.dT_brk)}$`, '°C']);
    if (T.gap && T.gap.length) rows.push(['Rail expansion joints, $x$', T.gap.map(num).join(', '), 'm']);
    if (['law1', 'law2', 'lawBr1', 'lawBr2', 'lawV'].some(f => T[f] !== undefined && T[f] !== null)) {
        rows.push(['Special spring laws', 'see input file', '--']);
    }
    rep.appendChild(table('Table 2: Track.', rows));
    rows = [['Load classification factor, $\\alpha$', num(Ld.alfa), '--']];
    if (Ld.LM71) rows.push(['LM71, distributed load / locomotive over 6.4 m', '80 / 156', 'kN/m']);
    if (Ld.SW)   rows.push(['SW/0, 2 $\\times$ 15 m, 5.3 m apart', '133', 'kN/m']);
    rows.push(['Braking, $q_\\mathrm{lbk}$ (max $Q_\\mathrm{lbk}$)', `${num(Ld.qlbk / 1e3)} (${num(Ld.Qlbk_max / 1e3)})`, 'kN/m (kN)']);
    rows.push(['Traction, $q_\\mathrm{lak}$ (max $Q_\\mathrm{lak}$)', `${num(Ld.qlak / 1e3)} (${num(Ld.Qlak_max / 1e3)})`, 'kN/m (kN)']);
    rep.appendChild(table('Table 3: Traffic loads, characteristic values.', rows));

    // results, one page -------------------------------------------------------
    el('h2', 'pb', rep, 'Results');
    const ex = out.Table.some(t => flat(t.exceed).some(Boolean));
    par(rep, 'Rail stresses are additional stresses (min / max), displacements at the left / right deck end and bearing forces the largest ' +
             'magnitude (positive in $+x$ on the deck). ' + (ex ? 'Values outside the limits are marked in bold red.' : 'All limits are met.'));
    const grp = [['MPa', 'Additional rail stress (MPa).'], ['mm', 'Displacements (mm).'], ['kN', 'Longitudinal bearing forces (kN).']];
    let nt = 4;
    for (const [unit, cap] of grp) {
        const ig = out.Table.filter(t => t.unit === unit);
        if (!ig.length) continue;
        let wd = 0;                                              // bearing forces: right-aligned among themselves,
        if (unit === 'kN') {                                     // centred in the cell: widest value
            for (const t of ig) {
                const v = flat(t.val);
                for (const x of [v[0], v[v.length - 1]]) wd = Math.max(wd, x.toFixed(0).length);
            }
        }
        rows = ig.map(t => {
            const lim = String(t.lim).replace(/\$([+-]?[\d.]+)\$/g, '$1');   // limits as text, hyphen as minus
            const v = [fmtval(t, 0), fmtval(t, 1)];
            return [tr(t.name), lim, wd ? alignR(v[0], wd) : v[0], wd ? alignR(v[1], wd) : v[1]];
        });
        rep.appendChild(table(`Table ${nt}: ${cap}`, rows, ['', 'Limit', 'Summer', 'Winter']));
        nt++;
    }

    // diagrams, one page ------------------------------------------------------
    el('div', 'pb', rep);
    const cap = ['Additional rail stress, temperature.',
                 'Additional rail stress, vertical traffic (dashed) and braking/traction (solid), envelope.',
                 'Additional rail stress, governing load combination with or without temperature (solid) and its temperature step (dashed).'];
    if (Ld.SW) cap[1] = 'Additional rail stress, LM71 (dashed), SW/0 (dash-dot) and braking/traction (solid), envelope.';
    if (rej) {
        cap[0] = 'Total rail stress, temperature; dotted: fully restrained rail.';
        cap[2] = 'Additional rail stress, governing load combination without temperature.';
    }
    const figs = [];
    for (let i = 0; i < 3; i++) {
        figs.push(el('div', 'fig', rep));
        caption(rep, `Figure ${i + 2}: ${cap[i]}`);
    }
    TBI.plotRail(figs, out, { width: 700, height: 280, fontSize: 11 });    // 160 x 64 mm, ca 9.5 pt
    return rep;
}


//% ------------------------------------------------------------------------
function table(cap, rows, head) {
    // table with caption above; rows = arrays of cells (text with $...$ or
    // DOM nodes); head ['', 'Value', 'Unit'] by default
    head = head || ['', 'Value', 'Unit'];
    const t = el('table');
    el('caption', '', t, cap);
    const tr0 = el('tr', '', el('thead', '', t));
    for (const h of head) el('th', '', tr0, h);
    const tb = el('tbody', '', t);
    for (const r of rows) {
        const tr = el('tr', '', tb);
        for (const c of r) {
            const td = el('td', '', tr);
            if (c instanceof Node) td.appendChild(c);
            else td.appendChild(TBI.tex2nodes(c));
        }
    }
    return t;
}

function tr(s) {
    // row name of the result table in the report (REJ written out)
    return String(s).replace(/^Opening of REJ/, 'Opening of rail expansion joint');
}

function num(x) {
    // number with at most 6 significant digits, decimal point, math mode for negatives
    const s = fmtG(x);
    return x < 0 ? `$${s}$` : s;
}

function e6(x) {
    // thermal expansion as "12 . 10^-6"
    return `$${fmtG(Math.round(x * 1e6 * 1e3) / 1e3)} \\cdot 10^{-6}$`;
}

function sci(x) {
    // number in scientific notation
    if (x === 0) return '0';
    const p = Math.floor(Math.log10(Math.abs(x)));
    if (p >= -2 && p <= 3) return num(x);
    return `$${fmtG(Math.round(x / Math.pow(10, p) * 1e4) / 1e4)} \\cdot 10^{${p}}$`;
}

function fmtval(t, k) {
    // table value of season k: two rows = "a / b", one row = value; values
    // outside the limit in bold red (class ex)
    const v  = t.val.map(r => r[k]);
    const ex = t.exceed.map(r => r[k]);
    let d = t.unit === 'kN' ? 0 : 1, sign = t.unit === 'MPa';
    if (t.dec !== undefined && t.dec !== null && !(Array.isArray(t.dec) && !t.dec.length)) { d = +t.dec;  sign = false; }   // own decimals
    const fr = document.createDocumentFragment();
    v.forEach((x, i) => {
        if (i) fr.appendChild(document.createTextNode(' / '));
        if (x === null || isNaN(x)) { fr.appendChild(document.createTextNode('–'));  return; }   // en dash for empty values
        const s = (sign && x >= 0 ? '+' : '') + x.toFixed(d);    // hyphen as minus (as TBI_report.m)
        if (ex[i]) el('span', 'ex', fr, s);
        else fr.appendChild(document.createTextNode(s));
    });
    return fr;
}

function alignR(fr, w) {
    // bearing forces: right-aligned in a box as wide as the widest value
    const s = el('span', 'rn');
    s.style.display = 'inline-block';                            // CSSOM, allowed by the CSP
    s.style.minWidth = w + 'ch';
    s.style.textAlign = 'right';
    s.appendChild(fr);
    return s;
}

function upper1(s) {
    // first letter in upper case
    return s ? s[0].toUpperCase() + s.slice(1) : s;
}


//% ------------------------------------------------------------------------
//  DOM and number helpers
function el(tag, cls, parent, text) {
    // element with class and plain text content (or LaTeX subset for h/p)
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.appendChild(TBI.tex2nodes(text));
    if (parent) parent.appendChild(e);
    return e;
}

function par(parent, s)     { return el('p', '', parent, s); }
function item(ul, s)        { return el('li', '', ul, s); }
function caption(parent, s) { return el('div', 'cap', parent, s); }

function plain(s) {
    // input text placed in report text: no math or dashes
    return String(s).replace(/[$\\~]/g, '').replace(/-{2,}/g, '-');
}

function endScreens(E) {
    // end screens as an array of {side, z, law}
    if (!E) return [];
    return Array.isArray(E) ? E : [E];
}

function flat(v) {
    const r = [];
    const go = a => { if (Array.isArray(a)) a.forEach(go);  else r.push(a); };
    go(v);
    return r;
}

function fmtG(x) {
    // number as MATLAB sprintf('%g', round(x, 6, 'significant'))
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

function sgnG(x) {
    // %+g
    return (x >= 0 ? '+' : '') + fmtG(x);
}


TBI.report = report;
})();

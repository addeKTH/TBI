# Longitudinal track-bridge interaction (TBI), 2D — web version

Longitudinal track-bridge interaction according to EN 1991-2:2024, 8.5.3–8.5.4, in the
browser: 2D FE model with rail(s) and deck as beams, nonlinear track resistance
(Table 8.9), bearings and end screens as springs, two-step analysis (temperature on
unloaded track, then vertical traffic and braking/traction on loaded track), rail break
(CEN/TR 17231 A.2). JavaScript port of the MATLAB version (`../TBI_2D_Matlab`), with the
same files, input, analysis and results. No build step and no libraries: static files.

## Running it

Serve the folder and open `index.html`, e.g. `python -m http.server 8000`, then
http://localhost:8000. The load cases are solved in parallel in Web Workers.

## Files (one per MATLAB file)

| File | MATLAB | Content |
|---|---|---|
| `index.html` | – | page skeleton, Content Security Policy, script tags |
| `tbi.css` | – | all styles (screen and print) |
| `tbi_fem.js` | `TBI_fem.m` | input defaults and check, JSON input, model, load arrangements, solver, analysis, results table |
| `tbi_worker.js` | (parfor) | Web Worker: builds the model once per run and solves load cases |
| `tbi_gui.js` | `TBI_gui.m` | input fields, events, run, result tables, open/save, export, print |
| `tbi_plot.js` | `TBI_plot.m` | SVG drawings: model, load models, rail stress and deck diagrams |
| `tbi_report.js` | `TBI_report.m` | report as a printable HTML page (save as PDF in the print dialog) |
| `tbi_xlsx.js` | – | minimal Excel (.xlsx) writer |
| `tbi_input.json` | `TBI_input.json` | default input (the bridge over Bryngeån) |
| `count.js` | – | GoatCounter page counter (unchanged) |
| `test/` | – | `make_reference.m` (MATLAB reference of the 31 benchmark cases), `test.html` / `test.js` (comparison in the browser) |

## Interfaces (shared by all files)

All functions are on one global object `TBI` (no modules, so that the page also works
without a server for the GUI and the worker can use `importScripts`).

`tbi_fem.js`

- `TBI.readJson(obj)` → `{inp, opt}`: the fields of the GUI / `TBI_input.json` (text as in
  the boxes, engineering units) to the input struct in SI units, as `readJson` in
  `TBI_fem.m`; `opt` holds `nlgeom` and `nInc` when present.
- `TBI.setDefaults(inp)` → completed copy of `inp` (defaults and input check as
  `setDefaults`/`checkInput`); errors are thrown as `Error` with a readable message.
- `TBI.model(inp)` → `{inp, Model}` (as `opt.defaultsOnly`): input with defaults and the
  geometry as rounded in the model.
- `await TBI.analysis(inp, opt)` → `out`. `opt.nlgeom` (false), `opt.nInc` (1),
  `opt.progress(fraction)`, `opt.workers` (number of workers, 0 = main thread).
- `TBI.stop()` ends a running analysis (it rejects with `Error('stopped')`).
- `TBI.springLaw(spec)`, `TBI.fixInc(n)` and the other helpers as in `TBI_fem.m`.

`out` has the fields of `TBI_fem.m` (x from support 1, SI units except where stated):

- MATLAB columns summer / winter become the first index `[k]`, k = 0 summer, 1 winter:
  a MATLAB `nx × 2` matrix is `[2][nx]` in JavaScript.
- `out.inp`, `out.Model` = {Lb, Ls, x0, Le, L, xsup, s_r, dL, dLd, e_r2}.
- `out.Track` = {x [nx], onBr [nx], sig_emb [2], rej, temp/LM71/SW/brk/acc/comb:
  {min [2][nx], max [2][nx]} (MPa), comb.gov [2][nx], comb.govTemp [2][nx],
  gap {temp [2][ng], combMin [2][ng], combMax [2][ng]} (mm),
  rbreak {x [nc], w [nc], wmax, xmax, S0 [nx], S [nx], dT_R, dT_B, wCWR}}.
- `out.Bridge` = {x, xF [nb], xsup, dTemp/dB/dA/dH/dV [2][2] (season, left/right end, mm),
  wV [2][nspan] (mm), Rh.{group} [2][nsup] (kN), F.{group}.{N,M,V} and
  D.{group}.{u,w,th} {min [2][nb], max [2][nb]} (MN, MNm, mm, mrad),
  F.comb.gov/govTemp.{N,M,V} [2][nb], D.comb.gov/govTemp.{u,w,th} [2][nb]}.
- `out.LoadPos` = {vert [{type, x, crit, season}], H [{name, fb, fa, sb, sa}],
  comb [2] {vert, H, u, temp}, Lbrk, Lacc, xloco [], xSW []}.
- `out.Table` = [{name, unit, lim, val, limv, exceed, dec}]; `val` and `exceed` as
  `[row][k]` (rows min/max or left/right, k summer/winter). `name` and `lim` keep the
  LaTeX of `TBI_fem.m` (e.g. `$\delta_\mathrm{B}$`); the GUI and the report convert it
  with `TBI.tex2html`.
- `out.Info` = {nRun, time (s), nlgeom, nInc}.
- NaN where MATLAB has NaN (e.g. rail break row `[NaN wmax]`); JSON has no NaN, so
  `null` is used only when results are saved to a file.

`tbi_plot.js` draws into a given container element: `TBI.plotModel(el, out)`,
`TBI.plotLoads(el, which)`, `TBI.plotRail(els[3], out)`, `TBI.plotBridge(els[3], out, lc,
kind)`. `tbi_report.js`: `TBI.report(out)` builds the report element for printing.

## Code style

- Each file starts with a header: purpose, author, date ("assisted by Claude"), usage.
- Sections and function names follow the MATLAB file, so the two can be read side by
  side; units in comments; comments say why, not what.
- `'use strict'`, `const`/`let`, plain functions, no frameworks; 4 spaces; lines up to
  about 120 characters.
- No `innerHTML` with input or file content (DOM built with `createElement` and
  `textContent`); no `eval`, no inline scripts or styles in the HTML (strict CSP).

## Verification

`test/make_reference.m` runs `TBI_fem.m` for the 31 cases of
`../benchmark/benchmark_cases.m` and writes `test/reference.json`; `test/test.html`
runs the same cases in the browser and compares the whole output (options in the URL:
`?workers=0`, `?cases=1,5`, `?tol=1e-4`).

State 2026-11-13 (TBI_fem.m of 2026-11-12): 31 of 31 cases agree, largest difference
5e-5 (kN), same number of analyses, same load case and table names. Run time with
the workers (24 cores): all 31 cases 8 s; the bridge over Bryngeån with moving loads
(274 analyses) 0.3 s, on one thread 2.2 s (MATLAB serial 2.6 s).

## Security

Static page, no server code, no cookies or storage. Strict Content Security Policy
(scripts, styles and workers only from the page's own origin; no inline scripts or
styles, no `eval`); no `innerHTML` (DOM built with `createElement`/`textContent`).
Opened JSON files: at most 1 MB, parsed with `JSON.parse`, only plain objects, only the
known keys are read (no prototype pollution), values checked like typed input. Excel
cells are written as inline strings (no formulas). The only external request is the
GoatCounter page counter (`count.js`, `img-src`/`connect-src` addekth.goatcounter.com).

## Disclaimer

This software is provided for research, education and preliminary assessment. It is provided "as is", without warranty of any kind, express or implied, including but not limited to accuracy, completeness, or fitness for a particular purpose.

The results have not been independently certified and do not replace the verification required by the applicable codes, regulations and infrastructure manager requirements. The user is responsible for checking that the method, the load models, the input and the assumptions suit the case at hand, and for verifying the results independently before using them in design, assessment or any other decision. Load models and dynamic factors are implemented as interpreted by the author and may differ from, or become out of date compared with, the current versions of the standards.

The author accepts no liability for any loss, damage or other consequence arising from the use of this software or its results.

Andreas Andersson, KTH, 2026.

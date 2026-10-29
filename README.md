# Longitudinal track-bridge interaction — web version

A browser port of `TBI_GUI.m` and the solver `TBI_fem.m`: longitudinal track-bridge
interaction (TBI) according to EN 1991-2:2024, 8.5.3–8.5.4. 2D FE model with rail and
deck as beams, nonlinear track resistance (Table 8.9), bearings with longitudinal
springs, two-step analysis (temperature on unloaded track, then vertical traffic and
braking/traction with loaded track resistance), rail break check (CEN/TR 17231 A.2).
No build step and no dependencies: static files for GitHub Pages.

## Running it

Open `index.html` in a browser, or serve the folder:

```
python -m http.server 8000      # then open http://localhost:8000
```

The load cases are solved in parallel in Web Workers (one per processor core, kept
between runs), in two rounds: temperature, vertical traffic sweeps, braking/traction and
the intact rail first; then the broken rail and the load combinations, which restart from
the saved temperature step. Without workers (e.g. `index.html` opened as a file) the same
cases run on the main thread. The results are identical in both modes; the progress bar
is updated about every 0.2 s. The bridge over Bryngeån takes about 0.1 s with 24 cores
(32 analyses), with the locomotive stepped every 0.65 m about 0.3 s (260 analyses).

## The interface

| Control | Behaviour |
|---|---|
| Run | all load cases, summer and winter (temperature, LM71/SW/0, braking, traction, load combination, rail break) |
| Reset | default input (the bridge over Bryngeån), clears the results |
| Open / Save | input fields as JSON, same format as `TBI_GUI.m` |
| Print | report on A4 (basis, model, input, results, diagrams); choose "Save as PDF" in the print dialog |
| Tables, Excel symbol | tables and diagram data as `.xlsx`; values outside the limits in bold red |
| Diagrams, print symbol | the three rail stress diagrams on one A4 page |

Input tabs Bridge, Track, Load and Limits. Vectors are typed with spaces, e.g. `30 40 30`.
`K_h` is filled in when the number of spans changes (fixed bearing at the right end),
`L_end` is rounded to a multiple of `s_r/2` as in the model, and the deck temperature
change follows EN 1991-1-5 6.1.3 and Figure 6.1 (AC:2009) unless "direct" is chosen.

## Files

| File | Content |
|---|---|
| `index.html` | page layout, styles, print layout |
| `gui.js` | input fields, events, run, tables, Save/Open, Excel export, report |
| `tbi_fem.js` | defaults, FE solver (`TBI.solve`), complete analysis (`TBI.analysis`), summary table |
| `plots.js` | SVG drawings: model sketch and rail stress diagrams |
| `xlsx.js` | minimal Excel writer with bold and red bold cells |

## Verification

The solver was compared with `TBI_fem.m` (MATLAB R2025b, 2026-10-28) in three cases:
the bridge over Bryngeån; three spans with a rail
expansion joint, an end screen and a nonlinear support; two tracks, ballastless,
'shifted' loaded resistance and moving loads. Same number of analyses; largest
differences 1e-9 MPa (rail stress), 1e-4 mm (displacements, rail break gap) and
1e-8 kN (bearing forces).

Andreas Andersson, KTH, 2026.

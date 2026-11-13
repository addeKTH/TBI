/* tbi_worker.js --------------------------------------------------------------
   Web Worker of the TBI analysis (the parfor of TBI_fem.m): builds the model
   once per run and solves the load cases sent by TBI.analysis (tbi_fem.js).
   Andreas Andersson, 2026-11-13 (assisted by Claude)
   -----------------------------------------------------------------------------
   Messages in:  {type: 'model', rid, inp, nlgeom, nInc}   input with defaults
                 {type: 'case', rid, id, c, S1}            one load case
   Messages out: {ready: true}                             after loading
                 {rid, model: true[, error]}               model built
                 {rid, id, r} or {rid, id, error}          result of a load case
---------------------------------------------------------------------------*/
'use strict';
importScripts('tbi_fem.js' + self.location.search);              // same version (?v=) as the page

let mdl = null, mdlRid = -1;

onmessage = function (e) {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'model') {
        try {
            mdl = TBI._buildModel(TBI.setDefaults(m.inp), m.nlgeom);
            mdl.nInc = TBI.fixInc(m.nInc);
            mdlRid = m.rid;
            postMessage({ rid: m.rid, model: true });
        } catch (err) {
            postMessage({ rid: m.rid, model: true, error: String((err && err.message) || err) });
        }
    } else if (m.type === 'case') {
        try {
            if (m.rid !== mdlRid) throw new Error('Model of another run.');
            postMessage({ rid: m.rid, id: m.id, r: TBI._solveCase(mdl, m.c, m.S1) });
        } catch (err) {
            postMessage({ rid: m.rid, id: m.id, error: String((err && err.message) || err) });
        }
    }
};

postMessage({ ready: true });

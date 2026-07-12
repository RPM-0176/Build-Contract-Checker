/**
 * Radius PG — Build Contract Checker (hardened)
 *
 * Pipeline:
 *   1. Contract extract (pass 1)      — facts, inclusions, exclusions, stage claims, red flags, with page/clause + confidence
 *   2. Contract audit  (pass 2)       — independent second reader: corrections, blanks, mis-cited clauses, internal conflicts
 *   3. Drawings index                 — catalogue every sheet + locate schedules
 *   4. Drawings cross-check           — verify contract inclusions against specific sheets (cited)
 *   5. Feasibility cross-check        — are the contract's excluded costs carried in the feasibility?
 *
 * Then buildReview() merges everything into a flat, checklist-ready review with an exceptions list.
 * The API key is server-side only.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024, files: 3 } });
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '12mb' }));

// ---------- Claude helper (with prompt caching on documents) ----------
async function callClaude(system, userContent, maxTokens = 6000) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000); // 5 min
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userContent }] })
    });
  } finally { clearTimeout(timeout); }
  if (!res.ok) { const t = await res.text(); throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 600)}`); }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function parseJson(text) {
  if (!text) return { parseError: true, raw: '' };
  let t = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const starts = ['{', '['].map(c => t.indexOf(c)).filter(i => i !== -1);
  const first = starts.length ? Math.min(...starts) : -1;
  if (first > 0) t = t.slice(first);
  // 1) straight parse (with trailing-fence trim)
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  // 2) truncation recovery: close open strings/brackets so partial-but-valid data survives
  const repaired = repairTruncatedJson(t);
  if (repaired) { try { const v = JSON.parse(repaired); v.__truncated = true; return v; } catch (e) { /* fall through */ } }
  return { parseError: true, raw: text };
}

// Walks the JSON, tracks open braces/brackets and string state, and closes them.
// If truncation happened mid-value, it drops the last incomplete key/element first.
function repairTruncatedJson(s) {
  let inStr = false, esc = false;
  const stack = [];
  let lastSafe = -1; // index just after the last completed top-of-stack element (comma/close)
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { stack.pop(); if (stack.length) lastSafe = i + 1; }
    else if (ch === ',' && stack.length) lastSafe = i + 1;
  }
  let core = s;
  if (inStr || /[:,]\s*$/.test(s.trimEnd()) || /"\w[^"]*$/.test(s)) {
    // we're mid-token — cut back to the last completed element
    if (lastSafe > 0) core = s.slice(0, lastSafe).replace(/,\s*$/, '');
    else return null;
  } else {
    core = s.replace(/,\s*$/, '');
  }
  // recompute open structures on the trimmed core
  inStr = false; esc = false; const close = [];
  for (let i = 0; i < core.length; i++) {
    const ch = core[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') close.push('}');
    else if (ch === '[') close.push(']');
    else if (ch === '}' || ch === ']') close.pop();
  }
  if (inStr) core += '"';
  while (close.length) core += close.pop();
  return core;
}

// document block, optionally cached so a re-send within ~5 min is cheap
function docBlock(file, cache) {
  const b = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') } };
  if (cache) b.cache_control = { type: 'ephemeral' };
  return b;
}

// ---------- Prompts ----------
const CITE = `Every extracted value MUST be an object: {"v": <value or null>, "page": <page number/label or null>, "clause": <clause ref or null>, "conf": "high"|"medium"|"low"}. Use conf "high" only when the value is explicit and unambiguous; "low" when inferred or uncertain. If a value is absent or a field is blank, set "v": null and say so.`;

const EXTRACT_SYSTEM = `You are a senior Australian construction-contract analyst reviewing a residential building contract — most often a Master Builders Victoria GCC6 commercial contract, frequently for an NDIS / SDA (Specialist Disability Accommodation, High Physical Support) dwelling. The PDF may bundle the general conditions, special conditions and specification/tender together.

Be exact and literal. Do not smooth over problems. Known issues in these contracts that you must actively look for:
- Blank mandatory fields (e.g. the Contractors' All-Risks insurance amount in the Agreed Details).
- A defects liability period left blank (defaults apply) that conflicts with any warranty schedule/annexure.
- Special conditions that mis-reference a clause number (e.g. citing a delays clause when they mean the defects clause).
- Special conditions overriding the general conditions (order of precedence).
- No retention / no security combined with "final payment before handover of keys".
- Low liquidated damages relative to project value.
- Commercial contract used for a dwelling (no domestic building warranties/insurance).
- Base specification saying one thing (e.g. "standard glazing") while inclusions imply another (e.g. double glazing for a 7-star rating).

${CITE}

Return ONLY valid JSON. No markdown, no commentary.`;

const EXTRACT_INSTRUCTION = `Return JSON exactly in this shape (every leaf value uses the citation object described):
{
  "parties": { "proprietor": {..}, "contractor": {..} },
  "price": { "amount": {..}, "gstTreatment": {..} },
  "dates": { "commencement": {..}, "practicalCompletion": {..} },
  "liquidatedDamages": {..},
  "insurances": { "contractorsAllRisk": {..}, "publicLiability": {..}, "workcare": {..} },
  "retention": {..},
  "defectsLiabilityPeriod": {..},
  "stageClaims": [ { "stage": string, "percent": number|null, "page": string|null, "conf": "high"|"medium"|"low" } ],
  "exclusions": [ { "item": string, "page": string|null, "conf": "high"|"medium"|"low" } ],
  "inclusions": [ { "item": string, "category": string, "page": string|null, "conf": "high"|"medium"|"low" } ],
  "redFlags": [ { "issue": string, "clause": string|null, "page": string|null, "severity": "high"|"medium"|"low", "why": string, "conf": "high"|"medium"|"low" } ]
}
"exclusions": costs/works the contract says are NOT the builder's responsibility.
"inclusions": material items the contract/spec says ARE included — appliances (with brands), SDA/accessibility features, glazing, blinds, flooring, tiling, fencing, driveway, landscaping, services, heating/cooling. List up to ~40 of the most material.`;

const AUDIT_SYSTEM = `You are a SECOND, skeptical construction-contract reviewer. A first reviewer has already produced findings. Your job is to catch what they got wrong or missed. Re-read the contract independently. Assume the first pass contains at least one error or omission and go looking for it. Focus on the known GCC6 / SDA failure points: blank mandatory fields, defects-period vs warranty-annexure conflicts, mis-referenced clause numbers, precedence of special conditions, retention/security + pay-before-keys, liquidated-damages adequacy, commercial-vs-domestic, and base-spec-vs-inclusions conflicts (e.g. glazing).

${CITE}

Return ONLY valid JSON. No markdown.`;

const FEAS_SYSTEM = `You review whether a development feasibility carries the costs a building contract has EXCLUDED. You get the excluded-items list and the feasibility PDF. For each excluded item decide if the feasibility appears to allow for it. Match on meaning, not wording (e.g. "site costs"/"civil works" may cover demolition/stormwater; "authority contributions" may cover council items). Be honest: "no" means a possible gap the proprietor is exposed to; "unclear" means you cannot tell.

${CITE.replace('extracted value', 'checked value')}

Return ONLY valid JSON. No markdown.`;

const DRAW_INDEX_SYSTEM = `You are cataloguing an architectural/working drawing set (PDF) so specific items can be located later. Go page by page. Identify each sheet's number, title and what it contains (site plan, floor plan, elevations, sections, window schedule, door schedule, finishes schedule, electrical layout, wet-area details, etc.). Note the page where any schedule appears. Return ONLY valid JSON. No markdown.`;

const DRAW_CHECK_SYSTEM = `You verify a building contract's stated inclusions against the working drawings. You get (a) an index of the drawing set with page numbers, (b) the list of contract inclusions, and (c) the drawings PDF. For each inclusion, decide whether the drawings support it, conflict with it, or don't show it — and CITE the sheet/page. Drawings are visual and use schedules, callouts and symbols; where you are not sure, say "not_found" and low confidence rather than guessing. "conflict" only when the drawings clearly show something different. Also list anything material on the drawings that is not in the contract inclusions. Return ONLY valid JSON. No markdown.`;

const BOM_SYSTEM = `You are an Australian building estimator preparing a trade-by-trade materials & items schedule for a residential (often NDIS / SDA) dwelling, so trades can quote from it. You are given the working drawings and (optionally) the specification/contract.

STRICT RULES — a wrong quantity sent to a trade is worse than no quantity:
- List only items actually named, scheduled or shown in the documents. Never invent items.
- Give a numeric quantity ONLY when a document explicitly states it (a schedule count, or a spec quantity like "4 drawers", "2 ensuites"). 
- If a quantity would require measuring or taking off from the drawings (linear metres, m2, areas, or counts you would have to derive from geometry), set quantity to null, put the likely unit, and set needsTakeoff true. NEVER estimate dimensions, areas or counts.
- Capture the specification/brand where stated (e.g. "Westinghouse 600mm induction cooktop", "Colorbond roof", "MDF 67x18 skirting").
- Give the location/room where the document indicates it.
- Cite the source for every line: sheet number/page for drawings, or the spec item.
- Assign each item to the most appropriate trade.
- Confidence: "high" if explicitly scheduled/specified; "low" if inferred.

Return ONLY valid JSON. No markdown.`;

const BOM_INSTRUCTION = `Group items under these trades where applicable (omit empty trades; use "Other" only if nothing fits):
Site & Concrete; Framing & Carpentry; Roofing & Cladding; Windows & Doors; Electrical; Plumbing & Drainage; Heating & Cooling (HVAC); Kitchen & Joinery; Wet Areas & Tiling; Painting; Insulation; External, Fencing & Landscaping; SDA / Accessibility.

Return JSON:
{ "trades": [ { "trade": string, "items": [ { "description": string, "spec": string|null, "location": string|null, "quantity": number|null, "unit": string|null, "needsTakeoff": boolean, "source": string|null, "confidence": "high"|"medium"|"low", "note": string|null } ] } ] }`;

// ---------- Merge into checklist-ready review ----------
function cite(o) {
  if (o == null) return { v: null, page: null, clause: null, conf: 'low' };
  if (typeof o === 'string' || typeof o === 'number') return { v: o, page: null, clause: null, conf: 'medium' };
  // direct citation object
  if ('v' in o || 'value' in o) {
    const val = o.v !== undefined ? o.v : o.value;
    return { v: (val === undefined ? null : val), page: o.page || null, clause: o.clause || null, conf: o.conf || o.confidence || 'medium' };
  }
  // nested: the model sometimes returns e.g. { name:{v..}, acn:{v..} } — prefer a meaningful child
  const preferKeys = ['name', 'summary', 'amount', 'value', 'period', 'periodWeeks', 'securityForPerformance', 'cashRetention'];
  for (const k of preferKeys) {
    if (o[k] && typeof o[k] === 'object' && ('v' in o[k] || 'value' in o[k])) {
      const c = cite(o[k]);
      if (c.v != null && c.v !== '') return c;
    }
  }
  // otherwise first child that carries a non-null value
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === 'object' && ('v' in o[k] || 'value' in o[k])) {
      const c = cite(o[k]);
      if (c.v != null && c.v !== '') return c;
    }
  }
  // nothing usable
  return { v: null, page: o.page || null, clause: o.clause || null, conf: o.conf || 'low' };
}
let RID = 0; const rid = () => 'r' + (++RID);
function mk(group, label, c, finding, forceStatus) {
  const blank = c.v == null || c.v === '';
  let status = 'ok', exception = false;
  if (forceStatus) { status = forceStatus; exception = forceStatus !== 'ok'; }
  else if (blank) { status = 'query'; exception = true; }
  else if (c.conf === 'low') { status = 'query'; exception = true; }
  return {
    id: rid(), group, label,
    value: blank ? null : c.v, page: c.page || null, clause: c.clause || null,
    confidence: c.conf || 'medium', finding: finding || (blank ? 'Not stated / blank in contract.' : ''),
    status, note: '', exception
  };
}

function buildReview(a) {
  const items = [];
  const ex = a.extract || {};
  const audit = a.audit || {};
  const P = ex.parties || {};
  const PR = ex.price || {};
  const D = ex.dates || {};
  const INS = ex.insurances || {};

  // Commercial terms
  items.push(mk('Commercial terms', 'Proprietor named', cite(P.proprietor)));
  items.push(mk('Commercial terms', 'Contractor named', cite(P.contractor)));
  items.push(mk('Commercial terms', 'Contract price', cite(PR.amount)));
  items.push(mk('Commercial terms', 'GST treatment', cite(PR.gstTreatment)));
  items.push(mk('Commercial terms', 'Date for commencement', cite(D.commencement)));
  items.push(mk('Commercial terms', 'Date for practical completion', cite(D.practicalCompletion)));
  items.push(mk('Commercial terms', 'Liquidated damages', cite(ex.liquidatedDamages)));

  // Insurances
  items.push(mk('Insurances', 'Contractors\u2019 all-risks amount', cite(INS.contractorsAllRisk)));
  items.push(mk('Insurances', 'Public liability', cite(INS.publicLiability)));
  items.push(mk('Insurances', 'WorkCare', cite(INS.workcare)));

  // Defects / retention
  items.push(mk('Defects & retention', 'Defects liability period', cite(ex.defectsLiabilityPeriod)));
  items.push(mk('Defects & retention', 'Retention / security', cite(ex.retention)));

  // Stage claims
  const stages = Array.isArray(ex.stageClaims) ? ex.stageClaims : [];
  if (stages.length) {
    const total = stages.reduce((s, x) => s + (parseFloat(x.percent) || 0), 0);
    const round = Math.round(total * 100) / 100;
    const ok = round === 100;
    const it = mk('Stage claims', `Stage schedule — ${stages.length} stages, total ${round}%`, { v: `${round}%`, page: stages[0] && stages[0].page, conf: ok ? 'high' : 'medium' }, ok ? '' : 'Stage percentages do not total 100% — check.', ok ? null : 'query');
    it.stages = stages;
    items.push(it);
  }

  // Inclusions vs drawings
  const dc = a.drawingsCheck;
  const incl = Array.isArray(ex.inclusions) ? ex.inclusions : [];
  if (dc && Array.isArray(dc.checks)) {
    dc.checks.forEach(x => {
      const st = x.status === 'supported' ? 'ok' : 'query';
      const label = x.item || '';
      const found = x.status === 'supported' ? `In drawings (${x.sheet || x.page || 'located'})` : x.status === 'conflict' ? 'CONFLICT with drawings' : 'Not found in drawings';
      const c = { v: null, page: x.page || null, clause: null, conf: x.confidence || 'medium' };
      const item = mk('Inclusions vs drawings', label, c, found, st);
      item.subStatus = x.status; item.note = ''; item.drawingNote = x.note || '';
      items.push(item);
    });
    (dc.notableOnDrawingsNotInContract || []).forEach(n => {
      items.push({ id: rid(), group: 'Inclusions vs drawings', label: 'On drawings, not in contract: ' + (n.item || n), value: null, page: n.page || null, clause: null, confidence: 'medium', finding: 'Appears on the drawings but not listed as a contract inclusion.', status: 'query', note: '', exception: true });
    });
  } else {
    incl.forEach(i => {
      const c = cite(i); c.v = i.item || c.v;
      const item = mk('Inclusions (no drawings uploaded)', i.item || '', { v: i.item, page: i.page, conf: i.conf }, 'Confirm against the working drawings (none uploaded).', 'query');
      items.push(item);
    });
  }

  // Exclusions vs feasibility
  const fc = a.feasibilityCheck;
  const excl = Array.isArray(ex.exclusions) ? ex.exclusions : [];
  if (fc && Array.isArray(fc.checks)) {
    fc.checks.forEach(x => {
      const st = x.inFeasibility === 'yes' ? 'ok' : 'query';
      const found = x.inFeasibility === 'yes' ? 'Carried in feasibility' : x.inFeasibility === 'no' ? 'GAP — not in feasibility' : 'Unclear in feasibility';
      const c = { v: null, page: (x.page || null), clause: null, conf: x.confidence || 'medium' };
      const item = mk('Exclusions vs feasibility', x.excludedItem || '', c, found, st);
      item.subStatus = x.inFeasibility; item.drawingNote = x.note || '';
      items.push(item);
    });
  } else {
    excl.forEach(e => {
      items.push(mk('Exclusions (no feasibility uploaded)', e.item || '', { v: e.item, page: e.page, conf: e.conf }, 'Confirm this excluded cost is carried in the feasibility (none uploaded).', 'query'));
    });
  }

  // Red flags (extract + audit)
  const flags = [].concat(Array.isArray(ex.redFlags) ? ex.redFlags : [], Array.isArray(audit.additionalRedFlags) ? audit.additionalRedFlags : []);
  flags.forEach(r => {
    items.push({ id: rid(), group: 'Red flags', label: r.issue || '', value: null, page: r.page || null, clause: r.clause || null, confidence: r.conf || r.confidence || 'medium', finding: r.why || '', severity: r.severity || 'medium', status: 'query', note: '', exception: true });
  });

  // Audit corrections / blanks / cross-ref / conflicts
  (audit.corrections || []).forEach(c => {
    items.push({ id: rid(), group: 'Second-pass discrepancies', label: `Check "${c.field}" — passes disagree`, value: `Pass 1: ${c.pass1Value} · Audit: ${c.auditValue}`, page: c.page || null, clause: null, confidence: c.conf || c.confidence || 'medium', finding: c.why || '', status: 'query', note: '', exception: true });
  });
  (audit.blanksAndMandatoryGaps || []).forEach(b => {
    items.push({ id: rid(), group: 'Second-pass discrepancies', label: `Blank/mandatory gap: ${b.field}`, value: null, page: b.page || null, clause: null, confidence: 'high', finding: b.note || '', status: 'query', note: '', exception: true });
  });
  (audit.crossReferenceErrors || []).forEach(x => {
    items.push({ id: rid(), group: 'Second-pass discrepancies', label: `Clause cross-reference error`, value: `${x.clauseCiting} cites ${x.citedClause}`, page: x.page || null, clause: x.clauseCiting || null, confidence: 'high', finding: x.note || '', status: 'query', note: '', exception: true });
  });
  (audit.internalConflicts || []).forEach(x => {
    items.push({ id: rid(), group: 'Second-pass discrepancies', label: `Internal conflict: ${x.between}`, value: null, page: x.page || null, clause: null, confidence: 'medium', finding: x.note || '', status: 'query', note: '', exception: true });
  });

  // Blind spots
  const blindSpots = items.filter(i => i.confidence === 'low' || i.subStatus === 'not_found' || i.subStatus === 'unclear').map(i => ({ label: i.label, page: i.page }));

  return { items, blindSpots, agreementNote: audit.agreementNote || null };
}

// ---------- Per-step endpoints (each is ONE Claude call, so nothing times out) ----------
const uploadOne = f => upload.fields([{ name: f, maxCount: 1 }]);

// helper: always respond with clean JSON, even on failure
function ok(res, data, extra) { res.json(Object.assign({ data }, extra || {})); }
function fail(res, code, msg) { res.status(code).json({ error: msg }); }

// 1) Contract extract
app.post('/api/extract', uploadOne('contract'), async (req, res) => {
  try {
    const contract = req.files && req.files.contract && req.files.contract[0];
    if (!contract) return fail(res, 400, 'A contract PDF is required.');
    const data = parseJson(await callClaude(EXTRACT_SYSTEM, [docBlock(contract, true), { type: 'text', text: EXTRACT_INSTRUCTION }], 16000));
    ok(res, data, { truncated: !!data.__truncated });
  } catch (err) { console.error(err); fail(res, 500, err.message || 'Extraction failed.'); }
});

// 2) Contract audit (independent second read)
app.post('/api/audit', uploadOne('contract'), async (req, res) => {
  try {
    const contract = req.files && req.files.contract && req.files.contract[0];
    if (!contract) return fail(res, 400, 'A contract PDF is required.');
    let extract = {};
    try { extract = JSON.parse(req.body.extract || '{}'); } catch (e) {}
    const auditInstruction = `The first reviewer produced this (JSON):\n${JSON.stringify(extract).slice(0, 12000)}\n\nRe-read the contract yourself and return JSON:\n{\n  "corrections": [ { "field": string, "pass1Value": string, "auditValue": string, "page": string|null, "why": string, "conf": "high"|"medium"|"low" } ],\n  "additionalRedFlags": [ { "issue": string, "clause": string|null, "page": string|null, "severity": "high"|"medium"|"low", "why": string, "conf": "high"|"medium"|"low" } ],\n  "blanksAndMandatoryGaps": [ { "field": string, "page": string|null, "note": string } ],\n  "crossReferenceErrors": [ { "clauseCiting": string, "citedClause": string, "page": string|null, "note": string } ],\n  "internalConflicts": [ { "between": string, "page": string|null, "note": string } ],\n  "agreementNote": string\n}`;
    const data = parseJson(await callClaude(AUDIT_SYSTEM, [docBlock(contract, true), { type: 'text', text: auditInstruction }], 12000));
    ok(res, data, { truncated: !!data.__truncated });
  } catch (err) { console.error(err); fail(res, 500, err.message || 'Audit failed.'); }
});

// 3) Drawings index
app.post('/api/drawings-index', uploadOne('drawings'), async (req, res) => {
  try {
    const drawings = req.files && req.files.drawings && req.files.drawings[0];
    if (!drawings) return fail(res, 400, 'A drawings PDF is required.');
    const data = parseJson(await callClaude(DRAW_INDEX_SYSTEM, [docBlock(drawings, true), { type: 'text', text: 'Return JSON: { "sheets": [ { "page": string, "sheetNo": string|null, "title": string, "contains": [string] } ], "schedules": { "window": string|null, "door": string|null, "finishes": string|null, "electrical": string|null } } (page = page number/label where each schedule is found).' }], 8000));
    ok(res, data, { truncated: !!data.__truncated });
  } catch (err) { console.error(err); fail(res, 500, err.message || 'Drawings indexing failed.'); }
});

// 4) Drawings cross-check
app.post('/api/drawings-check', uploadOne('drawings'), async (req, res) => {
  try {
    const drawings = req.files && req.files.drawings && req.files.drawings[0];
    if (!drawings) return fail(res, 400, 'A drawings PDF is required.');
    let index = {}, inclusions = [];
    try { index = JSON.parse(req.body.index || '{}'); } catch (e) {}
    try { inclusions = JSON.parse(req.body.inclusions || '[]'); } catch (e) {}
    if (!inclusions.length) return ok(res, { skipped: true, reason: 'No inclusions to check.' });
    const dInstr = `INDEX OF THE DRAWING SET:\n${JSON.stringify(index).slice(0, 8000)}\n\nCONTRACT INCLUSIONS TO VERIFY (cite the sheet/page for each):\n${inclusions.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nReturn JSON: { "checks": [ { "item": string, "status": "supported"|"conflict"|"not_found", "page": string|null, "sheet": string|null, "confidence": "high"|"medium"|"low", "note": string } ], "notableOnDrawingsNotInContract": [ { "item": string, "page": string|null } ] }`;
    const data = parseJson(await callClaude(DRAW_CHECK_SYSTEM, [docBlock(drawings, true), { type: 'text', text: dInstr }], 12000));
    ok(res, data, { truncated: !!data.__truncated });
  } catch (err) { console.error(err); fail(res, 500, err.message || 'Drawings cross-check failed.'); }
});

// 5) Feasibility cross-check
app.post('/api/feasibility', uploadOne('feasibility'), async (req, res) => {
  try {
    const feasibility = req.files && req.files.feasibility && req.files.feasibility[0];
    if (!feasibility) return fail(res, 400, 'A feasibility PDF is required.');
    let exclusions = [];
    try { exclusions = JSON.parse(req.body.exclusions || '[]'); } catch (e) {}
    if (!exclusions.length) return ok(res, { skipped: true, reason: 'No exclusions to check.' });
    const fInstr = `CONTRACT-EXCLUDED ITEMS:\n${exclusions.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\nReturn JSON: { "checks": [ { "excludedItem": string, "inFeasibility": "yes"|"no"|"unclear", "page": string|null, "confidence": "high"|"medium"|"low", "note": string } ], "overallNote": string }`;
    const data = parseJson(await callClaude(FEAS_SYSTEM, [docBlock(feasibility, false), { type: 'text', text: fInstr }], 10000));
    ok(res, data, { truncated: !!data.__truncated });
  } catch (err) { console.error(err); fail(res, 500, err.message || 'Feasibility cross-check failed.'); }
});

// 6) Assemble — no model call, just merges the pieces into the review
app.post('/api/assemble', (req, res) => {
  try {
    const analysis = (req.body && req.body.analysis) || {};
    const warnings = (req.body && req.body.warnings) || [];
    const docs = (req.body && req.body.docs) || {};
    const p1 = analysis.extract || {};
    const review = buildReview(analysis);
    const meta = {
      proprietor: cite((p1.parties || {}).proprietor).v || '',
      contractor: cite((p1.parties || {}).contractor).v || '',
      price: cite((p1.price || {}).amount).v || '',
      commencement: cite((p1.dates || {}).commencement).v || '',
      completion: cite((p1.dates || {}).practicalCompletion).v || '',
      ld: cite(p1.liquidatedDamages).v || ''
    };
    const total = review.items.length;
    const exceptions = review.items.filter(i => i.exception).length;
    res.json({
      model: MODEL, generatedAt: new Date().toISOString(), warnings,
      docs, meta, review, analysis,
      counts: { total, exceptions, autoConfirmed: total - exceptions, blindSpots: review.blindSpots.length }
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message || 'Assembly failed.' }); }
});

// ---------- Bill of materials ----------
app.post('/api/bom', upload.fields([{ name: 'contract', maxCount: 1 }, { name: 'drawings', maxCount: 1 }]), async (req, res) => {
  try {
    const f = req.files || {};
    const drawings = f.drawings && f.drawings[0];
    const contract = f.contract && f.contract[0];
    if (!drawings) return res.status(400).json({ error: 'Working drawings are required to build a bill of materials.' });
    const content = [docBlock(drawings, true)];
    if (contract) content.push(docBlock(contract, true));
    content.push({ type: 'text', text: BOM_INSTRUCTION });
    const bom = parseJson(await callClaude(BOM_SYSTEM, content, 16000));
    const warnings = [];
    if (bom.parseError) warnings.push('Bill of materials returned non-JSON.');
    res.json({ model: MODEL, generatedAt: new Date().toISOString(), warnings, bom });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Bill of materials failed.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, model: MODEL, keySet: !!API_KEY }));

// Ensure any error (incl. bad JSON body / oversized upload) returns JSON, never an HTML page
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Request failed.' });
});

app.listen(PORT, () => console.log(`Contract checker on :${PORT} (model ${MODEL}, key ${API_KEY ? 'set' : 'MISSING'})`));

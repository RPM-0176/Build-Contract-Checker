const files = { contract: null, drawings: null, feasibility: null };
const run = document.getElementById('run');
const statusBox = document.getElementById('status');
const ws = document.getElementById('workspace');
let DATA = null; // current report

// ---------- Uploads ----------
document.querySelectorAll('[data-input]').forEach(inp => {
  inp.addEventListener('change', () => {
    const field = inp.dataset.input, file = inp.files[0] || null;
    files[field] = file;
    const nameEl = document.querySelector(`[data-name="${field}"]`);
    const drop = document.querySelector(`.drop[data-field="${field}"]`);
    if (file) { nameEl.textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`; nameEl.classList.add('set'); drop.classList.add('filled'); }
    else { nameEl.textContent = ''; nameEl.classList.remove('set'); drop.classList.remove('filled'); }
    run.disabled = !files.contract;
  });
});

run.addEventListener('click', runReview);

async function runReview() {
  if (!files.contract) return;
  run.disabled = true; ws.hidden = true; ws.innerHTML = '';

  // Build the step plan based on what was uploaded
  const plan = [{ key: 'extract', label: 'Reading the contract (pass 1 of 2)' },
                { key: 'audit', label: 'Second-pass audit — catching misses' }];
  if (files.drawings) plan.push({ key: 'dindex', label: 'Indexing the drawing set' }, { key: 'dcheck', label: 'Checking inclusions against drawings' });
  if (files.feasibility) plan.push({ key: 'feas', label: 'Checking excluded costs vs feasibility' });
  plan.push({ key: 'assemble', label: 'Assembling the review' });
  const stepState = {}; plan.forEach(s => stepState[s.key] = 'pending');
  const setStep = (k, st) => { stepState[k] = st; renderSteps(plan, stepState); };
  renderSteps(plan, stepState);

  const analysis = {}; const warnings = [];

  // 1) Extract (critical)
  setStep('extract', 'running');
  try {
    const r = await postForm('/api/extract', { contract: files.contract });
    analysis.extract = r.data;
    if (r.data.parseError) { setStep('extract', 'failed'); return showStatus(true, 'The contract could not be read on this run. Please try Run review again.'); }
    if (r.truncated) warnings.push('The contract was long and the read was slightly cut off; partial data recovered. Consider re-running.');
    setStep('extract', 'done');
  } catch (e) { setStep('extract', 'failed'); return showStatus(true, 'Contract read failed: ' + e.message + ' — try again.'); }

  // 2) Audit (non-critical)
  setStep('audit', 'running');
  try {
    const r = await postForm('/api/audit', { contract: files.contract, extract: JSON.stringify(analysis.extract) });
    if (r.data.parseError) { analysis.audit = {}; warnings.push('The second-pass audit could not be read this run; the main analysis still ran (it already catches blanks and conflicts).'); setStep('audit', 'warn'); }
    else { analysis.audit = r.data; setStep('audit', 'done'); }
  } catch (e) { analysis.audit = {}; warnings.push('Second-pass audit step failed (' + e.message + '); the main analysis still ran.'); setStep('audit', 'warn'); }

  // 3) Drawings
  if (files.drawings) {
    setStep('dindex', 'running');
    let index = null;
    try {
      const r = await postForm('/api/drawings-index', { drawings: files.drawings });
      index = r.data; analysis.drawingsIndex = r.data; setStep('dindex', 'done');
    } catch (e) { warnings.push('Drawing indexing failed (' + e.message + ').'); setStep('dindex', 'failed'); }
    setStep('dcheck', 'running');
    try {
      const inclusions = (analysis.extract.inclusions || []).map(x => (x && x.item) ? x.item : x).filter(Boolean);
      const r = await postForm('/api/drawings-check', { drawings: files.drawings, index: JSON.stringify(index || {}), inclusions: JSON.stringify(inclusions) });
      analysis.drawingsCheck = r.data; setStep('dcheck', r.data && r.data.parseError ? 'warn' : 'done');
      if (r.data && r.data.parseError) warnings.push('Drawings cross-check could not be read this run.');
    } catch (e) { warnings.push('Drawings cross-check failed (' + e.message + ').'); setStep('dcheck', 'failed'); }
  }

  // 4) Feasibility
  if (files.feasibility) {
    setStep('feas', 'running');
    try {
      const exclusions = (analysis.extract.exclusions || []).map(x => (x && x.item) ? x.item : x).filter(Boolean);
      const r = await postForm('/api/feasibility', { feasibility: files.feasibility, exclusions: JSON.stringify(exclusions) });
      analysis.feasibilityCheck = r.data; setStep('feas', r.data && r.data.parseError ? 'warn' : 'done');
      if (r.data && r.data.parseError) warnings.push('Feasibility cross-check could not be read this run.');
    } catch (e) { warnings.push('Feasibility cross-check failed (' + e.message + ').'); setStep('feas', 'failed'); }
  }

  // 5) Assemble
  setStep('assemble', 'running');
  try {
    const docs = { contract: files.contract.name, drawings: files.drawings ? files.drawings.name : null, feasibility: files.feasibility ? files.feasibility.name : null };
    const rep = await postJson('/api/assemble', { analysis, warnings, docs });
    setStep('assemble', 'done');
    statusBox.hidden = true; DATA = rep; renderWorkspace(rep);
  } catch (e) { setStep('assemble', 'failed'); showStatus(true, 'Could not assemble the report: ' + e.message); }
  finally { run.disabled = !files.contract; }
}

function renderSteps(plan, state) {
  statusBox.hidden = false; statusBox.className = 'status-box';
  const running = plan.some(s => state[s.key] === 'running');
  const rows = plan.map(s => {
    const st = state[s.key];
    const icon = st === 'done' ? '✓' : st === 'failed' ? '✕' : st === 'warn' ? '!' : st === 'running' ? '<span class="mini-spin"></span>' : '·';
    const cls = st === 'done' ? 'sd-done' : st === 'failed' ? 'sd-fail' : st === 'warn' ? 'sd-warn' : st === 'running' ? 'sd-run' : 'sd-pend';
    return `<div class="step-row ${cls}"><span class="step-ic">${icon}</span>${esc(s.label)}</div>`;
  }).join('');
  statusBox.innerHTML = `<div style="width:100%"><div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">${running ? '<div class="spinner"></div>' : ''}<b>Running review…</b></div><div class="step-list">${rows}</div></div>`;
}

async function postForm(url, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(url, { method: 'POST', body: fd });
  let data; try { data = await res.json(); } catch (e) { throw new Error('server returned an unreadable response'); }
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}
async function postJson(url, obj) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  let data; try { data = await res.json(); } catch (e) { throw new Error('server returned an unreadable response'); }
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

document.getElementById('open').addEventListener('click', () => document.getElementById('file-in').click());
document.getElementById('file-in').addEventListener('change', e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { try { DATA = JSON.parse(r.result); statusBox.hidden = true; renderWorkspace(DATA); } catch (err) { showStatus(true, 'That file could not be read as a saved review.'); } };
  r.readAsText(f); e.target.value = '';
});

function showStatus(isErr, msg, steps) {
  statusBox.hidden = false;
  statusBox.className = 'status-box' + (isErr ? ' err' : '');
  if (isErr) { statusBox.innerHTML = esc(msg); return; }
  statusBox.innerHTML = `<div class="spinner"></div><div><div>${esc(msg)}</div>${steps ? `<div class="status-steps">${steps.map(esc).join(' → ')}</div>` : ''}</div>`;
}

// ---------- Workspace ----------
function renderWorkspace(d) {
  const m = d.meta || {};
  const c = d.counts || {};
  const parts = [];

  parts.push(`<div class="ws-meta">
    ${metaField('Proprietor', 'proprietor', m.proprietor)}
    ${metaField('Contractor', 'contractor', m.contractor)}
    ${metaField('Contract price', 'price', m.price)}
    ${metaField('Commencement', 'commencement', m.commencement)}
    ${metaField('Practical completion', 'completion', m.completion)}
    ${metaField('Liquidated damages', 'ld', m.ld)}
    ${metaField('Reviewed by', 'reviewer', d._reviewer || '')}
    ${metaField('Date reviewed', 'date', d._date || '')}
    ${metaField('Contract file', 'contractfile', (d.docs||{}).contract || '')}
  </div>`);

  parts.push(`<div class="summary">
    <div class="stat"><div class="n">${c.total||0}</div><div class="l">Items checked</div></div>
    <div class="stat exc"><div class="n">${c.exceptions||0}</div><div class="l">Need review</div></div>
    <div class="stat ok"><div class="n">${c.autoConfirmed||0}</div><div class="l">Auto-confirmed</div></div>
    <div class="stat blind"><div class="n">${c.blindSpots||0}</div><div class="l">Blind spots</div></div>
  </div>`);

  parts.push(`<div class="actions">
    <button id="btn-print" class="primary">Print / save PDF</button>
    <button id="btn-bom">Bill of materials</button>
    <button id="btn-save">Save review to file</button>
    <button id="btn-json">Download raw data</button>
  </div>`);
  parts.push(`<div id="bom-panel" class="bom-panel" hidden></div>`);

  if (d.warnings && d.warnings.length) parts.push(`<div class="note-strip"><b>Processing note:</b> ${d.warnings.map(esc).join(' ')}</div>`);
  if (d.review && d.review.agreementNote) parts.push(`<div class="note-strip"><b>Second-pass summary:</b> ${esc(d.review.agreementNote)}</div>`);

  const items = (d.review && d.review.items) || [];
  const exceptions = items.filter(i => i.exception);
  const confirmed = items.filter(i => !i.exception);

  // Exceptions first
  parts.push(`<div class="rsec exceptions"><h2>Exceptions to review <span class="count">${exceptions.length} item${exceptions.length===1?'':'s'}</span></h2><p class="sub">Only these need a human. Each cites a page or clause — open the document there, confirm, and mark it. Everything else is auto-confirmed below.</p>`);
  parts.push(exceptions.length ? exceptions.map(cardHtml).join('') : `<div class="note-strip">No exceptions flagged. Still worth a skim of the auto-confirmed items below.</div>`);
  parts.push(`</div>`);

  // Blind spots
  const bs = (d.review && d.review.blindSpots) || [];
  if (bs.length) {
    parts.push(`<div class="rsec"><h2>Couldn't verify <span class="count">${bs.length}</span></h2><p class="sub">Low-confidence or not-located items — the tool is telling you where it's unsure. Treat these as manual checks.</p><div class="blind-list">${bs.map(b => `• ${esc(b.label)}${b.page ? ` <span class="tag cite">p.${esc(b.page)}</span>` : ''}`).join('<br>')}</div></div>`);
  }

  // Auto-confirmed, grouped & collapsed
  parts.push(`<div class="rsec"><h2>Auto-confirmed detail <span class="count">${confirmed.length}</span></h2><p class="sub">High-confidence, cited. Glance if you like; open to override any.</p>`);
  const groups = {};
  confirmed.forEach(i => { (groups[i.group] = groups[i.group] || []).push(i); });
  Object.keys(groups).forEach(g => {
    parts.push(`<div class="grp collapsed" data-grp><p class="grp-h" data-toggle><span class="chev">▾</span> ${esc(g)} · ${groups[g].length}</p><div class="grp-body">${groups[g].map(cardHtml).join('')}</div></div>`);
  });
  parts.push(`</div>`);

  parts.push(`<div class="rsec"><p class="sub">Model: ${esc(d.model||'')} · Generated ${esc((d.generatedAt||'').replace('T',' ').slice(0,16))}. AI-assisted draft — confirm exceptions before relying on it or sending to a client.</p></div>`);

  ws.innerHTML = parts.join('');
  ws.hidden = false;
  wire(d);
  ws.scrollIntoView({ behavior: 'smooth' });
}

function metaField(label, key, val) {
  return `<div class="f"><label>${esc(label)}</label><input data-meta="${key}" value="${escAttr(val||'')}"></div>`;
}

function cardHtml(i) {
  const cls = 'card' + (i.exception ? ' exc' : '');
  const valMiss = i.value == null || i.value === '';
  const valHtml = i.value != null && i.value !== '' ? `<div class="val"><b>${esc(i.value)}</b></div>` : (i.finding ? '' : `<div class="val miss">Not stated / blank</div>`);
  const tags = [];
  if (i.clause) tags.push(`<span class="tag cite">${esc(i.clause)}</span>`);
  if (i.page) tags.push(`<span class="tag cite">p.${esc(i.page)}</span>`);
  if (i.severity) tags.push(`<span class="tag">${esc(i.severity)} severity</span>`);
  const conf = i.confidence ? `<span class="conf ${esc(i.confidence)}">${esc(i.confidence)} conf</span>` : '';
  const findingText = [i.finding, i.drawingNote].filter(Boolean).join(' — ');
  return `<div class="${cls}" data-id="${i.id}">
    <div>
      <div class="label">${esc(i.label)}</div>
      <span class="print-status p-${i.status}" id="ps-${i.id}">${i.status==='ok'?'OK':i.status==='query'?'REVIEW':i.status==='na'?'N/A':'—'}</span>
      ${valHtml}
      ${findingText ? `<div class="finding">${esc(findingText)}</div>` : ''}
      <div class="tags">${conf}${tags.join('')}</div>
    </div>
    <div class="rightcol">
      <div class="status" data-id="${i.id}">
        <button data-v="ok">OK</button><button data-v="query">Review</button><button data-v="na">N/A</button>
      </div>
    </div>
    <div class="note-wrap"><textarea data-note="${i.id}" placeholder="Reviewer note — confirmed against p.X, discrepancy, action…">${esc(i.note||'')}</textarea></div>
  </div>`;
}

function itemById(id) { return ((DATA.review && DATA.review.items) || []).find(x => x.id === id); }
function paint(id) {
  const it = itemById(id); if (!it) return;
  const g = ws.querySelector(`.status[data-id="${id}"]`); if (!g) return;
  g.querySelectorAll('button').forEach(b => b.classList.toggle('on-' + b.dataset.v, b.dataset.v === it.status));
  const ps = document.getElementById('ps-' + id);
  if (ps) { ps.className = 'print-status p-' + it.status; ps.textContent = it.status === 'ok' ? 'OK' : it.status === 'query' ? 'REVIEW' : it.status === 'na' ? 'N/A' : '—'; }
}

function wire(d) {
  ws.querySelectorAll('.status button').forEach(b => paint(b.closest('.status').dataset.id));
  ws.addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]');
    if (t) { t.closest('.grp').classList.toggle('collapsed'); return; }
    const btn = e.target.closest('.status button');
    if (btn) { const id = btn.closest('.status').dataset.id; const it = itemById(id); it.status = (it.status === btn.dataset.v) ? '' : btn.dataset.v; paint(id); }
  });
  ws.addEventListener('input', e => {
    const nt = e.target.closest('[data-note]'); if (nt) { const it = itemById(nt.dataset.note); if (it) it.note = nt.value; return; }
    const mt = e.target.closest('[data-meta]'); if (mt) { DATA.meta = DATA.meta || {}; if (mt.dataset.meta === 'reviewer') DATA._reviewer = mt.value; else if (mt.dataset.meta === 'date') DATA._date = mt.value; else DATA.meta[mt.dataset.meta] = mt.value; }
  });
  const bomBtn = document.getElementById('btn-bom');
  if (bomBtn) bomBtn.onclick = runBom;
  document.getElementById('btn-print').onclick = () => window.print();
  document.getElementById('btn-json').onclick = () => download(JSON.stringify(d.analysis || d, null, 2), 'contract-raw.json');
  document.getElementById('btn-save').onclick = () => {
    const name = ((DATA.meta && (DATA.meta.contractfile || DATA.meta.proprietor)) || 'contract-review').toString().replace(/[^\w\-]+/g, '-').slice(0, 40) + '.json';
    download(JSON.stringify(DATA, null, 2), name);
  };
}

function download(text, name) {
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// ---------- Bill of materials ----------
let BOM = null;
async function runBom() {
  const panel = document.getElementById('bom-panel');
  if (!files.drawings) {
    panel.hidden = false;
    panel.innerHTML = `<div class="note-strip">Working drawings are needed for a bill of materials. Upload the drawings and run the review, then generate the BOM.</div>`;
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `<div class="bom-loading"><div class="spinner"></div><span>Reading the drawings and specification, building the trade schedules… this takes a minute.</span></div>`;
  const fd = new FormData();
  fd.append('drawings', files.drawings);
  if (files.contract) fd.append('contract', files.contract);
  try {
    const res = await fetch('/api/bom', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Bill of materials failed.');
    BOM = data;
    renderBom(data);
  } catch (err) {
    panel.innerHTML = `<div class="note-strip" style="border-color:var(--bad);background:var(--bad-bg);color:var(--bad)">${esc(err.message)}</div>`;
  }
}

function renderBom(data) {
  const panel = document.getElementById('bom-panel');
  const trades = (data.bom && data.bom.trades) || [];
  if (!trades.length) {
    panel.innerHTML = `<div class="note-strip">No items could be extracted for a bill of materials. Check the drawings PDF is legible.</div>`;
    return;
  }
  const proj = (DATA.meta && DATA.meta.proprietor) || (DATA.docs && DATA.docs.contract) || 'project';
  const totalItems = trades.reduce((s, t) => s + (t.items ? t.items.length : 0), 0);
  const takeoff = trades.reduce((s, t) => s + (t.items || []).filter(i => i.needsTakeoff).length, 0);
  let html = `<div class="bom-head">
    <h2>Bill of materials <span class="count">${trades.length} trades · ${totalItems} items</span></h2>
    <p class="sub">One Excel file per trade — attach the right one to each trade's quote request. ${takeoff} item${takeoff === 1 ? '' : 's'} need on-site take-off (marked in the sheets). <b>Draft for quoting — verify against the drawings.</b></p>
    <div class="actions"><button id="bom-zip" class="primary">Download all trades (.zip)</button></div>
  </div><div class="bom-trades">`;
  trades.forEach((t, i) => {
    const to = (t.items || []).filter(x => x.needsTakeoff).length;
    html += `<div class="bom-trade"><div><b>${esc(t.trade)}</b><span class="tag">${(t.items || []).length} items${to ? ' · ' + to + ' to measure' : ''}</span></div><button data-trade="${i}">Download .xlsx</button></div>`;
  });
  html += `</div>`;
  panel.innerHTML = html;
  panel.querySelector('#bom-zip').onclick = () => downloadAllTrades(trades, proj);
  panel.querySelectorAll('[data-trade]').forEach(b => b.onclick = () => {
    const t = trades[+b.dataset.trade];
    const wb = tradeWorkbook(t, proj);
    XLSX.writeFile(wb, fileName(proj, t.trade) + '.xlsx');
  });
}

function tradeWorkbook(trade, proj) {
  const wb = XLSX.utils.book_new();
  const header = ['Item / Description', 'Specification / Brand', 'Location', 'Qty', 'Unit', 'Take-off required', 'Source (sheet/page)', 'Confidence', 'Notes'];
  const aoa = [
    ['BILL OF MATERIALS — ' + trade.trade],
    ['Project: ' + proj + '   —   DRAFT for quoting. Verify against drawings. Items marked "MEASURE" require on-site take-off; no quantity has been estimated.'],
    [],
    header
  ];
  (trade.items || []).forEach(it => aoa.push([
    it.description || '', it.spec || '', it.location || '',
    (it.quantity == null ? '' : it.quantity), it.unit || '',
    it.needsTakeoff ? 'MEASURE' : '', it.source || '', it.confidence || '', it.note || ''
  ]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 44 }, { wch: 30 }, { wch: 20 }, { wch: 7 }, { wch: 9 }, { wch: 16 }, { wch: 22 }, { wch: 11 }, { wch: 34 }];
  const headerRow = 4, lastRow = aoa.length;
  ws['!autofilter'] = { ref: `A${headerRow}:I${lastRow}` };
  XLSX.utils.book_append_sheet(wb, ws, sheetName(trade.trade));
  return wb;
}

async function downloadAllTrades(trades, proj) {
  const zip = new JSZip();
  trades.forEach(t => {
    const wb = tradeWorkbook(t, proj);
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    zip.file(fileName(proj, t.trade) + '.xlsx', buf);
  });
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'BOM-' + slug(proj) + '.zip'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function slug(s) { return String(s || 'project').replace(/[^\w\-]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, ''); }
function fileName(proj, trade) { return 'BOM-' + slug(proj) + '-' + slug(trade); }
function sheetName(s) { return String(s || 'Trade').replace(/[\\/?*[\]:]/g, '').slice(0, 31); }

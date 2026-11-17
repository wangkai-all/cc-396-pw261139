/* Pointwise Rules UI. Plain ES module, no build step, no dependencies. */

const state = {
  datasets: [],
  datasetVersionId: null,
  datasetColumns: [],
  dimensions: [],
  selectedDims: new Map(), // name -> dimensionVersionId
  rules: [],
  groupKeys: [], // {name, expression}
  currentJobId: null,
  pollTimer: null,
  loading: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------------ *
 * HTTP and format helpers
 * ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(payload?.error?.message || `HTTP ${res.status}`);
    err.code = payload?.error?.code;
    err.details = payload?.error?.details;
    throw err;
  }
  return payload;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmt(value) {
  if (value === null || value === undefined) return '<span style="color:#5a6472">null</span>';
  if (typeof value === 'string') return esc(value);
  if (typeof value === 'boolean') return `<span style="color:#d2a8ff">${value}</span>`;
  if (typeof value === 'number') return `<span style="color:#79c0ff">${esc(Number.isInteger(value) ? value : value)}</span>`;
  return esc(JSON.stringify(value));
}

function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), bad ? 6000 : 3200);
}

const debounce = (fn, ms) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${btn.dataset.view}`));
  if (btn.dataset.view === 'jobs') refreshJobs();
  if (btn.dataset.view === 'sources') refreshSources();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  try {
    const health = await api('/api/health');
    const el = $('#health');
    el.textContent = `server ok · ${Math.round(health.uptimeMs / 1000)}s`;
    el.classList.add('ok');
  } catch {
    $('#health').textContent = 'server unreachable';
  }
  await Promise.all([loadDatasets(), loadDimensions(), loadRules()]);
  const params = new URLSearchParams(location.search);
  const ruleParam = params.get('rule');
  if (ruleParam) {
    await loadRuleIntoEditor(ruleParam);
  } else if (state.rules.length > 0) {
    await loadRuleIntoEditor(state.rules[0].name);
  } else {
    $('#expression').value = 'round(gross_amount * (1 - discount_pct), 2)';
  }
  updateGutter();
  scheduleValidate();
  refreshJobs();
  state.pollTimer = setInterval(() => {
    if ($('#view-jobs').classList.contains('active')) refreshJobs({ quiet: true });
  }, 2500);
}

async function loadDatasets() {
  const data = await api('/api/datasets');
  state.datasets = data.datasets;
  const select = $('#dataset-version');
  const previous = state.datasetVersionId;
  select.innerHTML = '';
  for (const ds of state.datasets) {
    const versions = await api(`/api/datasets/${ds.id}/versions`);
    for (const v of versions.versions) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${ds.name} v${v.versionNo} · ${v.rowCount} rows`;
      opt.dataset.columns = JSON.stringify(v.columns.map((c) => c.name));
      select.append(opt);
    }
  }
  if (select.options.length === 0) {
    select.innerHTML = '<option value="">no datasets loaded</option>';
    state.datasetVersionId = null;
    state.datasetColumns = [];
    return;
  }
  select.value = previous && [...select.options].some((o) => o.value === previous) ? previous : select.options[0].value;
  onDatasetVersionChange();
}

function onDatasetVersionChange() {
  const opt = $('#dataset-version').selectedOptions[0];
  state.datasetVersionId = opt?.value || null;
  state.datasetColumns = opt?.dataset.columns ? JSON.parse(opt.dataset.columns) : [];
  renderColumnChips();
}

$('#dataset-version').addEventListener('change', () => {
  onDatasetVersionChange();
  scheduleValidate();
});

async function loadDimensions() {
  const data = await api('/api/dimensions');
  state.dimensions = data.dimensions;
  const box = $('#dim-checks');
  box.innerHTML = '';
  for (const dim of state.dimensions) {
    const button = document.createElement('button');
    button.className = `chip${state.selectedDims.has(dim.name) ? ' on' : ''}`;
    button.type = 'button';
    button.innerHTML = `${esc(dim.name)} <span style="color:#5a6472">v${dim.latest_version}</span>`;
    button.title = `Pin dimension "${dim.name}" at its latest version for previews and jobs`;
    button.addEventListener('click', () => {
      toggleDimension(dim.name);
      button.classList.toggle('on', state.selectedDims.has(dim.name));
      scheduleValidate();
    });
    box.append(button);
  }
  if (state.dimensions.length === 0) box.innerHTML = '<span class="meta">no dimension tables loaded</span>';
}

async function toggleDimension(name) {
  if (state.selectedDims.has(name)) {
    state.selectedDims.delete(name);
    return;
  }
  const versions = await api(`/api/dimensions/${encodeURIComponent(name)}`);
  const latest = versions.versions[0];
  if (!latest) return;
  state.selectedDims.set(name, latest.id);
}

async function loadRules() {
  const data = await api('/api/rules');
  state.rules = data.rules;
  const list = $('#rule-names');
  list.innerHTML = state.rules.map((r) => `<option value="${esc(r.name)}">v${r.latest_version}</option>`).join('');
}

async function loadRuleIntoEditor(name) {
  const data = await api(`/api/rules/${encodeURIComponent(name)}`);
  const latest = data.versions[0];
  if (!latest) return;
  $('#rule-name').value = latest.name;
  $('#expression').value = latest.expression;
  $('#mode').value = latest.outputType === 'number' && /\b(sum|count|avg|min|max)\(/.test(latest.expression) ? 'group' : 'row';
  updateGutter();
  scheduleValidate();
  $('#rule-name').dataset.loaded = '1';
}

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

const expressionEl = $('#expression');
const gutterEl = $('#gutter');

function updateGutter() {
  const lines = expressionEl.value.split('\n').length;
  gutterEl.textContent = Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join('\n');
  expressionEl.style.height = 'auto';
  expressionEl.style.height = `${Math.max(190, expressionEl.scrollHeight)}px`;
  gutterEl.style.height = expressionEl.style.height;
}

expressionEl.addEventListener('input', () => {
  updateGutter();
  scheduleValidate();
});
expressionEl.addEventListener('scroll', () => {
  gutterEl.scrollTop = expressionEl.scrollTop;
});
expressionEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = expressionEl.selectionStart;
    const end = expressionEl.selectionEnd;
    expressionEl.value = `${expressionEl.value.slice(0, start)}  ${expressionEl.value.slice(end)}`;
    expressionEl.selectionStart = expressionEl.selectionEnd = start + 2;
    updateGutter();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    preview();
  }
});

function renderColumnChips() {
  const box = $('#dim-picker');
  box.dataset.columns = state.datasetColumns.join(',');
}

/* ------------------------------------------------------------------ *
 * Validation & preview
 * ------------------------------------------------------------------ */

const scheduleValidate = debounce(() => validateOnly({ quiet: true }), 320);

function requestBody() {
  return {
    expression: expressionEl.value,
    knownColumns: state.datasetColumns,
    knownDimensions: state.dimensions.map((d) => d.name),
    mode: $('#mode').value,
    outputName: $('#rule-name').value || null,
    datasetVersionId: state.datasetVersionId,
    dimensions: [...state.selectedDims].map(([name, id]) => ({ name, dimensionVersionId: id })),
    groupKeys: state.groupKeys.map((k) => ({ name: k.name, expression: k.expression })),
  };
}

async function validateOnly({ quiet = false } = {}) {
  const status = $('#compile-status');
  const body = requestBody();
  if (!body.expression.trim()) {
    status.textContent = '';
    status.className = 'status-line';
    return;
  }
  try {
    const result = await api('/api/rules/validate', {
      method: 'POST',
      body,
    });
    if (result.ok) {
      status.className = 'status-line ok';
      const info = result.info;
      status.textContent = `compiles · returns ${result.outputType}` +
        (info.functions.length ? ` · calls ${info.functions.join(', ')}` : '') +
        (info.dimensions.length ? ` · looks up ${info.dimensions.join(', ')}` : '');
      hideError();
      renderWarnings(result.warnings);
    } else {
      status.className = 'status-line bad';
      status.textContent = 'does not compile';
      if (!quiet) showError(result.error);
      renderWarnings(result.warnings);
    }
  } catch (err) {
    status.className = 'status-line bad';
    status.textContent = err.message;
  }
}

function showError(error) {
  const box = $('#error-box');
  if (!error) return box.classList.add('hidden');
  box.classList.remove('hidden');
  box.innerHTML = `<div><span class="code">${esc(error.code || 'E_EXPRESSION')}</span> ${esc(error.message)}</div>` +
    (error.excerpt ? `<pre>${esc(error.excerpt)}</pre>` : '');
}

function hideError() {
  $('#error-box').classList.add('hidden');
}

function renderWarnings(warnings = []) {
  $('#warnings').innerHTML = warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join('');
}

async function preview() {
  if (state.loading) return;
  const body = requestBody();
  if (!body.datasetVersionId) return toast('load a dataset first', true);
  if (!body.expression.trim()) return toast('write an expression first', true);
  if (body.mode === 'group' && state.groupKeys.length === 0) {
    return toast('grouped mode needs at least one group key', true);
  }
  state.loading = true;
  $('#btn-preview').disabled = true;
  $('#preview-body').innerHTML = '<p class="hint">computing…</p>';
  try {
    const result = await api('/api/preview', {
      method: 'POST',
      body: { ...body, limit: 12 },
    });
    if (!result.ok) {
      showError(result.error);
      renderWarnings(result.warnings);
      $('#preview-meta').textContent = result.stage === 'compile' ? 'compile error' : 'evaluation error';
      $('#preview-body').innerHTML = `<p class="hint">Preview stopped at the first failing row so you can fix the expression. No job was created.</p>`;
      return;
    }
    hideError();
    renderWarnings(result.warnings);
    renderPreview(result, body);
  } catch (err) {
    showError({ code: err.code || 'E_PREVIEW', message: err.message });
    $('#preview-body').innerHTML = '';
  } finally {
    state.loading = false;
    $('#btn-preview').disabled = false;
  }
}

function renderPreview(result, body) {
  $('#preview-meta').textContent =
    `${result.results.length} row${result.results.length === 1 ? '' : 's'} · ${result.outputType}` +
    (result.pinnedDimensions?.length ? ` · ${result.pinnedDimensions.length} dimension pin(s)` : '');
  if (body.mode === 'group') {
    const keys = Object.keys(result.results[0]?.key ?? {});
    const rows = result.results
      .map((r) => `<tr>${keys.map((k) => `<td class="input">${esc(k)}=${fmt(r.key[k])}</td>`).join('')}<td class="value">${fmt(r.value)}</td></tr>`)
      .join('');
    $('#preview-body').innerHTML =
      `<table class="table preview-table"><thead><tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}<th>result</th></tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }
  const rows = result.results
    .map((r) => {
      const inputs = Object.entries(r.input)
        .slice(0, 4)
        .map(([k, v]) => `<span>${esc(k)}=${fmt(v)}</span>`)
        .join(' · ');
      return `<tr><td class="input">#${r.rowNo}</td><td class="inputs">${inputs}</td><td class="value">${fmt(r.value)}</td></tr>`;
    })
    .join('');
  $('#preview-body').innerHTML =
    `<table class="table preview-table"><thead><tr><th>Row</th><th>Input (first columns)</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ------------------------------------------------------------------ *
 * Group keys
 * ------------------------------------------------------------------ */

$('#btn-add-key').addEventListener('click', addGroupKey);
$('#key-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addGroupKey();
  }
});

function addGroupKey() {
  const raw = $('#key-input').value.trim();
  if (!raw) return;
  const eq = raw.indexOf('=');
  const name = eq >= 0 ? raw.slice(0, eq).trim() : raw.split(/[^A-Za-z0-9_]/)[0];
  const expression = eq >= 0 ? raw.slice(eq + 1).trim() : raw;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return toast('key name must be a valid identifier', true);
  if (state.groupKeys.some((k) => k.name === name)) return toast(`key "${name}" already exists`, true);
  state.groupKeys.push({ name, expression });
  $('#key-input').value = '';
  renderKeys();
  scheduleValidate();
}

function renderKeys() {
  const box = $('#key-list');
  box.innerHTML = '';
  for (const key of state.groupKeys) {
    const el = document.createElement('span');
    el.className = 'chip on';
    el.innerHTML = `${esc(key.name)} = <span style="color:#8b95a3">${esc(key.expression)}</span> <button title="remove">×</button>`;
    el.querySelector('button').addEventListener('click', () => {
      state.groupKeys = state.groupKeys.filter((k) => k.name !== key.name);
      renderKeys();
      scheduleValidate();
    });
    box.append(el);
  }
  if (state.groupKeys.length === 0) box.innerHTML = '<span class="meta">none (grouped mode only)</span>';
}

$('#mode').addEventListener('change', () => {
  const grouped = $('#mode').value === 'group';
  $('#key-list').parentElement.style.display = grouped ? '' : 'none';
  scheduleValidate();
});

/* ------------------------------------------------------------------ *
 * Save & run
 * ------------------------------------------------------------------ */

$('#btn-validate').addEventListener('click', () => validateOnly({ quiet: false }));
$('#btn-preview').addEventListener('click', preview);

$('#btn-save').addEventListener('click', async () => {
  const name = $('#rule-name').value.trim();
  if (!name) return toast('give the rule a name first', true);
  try {
    const body = requestBody();
    const result = await api('/api/rules', {
      method: 'POST',
      body: {
        name,
        expression: body.expression,
        note: '',
        knownColumns: body.knownColumns,
        knownDimensions: body.knownDimensions,
        mode: body.mode,
      },
    });
    toast(`saved ${name} v${result.rule.versionNo}${result.reused ? ' (unchanged, reused)' : ''}`);
    await loadRules();
  } catch (err) {
    showError(err.details?.errors ? err.details.errors[0] : { code: err.code, message: err.message });
    toast(err.message, true);
  }
});

$('#btn-run').addEventListener('click', async () => {
  const name = $('#rule-name').value.trim() || 'adhoc';
  if (!state.datasetVersionId) return toast('load a dataset first', true);
  if ($('#mode').value === 'group' && state.groupKeys.length === 0) {
    return toast('grouped mode needs at least one group key', true);
  }
  try {
    const body = requestBody();
    // Persist the current text as a version first, so the job can pin it.
    const saved = await api('/api/rules', {
      method: 'POST',
      body: {
        name,
        expression: body.expression,
        note: '',
        knownColumns: body.knownColumns,
        knownDimensions: body.knownDimensions,
        mode: body.mode,
      },
    });
    await loadRules();

    const validation = await api('/api/rules/validate', { method: 'POST', body });
    if (!validation.ok) {
      showError(validation.error);
      return toast('fix the expression before running', true);
    }
    const result = await api('/api/jobs', {
      method: 'POST',
      body: {
        name: `${name} · ${state.datasets.length ? '' : ''}run`,
        datasetVersionId: state.datasetVersionId,
        mode: body.mode,
        groupKeys: state.groupKeys.map((k) => ({ name: k.name, expression: k.expression })),
        rules: [{ outputName: name, ruleVersionId: saved.rule.id }],
        dimensions: [...state.selectedDims].map(([dimName, id]) => ({ dimensionVersionId: id })),
        startWorker: true,
        runLabel: `v${saved.rule.versionNo}`,
      },
    });
    toast(`job ${result.job.id} created; worker started`);
    await refreshJobs();
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'jobs'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-jobs'));
    openJob(result.job.id);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------------ *
 * Jobs view
 * ------------------------------------------------------------------ */

async function refreshJobs({ quiet = false } = {}) {
  try {
    const data = await api('/api/jobs');
    renderJobs(data.jobs);
    if (state.currentJobId) {
      const stillThere = data.jobs.some((j) => j.id === state.currentJobId);
      if (stillThere) openJob(state.currentJobId, { quiet: true });
    }
  } catch (err) {
    if (!quiet) toast(err.message, true);
  }
}

function renderJobs(jobs) {
  const tbody = $('#jobs-table tbody');
  if (jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="meta">no jobs yet. Build a rule and press Run job.</td></tr>';
    return;
  }
  tbody.innerHTML = jobs
    .map((j) => {
      const pct = j.totalRows ? Math.round((j.processedRows / j.totalRows) * 100) : 0;
      return `<tr data-job="${esc(j.id)}" style="cursor:pointer">
        <td>${esc(j.name)}<div class="meta">${esc(j.id)}</div></td>
        <td><span class="pill ${esc(j.status)}">${esc(j.status)}</span></td>
        <td>${esc(j.mode)}</td>
        <td><div class="progress"><i style="width:${pct}%"></i></div><span class="meta">${j.processedRows}/${j.totalRows}</span></td>
        <td>${esc(j.runLabel || '—')}</td>
        <td class="meta">${esc(new Date(j.createdAt).toLocaleTimeString())}</td>
        <td><button class="ghost small" data-open="${esc(j.id)}">Open</button></td>
      </tr>`;
    })
    .join('');
  tbody.querySelectorAll('button[data-open]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openJob(b.dataset.open);
    });
  });
  tbody.querySelectorAll('tr[data-job]').forEach((tr) => {
    tr.addEventListener('click', () => openJob(tr.dataset.job));
  });
}

async function openJob(jobId, { quiet = false } = {}) {
  state.currentJobId = jobId;
  const detail = await api(`/api/jobs/${jobId}`);
  const job = detail.job;
  $('#job-detail').classList.remove('hidden');
  $('#job-detail-title').textContent = `Job ${job.name}`;
  const pct = job.totalRows ? Math.round((job.processedRows / job.totalRows) * 100) : 0;
  const taskList = detail.tasks
    .map((t) => {
      const label = `${String(t.taskNo).padStart(3, '0')} ${t.status}${t.attempts > 1 ? ` ×${t.attempts}` : ''}`;
      const color = t.status === 'done' ? '#3fb950' : t.status === 'running' ? '#4f9cf9' : t.status === 'failed' ? '#f85149' : '#5a6472';
      return `<span class="chip" style="color:${color};border-color:${t.status === 'done' ? '#234b2c' : 'var(--line)'}" title="${esc(t.error || '')}">${esc(label)}</span>`;
    })
    .join('');

  const manifest = job.status === 'done'
    ? await api(`/api/jobs/${job.id}/manifest`).catch(() => null)
    : null;

  $('#job-detail-body').innerHTML = `
    <div class="kv">
      <span class="k">status</span><span class="v"><span class="pill ${esc(job.status)}">${esc(job.status)}</span> ${pct}%</span>
      <span class="k">job id</span><span class="v">${esc(job.id)}</span>
      <span class="k">input version</span><span class="v">${esc(job.datasetVersionId)} (v${esc(job.datasetVersionNo ?? '?')})</span>
      <span class="k">mode</span><span class="v">${esc(job.mode)}${job.groupKeys.length ? ` · keys: ${esc(job.groupKeys.join(', '))}` : ''}</span>
      <span class="k">rows</span><span class="v">${job.processedRows} / ${job.totalRows}${job.mode === 'group' ? ` · ${job.totalGroups} groups` : ''}</span>
      <span class="k">batch size</span><span class="v">${job.batchSize} rows per task</span>
      <span class="k">rules</span><span class="v">${job.rules.map((r) => `${esc(r.outputName)} = <code>${esc(r.expression)}</code>${r.ruleVersionId ? ` <span class="meta">${esc(r.ruleVersionId)}</span>` : ''}`).join('<br>')}</span>
      <span class="k">dimension pins</span><span class="v">${job.dimensions.length ? job.dimensions.map((d) => `${esc(d.name)} v${esc(d.versionNo)} <span class="meta">${esc(d.versionId.slice(0, 12))}…</span>`).join('<br>') : '<span class="meta">none</span>'}</span>
      ${job.manifestHash ? `<span class="k">manifest hash</span><span class="v">${esc(job.manifestHash)}</span>` : ''}
      ${job.resumedFrom ? `<span class="k">forked from</span><span class="v">${esc(job.resumedFrom)}</span>` : ''}
      ${job.error ? `<span class="k">error</span><span class="v" style="color:var(--danger)">${esc(job.error)}</span>` : ''}
    </div>
    <div class="section-title">Tasks (${detail.tasks.length})</div>
    <div class="chips">${taskList || '<span class="meta">none</span>'}</div>
    <div class="section-title">Events</div>
    <div class="log">${detail.events.map((e) => `<div class="${esc(e.level)}">${esc(new Date(e.at).toLocaleTimeString())} · ${esc(e.kind)} · ${esc(e.message)}</div>`).join('') || '<div>no events</div>'}</div>
    <div class="section-title">Result</div>
    <div class="row wrap">
      ${job.status === 'done' ? `<a class="ghost small" style="padding:6px 11px;border:1px solid var(--line);border-radius:7px;text-decoration:none;color:var(--text)" href="/api/jobs/${esc(job.id)}/result.jsonl">Download JSONL</a>` : '<span class="meta">not finished yet</span>'}
      <button class="ghost small" id="btn-fork">Fork with edited rule…</button>
    </div>
    ${manifest ? `<details class="uploader"><summary>Manifest (input + dimension + rule versions)</summary><pre class="log" style="white-space:pre-wrap">${esc(JSON.stringify(manifest, null, 2))}</pre></details>` : ''}
    <div id="result-sample"></div>
  `;

  $('#btn-fork')?.addEventListener('click', () => forkJob(job));

  if (job.status === 'done') {
    const sample = await api(`/api/jobs/${job.id}/result?limit=20`).catch(() => null);
    if (sample?.ready) {
      const cols = [...new Set(sample.rows.flatMap((r) => Object.keys(r)))];
      const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
      const body = sample.rows
        .map((r) => `<tr>${cols.map((c) => `<td>${fmt(r[c])}</td>`).join('')}</tr>`)
        .join('');
      $('#result-sample').innerHTML = `<div class="section-title">First ${sample.rows.length} of ${sample.total} output rows</div>
        <div style="overflow:auto"><table class="table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
    }
  }
  if (!quiet) {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === 'jobs'));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-jobs'));
  }
}

async function forkJob(job) {
  const rule = job.rules[0];
  if (!rule) return toast('this job has no rule to edit', true);
  const expression = prompt('Edit the expression for the forked job (input and dimension versions stay pinned):', rule.expression);
  if (expression === null || expression === rule.expression) return;
  try {
    const validation = await api('/api/rules/validate', {
      method: 'POST',
      body: { expression, knownColumns: state.datasetColumns, mode: job.mode },
    });
    if (!validation.ok) {
      showError(validation.error);
      return toast('expression does not compile', true);
    }
    const saved = await api('/api/rules', {
      method: 'POST',
      body: { name: rule.outputName, expression, note: 'fork', mode: job.mode },
    });
    const forked = await api(`/api/jobs/${job.id}/fork`, {
      method: 'POST',
      body: {
        runLabel: `fork-v${saved.rule.versionNo}`,
        startWorker: true,
        rules: [{ outputName: rule.outputName, ruleVersionId: saved.rule.id }],
      },
    });
    toast(`forked job ${forked.job.id}`);
    await refreshJobs();
    openJob(forked.job.id);
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-refresh-jobs').addEventListener('click', () => refreshJobs());
$('#btn-recover').addEventListener('click', async () => {
  try {
    const result = await api('/api/jobs/recover', { method: 'POST', body: {} });
    toast(`requeued ${result.requeuedTasks} task(s)`);
    refreshJobs();
  } catch (err) {
    toast(err.message, true);
  }
});
$('#btn-wake').addEventListener('click', async () => {
  if (!state.currentJobId) return;
  try {
    await api(`/api/jobs/${state.currentJobId}/wake`, { method: 'POST', body: {} });
    toast('worker started');
    refreshJobs();
  } catch (err) {
    toast(err.message, true);
  }
});
$('#btn-cancel-job').addEventListener('click', async () => {
  if (!state.currentJobId) return;
  try {
    await api(`/api/jobs/${state.currentJobId}/cancel`, { method: 'POST', body: {} });
    toast('job cancelled');
    refreshJobs();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------------ *
 * Sources view
 * ------------------------------------------------------------------ */

async function refreshSources() {
  try {
    const [ds, dims] = await Promise.all([api('/api/datasets'), api('/api/dimensions')]);
    $('#datasets-list').innerHTML = ds.datasets
      .map((d) => `<div class="source-item"><div><div class="name">${esc(d.name)}</div><div class="info">${esc(d.description || '')}</div></div><div class="info">latest v${esc(d.latest_version)}</div></div>`)
      .join('') || '<p class="hint">No datasets yet.</p>';
    $('#dims-list').innerHTML = dims.dimensions
      .map((d) => `<div class="source-item"><div class="name">${esc(d.name)}</div><div class="info">v${esc(d.latest_version)} · ${esc(d.versions)} version(s)</div></div>`)
      .join('') || '<p class="hint">No dimension tables yet.</p>';
  } catch (err) {
    toast(err.message, true);
  }
}

$('#btn-load-dataset').addEventListener('click', async () => {
  const name = $('#ds-name').value.trim();
  const content = $('#ds-content').value;
  if (!name || !content.trim()) return toast('name and content are required', true);
  try {
    const result = await api('/api/datasets', {
      method: 'POST',
      body: { name, content, format: $('#ds-format').value, description: 'loaded from UI' },
    });
    $('#ds-msg').textContent = result.reused ? `reused v${result.version.versionNo}` : `loaded v${result.version.versionNo}`;
    toast(result.reused ? 'identical content: version reused' : `dataset version v${result.version.versionNo} created`);
    await loadDatasets();
    refreshSources();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#btn-load-dim').addEventListener('click', async () => {
  const name = $('#dim-name').value.trim();
  const content = $('#dim-content').value;
  if (!name || !content.trim()) return toast('name and content are required', true);
  try {
    const result = await api('/api/dimensions', {
      method: 'POST',
      body: { name, content, format: $('#dim-format').value },
    });
    $('#dim-msg').textContent = result.reused ? `reused v${result.version.versionNo}` : `loaded v${result.version.versionNo}`;
    toast(result.reused ? 'identical content: version reused' : `dimension version v${result.version.versionNo} created`);
    await loadDimensions();
    refreshSources();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------------ */

renderKeys();
boot();

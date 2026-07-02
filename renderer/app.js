/* DriveLens renderer */
'use strict';

const $ = (id) => document.getElementById(id);

// ---------- State ----------
let scanRoot = null;        // e.g. "C:\"
let expectedBytes = 0;      // used bytes on drive, for progress %
let tree = null;            // root node
let currentNode = null;     // node being viewed
let largestFiles = [];      // [{p, s, m}]
let scanStats = null;       // {files, dirs, bytes, errors}
let selection = new Set();  // selected nodes in explorer
let largestSelection = new Set(); // selected indices in largest view
let hoverIndex = -1;
let layoutRects = [];       // [{x,y,w,h,node}]

// ---------- Formatting ----------
function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function truncMiddle(s, max) {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return s.slice(0, half) + '…' + s.slice(-half);
}

// ---------- Path helpers ----------
function nodePath(node) {
  if (node.path) return node.path;
  if (!node.p) { node.path = node.n; return node.path; }
  const parent = nodePath(node.p);
  node.path = parent.endsWith('\\') ? parent + node.n : parent + '\\' + node.n;
  return node.path;
}

function linkParents(node) {
  if (!node.c) return;
  for (const child of node.c) {
    child.p = node;
    if (child.d) linkParents(child);
  }
}

const SYSTEM_PATTERNS = [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files( \(x86\))?(\\|$)/i, /pagefile\.sys$/i, /hiberfil\.sys$/i, /swapfile\.sys$/i];
function isSystemPath(p) {
  return SYSTEM_PATTERNS.some((re) => re.test(p));
}

// ---------- Colors ----------
const EXT_CATEGORIES = {
  video: { color: '#e0655f', exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'ts', 'mpg', 'mpeg'] },
  audio: { color: '#c987e8', exts: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma', 'opus'] },
  image: { color: '#e8a13c', exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tiff', 'raw', 'heic', 'svg', 'psd'] },
  archive: { color: '#d4b13f', exts: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'img'] },
  code: { color: '#52c78a', exts: ['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'html', 'css', 'json', 'xml', 'sql', 'sh', 'ps1'] },
  doc: { color: '#5aa8e8', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'odt', 'csv'] },
  app: { color: '#7c8ff0', exts: ['exe', 'dll', 'msi', 'sys', 'bin', 'dat', 'pak', 'apk'] }
};
const DIR_PALETTE = ['#3b6fd4', '#4585e0', '#5470c9', '#3d7fc4', '#4a63b8', '#3f8ed0', '#5b7ad6', '#3868be'];

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function colorFor(node) {
  if (node.agg) return '#3a4150';
  if (node.d) return DIR_PALETTE[hashStr(node.n) % DIR_PALETTE.length];
  const dot = node.n.lastIndexOf('.');
  const ext = dot >= 0 ? node.n.slice(dot + 1).toLowerCase() : '';
  for (const key of Object.keys(EXT_CATEGORIES)) {
    if (EXT_CATEGORIES[key].exts.includes(ext)) return EXT_CATEGORIES[key].color;
  }
  return '#6b7484';
}

// ---------- Views ----------
function showView(name) {
  $('view-drives').classList.toggle('hidden', name !== 'drives');
  $('view-scanning').classList.toggle('hidden', name !== 'scanning');
  $('view-results').classList.toggle('hidden', name !== 'results');
  $('btn-home').classList.toggle('hidden', name === 'drives');
  $('btn-rescan').classList.toggle('hidden', name !== 'results');
}

// ---------- Drive picker ----------
async function loadDrives() {
  showView('drives');
  const drives = await window.api.getDrives();
  const grid = $('drive-grid');
  grid.innerHTML = '';
  for (const d of drives) {
    const used = d.total - d.free;
    const pct = d.total > 0 ? (used / d.total) * 100 : 0;
    const cls = pct > 90 ? 'crit' : pct > 75 ? 'warn' : '';
    const card = document.createElement('div');
    card.className = 'drive-card';
    card.innerHTML = `
      <div class="drive-top">
        <div class="drive-icon">🖴</div>
        <div>
          <h3>Local Disk (${d.letter}:)</h3>
          <div class="drive-sub">${fmtBytes(d.free)} free of ${fmtBytes(d.total)}</div>
        </div>
      </div>
      <div class="usage-track"><div class="usage-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="drive-detail"><span>${pct.toFixed(0)}% used</span><span>Click to scan →</span></div>`;
    card.addEventListener('click', () => startScan(d.root, used));
    grid.appendChild(card);
  }
}

// ---------- Scanning ----------
function startScan(root, usedBytes) {
  scanRoot = root;
  expectedBytes = usedBytes || 0;
  selection.clear();
  largestSelection.clear();
  showView('scanning');
  $('scan-title').textContent = `Scanning ${root}`;
  $('progress-fill').style.width = '0%';
  $('progress-fill').classList.toggle('indeterminate', !expectedBytes);
  $('scan-bytes').textContent = '0 B';
  $('scan-files').textContent = '0';
  $('scan-dirs').textContent = '0';
  $('scan-errors').textContent = '0';
  $('scan-current').textContent = '';
  window.api.startScan(root);
}

window.api.onProgress((d) => {
  $('scan-bytes').textContent = fmtBytes(d.bytes);
  $('scan-files').textContent = d.files.toLocaleString();
  $('scan-dirs').textContent = d.dirs.toLocaleString();
  $('scan-errors').textContent = d.errors.toLocaleString();
  $('scan-current').textContent = truncMiddle(d.current || '', 90);
  if (expectedBytes > 0) {
    const pct = Math.min(99, (d.bytes / expectedBytes) * 100);
    $('progress-fill').style.width = pct.toFixed(1) + '%';
  }
});

window.api.onDone((msg) => {
  if (!msg.tree) {
    toast(msg.error || 'Scan failed', 'err');
    showView('drives');
    return;
  }
  tree = msg.tree;
  tree.path = msg.root;
  linkParents(tree);
  largestFiles = msg.largest || [];
  scanStats = { files: msg.files, dirs: msg.dirs, bytes: msg.bytes, errors: msg.errors };
  currentNode = tree;
  selection.clear();
  largestSelection.clear();
  showView('results');
  switchTab('explorer');
  render();
});

window.api.onError((err) => {
  toast('Scan error: ' + err, 'err');
  showView('drives');
});

// ---------- Rendering ----------
function render() {
  renderBreadcrumbs();
  renderSummary();
  drawTreemap();
  renderList();
  renderSelectionBar();
}

function renderBreadcrumbs() {
  const bc = $('breadcrumbs');
  bc.innerHTML = '';
  const chain = [];
  let n = currentNode;
  while (n) { chain.unshift(n); n = n.p; }
  chain.forEach((node, i) => {
    const span = document.createElement('span');
    span.className = 'crumb' + (i === chain.length - 1 ? ' current' : '');
    span.textContent = node.n.replace(/\\$/, '') || node.n;
    if (i < chain.length - 1) span.addEventListener('click', () => navigate(node));
    bc.appendChild(span);
    if (i < chain.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = ' › ';
      bc.appendChild(sep);
    }
  });
}

function renderSummary() {
  const s = scanStats;
  const parts = [
    `<b>${fmtBytes(currentNode.s)}</b> in this folder`,
    `${(currentNode.f || 0).toLocaleString()} files`
  ];
  if (currentNode === tree && s) {
    parts.push(`${s.dirs.toLocaleString()} folders scanned`);
    if (s.errors > 0) parts.push(`${s.errors.toLocaleString()} items skipped (no permission)`);
  }
  $('summary-bar').innerHTML = parts.join(' · ');
}

function navigate(node) {
  currentNode = node;
  selection.clear();
  hoverIndex = -1;
  render();
}

// ---------- Treemap ----------
function squarifyWorst(row, totalArea, side) {
  const t = totalArea / side;
  let max = 0;
  for (const it of row) {
    const len = it.area / t;
    const r = Math.max(len / t, t / len);
    if (r > max) max = r;
  }
  return max;
}

function layoutTreemap(items, x, y, w, h, out) {
  items = items.slice();
  while (items.length && w > 1 && h > 1) {
    const horizontalRow = w >= h; // row laid along the shorter side
    const side = horizontalRow ? h : w;
    let row = [items[0]];
    let rowArea = items[0].area;
    let best = squarifyWorst(row, rowArea, side);
    let i = 1;
    while (i < items.length) {
      const trial = row.concat(items[i]);
      const trialArea = rowArea + items[i].area;
      const tw = squarifyWorst(trial, trialArea, side);
      if (tw <= best) { row = trial; rowArea = trialArea; best = tw; i++; }
      else break;
    }
    items = items.slice(row.length);
    const thickness = Math.max(rowArea / side, 0.5);
    let offset = 0;
    for (const it of row) {
      const len = it.area / thickness;
      if (horizontalRow) out.push({ x: x, y: y + offset, w: thickness, h: len, node: it.node });
      else out.push({ x: x + offset, y: y, w: len, h: thickness, node: it.node });
      offset += len;
    }
    if (horizontalRow) { x += thickness; w -= thickness; }
    else { y += thickness; h -= thickness; }
  }
}

function drawTreemap() {
  const canvas = $('treemap');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  if (cw === 0 || ch === 0) return;
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cw, ch);

  layoutRects = [];
  let kids = (currentNode.c || []).filter((k) => k.s > 0);
  if (!kids.length) {
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '13px "Segoe UI"';
    ctx.textAlign = 'center';
    ctx.fillText('Empty folder', cw / 2, ch / 2);
    return;
  }

  // Cap item count; aggregate the tail so areas stay truthful
  const MAX_ITEMS = 80;
  let items = kids;
  let tail = null;
  if (kids.length > MAX_ITEMS) {
    items = kids.slice(0, MAX_ITEMS);
    const tailSize = kids.slice(MAX_ITEMS).reduce((a, k) => a + k.s, 0);
    tail = { n: `${(kids.length - MAX_ITEMS).toLocaleString()} more items`, s: tailSize, agg: 1 };
    items = items.concat(tail);
  }

  const totalSize = items.reduce((a, k) => a + k.s, 0);
  const totalArea = cw * ch;
  const mapped = items
    .map((node) => ({ node, area: (node.s / totalSize) * totalArea }))
    .filter((it) => it.area >= 1);

  layoutTreemap(mapped, 0, 0, cw, ch, layoutRects);

  for (let i = 0; i < layoutRects.length; i++) {
    const r = layoutRects[i];
    const pad = 1;
    const x = r.x + pad, y = r.y + pad, w = Math.max(r.w - pad * 2, 0.5), h = Math.max(r.h - pad * 2, 0.5);
    const base = colorFor(r.node);
    ctx.fillStyle = base;
    ctx.globalAlpha = i === hoverIndex ? 1 : 0.82;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    if (i === hoverIndex) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    }
    // Labels
    if (w > 64 && h > 26) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = '600 12px "Segoe UI"';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const label = truncMiddle(r.node.n, Math.floor(w / 7));
      ctx.fillText(label, x + 6, y + 6);
      if (h > 44) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = '11px "Segoe UI"';
        ctx.fillText(fmtBytes(r.node.s), x + 6, y + 22);
      }
      ctx.restore();
    }
  }
}

function rectAt(mx, my) {
  for (let i = 0; i < layoutRects.length; i++) {
    const r = layoutRects[i];
    if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return i;
  }
  return -1;
}

$('treemap').addEventListener('mousemove', (e) => {
  const rect = e.target.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const idx = rectAt(mx, my);
  if (idx !== hoverIndex) {
    hoverIndex = idx;
    drawTreemap();
  }
  const tt = $('tooltip');
  if (idx >= 0) {
    const node = layoutRects[idx].node;
    const pct = currentNode.s > 0 ? ((node.s / currentNode.s) * 100).toFixed(1) : '0';
    tt.innerHTML = `<div class="tt-name">${escapeHtml(node.n)}</div><div class="tt-size">${fmtBytes(node.s)} · ${pct}% of this folder${node.d ? ' · click to open' : ''}</div>`;
    tt.classList.remove('hidden');
    const wrap = e.target.parentElement.getBoundingClientRect();
    let tx = e.clientX - wrap.left + 14;
    let ty = e.clientY - wrap.top + 14;
    if (tx + tt.offsetWidth > wrap.width - 8) tx = wrap.width - tt.offsetWidth - 8;
    if (ty + tt.offsetHeight > wrap.height - 8) ty = e.clientY - wrap.top - tt.offsetHeight - 10;
    tt.style.left = tx + 'px';
    tt.style.top = ty + 'px';
  } else {
    tt.classList.add('hidden');
  }
});

$('treemap').addEventListener('mouseleave', () => {
  hoverIndex = -1;
  $('tooltip').classList.add('hidden');
  drawTreemap();
});

$('treemap').addEventListener('click', (e) => {
  const rect = e.target.getBoundingClientRect();
  const idx = rectAt(e.clientX - rect.left, e.clientY - rect.top);
  if (idx >= 0) {
    const node = layoutRects[idx].node;
    if (node.d) navigate(node);
  }
});

window.addEventListener('resize', () => {
  if (!$('view-results').classList.contains('hidden')) drawTreemap();
});

// ---------- File list ----------
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderList() {
  const tbody = $('file-rows');
  tbody.innerHTML = '';
  const kids = (currentNode.c || []).slice(0, 1000);
  const folderSize = currentNode.s || 1;
  $('check-all').checked = false;

  for (const node of kids) {
    const tr = document.createElement('tr');

    // checkbox
    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    if (!node.agg) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selection.has(node);
      cb.addEventListener('change', () => {
        if (cb.checked) selection.add(node); else selection.delete(node);
        renderSelectionBar();
      });
      tdCheck.appendChild(cb);
    }
    tr.appendChild(tdCheck);

    // name
    const tdName = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'name-cell';
    const dot = document.createElement('span');
    dot.className = 'type-dot';
    dot.style.background = colorFor(node);
    wrap.appendChild(dot);
    const label = document.createElement('span');
    label.className = 'name-label' + (node.d ? ' dir' : '') + (node.agg ? ' muted' : '');
    label.textContent = (node.d ? '📁 ' : '') + node.n;
    if (node.d) label.addEventListener('click', () => navigate(node));
    wrap.appendChild(label);
    tdName.appendChild(wrap);
    tr.appendChild(tdName);

    // size
    const tdSize = document.createElement('td');
    tdSize.className = 'col-size';
    tdSize.textContent = fmtBytes(node.s);
    tr.appendChild(tdSize);

    // percent bar
    const tdPct = document.createElement('td');
    tdPct.className = 'col-pct';
    const pct = Math.min(100, (node.s / folderSize) * 100);
    tdPct.innerHTML = `<div class="pct-track"><div class="pct-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
    tr.appendChild(tdPct);

    // actions
    const tdAct = document.createElement('td');
    tdAct.className = 'col-actions';
    if (!node.agg) {
      const btnReveal = document.createElement('button');
      btnReveal.className = 'row-btn';
      btnReveal.title = 'Show in Explorer';
      btnReveal.textContent = '📂';
      btnReveal.addEventListener('click', () => window.api.showInFolder(nodePath(node)));
      tdAct.appendChild(btnReveal);
      const btnDel = document.createElement('button');
      btnDel.className = 'row-btn del';
      btnDel.title = 'Move to Recycle Bin';
      btnDel.textContent = '🗑';
      btnDel.addEventListener('click', () => confirmDelete([node]));
      tdAct.appendChild(btnDel);
    }
    tr.appendChild(tdAct);
    tbody.appendChild(tr);
  }
}

$('check-all').addEventListener('change', (e) => {
  selection.clear();
  if (e.target.checked) {
    for (const node of (currentNode.c || []).slice(0, 1000)) {
      if (!node.agg) selection.add(node);
    }
  }
  renderList();
  renderSelectionBar();
});

function renderSelectionBar() {
  const active = $('panel-explorer').classList.contains('hidden') ? largestSelectionNodes() : [...selection];
  const bar = $('selection-bar');
  if (!active.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const total = active.reduce((a, n) => a + (n.s || n.size || 0), 0);
  $('selection-info').innerHTML = `<b>${active.length}</b> item${active.length > 1 ? 's' : ''} selected · <b>${fmtBytes(total)}</b> would be freed`;
}

// ---------- Largest files ----------
function largestSelectionNodes() {
  return [...largestSelection].map((i) => largestFiles[i]).filter(Boolean).map((f) => ({ n: f.p, s: f.s, _lf: f }));
}

function renderLargest() {
  const tbody = $('largest-rows');
  tbody.innerHTML = '';
  $('check-all-largest').checked = false;

  largestFiles.forEach((f, idx) => {
    const tr = document.createElement('tr');

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = largestSelection.has(idx);
    cb.addEventListener('change', () => {
      if (cb.checked) largestSelection.add(idx); else largestSelection.delete(idx);
      renderSelectionBar();
    });
    tdCheck.appendChild(cb);
    tr.appendChild(tdCheck);

    const tdName = document.createElement('td');
    const lastSlash = f.p.lastIndexOf('\\');
    const fname = f.p.slice(lastSlash + 1);
    const fdir = f.p.slice(0, lastSlash);
    const dot = `<span class="type-dot" style="background:${colorFor({ n: fname })}"></span>`;
    tdName.innerHTML = `<div class="name-cell">${dot}<div><div class="name-label">${escapeHtml(fname)}</div><div class="file-path-sub">${escapeHtml(fdir)}</div></div></div>`;
    tr.appendChild(tdName);

    const tdSize = document.createElement('td');
    tdSize.className = 'col-size';
    tdSize.textContent = fmtBytes(f.s);
    tr.appendChild(tdSize);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = fmtDate(f.m);
    tr.appendChild(tdDate);

    const tdAct = document.createElement('td');
    tdAct.className = 'col-actions';
    const btnReveal = document.createElement('button');
    btnReveal.className = 'row-btn';
    btnReveal.title = 'Show in Explorer';
    btnReveal.textContent = '📂';
    btnReveal.addEventListener('click', () => window.api.showInFolder(f.p));
    tdAct.appendChild(btnReveal);
    const btnDel = document.createElement('button');
    btnDel.className = 'row-btn del';
    btnDel.title = 'Move to Recycle Bin';
    btnDel.textContent = '🗑';
    btnDel.addEventListener('click', () => confirmDelete([{ n: f.p, s: f.s, _lf: f }]));
    tdAct.appendChild(btnDel);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });
}

$('check-all-largest').addEventListener('change', (e) => {
  largestSelection.clear();
  if (e.target.checked) largestFiles.forEach((_f, i) => largestSelection.add(i));
  renderLargest();
  renderSelectionBar();
});

// ---------- Tabs ----------
function switchTab(name) {
  $('tab-explorer').classList.toggle('active', name === 'explorer');
  $('tab-largest').classList.toggle('active', name === 'largest');
  $('panel-explorer').classList.toggle('hidden', name !== 'explorer');
  $('panel-largest').classList.toggle('hidden', name !== 'largest');
  if (name === 'largest') renderLargest();
  else drawTreemap();
  renderSelectionBar();
}
$('tab-explorer').addEventListener('click', () => switchTab('explorer'));
$('tab-largest').addEventListener('click', () => switchTab('largest'));

// ---------- Delete ----------
// items: tree nodes, or {n: fullPath, s, _lf} wrappers from the largest-files view
function confirmDelete(items) {
  const paths = items.map((it) => (it._lf ? it._lf.p : nodePath(it)));
  const total = items.reduce((a, it) => a + (it.s || 0), 0);
  const hasSystem = paths.some(isSystemPath);

  const listHtml = paths.slice(0, 50).map((p) => `<div>${escapeHtml(p)}</div>`).join('')
    + (paths.length > 50 ? `<div>… and ${paths.length - 50} more</div>` : '');

  let body = `You are about to move <b>${items.length}</b> item${items.length > 1 ? 's' : ''} (<b>${fmtBytes(total)}</b>) to the Recycle Bin.` +
    `<div class="del-list">${listHtml}</div>` +
    `You can restore them from the Recycle Bin if needed.`;
  if (hasSystem) {
    body += `<div class="warn-sys">⚠ Some of these look like <b>Windows system files</b> (Windows / Program Files / pagefile). Deleting them can break Windows or installed apps. Only continue if you are sure.</div>`;
  }

  openModal(`Move ${items.length > 1 ? items.length + ' items' : 'to Recycle Bin'}?`, body, async () => {
    closeModal();
    toast('Moving to Recycle Bin…');
    const results = await window.api.trashItems(paths);
    let freed = 0, okCount = 0, failCount = 0;
    results.forEach((r, i) => {
      if (r.ok) {
        okCount++;
        freed += items[i].s || 0;
        removeFromTree(items[i], r.path);
      } else {
        failCount++;
      }
    });
    selection.clear();
    largestSelection.clear();
    // Drop deleted entries from the largest-files list
    const deletedPaths = new Set(results.filter((r) => r.ok).map((r) => r.path));
    largestFiles = largestFiles.filter((f) => !deletedPaths.has(f.p));

    if ($('panel-largest').classList.contains('hidden')) render();
    else { renderLargest(); renderSummary(); renderSelectionBar(); }

    if (failCount === 0) toast(`✓ Freed ${fmtBytes(freed)} (${okCount} item${okCount > 1 ? 's' : ''} moved to Recycle Bin)`, 'ok');
    else if (okCount > 0) toast(`Freed ${fmtBytes(freed)}, but ${failCount} item${failCount > 1 ? 's' : ''} could not be deleted (in use or protected)`, 'err');
    else toast(`Could not delete: ${results[0].error || 'file may be in use or protected'}`, 'err');
  });
}

function removeFromTree(item, fullPath) {
  let node = item._lf ? findNodeByPath(fullPath) : item;
  if (!node || !node.p) return;
  const parent = node.p;
  const idx = parent.c.indexOf(node);
  if (idx >= 0) parent.c.splice(idx, 1);
  // Propagate size/file-count reduction up to the root
  let a = parent;
  while (a) {
    a.s -= node.s;
    if (a.f != null) a.f -= (node.d ? node.f : 1);
    a = a.p;
  }
  // If the current view was inside the deleted folder, jump to its parent
  let cur = currentNode;
  while (cur) {
    if (cur === node) { currentNode = parent; break; }
    cur = cur.p;
  }
}

function findNodeByPath(fullPath) {
  if (!tree) return null;
  const rootPath = tree.path.endsWith('\\') ? tree.path : tree.path + '\\';
  if (!fullPath.toLowerCase().startsWith(rootPath.toLowerCase())) return null;
  const parts = fullPath.slice(rootPath.length).split('\\').filter(Boolean);
  let node = tree;
  for (const part of parts) {
    if (!node.c) return null;
    const next = node.c.find((ch) => ch.n.toLowerCase() === part.toLowerCase());
    if (!next) return null;
    node = next;
  }
  return node;
}

// ---------- Modal / toast ----------
let modalAction = null;
function openModal(title, bodyHtml, onConfirm) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  modalAction = onConfirm;
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('modal-overlay').classList.add('hidden');
  modalAction = null;
}
$('modal-cancel').addEventListener('click', closeModal);
$('modal-confirm').addEventListener('click', () => { if (modalAction) modalAction(); });
$('modal-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });

let toastTimer = null;
function toast(msg, kind) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 5000);
}

// ---------- Top-level buttons ----------
$('btn-home').addEventListener('click', async () => {
  await window.api.cancelScan();
  loadDrives();
});
$('btn-rescan').addEventListener('click', () => {
  if (scanRoot) startScan(scanRoot, expectedBytes);
});
$('btn-folder').addEventListener('click', async () => {
  const folder = await window.api.chooseFolder();
  if (folder) startScan(folder, 0);
});
$('btn-cancel').addEventListener('click', async () => {
  await window.api.cancelScan();
  loadDrives();
});
$('btn-delete-sel').addEventListener('click', () => {
  const items = $('panel-explorer').classList.contains('hidden') ? largestSelectionNodes() : [...selection];
  if (items.length) confirmDelete(items);
});
$('btn-clear-sel').addEventListener('click', () => {
  selection.clear();
  largestSelection.clear();
  renderList();
  if (!$('panel-largest').classList.contains('hidden')) renderLargest();
  renderSelectionBar();
});

// ---------- Init ----------
loadDrives();

let scan = null;

const $ = (id) => document.getElementById(id);
const scanBtn = $('scanBtn');
const statusEl = $('status');
const filtersEl = $('filters');
const summaryEl = $('summary');
const listEl = $('list');
const downloadBtn = $('downloadBtn');
const selectAllBtn = $('selectAllBtn');
const copyDiagBtn = $('copyDiagBtn');

const filterIds = ['fPpt', 'fPdf', 'fWord', 'fExcel', 'fOther'];
filterIds.forEach((id) => $(id).addEventListener('change', render));

scanBtn.addEventListener('click', async () => {
  setStatus('正在读取课程结构并解析课件下载地址……课程资料较多时可能需要十几秒。');
  scanBtn.disabled = true;
  downloadBtn.disabled = true;
  selectAllBtn.disabled = true;
  copyDiagBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SCAN_ACTIVE' });
    if (!res?.ok) throw new Error(res?.error || '扫描失败');
    scan = res.result;
    setStatus(`扫描完成：${scan.courseName}`, 'ok');
    render();
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally {
    scanBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', async () => {
  if (!scan) return;
  const selected = visibleResolvedResources().filter((r) => {
    const box = document.querySelector(`input[data-key="${cssEscape(r._key)}"]`);
    return box?.checked;
  });
  if (!selected.length) {
    setStatus('没有选中可下载文件。', 'error');
    return;
  }
  downloadBtn.disabled = true;
  setStatus(`正在创建 ${selected.length} 个下载任务……`);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_RESOURCES', resources: selected });
    if (!res?.ok) throw new Error(res?.error || '下载任务创建失败');
    const fail = res.result?.failed?.length || 0;
    setStatus(`已创建 ${res.result.started} 个下载任务${fail ? `，${fail} 个失败` : ''}。文件会进入 Edge 默认下载目录下的“中国大学MOOC”文件夹。`, fail ? 'error' : 'ok');
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally {
    downloadBtn.disabled = false;
  }
});

selectAllBtn.addEventListener('click', () => {
  document.querySelectorAll('.file-check:not(:disabled)').forEach((x) => { x.checked = true; });
});

copyDiagBtn.addEventListener('click', async () => {
  if (!scan) return;
  const diag = {
    version: '0.1.0',
    courseName: scan.courseName,
    schoolCourseId: scan.schoolCourseId,
    termId: scan.termId,
    chapterCount: scan.chapterCount,
    candidateCount: scan.candidateCount,
    resolvedCount: scan.resources?.length || 0,
    unresolvedCount: scan.unresolved?.length || 0,
    diagnostics: scan.diagnostics,
    unresolved: scan.unresolved
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
    setStatus('诊断信息已经复制。测试失败时把这段内容发给我即可。', 'ok');
  } catch (e) {
    setStatus('复制失败：' + (e?.message || String(e)), 'error');
  }
});

async function loadLast() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LAST_SCAN' });
    if (res?.ok && res.result) {
      scan = res.result;
      setStatus(`已载入上次扫描：${scan.courseName}。你也可以重新扫描当前课程。`, 'ok');
      render();
    }
  } catch (_) {}
}

function render() {
  if (!scan) return;
  filtersEl.classList.remove('hidden');
  summaryEl.classList.remove('hidden');
  selectAllBtn.disabled = false;
  copyDiagBtn.disabled = false;

  const resolved = (scan.resources || []).map((r, i) => ({ ...r, _key: `${i}-${hash(r.url || r.unitName || '')}` }));
  scan.resources = resolved;
  const visible = visibleResolvedResources();
  const unresolved = scan.unresolved || [];

  summaryEl.innerHTML = [
    `<b>${escapeHtml(scan.courseName || '未命名课程')}</b>`,
    `章节：${scan.chapterCount ?? '-'}；识别文档/附件单元：${scan.candidateCount ?? 0}`,
    `已解析下载链接：${resolved.length}；未解析：${unresolved.length}`,
    `<span class="badge">termId ${escapeHtml(scan.termId || '')}</span>`
  ].join('<br>');

  const groups = new Map();
  for (const r of visible) {
    const key = `${r.chapterIndex}|${r.chapterName}|${r.lessonIndex}|${r.lessonName}`;
    if (!groups.has(key)) groups.set(key, { title: `${r.chapterName || ''} / ${r.lessonName || ''}`, items: [] });
    groups.get(key).items.push(r);
  }

  listEl.innerHTML = '';
  for (const g of groups.values()) {
    const box = document.createElement('section');
    box.className = 'group';
    box.innerHTML = `<div class="group-title">${escapeHtml(g.title)}</div>`;
    for (const r of g.items) box.appendChild(fileRow(r, true));
    listEl.appendChild(box);
  }

  if (unresolved.length) {
    const box = document.createElement('section');
    box.className = 'group unresolved';
    box.innerHTML = `<div class="group-title">未解析到下载链接（${unresolved.length}）</div>`;
    unresolved.slice(0, 100).forEach((r) => box.appendChild(fileRow(r, false)));
    listEl.appendChild(box);
  }

  if (!visible.length && !unresolved.length) {
    listEl.innerHTML = '<section class="status">没有识别到文档型课程资源。可以先点“复制诊断”把结果发给我继续适配。</section>';
  }

  downloadBtn.disabled = visible.length === 0;
}

function fileRow(r, downloadable) {
  const row = document.createElement('div');
  row.className = 'item' + (downloadable ? '' : ' unresolved');
  const check = downloadable
    ? `<input class="file-check" type="checkbox" checked data-key="${escapeAttr(r._key)}">`
    : '<input type="checkbox" disabled>';
  const type = downloadable ? classify(r.fileName || r.url || '') : '待适配';
  row.innerHTML = `
    <div>${check}</div>
    <div>
      <div class="item-name">${escapeHtml(r.fileName || r.unitName || '未命名资料')}</div>
      <div class="item-meta">${escapeHtml(r.unitName || '')}${r.source ? ` · ${escapeHtml(r.source)}` : ''}</div>
    </div>
    <span class="badge">${escapeHtml(type)}</span>`;
  return row;
}

function visibleResolvedResources() {
  if (!scan) return [];
  return (scan.resources || []).filter((r) => passesFilter(r.fileName || r.url || ''));
}

function passesFilter(name) {
  const n = String(name).toLowerCase();
  if (/\.pptx?(?:$|[?#])/.test(n)) return $('fPpt').checked;
  if (/\.pdf(?:$|[?#])/.test(n)) return $('fPdf').checked;
  if (/\.docx?(?:$|[?#])/.test(n)) return $('fWord').checked;
  if (/\.xlsx?(?:$|[?#])|\.csv(?:$|[?#])/.test(n)) return $('fExcel').checked;
  return $('fOther').checked;
}

function classify(name) {
  const n = String(name).toLowerCase();
  if (/\.pptx?(?:$|[?#])/.test(n)) return 'PPT';
  if (/\.pdf(?:$|[?#])/.test(n)) return 'PDF';
  if (/\.docx?(?:$|[?#])/.test(n)) return 'Word';
  if (/\.xlsx?(?:$|[?#])|\.csv(?:$|[?#])/.test(n)) return 'Excel';
  if (/\.(zip|rar|7z)(?:$|[?#])/.test(n)) return '压缩包';
  return '附件';
}

function setStatus(text, mode = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (mode ? ` ${mode}` : '');
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}
function escapeAttr(v) { return escapeHtml(v).replace(/'/g, '&#39;'); }
function cssEscape(v) { return String(v).replace(/["\\]/g, '\\$&'); }
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

loadLast();

let scan = null;
let selectedKeys = new Set();

const $ = (id) => document.getElementById(id);
const scanBtn = $('scanBtn');
const statusEl = $('status');
const filtersEl = $('filters');
const downloadOptionsEl = $('downloadOptions');
const summaryEl = $('summary');
const listEl = $('list');
const downloadBtn = $('downloadBtn');
const selectAllBtn = $('selectAllBtn');
const selectNewBtn = $('selectNewBtn');
const markKnownBtn = $('markKnownBtn');
const copyDiagBtn = $('copyDiagBtn');

const filterIds = ['fPpt', 'fPdf', 'fWord', 'fExcel', 'fOther', 'onlyNew'];
filterIds.forEach((id) => $(id).addEventListener('change', render));
document.querySelectorAll('input[name="downloadMode"]').forEach((x) => x.addEventListener('change', syncButtons));

listEl.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('file-check')) return;
  const key = target.dataset.key || '';
  if (!key) return;
  if (target.checked) selectedKeys.add(key);
  else selectedKeys.delete(key);
  syncButtons();
});

scanBtn.addEventListener('click', async () => {
  setStatus('正在读取课程结构并解析课件下载地址……课程资料较多时可能需要十几秒。');
  setBusy(true);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SCAN_ACTIVE' });
    if (!res?.ok) throw new Error(res?.error || '扫描失败');
    scan = res.result;
    initializeSelection();
    setStatus(`扫描完成：${scan.courseName}`, 'ok');
    render();
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally {
    setBusy(false);
    syncButtons();
  }
});

downloadBtn.addEventListener('click', async () => {
  if (!scan) return;
  const selected = selectedResources();
  if (!selected.length) {
    setStatus('没有选中可下载文件。', 'error');
    return;
  }

  const mode = currentDownloadMode();
  if (mode === 'zip') {
    // 权限请求必须直接由用户点击触发，所以放在任何网络请求之前。
    let permissionOk = false;
    try {
      permissionOk = await ensureZipPermissions(selected);
    } catch (e) {
      setStatus('ZIP 下载权限申请失败：' + (e?.message || String(e)), 'error');
      return;
    }
    if (!permissionOk) {
      setStatus('未获得课件文件所在域名的读取权限，已取消 ZIP 打包。你仍可以使用“分别下载”。', 'error');
      return;
    }
  }

  setBusy(true);
  try {
    if (mode === 'zip') {
      await downloadAsZip(selected);
    } else {
      await downloadAsFiles(selected);
    }
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally {
    setBusy(false);
    syncButtons();
  }
});

selectAllBtn.addEventListener('click', () => {
  for (const r of visibleResolvedResources()) selectedKeys.add(resourceKeyOf(r));
  render();
});

selectNewBtn.addEventListener('click', () => {
  selectedKeys.clear();
  for (const r of (scan?.resources || [])) {
    if (r.isNew && passesTypeFilter(r.fileName || r.url || '')) selectedKeys.add(resourceKeyOf(r));
  }
  render();
});

markKnownBtn.addEventListener('click', async () => {
  if (!scan?.resources?.length) return;
  const ok = confirm('将当前课程已经扫描到的全部资料标记为“已有”？\n\n以后只有新出现的资料会显示“新增”。这个操作不会删除任何文件。');
  if (!ok) return;
  setBusy(true);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'MARK_RESOURCES_KNOWN', resources: scan.resources });
    if (!res?.ok) throw new Error(res?.error || '标记失败');
    await reloadLastScan();
    selectedKeys.clear();
    setStatus('当前课程资料已设为基线。以后新增加的课件会单独标记为“新增”。', 'ok');
    render();
  } catch (e) {
    setStatus(e?.message || String(e), 'error');
  } finally {
    setBusy(false);
    syncButtons();
  }
});

copyDiagBtn.addEventListener('click', async () => {
  if (!scan) return;
  const newCount = (scan.resources || []).filter((r) => r.isNew).length;
  const diag = {
    version: '1.1.0',
    courseName: scan.courseName,
    schoolCourseId: scan.schoolCourseId,
    termId: scan.termId,
    chapterCount: scan.chapterCount,
    candidateCount: scan.candidateCount,
    resolvedCount: scan.resources?.length || 0,
    newCount,
    duplicateRemovedCount: scan.duplicateRemovedCount || 0,
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
      initializeSelection();
      setStatus(`已载入上次扫描：${scan.courseName}。你也可以重新扫描当前课程。`, 'ok');
      render();
    }
  } catch (_) {}
}

async function reloadLastScan() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_LAST_SCAN' });
  if (res?.ok && res.result) scan = res.result;
}

function initializeSelection() {
  selectedKeys = new Set();
  for (const r of (scan?.resources || [])) {
    if (r.isNew && !r.downloadedBefore) selectedKeys.add(resourceKeyOf(r));
  }
}

function render() {
  if (!scan) return;
  filtersEl.classList.remove('hidden');
  downloadOptionsEl.classList.remove('hidden');
  summaryEl.classList.remove('hidden');
  selectAllBtn.disabled = false;
  selectNewBtn.disabled = false;
  markKnownBtn.disabled = false;
  copyDiagBtn.disabled = false;

  const resources = (scan.resources || []).map((r, i) => ({
    ...r,
    _key: resourceKeyOf(r) || `${i}-${hash(r.url || r.unitName || '')}`
  }));
  scan.resources = resources;

  const visible = visibleResolvedResources();
  const unresolved = scan.unresolved || [];
  const newCount = resources.filter((r) => r.isNew).length;
  const downloadedCount = resources.filter((r) => r.downloadedBefore).length;
  const existingCount = Math.max(0, resources.length - newCount);

  summaryEl.innerHTML = [
    `<b>${escapeHtml(scan.courseName || '未命名课程')}</b>`,
    `章节：${scan.chapterCount ?? '-'}；识别文档/附件单元：${scan.candidateCount ?? 0}`,
    `已解析：${resources.length}；<b>新增：${newCount}</b>；已有：${existingCount}；曾下载：${downloadedCount}；未解析：${unresolved.length}`,
    scan.duplicateRemovedCount ? `本次已自动去重：${scan.duplicateRemovedCount} 项` : '本次未发现重复资源',
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

  if (unresolved.length && !$('onlyNew').checked) {
    const box = document.createElement('section');
    box.className = 'group unresolved';
    box.innerHTML = `<div class="group-title">未解析到下载链接（${unresolved.length}）</div>`;
    unresolved.slice(0, 100).forEach((r) => box.appendChild(fileRow(r, false)));
    listEl.appendChild(box);
  }

  if (!visible.length && (!$('onlyNew').checked ? !unresolved.length : true)) {
    listEl.innerHTML = '<section class="empty-note">当前筛选条件下没有可显示的资料。若“新增”为 0，说明这次扫描没有发现新课件。</section>';
  }

  syncButtons();
}

function fileRow(r, downloadable) {
  const row = document.createElement('div');
  row.className = 'item' + (downloadable ? '' : ' unresolved');

  const key = r._key || resourceKeyOf(r);
  const checked = downloadable && selectedKeys.has(key) ? ' checked' : '';
  const check = downloadable
    ? `<input class="file-check" type="checkbox"${checked} data-key="${escapeAttr(key)}">`
    : '<input type="checkbox" disabled>';

  const type = downloadable ? classify(r.fileName || r.url || '') : '待适配';
  let stateBadge = '<span class="badge badge-old">已有</span>';
  if (r.downloadedBefore) stateBadge = '<span class="badge badge-downloaded">已下载</span>';
  if (r.isNew) stateBadge = '<span class="badge badge-new">新增</span>';

  row.innerHTML = `
    <div>${check}</div>
    <div>
      <div class="item-name">${escapeHtml(r.fileName || r.unitName || '未命名资料')}</div>
      <div class="item-meta">${escapeHtml(r.unitName || '')}${r.source ? ` · ${escapeHtml(r.source)}` : ''}</div>
    </div>
    <div class="badges">
      ${stateBadge}
      <span class="badge">${escapeHtml(type)}</span>
    </div>`;
  return row;
}

function visibleResolvedResources() {
  if (!scan) return [];
  return (scan.resources || []).filter((r) => {
    if (!passesTypeFilter(r.fileName || r.url || '')) return false;
    if ($('onlyNew').checked && !r.isNew) return false;
    return true;
  });
}

function selectedResources() {
  if (!scan) return [];
  return (scan.resources || []).filter((r) => selectedKeys.has(resourceKeyOf(r)));
}

function passesTypeFilter(name) {
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

function currentDownloadMode() {
  return document.querySelector('input[name="downloadMode"]:checked')?.value || 'files';
}

function syncButtons() {
  const count = selectedResources().length;
  const mode = currentDownloadMode();
  downloadBtn.textContent = mode === 'zip' ? `打包 ZIP（${count}）` : `下载选中（${count}）`;
  downloadBtn.disabled = !scan || count === 0;
}

function setBusy(busy) {
  scanBtn.disabled = busy;
  selectAllBtn.disabled = busy || !scan;
  selectNewBtn.disabled = busy || !scan;
  markKnownBtn.disabled = busy || !scan;
  copyDiagBtn.disabled = busy || !scan;
  downloadBtn.disabled = busy || !scan || selectedResources().length === 0;
}

async function downloadAsFiles(resources) {
  setStatus(`正在创建 ${resources.length} 个下载任务……`);
  const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_RESOURCES', resources });
  if (!res?.ok) throw new Error(res?.error || '下载任务创建失败');

  await reloadLastScan();
  for (const r of resources) selectedKeys.delete(resourceKeyOf(r));
  const fail = res.result?.failed?.length || 0;
  setStatus(
    `已创建 ${res.result.started} 个下载任务${fail ? `，${fail} 个失败` : ''}。文件会进入 Edge 默认下载目录下的“中国大学MOOC”文件夹。`,
    fail ? 'error' : 'ok'
  );
  render();
}

async function ensureZipPermissions(resources) {
  const patterns = [];
  for (const r of resources) {
    try {
      const u = new URL(r.url);
      if (!/^https?:$/.test(u.protocol)) continue;
      const p = `${u.protocol}//${u.host}/*`;
      if (!patterns.includes(p)) patterns.push(p);
    } catch (_) {}
  }

  const missing = [];
  for (const p of patterns) {
    const has = await chrome.permissions.contains({ origins: [p] });
    if (!has) missing.push(p);
  }
  if (!missing.length) return true;
  return chrome.permissions.request({ origins: missing });
}

async function downloadAsZip(resources) {
  const entries = [];
  const succeeded = [];
  const failed = [];
  const usedPaths = new Set();

  for (let i = 0; i < resources.length; i++) {
    const r = resources[i];
    setStatus(`正在读取课件并打包 ZIP：${i + 1}/${resources.length}\n${r.fileName || r.unitName || ''}`);
    try {
      const data = await fetchResourceBytes(r.url);
      const path = uniqueArchivePath(buildArchiveEntryPath(r), usedPaths);
      entries.push({ path, data });
      succeeded.push(r);
    } catch (e) {
      failed.push({ name: r.fileName || r.unitName || '未知文件', error: e?.message || String(e) });
    }
  }

  if (!entries.length) {
    throw new Error('没有任何文件成功读取，ZIP 未生成。可以切换到“分别下载”重试。');
  }

  setStatus(`正在生成 ZIP（${entries.length} 个文件）……`);
  const blob = createStoredZip(entries);
  const blobUrl = URL.createObjectURL(blob);
  const allNew = succeeded.every((r) => r.isNew);
  const zipName = buildZipFileName(scan?.courseName || '课程资料', allNew);

  try {
    await chrome.downloads.download({
      url: blobUrl,
      filename: zipName,
      conflictAction: 'uniquify',
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }

  const mark = await chrome.runtime.sendMessage({ type: 'MARK_RESOURCES_DOWNLOADED', resources: succeeded });
  if (!mark?.ok) console.warn('下载记录写入失败：', mark?.error || 'unknown');

  await reloadLastScan();
  for (const r of succeeded) selectedKeys.delete(resourceKeyOf(r));

  if (failed.length) {
    setStatus(`ZIP 已开始下载：成功打包 ${succeeded.length} 个文件，${failed.length} 个文件读取失败。失败项仍可切换到“分别下载”单独下载。`, 'error');
  } else {
    setStatus(`ZIP 已开始下载：共 ${succeeded.length} 个文件，目录结构已保留。`, 'ok');
  }
  render();
}

async function fetchResourceBytes(url) {
  let response;
  try {
    response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  } catch (_) {
    response = await fetch(url, { cache: 'no-store' });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function buildArchiveEntryPath(r) {
  const course = cleanPathPart(r.courseName || scan?.courseName || '未命名课程');
  const chapterNo = String((r.chapterIndex ?? 0) + 1).padStart(2, '0');
  const lessonNo = String((r.lessonIndex ?? 0) + 1).padStart(2, '0');
  const chapter = cleanPathPart(r.chapterName || `第${chapterNo}章`);
  const lesson = cleanPathPart(r.lessonName || `第${lessonNo}节`);
  const file = cleanPathPart(r.fileName || r.unitName || '课程资料');
  return `${course}/${chapterNo}_${chapter}/${chapterNo}.${lessonNo}_${lesson}/${file}`;
}

function uniqueArchivePath(path, used) {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (used.has(`${dir}${base} (${n})${ext}`)) n++;
  const next = `${dir}${base} (${n})${ext}`;
  used.add(next);
  return next;
}

function buildZipFileName(courseName, allNew) {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '_',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0')
  ].join('');
  const label = allNew ? '新增资料' : '课程资料';
  return `中国大学MOOC/${cleanPathPart(courseName)}_${label}_${stamp}.zip`;
}

function cleanPathPart(v) {
  const s = String(v || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  return (s || '未命名').slice(0, 120);
}

function createStoredZip(entries) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dos = toDosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true);
    ldv.setUint16(8, 0, true);
    ldv.setUint16(10, dos.time, true);
    ldv.setUint16(12, dos.date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.byteLength, true);
    ldv.setUint32(22, data.byteLength, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    local.set(nameBytes, 30);

    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, dos.time, true);
    cdv.setUint16(14, dos.date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.byteLength, true);
    cdv.setUint32(24, data.byteLength, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.byteLength + data.byteLength;
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.byteLength, 0);
  const end = new Uint8Array(22);
  const edv = new DataView(end.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, offset, true);
  edv.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((Math.floor(date.getSeconds() / 2)) & 31),
    date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function resourceKeyOf(r) {
  return String(r?.resourceKey || [
    r?.schoolCourseId || r?.courseName || '',
    r?.termId || '',
    r?.unitId || '',
    r?.contentId || '',
    r?.modifiedAt || '',
    r?.fileName || r?.unitName || ''
  ].join('|'));
}

function setStatus(text, mode = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (mode ? ` ${mode}` : '');
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}
function escapeAttr(v) { return escapeHtml(v).replace(/'/g, '&#39;'); }
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

loadLast();

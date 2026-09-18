const STORE_KEY = 'lastScan';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'SCAN_ACTIVE') {
    scanActiveTab()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'GET_LAST_SCAN') {
    chrome.storage.local.get(STORE_KEY)
      .then((obj) => sendResponse({ ok: true, result: obj[STORE_KEY] || null }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  if (msg.type === 'DOWNLOAD_RESOURCES') {
    downloadResources(Array.isArray(msg.resources) ? msg.resources : [])
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }

  return false;
});

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error('没有找到当前标签页。');
  if (!/^https:\/\/www\.icourse163\.org\/(?:spoc\/)?learn\//i.test(tab.url)) {
    throw new Error('请先打开中国大学MOOC的一门课程学习页（网址包含 /learn/）。');
  }

  const cookie = await chrome.cookies.get({
    url: 'https://www.icourse163.org/',
    name: 'NTESSTUDYSI'
  });
  if (!cookie?.value) {
    throw new Error('没有读取到登录会话。请确认已经登录中国大学MOOC，然后刷新课程页面再试。');
  }

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: pageScan,
    args: [cookie.value]
  });

  const result = injected?.[0]?.result;
  if (!result) throw new Error('课程页面没有返回扫描结果。');
  if (!result.ok) throw new Error(result.error || '扫描失败。');

  const normalized = {
    ...result,
    scannedAt: new Date().toISOString(),
    pageUrl: tab.url
  };
  await chrome.storage.local.set({ [STORE_KEY]: normalized });
  return normalized;
}

async function downloadResources(resources) {
  let started = 0;
  const failed = [];

  for (const r of resources) {
    if (!r?.url) continue;
    try {
      const filename = buildDownloadPath(r);
      await chrome.downloads.download({
        url: r.url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false
      });
      started++;
      // 轻微错开下载，避免一次性创建大量任务。
      await sleep(80);
    } catch (e) {
      failed.push({ name: r.fileName || r.unitName || '未知文件', error: e?.message || String(e) });
    }
  }

  return { started, failed };
}

function buildDownloadPath(r) {
  const course = cleanPart(r.courseName || '未命名课程');
  const chapterNo = String((r.chapterIndex ?? 0) + 1).padStart(2, '0');
  const lessonNo = String((r.lessonIndex ?? 0) + 1).padStart(2, '0');
  const chapter = cleanPart(r.chapterName || `第${chapterNo}章`);
  const lesson = cleanPart(r.lessonName || `第${lessonNo}节`);
  const file = cleanPart(r.fileName || r.unitName || `资料_${Date.now()}`);
  return `中国大学MOOC/${course}/${chapterNo}_${chapter}/${chapterNo}.${lessonNo}_${lesson}/${file}`;
}

function cleanPart(v) {
  const s = String(v || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  return (s || '未命名').slice(0, 120);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 注意：这个函数会被序列化后注入中国大学MOOC页面 MAIN world。
// 因此它必须完全自包含，不能引用外部变量。
async function pageScan(csrf) {
  try {
    const currentUrl = new URL(location.href);
    const path = currentUrl.pathname.split('/').filter(Boolean);
    const learnIndex = path.indexOf('learn');
    const schoolCourseId = learnIndex >= 0 ? (path[learnIndex + 1] || '') : '';
    const urlTermId = currentUrl.searchParams.get('tid') || '';
    const windowTermId = String(
      window.moocTermDto?.id || window.termDto?.id || window.termDto?.termId || ''
    );
    const termId = windowTermId || urlTermId;

    if (!termId) {
      return { ok: false, error: '没有识别到课程 termId。' };
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function xhrPost(url, contentType, body) {
      return new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.withCredentials = true;
        if (contentType) x.setRequestHeader('Content-Type', contentType);
        try { x.setRequestHeader('edu-script-token', csrf); } catch (_) {}
        x.onload = () => {
          if (x.status >= 200 && x.status < 400) resolve(x.responseText || '');
          else reject(new Error(`HTTP ${x.status}`));
        };
        x.onerror = () => reject(new Error('网络请求失败'));
        x.timeout = 20000;
        x.ontimeout = () => reject(new Error('网络请求超时'));
        x.send(body);
      });
    }

    function tryJson(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) {}
      const i = text.search(/[\[{]/);
      if (i > 0) {
        try { return JSON.parse(text.slice(i)); } catch (_) {}
      }
      return null;
    }

    async function fetchTermDto() {
      const key = encodeURIComponent(csrf || '');
      const tid = String(termId);
      const tries = [
        async () => xhrPost(
          `https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=${key}`,
          'application/json;charset=UTF-8',
          JSON.stringify({ termId: Number(tid) })
        ),
        async () => xhrPost(
          `https://www.icourse163.org/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=${key}`,
          'application/x-www-form-urlencoded;charset=UTF-8',
          `termId=${encodeURIComponent(tid)}`
        ),
        async () => xhrPost(
          `https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=${key}`,
          'application/x-www-form-urlencoded;charset=UTF-8',
          `termId=${encodeURIComponent(tid)}&gatewayType=3`
        ),
        async () => xhrPost(
          `https://www.icourse163.org/web/j/courseBean.getMocTermDto.rpc?csrfKey=${key}`,
          'application/x-www-form-urlencoded;charset=UTF-8',
          `termId=${encodeURIComponent(tid)}`
        )
      ];

      let lastError = '';
      for (const call of tries) {
        try {
          const text = await call();
          const data = tryJson(text);
          if (data && !String(data.code ?? '').startsWith('-')) {
            const dto = data?.result?.mocTermDto || data?.result?.term || data?.result || data?.mocTermDto;
            if (dto && (Array.isArray(dto.chapters) || dto.courseName || dto.id)) {
              return { data, dto, rawLength: text.length };
            }
          }
        } catch (e) {
          lastError = e?.message || String(e);
        }
        await sleep(180);
      }
      throw new Error(`课程结构接口失败${lastError ? `：${lastError}` : ''}`);
    }

    function decodeJsString(raw) {
      if (raw == null) return '';
      return String(raw)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');
    }

    function extractField(text, name) {
      const patterns = [
        new RegExp(`${name}\\s*[:=]\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'),
        new RegExp(`${name}\\s*[:=]\\s*'((?:\\\\.|[^'\\\\])*)'`, 'i')
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m) return decodeJsString(m[1]);
      }
      return '';
    }

    function firstDownloadableUrl(obj) {
      const allowed = /\.(?:pdf|pptx?|docx?|xlsx?|csv|txt|zip|rar|7z)(?:$|[?#])/i;
      let found = '';
      const seen = new Set();
      function walk(v, depth) {
        if (found || depth > 5 || v == null) return;
        if (typeof v === 'string') {
          if (/^https?:\/\//i.test(v) && (allowed.test(v) || /[?&]download=/i.test(v))) found = v;
          return;
        }
        if (typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (Array.isArray(v)) {
          for (const x of v) walk(x, depth + 1);
        } else {
          for (const k of Object.keys(v)) {
            const x = v[k];
            if (typeof x === 'string' && /^https?:\/\//i.test(x) && /url|download|file|resource|orig/i.test(k)) {
              if (allowed.test(x) || /[?&]download=/i.test(x)) {
                found = x;
                return;
              }
            }
            walk(x, depth + 1);
          }
        }
      }
      walk(obj, 0);
      return found;
    }

    function guessFileName(url, fallback) {
      const safeFallback = String(fallback || '课程资料').trim() || '课程资料';
      try {
        const u = new URL(url, location.href);
        const q = u.searchParams.get('download') || u.searchParams.get('filename') || u.searchParams.get('fileName');
        if (q) return decodeURIComponent(q);
        const part = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
        if (/\.[a-z0-9]{2,6}$/i.test(part)) return part;
      } catch (_) {}
      const ext = String(url).match(/\.(pdf|pptx?|docx?|xlsx?|csv|txt|zip|rar|7z)(?:$|[?#])/i)?.[1];
      return ext ? `${safeFallback}.${ext}` : safeFallback;
    }

    async function fetchDocumentUrl(unit) {
      const contentId = unit?.contentId;
      const unitId = unit?.id || unit?.unitId;
      if (!contentId || !unitId) return { url: firstDownloadableUrl(unit), source: 'dto' };

      async function one(typeNo) {
        const params = new URLSearchParams();
        params.set('callCount', '1');
        params.set('scriptSessionId', '${scriptSessionId}190');
        params.set('httpSessionId', csrf || '');
        params.set('c0-scriptName', 'CourseBean');
        params.set('c0-methodName', 'getLessonUnitLearnVo');
        params.set('c0-id', '0');
        params.set('c0-param0', `number:${contentId}`);
        params.set('c0-param1', `number:${typeNo}`);
        params.set('c0-param2', 'number:0');
        params.set('c0-param3', `number:${unitId}`);
        params.set('batchId', String(Date.now()));

        const text = await xhrPost(
          'https://www.icourse163.org/dwr/call/plaincall/CourseBean.getLessonUnitLearnVo.dwr',
          'application/x-www-form-urlencoded;charset=UTF-8',
          params.toString()
        );

        const original = extractField(text, 'textOrigUrl');
        const converted = extractField(text, 'textUrl');
        const url = original || converted;
        return { url, source: original ? 'textOrigUrl' : (converted ? 'textUrl' : 'dwr-none'), dwrLength: text.length };
      }

      try {
        const actualType = Number(unit.contentType) || 3;
        let r = await one(actualType);
        if (!r.url && actualType !== 3) r = await one(3);
        if (r.url) return r;
      } catch (_) {}

      return { url: firstDownloadableUrl(unit), source: 'dto' };
    }

    function collectDomFiles() {
      const allowed = /\.(?:pdf|pptx?|docx?|xlsx?|csv|txt|zip|rar|7z)(?:$|[?#])/i;
      const arr = [];
      const seen = new Set();
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.href || '';
        if (!/^https?:\/\//i.test(href) || !allowed.test(href) || seen.has(href)) return;
        seen.add(href);
        arr.push({
          url: href,
          fileName: guessFileName(href, (a.textContent || '').trim() || '页面附件'),
          unitName: (a.textContent || '').trim() || '页面附件',
          chapterName: '页面直接附件',
          lessonName: '当前页面',
          chapterIndex: 999,
          lessonIndex: 0,
          contentType: 4,
          source: 'dom'
        });
      });
      return arr;
    }

    const term = await fetchTermDto();
    const dto = term.dto || {};
    const chapters = Array.isArray(dto.chapters) ? dto.chapters : [];
    const courseName = String(
      dto.courseName || window.courseDto?.name || window.termDto?.courseName ||
      document.querySelector('.course-title, .course-name, .m-coursename, h1')?.textContent ||
      document.title.replace(/[_-]?\s*中国大学MOOC.*$/i, '') || schoolCourseId || '未命名课程'
    ).trim();

    const candidates = [];
    chapters.forEach((chapter, ci) => {
      const lessons = Array.isArray(chapter?.lessons) ? chapter.lessons : [];
      lessons.forEach((lesson, li) => {
        const units = Array.isArray(lesson?.units) ? lesson.units : [];
        units.forEach((unit, ui) => {
          const type = Number(unit?.contentType);
          // 旧版/现行公开实现：1视频，2测验，3文档，4附件。
          if (type === 3 || type === 4) {
            candidates.push({
              unit,
              chapterIndex: ci,
              lessonIndex: li,
              unitIndex: ui,
              chapterName: chapter?.name || `第${ci + 1}章`,
              lessonName: lesson?.name || `第${li + 1}节`
            });
          }
        });
      });
    });

    const resources = [];
    const unresolved = [];
    let cursor = 0;
    const workerCount = Math.min(4, Math.max(1, candidates.length));

    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= candidates.length) return;
        const c = candidates[i];
        const unit = c.unit;
        let detail = { url: firstDownloadableUrl(unit), source: 'dto' };
        if (!detail.url) detail = await fetchDocumentUrl(unit);
        const base = {
          courseName,
          schoolCourseId,
          termId: String(termId),
          chapterIndex: c.chapterIndex,
          lessonIndex: c.lessonIndex,
          unitIndex: c.unitIndex,
          chapterName: c.chapterName,
          lessonName: c.lessonName,
          unitName: unit?.name || `资料${i + 1}`,
          contentType: Number(unit?.contentType) || 0,
          contentId: unit?.contentId || null,
          unitId: unit?.id || unit?.unitId || null,
          source: detail.source || 'unknown'
        };
        if (detail.url) {
          resources.push({ ...base, url: detail.url, fileName: guessFileName(detail.url, base.unitName) });
        } else {
          unresolved.push(base);
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // 当前路由可见链接作为兜底；按 URL 去重。
    resources.push(...collectDomFiles().map((r) => ({ ...r, courseName, schoolCourseId, termId: String(termId) })));
    const dedup = [];
    const seenUrl = new Set();
    for (const r of resources) {
      if (!r.url || seenUrl.has(r.url)) continue;
      seenUrl.add(r.url);
      dedup.push(r);
    }

    dedup.sort((a, b) =>
      (a.chapterIndex - b.chapterIndex) ||
      (a.lessonIndex - b.lessonIndex) ||
      (a.unitIndex - b.unitIndex)
    );

    return {
      ok: true,
      courseName,
      schoolCourseId,
      termId: String(termId),
      apiRawLength: term.rawLength || 0,
      chapterCount: chapters.length,
      candidateCount: candidates.length,
      resources: dedup,
      unresolved,
      diagnostics: {
        href: location.href,
        dtoKeys: Object.keys(dto).slice(0, 40),
        firstChapterKeys: chapters[0] ? Object.keys(chapters[0]).slice(0, 40) : [],
        candidateTypes: candidates.reduce((acc, c) => {
          const k = String(c.unit?.contentType ?? 'unknown');
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {})
      }
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), stack: e?.stack || '' };
  }
}

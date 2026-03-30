// ==UserScript==
// @name         Zentao Bug + Testcase Capture
// @name:zh-CN   禅道 Bug/用例采集推送面板
// @namespace    https://github.com/chenwenbo/zentao-capture
// @version      6.2.2
// @description  Capture bug/testcase creation events in ZenTao QA pages, match entity IDs from list pages, and push records to a custom backend. Features a draggable floating button and filterable record panel.
// @description:zh-CN  在禅道 QA 页面采集 Bug/用例创建信息，识别编号与创建者，推送到自定义后端服务，提供可拖动悬浮按钮与记录面板。
// @author       chenwenbo
// @license      MIT
// @match        *://*/zentao/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @homepageURL  https://github.com/CC-coder-GSG/zentao-capture-for-Omni-QA-test-management-system
// @supportURL   https://github.com/CC-coder-GSG/zentao-capture-for-Omni-QA-test-management-system/issues
// @updateURL    https://raw.githubusercontent.com/CC-coder-GSG/zentao-capture-for-Omni-QA-test-management-system/main/zentao-capture.user.js
// @downloadURL  https://raw.githubusercontent.com/CC-coder-GSG/zentao-capture-for-Omni-QA-test-management-system/main/zentao-capture.user.js
// ==/UserScript==

/*
 * 脚本说明
 * - 用途：在禅道 QA 页面中采集 Bug/用例创建信息，创建后在列表页识别实体 ID 和创建者，并推送到后端。
 * - 支持页面：Bug 创建页、Bug 列表页、用例创建页、用例列表页（均位于 #appIframe-qa 内）。
 * - 主要能力：创建页采集、列表识别、本地记录持久化、自动/手动重试、悬浮按钮与面板、筛选、toast、识别弹窗开关。
 * - 主要数据流：创建页缓存 Draft -> 列表页补齐 result/creator -> 生成 Record -> 推送服务 -> 面板显示状态。
 * - 常改配置：CONFIG.API_BASE_URL、CONFIG.SYNC_ENDPOINT、CONFIG.SYNC_API_KEY、CONFIG.RETRY_INTERVAL_MS。
 */

(function () {
  'use strict';

  /******************** 配置区 ********************/
  const CONFIG = {
    DEBUG: false,
    SCRIPT_VERSION: '6.1.2-debug1',
    API_BASE_URL: 'http://192.168.2.229:8000',
    SYNC_ENDPOINT: '/api/zentao/browser-sync',
    // 请替换为你的真实后端同步密钥（X-Zentao-Sync-Key）
    SYNC_API_KEY: 'that is a secret key, do not leak it',
    AUTO_PUSH: true,
    DEFAULT_USE_ALERT_ON_CAPTURE: true,
    MAX_RECORDS: 200,
    RETRY_INTERVAL_MS: 15000,
    REQUEST_TIMEOUT_MS: 10000,
    ENABLE_DEBUGGER_ON_PUSH: false,
    MAX_RETRY: 3,
    CACHE_RECENT_MS: 5 * 60 * 1000,
    TICK_INTERVAL_MS: 1000,
    FAB_HIDE_GRACE_MS: 4000,
    FAB_HIDE_MISS_COUNT: 3,
    LIST_SCAN_DEBOUNCE_MS: 1200,
    DUPLICATE_MATCH_GUARD_MS: 4000,
    STORAGE_KEYS: {
      bugCache: 'zentao_bug_capture_cache_v54',
      testcaseCache: 'zentao_testcase_capture_cache_v54',
      records: 'zentao_capture_records_v54',
      fabPos: 'zentao_capture_fab_pos_v54',
      panelFilters: 'zentao_capture_panel_filters_v54',
      settings: 'zentao_capture_settings_v54',
      panelOpen: 'zentao_capture_panel_open_v54'
    },
    SELECTORS: {
      qaIframe: '#appIframe-qa',
      bugTitle: 'input[name="title"], #zin_bug_create_colorInput_2',
      bugProductHiddenInput: 'input[name="product"]',
      bugProjectHiddenInput: 'input[name="project"]',
      bugExecutionHiddenInput: 'input[name="execution"]',
      bugStoryHiddenInput: 'input[name="story"]',
      bugOpenedBuildSelect: 'select[name="openedBuild[]"]',
      caseTitle: 'input[name="title"], #zin_testcase_create_colorInput',
      caseProductHiddenInput: 'input[name="product"]',
      caseStoryHiddenInput: 'input[name="story"]'
    },
    UI: {
      Z_INDEX: 999999,
      FAB_SIZE: 58,
      FAB_RIGHT: 20,
      FAB_BOTTOM: 20,
      PANEL_WIDTH: 500,
      PANEL_MAX_HEIGHT_VH: 76,
      PANEL_GAP_FROM_FAB: 12,
      VIEWPORT_PADDING: 10,
      TOAST_RIGHT: 20,
      TOAST_BOTTOM: 90,
      TOAST_MAX_WIDTH: 420
    }
  };

  /*
   * 数据模型
   * BugDraft: productId, productName, projectId, projectName, openedBuildIds, affectedVersion, bugTitle,
   *          executionId, executionName, requirementId, requirementName, creatorName(列表页补充)
   * TestcaseDraft: productId, productName, caseTitle, requirementId, requirementName, creatorName(列表页补充)
   * Record: uniqueKey, clientRecordId, entityType, action, source, capturedAt, topHref, draft, result,
   *         pushStatus, pushMessage, lastPushAt, retryCount
   */

  /******************** 日志与工具函数区 ********************/
  const LOG_PREFIX = '[ZentaoCapture]';
  const logInfo = (...args) => CONFIG.DEBUG && console.log(LOG_PREFIX, ...args);
  const logWarn = (...args) => CONFIG.DEBUG && console.warn(LOG_PREFIX, ...args);
  const logError = (...args) => CONFIG.DEBUG && console.error(LOG_PREFIX, ...args);
  const summarizeText = (v, maxLen = 300) => {
    const text = String(v || '');
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
  };
  const maskKey = (v) => {
    const key = String(v || '');
    if (!key) return '';
    if (key.length <= 4) return `${key.slice(0, 1)}***${key.slice(-1)}`;
    return `${key.slice(0, 2)}***${key.slice(-2)}`;
  };
  const getNow = () => Date.now();
  const safeText = (el) => String(el?.innerText || el?.textContent || '').trim();
  const safeValue = (el) => String(el?.value || '').trim();
  const normalizeText = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const lowerNormalize = (v) => normalizeText(v).toLowerCase();
  const pageText = (doc) => safeText(doc?.body);
  const QaDocState = {
    lastMode: '',
    lastFallbackReason: '',
    lastHref: ''
  };

  function escapeHtml(v) {
    return String(v || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function extractIdFromHref(href, type) {
    if (!href) return '';
    if (type === 'bug') {
      const m = href.match(/bug-view-(\d+)\.html/i);
      if (m) return m[1];
    }
    if (type === 'testcase') {
      // 兼容 testcase-view-19703.html 与 testcase-view-19703-l.html
      const m = href.match(/testcase-view-(\d+)(?:-[a-z])?\.html/i) || href.match(/testcase-view-(\d+)-/i);
      if (m) return m[1];
    }
    const fallback = href.match(/[?&]id=(\d+)/i);
    return fallback ? fallback[1] : '';
  }

  /******************** 存储区 ********************/
  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }

  const StorageService = {
    getSettings: () => readJson(CONFIG.STORAGE_KEYS.settings, { useAlertOnCapture: CONFIG.DEFAULT_USE_ALERT_ON_CAPTURE }),
    saveSettings: (patch) => {
      const next = { ...StorageService.getSettings(), ...(patch || {}) };
      writeJson(CONFIG.STORAGE_KEYS.settings, next);
      return next;
    },
    getBugCache: () => readJson(CONFIG.STORAGE_KEYS.bugCache, null),
    saveBugCache: (v) => writeJson(CONFIG.STORAGE_KEYS.bugCache, v),
    getTestcaseCache: () => readJson(CONFIG.STORAGE_KEYS.testcaseCache, null),
    saveTestcaseCache: (v) => writeJson(CONFIG.STORAGE_KEYS.testcaseCache, v),
    getRecords: () => readJson(CONFIG.STORAGE_KEYS.records, []),
    saveRecords: (records) => writeJson(CONFIG.STORAGE_KEYS.records, (records || []).slice(0, CONFIG.MAX_RECORDS)),
    getFabPosition: () => readJson(CONFIG.STORAGE_KEYS.fabPos, { left: null, top: null }),
    saveFabPosition: (v) => writeJson(CONFIG.STORAGE_KEYS.fabPos, v),
    getPanelFilters: () => readJson(CONFIG.STORAGE_KEYS.panelFilters, { entityType: 'all', pushStatus: 'all', keyword: '' }),
    savePanelFilters: (v) => writeJson(CONFIG.STORAGE_KEYS.panelFilters, v),
    getPanelOpen: () => !!readJson(CONFIG.STORAGE_KEYS.panelOpen, false),
    savePanelOpen: (open) => writeJson(CONFIG.STORAGE_KEYS.panelOpen, !!open)
  };

  /******************** 页面识别模块 ********************/
  function isLikelyQaListDoc(doc) {
    if (!doc?.body) return false;
    const text = pageText(doc);
    const hasTitle = text.includes('Bug标题') || text.includes('用例名称') || text.includes('标题');
    const hasCreator = text.includes('创建者') || text.includes('创建人') || text.includes('由我创建');
    return hasTitle && hasCreator;
  }

  function getSyncEndpoint() {
    const endpoint = CONFIG.SYNC_ENDPOINT;
    if (!endpoint) return '';
    const base = String(CONFIG.API_BASE_URL || '').replace(/\/+$/, '');
    const path = String(endpoint).startsWith('/') ? endpoint : `/${endpoint}`;
    return `${base}${path}`;
  }

  function buildRequestHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Zentao-Sync-Key': CONFIG.SYNC_API_KEY || ''
    };
  }

  function detectOperatorInfo(doc) {
    const scope = doc || document;
    const candidates = [
      safeText(scope.querySelector('.user-name')),
      safeText(scope.querySelector('.user .name')),
      safeText(scope.querySelector('.dropdown-user .text')),
      safeText(document.querySelector('.user-name')),
      safeText(document.querySelector('.dropdown-user .text'))
    ].filter(Boolean);

    return {
      operatorName: candidates[0] || '',
      operatorAccount: ''
    };
  }

  function getQaDoc() {
    const emitQaDocLog = (mode, fallbackReason = '') => {
      if (
        QaDocState.lastMode !== mode ||
        QaDocState.lastFallbackReason !== fallbackReason ||
        QaDocState.lastHref !== location.href
      ) {
        QaDocState.lastMode = mode;
        QaDocState.lastFallbackReason = fallbackReason;
        QaDocState.lastHref = location.href;
        logInfo('getQaDoc resolved', { qaDocMode: mode, href: location.href, fallbackReason: fallbackReason || '' });
      }
    };

    if (isLikelyQaListDoc(document)) {
      emitQaDocLog('top', '');
      return document;
    }

    const iframe = document.querySelector(CONFIG.SELECTORS.qaIframe);
    try {
      const iframeDoc = iframe?.contentWindow?.document || iframe?.contentDocument || null;
      if (iframeDoc?.body) {
        emitQaDocLog('iframe', '');
        return iframeDoc;
      }
      emitQaDocLog('top', 'iframe document not ready');
    } catch (e) {
      const reason = e?.message || 'cannot access iframe document';
      logWarn('getQaDoc iframe access failed', { reason, error: e });
      emitQaDocLog('top', reason);
    }
    return document;
  }
  function isBugCreatePage(doc) { return !!doc?.querySelector(CONFIG.SELECTORS.bugTitle) && pageText(doc).includes('提Bug'); }
  function isBugListPage(doc) {
    const t = pageText(doc);
    return t.includes('Bug标题') || t.includes('由我创建') || t.includes('未关闭');
  }
  function isTestcaseCreatePage(doc) { return !!doc?.querySelector(CONFIG.SELECTORS.caseTitle) && pageText(doc).includes('建用例'); }
  function isTestcaseListPage(doc) {
    const t = pageText(doc);
    return t.includes('用例') && (t.includes('测试用例') || t.includes('由我创建') || t.includes('用例名称'));
  }
  function shouldShowFab(doc) {
    return !!doc && (isBugCreatePage(doc) || isBugListPage(doc) || isTestcaseCreatePage(doc) || isTestcaseListPage(doc));
  }
  function detectPageType(doc) {
    const t = pageText(doc);
    if (doc?.querySelector(CONFIG.SELECTORS.bugTitle) && t.includes('提Bug')) return 'bug-create';
    if (t.includes('Bug标题') || t.includes('由我创建') || t.includes('未关闭')) return 'bug-list';
    if (doc?.querySelector(CONFIG.SELECTORS.caseTitle) && t.includes('建用例')) return 'testcase-create';
    if (t.includes('用例') && (t.includes('测试用例') || t.includes('由我创建') || t.includes('用例名称'))) return 'testcase-list';
    return 'other';
  }

  /******************** Bug/用例采集模块 ********************/
  function findSaveControls(doc) {
    return [...(doc?.querySelectorAll('button, input[type="submit"], input[type="button"], a') || [])].filter((el) => {
      const text = normalizeText(safeText(el));
      const value = normalizeText(safeValue(el));
      return text === '保存' || value === '保存' || text.includes('保存') || value.includes('保存');
    });
  }

  function findPickRootByHiddenInput(doc, selector) {
    const input = doc?.querySelector(selector);
    return input ? input.closest('.pick') : null;
  }

  function getPickDisplayText(root) {
    if (!root) return '';
    const c = [
      safeText(root.querySelector('.picker-single-selection > div')),
      safeText(root.querySelector('.picker-single-selection')),
      safeText(root.querySelector('.picker-multi-selection')),
      safeText(root.querySelector('.text'))
    ].map(normalizeText).filter(Boolean)
      .filter((t) => t !== 'SR' && t !== '所有' && !t.includes('保存模板') && !t.includes('应用模板'));
    return c[0] || '';
  }

  function collectPickInfoByHiddenInput(doc, selector) {
    const input = doc?.querySelector(selector);
    const root = findPickRootByHiddenInput(doc, selector);
    return { value: safeValue(input), text: getPickDisplayText(root) };
  }

  function collectOpenedBuildInfo(doc) {
    const select = doc?.querySelector(CONFIG.SELECTORS.bugOpenedBuildSelect);
    if (!select) return { openedBuildIds: [], affectedVersion: '' };
    const root = select.closest('.pick');
    if (!root) return { openedBuildIds: [], affectedVersion: '' };
    const selectedTexts = [...root.querySelectorAll('.picker-multi-selection .text')].map((el) => normalizeText(safeText(el))).filter(Boolean);
    const selectedIds = [...select.querySelectorAll('option')].map((opt) => safeValue(opt)).filter(Boolean);
    return { openedBuildIds: selectedIds, affectedVersion: selectedTexts[0] || '' };
  }

  function collectBugDraft(doc) {
    const product = collectPickInfoByHiddenInput(doc, CONFIG.SELECTORS.bugProductHiddenInput);
    const project = collectPickInfoByHiddenInput(doc, CONFIG.SELECTORS.bugProjectHiddenInput);
    const execution = collectPickInfoByHiddenInput(doc, CONFIG.SELECTORS.bugExecutionHiddenInput);
    const story = collectPickInfoByHiddenInput(doc, CONFIG.SELECTORS.bugStoryHiddenInput);
    const build = collectOpenedBuildInfo(doc);
    const draft = {
      productId: product.value || '',
      productName: product.text || '',
      projectId: project.value || '',
      projectName: project.text || '',
      openedBuildIds: build.openedBuildIds || [],
      affectedVersion: build.affectedVersion || '',
      bugTitle: safeValue(doc.querySelector(CONFIG.SELECTORS.bugTitle)),
      executionId: execution.value || '',
      executionName: execution.text || '',
      requirementId: story.value || '',
      requirementName: story.text || '',
      creatorName: ''
    };
    logInfo('bug draft collected', {
      productId: draft.productId,
      productName: draft.productName,
      projectId: draft.projectId,
      projectName: draft.projectName,
      openedBuildIds: draft.openedBuildIds,
      affectedVersion: draft.affectedVersion,
      bugTitle: draft.bugTitle,
      executionId: draft.executionId,
      executionName: draft.executionName,
      requirementId: draft.requirementId,
      requirementName: draft.requirementName
    });
    return draft;
  }

  function collectTestcaseDraft(doc) {
    const product = collectPickInfoByHiddenInput(doc, CONFIG.SELECTORS.caseProductHiddenInput);
    const story = collectPickInfoByHiddenInput(doc, CONFIG.SELECTORS.caseStoryHiddenInput);
    const draft = {
      productId: product.value || '',
      productName: product.text || '',
      caseTitle: safeValue(doc.querySelector(CONFIG.SELECTORS.caseTitle)),
      requirementId: story.value || '',
      requirementName: story.text || '',
      creatorName: ''
    };
    logInfo('testcase draft collected', {
      productId: draft.productId,
      productName: draft.productName,
      caseTitle: draft.caseTitle,
      requirementId: draft.requirementId,
      requirementName: draft.requirementName
    });
    return draft;
  }

  function saveBugCreateContext(doc) {
    const draft = collectBugDraft(doc);
    if (!draft.bugTitle) return false;
    const cache = { entityType: 'bug', action: 'create', source: 'tampermonkey', draft, time: getNow(), topHref: location.href };
    StorageService.saveBugCache(cache);
    logInfo('create cache saved', {
      entityType: cache.entityType,
      title: draft.bugTitle,
      cacheTime: cache.time,
      topHref: cache.topHref
    });
    return true;
  }

  function saveTestcaseCreateContext(doc) {
    const draft = collectTestcaseDraft(doc);
    if (!draft.caseTitle) return false;
    const cache = { entityType: 'testcase', action: 'create', source: 'tampermonkey', draft, time: getNow(), topHref: location.href };
    StorageService.saveTestcaseCache(cache);
    logInfo('create cache saved', {
      entityType: cache.entityType,
      title: draft.caseTitle,
      cacheTime: cache.time,
      topHref: cache.topHref
    });
    return true;
  }

  /******************** 列表识别模块 ********************/
  // 维护说明：如果禅道 DOM 变化，优先检查 getHeaderRow/findColumnIndex/getRowCells/findCreatorByTitleLink。
  // 维护说明：不要再通过“最后一个非空单元格”推断创建者。
  const isRecentCache = (cache, maxAgeMs = CONFIG.CACHE_RECENT_MS) => !!(cache?.time && (getNow() - cache.time < maxAgeMs));

  function toLooseComparableTitle(v) {
    return lowerNormalize(v).replace(/[\s:：\-_.，,。()（）[\]【】]/g, '');
  }

  function findTitleLink(doc, title) {
    if (!doc || !title) {
      logInfo('findTitleLink', { title: title || '', found: false, mode: 'invalid-args' });
      return null;
    }
    const expect = lowerNormalize(title);
    const expectLoose = toLooseComparableTitle(title);
    const bodyScope = doc.querySelector('.dtable-block.dtable-body') || doc.querySelector('.dtable-body') || doc;
    let loose = null;
    for (const a of bodyScope.querySelectorAll('a')) {
      const text = lowerNormalize(safeText(a));
      const textLoose = toLooseComparableTitle(text);
      if (!text) continue;
      if (text === expect) {
        logInfo('findTitleLink', { title, found: true, mode: 'exact', href: a.href || '' });
        return a;
      }
      if (!loose && (text.includes(expect) || expect.includes(text) || (textLoose && expectLoose && (textLoose.includes(expectLoose) || expectLoose.includes(textLoose))))) {
        loose = a;
      }
    }
    logInfo('findTitleLink', { title, found: !!loose, mode: loose ? 'loose' : 'none', href: loose?.href || '' });
    return loose;
  }

  function getClosestDtableRow(el) {
    if (!el) return null;
    return el.closest('.dtable-row, [role="row"], tr') || null;
  }

  function getRowCells(row) {
    if (!row) return [];

    const byScope = row.querySelectorAll(':scope > .dtable-cell, :scope > [role="cell"], :scope > td, :scope > th');
    if (byScope.length) return [...byScope];

    const byClass = [...(row.children || [])].filter((ch) => {
      const cls = ch.className || '';
      return typeof cls === 'string' && (cls.includes('dtable-cell') || cls.includes('cell'));
    });
    if (byClass.length) return byClass;

    return [...(row.children || [])].filter((ch) => ch.nodeType === 1);
  }

  function getHeaderRow(doc) {
    const direct = doc?.querySelector('.dtable-header .dtable-row, .dtable-head .dtable-row, .dtable-row.is-header, [role="rowgroup"] [role="row"]');
    if (direct && normalizeText(safeText(direct)).includes('创建者')) return direct;

    return [...(doc?.querySelectorAll('.dtable-row') || [])].find((row) => {
      const text = normalizeText(safeText(row));
      return text.includes('创建者') && (text.includes('Bug标题') || text.includes('用例名称') || text.includes('标题'));
    }) || null;
  }
  function findColumnIndex(headerRow, expectedTexts) {
    const cells = getRowCells(headerRow);
    for (let i = 0; i < cells.length; i += 1) {
      const text = normalizeText(safeText(cells[i]));
      if (expectedTexts.some((v) => text === v || text.includes(v))) return i;
    }
    return -1;
  }
  function getCellText(cell) {
    const content = cell?.querySelector('.dtable-cell-content');
    return normalizeText(safeText(content || cell));
  }
  function findCreatorByTitleLink(doc, titleLink) {
    if (!doc || !titleLink) return '';
    const headerRow = getHeaderRow(doc);
    const creatorColIndex = findColumnIndex(headerRow, ['创建者']);
    const row = getClosestDtableRow(titleLink);
    logInfo('creator locating', { creatorColIndex, hasRow: !!row, hasHeader: !!headerRow });

    // 主路径：同一行按列索引取值
    if (creatorColIndex >= 0 && row) {
      const cells = getRowCells(row);
      const creator = getCellText(cells[creatorColIndex]) || '';
      if (creator) return creator;
    }

    // 次路径：同一行文本邻近“创建者”标签
    if (row) {
      const cells = getRowCells(row);
      for (let i = 0; i < cells.length; i += 1) {
        const text = getCellText(cells[i]);
        if (text.includes('创建者')) {
          const next = getCellText(cells[i + 1]);
          if (next) return next;
        }
      }
    }

    return '';
  }

  function getDtableHeaderTitles(blockEl) {
    if (!blockEl) return [];
    const titleEls = blockEl.querySelectorAll('.dtable-cell, [role="columnheader"], th');
    return [...titleEls]
      .map((el) => normalizeText(safeText(el)))
      .filter(Boolean);
  }

  function getDtableChildBlock(parentEl, role) {
    if (!parentEl) return null;

    if (role === 'left') {
      return parentEl.querySelector('.dtable-cells.dtable-fixed-left') || null;
    }
    if (role === 'center') {
      return parentEl.querySelector('.dtable-cells.dtable-scroll-center') || null;
    }
    if (role === 'right') {
      return parentEl.querySelector('.dtable-cells.dtable-fixed-right') || null;
    }

    return null;
  }

  // 结构化解析禅道 dtable（header/body + left/center/right）
  function getDtableLayout(doc) {
    if (!doc) return null;

    const headerBlock = doc.querySelector('.dtable-block.dtable-header');
    const bodyBlock = doc.querySelector('.dtable-block.dtable-body');
    if (!headerBlock || !bodyBlock) return null;

    const leftHeader = getDtableChildBlock(headerBlock, 'left');
    const centerHeader = getDtableChildBlock(headerBlock, 'center');
    const rightHeader = getDtableChildBlock(headerBlock, 'right');

    const leftBody = getDtableChildBlock(bodyBlock, 'left');
    const centerBody = getDtableChildBlock(bodyBlock, 'center');
    const rightBody = getDtableChildBlock(bodyBlock, 'right');

    if (!leftBody || !centerBody) return null;

    const leftHeaderTitles = getDtableHeaderTitles(leftHeader);
    const centerHeaderTitles = getDtableHeaderTitles(centerHeader);
    const rightHeaderTitles = getDtableHeaderTitles(rightHeader);

    const leftColCount = leftHeaderTitles.length;
    const centerColCount = centerHeaderTitles.length;
    const rightColCount = rightHeaderTitles.length;

    const titleOffsetInLeft = leftHeaderTitles.findIndex((t) => t === 'Bug标题' || t.includes('Bug标题'));
    const creatorOffsetInCenter = centerHeaderTitles.findIndex((t) => t === '创建者' || t.includes('创建者'));

    const layout = {
      headerBlock,
      bodyBlock,
      leftHeader,
      centerHeader,
      rightHeader,
      leftBody,
      centerBody,
      rightBody,
      leftHeaderTitles,
      centerHeaderTitles,
      rightHeaderTitles,
      leftColCount,
      centerColCount,
      rightColCount,
      titleOffsetInLeft,
      creatorOffsetInCenter
    };

    logInfo('dtable layout parsed', {
      leftColCount,
      centerColCount,
      rightColCount,
      titleOffsetInLeft,
      creatorOffsetInCenter
    });

    return layout;
  }

  function findColumnMeta(layout, candidateNames) {
    if (!layout || !candidateNames?.length) return null;

    const names = candidateNames.map((v) => normalizeText(v)).filter(Boolean);
    if (!names.length) return null;

    const blocks = [
      { blockName: 'left', titles: layout.leftHeaderTitles || [], colCount: layout.leftColCount, bodyBlock: layout.leftBody },
      { blockName: 'center', titles: layout.centerHeaderTitles || [], colCount: layout.centerColCount, bodyBlock: layout.centerBody },
      { blockName: 'right', titles: layout.rightHeaderTitles || [], colCount: layout.rightColCount, bodyBlock: layout.rightBody }
    ];

    // 先精确匹配
    for (const block of blocks) {
      for (let i = 0; i < block.titles.length; i += 1) {
        const headerText = normalizeText(block.titles[i]);
        if (!headerText) continue;
        if (names.some((name) => headerText === name)) {
          return {
            blockName: block.blockName,
            headerText,
            colOffset: i,
            colCount: block.colCount,
            bodyBlock: block.bodyBlock
          };
        }
      }
    }

    // 再包含匹配
    for (const block of blocks) {
      for (let i = 0; i < block.titles.length; i += 1) {
        const headerText = normalizeText(block.titles[i]);
        if (!headerText) continue;
        if (names.some((name) => headerText.includes(name) || name.includes(headerText))) {
          return {
            blockName: block.blockName,
            headerText,
            colOffset: i,
            colCount: block.colCount,
            bodyBlock: block.bodyBlock
          };
        }
      }
    }

    return null;
  }

  function findRowIndexByTitleWithMeta(titleMeta, titleText) {
    const titleNormalized = normalizeText(titleText || '');
    if (!titleMeta || !titleMeta.bodyBlock || !titleNormalized || !titleMeta.colCount) return -1;

    const blockCells = [...titleMeta.bodyBlock.querySelectorAll('.dtable-cell')];
    const rowCount = Math.floor(blockCells.length / titleMeta.colCount);
    logInfo('findRowIndexByTitle: scanning rows', {
      blockName: titleMeta.blockName,
      colCount: titleMeta.colCount,
      colOffset: titleMeta.colOffset,
      rowCount
    });

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const cellIndex = rowIndex * titleMeta.colCount + titleMeta.colOffset;
      const titleCellText = normalizeText(getCellText(blockCells[cellIndex]));
      if (!titleCellText) continue;

      const matched = titleCellText === titleNormalized || titleCellText.includes(titleNormalized) || titleNormalized.includes(titleCellText);
      if (matched) return rowIndex;
    }

    return -1;
  }

  function findRowIndexByTitle(layout, titleText) {
    const titleMeta = findColumnMeta(layout, ['Bug标题', '用例名称', '标题', '名称']);
    return findRowIndexByTitleWithMeta(titleMeta, titleText);
  }

  function getFieldValueByRowIndex(columnMeta, rowIndex) {
    if (!columnMeta || !columnMeta.bodyBlock || !columnMeta.colCount || rowIndex < 0) return '';
    const blockCells = [...columnMeta.bodyBlock.querySelectorAll('.dtable-cell')];
    const cellIndex = rowIndex * columnMeta.colCount + columnMeta.colOffset;
    if (cellIndex < 0 || cellIndex >= blockCells.length) return '';
    return normalizeText(getCellText(blockCells[cellIndex]));
  }

  // 主路径：按 left/center/right 分块 + 动态表头定位创建者
  function findCreatorByTitle(doc, titleText) {
    const titleNormalized = normalizeText(titleText || '');
    if (!doc || !titleNormalized) return '';

    const layout = getDtableLayout(doc);
    if (!layout) {
      logInfo('findCreatorByTitle: layout unavailable');
      return '';
    }

    const titleMeta = findColumnMeta(layout, ['Bug标题', '用例名称', '标题', '名称']);
    const creatorMeta = findColumnMeta(layout, ['创建者', '创建人', '由谁创建']);
    logInfo('findCreatorByTitle: column meta', { titleMeta, creatorMeta });
    if (!titleMeta || !creatorMeta) {
      return '';
    }

    const rowIndex = findRowIndexByTitleWithMeta(titleMeta, titleNormalized);
    logInfo('findCreatorByTitle: row index', { rowIndex, title: titleNormalized });
    if (rowIndex < 0) {
      return '';
    }

    const creator = getFieldValueByRowIndex(creatorMeta, rowIndex);
    logInfo('findCreatorByTitle: creator result', { creator });
    return creator || '';
  }

  function findCreator(doc, title, titleLink) {
    logInfo('findCreator start', { title: title || '', hasTitleLink: !!titleLink });
    const byDtable = findCreatorByTitle(doc, title);
    if (byDtable) {
      logInfo('findCreator: hit dtable layout path', { creator: byDtable });
      return byDtable;
    }

    const byLegacy = findCreatorByTitleLink(doc, titleLink);
    if (byLegacy) {
      logInfo('findCreator: hit legacy fallback path', { creator: byLegacy });
      return byLegacy;
    }

    logInfo('findCreator: not found', { title: title || '' });
    return '';
  }

  function extractCaseIdFromTextGray(caseLinkEl) {
    const empty = {
      sourceType: '',
      linkedCaseId: '',
      linkedCaseLabel: '',
      linkedCaseHref: ''
    };
    if (!caseLinkEl) return empty;

    const label = normalizeText(safeText(caseLinkEl));
    const href = String(caseLinkEl.getAttribute('href') || '');
    const title = String(caseLinkEl.getAttribute('title') || '').trim();

    let caseId = '';
    if (/^\d+$/.test(title)) {
      caseId = title;
      logInfo('extractCaseIdFromTextGray: id from title', { caseId });
    }

    if (!caseId && href) {
      const m = href.match(/testcase-view-(\d+)-/i);
      if (m) {
        caseId = m[1];
        logInfo('extractCaseIdFromTextGray: id from href', { caseId, href });
      }
    }

    if (!caseId && label) {
      const m = label.match(/用例#\s*(\d+)/i) || label.match(/\[(?:用例|case)#?\s*(\d+)\]/i);
      if (m) {
        caseId = m[1];
        logInfo('extractCaseIdFromTextGray: id from text', { caseId, label });
      }
    }

    if (!caseId) return empty;
    return {
      sourceType: 'case',
      linkedCaseId: caseId,
      linkedCaseLabel: label || '',
      linkedCaseHref: href || ''
    };
  }

  function findBugTitleCellContent(titleLink) {
    if (!titleLink) return null;
    const content = titleLink.closest('.dtable-cell-content');
    logInfo('findBugTitleCellContent', { found: !!content });
    return content;
  }

  function isLikelySourceCaseLink(caseLinkEl) {
    if (!caseLinkEl) return false;
    const label = normalizeText(safeText(caseLinkEl));
    const href = String(caseLinkEl.getAttribute('href') || '');
    const title = String(caseLinkEl.getAttribute('title') || '').trim();
    return (
      label.includes('用例#') ||
      href.includes('testcase-view-') ||
      /^\d+$/.test(title)
    );
  }

  function extractBugSourceCaseInfo(titleLink) {
    const empty = {
      sourceType: '',
      linkedCaseId: '',
      linkedCaseLabel: '',
      linkedCaseHref: ''
    };
    if (!titleLink) return empty;

    const cellContent = findBugTitleCellContent(titleLink);
    if (!cellContent) {
      logInfo('extractBugSourceCaseInfo detail', { hasCellContent: false, hasTextGray: false });
      return empty;
    }

    const caseLink = cellContent.querySelector('a.text-gray');
    logInfo('extractBugSourceCaseInfo detail', {
      hasCellContent: true,
      hasTextGray: !!caseLink,
      textGrayOuterHTML: caseLink ? summarizeText(caseLink.outerHTML || '', 300) : ''
    });
    if (!caseLink) return empty;
    if (!isLikelySourceCaseLink(caseLink)) {
      logInfo('extractBugSourceCaseInfo: skip non-case text-gray');
      return empty;
    }

    const info = extractCaseIdFromTextGray(caseLink);
    logInfo('extractBugSourceCaseInfo parsed', {
      sourceType: info.sourceType || '',
      linkedCaseId: info.linkedCaseId || '',
      linkedCaseLabel: info.linkedCaseLabel || '',
      linkedCaseHref: info.linkedCaseHref || ''
    });
    return info;
  }

  /******************** 本地记录管理模块 ********************/
  function buildUniqueKey(payload) {
    if (payload.entityType === 'bug') return `bug:${payload.result?.zentaoBugId || ''}:${payload.draft?.bugTitle || ''}`;
    if (payload.entityType === 'testcase') return `testcase:${payload.result?.zentaoCaseId || ''}:${payload.draft?.caseTitle || ''}`;
    return `${payload.entityType || 'unknown'}:${payload.capturedAt || getNow()}`;
  }

  function buildDraftPayload(record) {
    const draft = { ...(record?.draft || {}) };
    const payload = {
      ...draft,
      sourceType: draft.sourceType || record?.sourceType || '',
      linkedCaseId: draft.linkedCaseId || record?.linkedCaseId || '',
      linkedCaseLabel: draft.linkedCaseLabel || record?.linkedCaseLabel || '',
      linkedCaseHref: draft.linkedCaseHref || record?.linkedCaseHref || ''
    };
    logInfo('buildDraftPayload', {
      entityType: record?.entityType || '',
      title: payload.bugTitle || payload.caseTitle || '',
      sourceType: payload.sourceType || '',
      linkedCaseId: payload.linkedCaseId || ''
    });
    return payload;
  }

  function buildResultPayload(record) {
    const result = { ...(record?.result || {}) };
    const payload = {
      ...result,
      sourceType: result.sourceType || record?.sourceType || '',
      linkedCaseId: result.linkedCaseId || record?.linkedCaseId || '',
      linkedCaseLabel: result.linkedCaseLabel || record?.linkedCaseLabel || '',
      linkedCaseHref: result.linkedCaseHref || record?.linkedCaseHref || ''
    };
    logInfo('buildResultPayload', {
      entityType: record?.entityType || '',
      bugId: payload.zentaoBugId || '',
      caseId: payload.zentaoCaseId || '',
      sourceType: payload.sourceType || '',
      linkedCaseId: payload.linkedCaseId || ''
    });
    return payload;
  }

  function buildStandardRecord(record, qaDoc, pageType, extra = {}) {
    const operatorInfo = detectOperatorInfo(qaDoc);
    const draftPayload = buildDraftPayload(record);
    const resultPayload = buildResultPayload(record);
    const payload = {
      clientRecordId: record.clientRecordId || '',
      entityType: record.entityType || '',
      action: record.action || 'create',
      source: record.source || 'tampermonkey',
      capturedAt: record.capturedAt || 0,
      topHref: record.topHref || '',
      pageUrl: location.href,
      pageType: pageType || '',
      scriptVersion: CONFIG.SCRIPT_VERSION,
      detectedAt: getNow(),
      operatorName: operatorInfo.operatorName || '',
      operatorAccount: operatorInfo.operatorAccount || '',
      matchedBy: extra.matchedBy || '',
      qaDocMode: qaDoc === document ? 'top' : 'iframe',
      listFilterSnapshot: extra.listFilterSnapshot || '',
      pushMessage: record.pushMessage || '',
      sourceType: draftPayload.sourceType || resultPayload.sourceType || '',
      linkedCaseId: draftPayload.linkedCaseId || resultPayload.linkedCaseId || '',
      linkedCaseLabel: draftPayload.linkedCaseLabel || resultPayload.linkedCaseLabel || '',
      linkedCaseHref: draftPayload.linkedCaseHref || resultPayload.linkedCaseHref || '',
      draft: draftPayload,
      result: resultPayload
    };
    logInfo('buildStandardRecord', {
      clientRecordId: payload.clientRecordId,
      entityType: payload.entityType,
      pageType: payload.pageType,
      qaDocMode: payload.qaDocMode,
      operatorName: payload.operatorName || ''
    });
    return payload;
  }

  function normalizeRecord(payload) {
    const entityId = payload.entityType === 'bug' ? payload.result?.zentaoBugId : payload.result?.zentaoCaseId;
    return {
      uniqueKey: buildUniqueKey(payload),
      clientRecordId: payload.clientRecordId || `${payload.entityType}_${entityId || 'unknown'}_${getNow()}`,
      entityType: payload.entityType,
      action: payload.action || 'create',
      source: payload.source || 'tampermonkey',
      capturedAt: payload.capturedAt || getNow(),
      topHref: payload.topHref || '',
      draft: payload.draft || {},
      result: payload.result || {},
      pushStatus: payload.pushStatus || 'pending',
      pushMessage: payload.pushMessage || '',
      lastPushAt: payload.lastPushAt || 0,
      retryCount: payload.retryCount || 0,
      pageType: payload.pageType || '',
      pageUrl: payload.pageUrl || '',
      scriptVersion: payload.scriptVersion || CONFIG.SCRIPT_VERSION,
      detectedAt: payload.detectedAt || 0,
      operatorName: payload.operatorName || '',
      operatorAccount: payload.operatorAccount || '',
      matchedBy: payload.matchedBy || '',
      qaDocMode: payload.qaDocMode || '',
      listFilterSnapshot: payload.listFilterSnapshot || '',
      serverEventId: payload.serverEventId || '',
      serverStatus: payload.serverStatus || '',
      duplicateOf: payload.duplicateOf || '',
      lastResponseCode: payload.lastResponseCode || 0
    };
  }

  function normalizeStoredRecord(record) {
    return normalizeRecord(record || {});
  }

  function migrateStoredRecords(records) {
    return (records || []).map(normalizeStoredRecord);
  }

  function getRecords() {
    return migrateStoredRecords(StorageService.getRecords());
  }
  function saveRecords(records) {
    StorageService.saveRecords(migrateStoredRecords(records));
    UIService.renderPanelList();
  }
  function upsertRecord(payload) {
    const records = getRecords();
    const record = normalizeRecord(payload);
    const idx = records.findIndex((r) => r.uniqueKey === record.uniqueKey);
    if (idx >= 0) records[idx] = { ...records[idx], ...record };
    else records.unshift(record);
    saveRecords(records);
    return record;
  }
  function updateRecord(uniqueKey, patch) {
    const records = getRecords();
    const idx = records.findIndex((r) => r.uniqueKey === uniqueKey);
    if (idx < 0) return null;
    records[idx] = { ...records[idx], ...(patch || {}) };
    saveRecords(records);
    return records[idx];
  }
  function getPendingOrFailedRecords() {
    return getRecords().filter((r) => r.pushStatus === 'pending' || r.pushStatus === 'failed');
  }

  function deleteRecord(uniqueKey) {
    const records = getRecords();
    const next = records.filter((r) => r.uniqueKey !== uniqueKey);
    if (next.length === records.length) return false;
    saveRecords(next);
    return true;
  }

  /******************** 推送服务模块 ********************/
  // 维护说明：推送失败优先检查 CONFIG.API_BASE_URL/CONFIG.SYNC_ENDPOINT/CONFIG.SYNC_API_KEY。
  function gmPostJson(url, payload, headers, timeout) {
    return new Promise((resolve, reject) => {
      try {
        const timeoutMs = timeout || CONFIG.REQUEST_TIMEOUT_MS;
        const reqHeaders = headers || {};
        const headerSummary = {
          hasSyncKey: !!reqHeaders['X-Zentao-Sync-Key'],
          maskedSyncKey: maskKey(reqHeaders['X-Zentao-Sync-Key'] || ''),
          contentType: reqHeaders['Content-Type'] || ''
        };
        const payloadStr = JSON.stringify(payload || {});
        logInfo('gmPostJson request', {
          method: 'POST',
          url,
          timeout: timeoutMs,
          headers: headerSummary,
          payloadLength: payloadStr.length
        });
        GM_xmlhttpRequest({
          method: 'POST',
          url,
          headers: reqHeaders,
          data: payloadStr,
          timeout: timeoutMs,
          onload: (resp) => {
            logInfo('gmPostJson onload', {
              status: resp?.status || 0,
              responseText: summarizeText(resp?.responseText || '', 500)
            });
            resolve(resp);
          },
          onerror: (err) => {
            logError('gmPostJson onerror', { error: err });
            reject(new Error(err?.error || '网络错误'));
          },
          ontimeout: () => {
            logError('gmPostJson ontimeout', { timeout: timeoutMs });
            reject(new Error(`请求超时(${timeoutMs}ms)`));
          }
        });
      } catch (err) {
        logError('gmPostJson exception', { error: err });
        reject(err);
      }
    });
  }

  async function pushRecordToServer(record, qaDoc, pageType, extra = {}) {
    const endpoint = getSyncEndpoint();
    const payload = buildStandardRecord(record, qaDoc, pageType, extra);
    const timeout = CONFIG.REQUEST_TIMEOUT_MS;
    const requestHeaders = buildRequestHeaders();
    const payloadSummary = {
      clientRecordId: payload.clientRecordId || '',
      entityType: payload.entityType || '',
      pageType: payload.pageType || '',
      qaDocMode: payload.qaDocMode || '',
      operatorName: payload.operatorName || '',
      draft: {
        bugTitle: payload.draft?.bugTitle || '',
        caseTitle: payload.draft?.caseTitle || '',
        productId: payload.draft?.productId || '',
        projectId: payload.draft?.projectId || '',
        requirementId: payload.draft?.requirementId || '',
        linkedCaseId: payload.draft?.linkedCaseId || ''
      },
      result: {
        bugId: payload.result?.zentaoBugId || '',
        caseId: payload.result?.zentaoCaseId || '',
        linkedCaseId: payload.result?.linkedCaseId || ''
      }
    };
    logInfo('push payload summary', payloadSummary);
    logInfo('push payload full', JSON.stringify(payload, null, 2));
    logInfo('about to push', {
      endpoint,
      timeout,
      hasSyncKey: !!CONFIG.SYNC_API_KEY,
      pageType: payload.pageType || pageType || '',
      clientRecordId: payload.clientRecordId || '',
      entityType: payload.entityType || '',
      bugId: payload.result?.zentaoBugId || '',
      caseId: payload.result?.zentaoCaseId || ''
    });
    if (CONFIG.ENABLE_DEBUGGER_ON_PUSH) debugger;

    try {
      const resp = await gmPostJson(endpoint, payload, requestHeaders, timeout);
      const text = resp?.responseText || '';
      logInfo('push response raw', {
        httpStatus: resp?.status || 0,
        responseText: summarizeText(text, 500)
      });
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
        logInfo('push response parsed', {
          data,
          ok: !!(data?.ok || data?.success),
          duplicate: !!data?.duplicate_of || String(data?.status || '').toLowerCase() === 'duplicate',
          status: data?.status || '',
          message: data?.message || '',
          eventId: data?.event_id || '',
          duplicateOf: data?.duplicate_of || ''
        });
      } catch (parseErr) {
        logError('push response parse failed', {
          httpStatus: resp?.status || 0,
          responseText: summarizeText(text, 500),
          error: parseErr
        });
        throw new Error(`响应解析失败: HTTP ${resp?.status || 0}, body=${text?.slice(0, 200) || ''}`);
      }

      if (!(resp?.status >= 200 && resp?.status < 300)) {
        logWarn('push response http non-2xx', { status: resp?.status || 0, message: data?.message || '' });
        throw new Error(data?.message || `HTTP ${resp?.status || 0}`);
      }

      const status = String(data?.status || '').toLowerCase();
      const duplicate = !!data?.duplicate_of || status === 'duplicate';
      const ok = !!data?.ok || !!data?.success || status === 'ok' || status === 'success' || duplicate;

      if (!ok) {
        logWarn('push response business non-success', {
          status: data?.status || '',
          message: data?.message || '',
          duplicateOf: data?.duplicate_of || ''
        });
        throw new Error(data?.message || 'server returned non-success status');
      }

      return {
        ok: true,
        duplicate,
        message: data?.message || (duplicate ? '服务端已存在(重复)' : '推送成功'),
        eventId: data?.event_id || '',
        status: data?.status || '',
        duplicateOf: data?.duplicate_of || '',
        responseCode: resp?.status || 0
      };
    } catch (err) {
      logError('push request failed', { error: err, endpoint });
      throw err;
    }
  }

  const PushService = {
    pushingSet: new Set(),
    async pushByUniqueKey(uniqueKey, qaDoc = null, pageType = '') {
      const record = getRecords().find((r) => r.uniqueKey === uniqueKey);
      if (!record || this.pushingSet.has(uniqueKey)) return;
      if ((record.retryCount || 0) >= CONFIG.MAX_RETRY && record.pushStatus === 'failed') {
        logWarn('push skipped: retry limit reached', { uniqueKey, retryCount: record.retryCount });
        return;
      }
      this.pushingSet.add(uniqueKey);
      logInfo('updateRecord before', {
        uniqueKey,
        fromStatus: record.pushStatus || '',
        toStatus: 'pending',
        retryCount: record.retryCount || 0
      });
      const pendingUpdated = updateRecord(uniqueKey, { pushStatus: 'pending', pushMessage: '正在推送...' });
      logInfo('updateRecord after', {
        uniqueKey,
        status: pendingUpdated?.pushStatus || '',
        retryCount: pendingUpdated?.retryCount || 0
      });
      try {
        logInfo('push start', {
          uniqueKey,
          entityType: record.entityType,
          endpoint: getSyncEndpoint(),
          retryCount: record.retryCount || 0
        });
        const data = await pushRecordToServer(record, qaDoc || getQaDoc(), pageType || detectPageType(getQaDoc()), {
          matchedBy: record.matchedBy || ''
        });
        const nextStatus = data.duplicate ? 'duplicate' : 'success';
        logInfo('updateRecord before', {
          uniqueKey,
          fromStatus: pendingUpdated?.pushStatus || 'pending',
          toStatus: nextStatus,
          retryCount: record.retryCount || 0
        });
        const successUpdated = updateRecord(uniqueKey, {
          pushStatus: nextStatus,
          pushMessage: data?.message || '推送成功',
          lastPushAt: getNow(),
          serverEventId: data?.eventId || '',
          serverStatus: data?.status || '',
          duplicateOf: data?.duplicateOf || '',
          lastResponseCode: data?.responseCode || 0
        });
        logInfo('updateRecord after', {
          uniqueKey,
          status: successUpdated?.pushStatus || '',
          retryCount: successUpdated?.retryCount || 0
        });
        UIService.showToast(`${record.entityType === 'bug' ? 'Bug' : '用例'} ${data.duplicate ? '重复已忽略' : '推送成功'}`, 'success');
        logInfo('push success', {
          uniqueKey,
          nextStatus,
          serverEventId: data?.eventId || '',
          serverStatus: data?.status || '',
          duplicateOf: data?.duplicateOf || '',
          responseCode: data?.responseCode || 0
        });
      } catch (err) {
        const retryBefore = record.retryCount || 0;
        const retryAfter = retryBefore + 1;
        logInfo('updateRecord before', {
          uniqueKey,
          fromStatus: pendingUpdated?.pushStatus || 'pending',
          toStatus: 'failed',
          retryCount: retryBefore
        });
        const failedUpdated = updateRecord(uniqueKey, {
          pushStatus: 'failed',
          pushMessage: err?.message || '推送失败',
          lastPushAt: getNow(),
          retryCount: retryAfter
        });
        logInfo('updateRecord after', {
          uniqueKey,
          status: failedUpdated?.pushStatus || '',
          retryCount: failedUpdated?.retryCount || 0
        });
        UIService.showToast(`${record.entityType === 'bug' ? 'Bug' : '用例'} 推送失败: ${err?.message || 'unknown'}`, 'error', 4500);
        logError('push failed', {
          uniqueKey,
          error: err?.message || err,
          retryCountBefore: retryBefore,
          retryCountAfter: retryAfter
        });
      } finally {
        this.pushingSet.delete(uniqueKey);
      }
    },
    async pushAllPendingRecords(qaDoc = null, pageType = '') {
      await Promise.all(getPendingOrFailedRecords().map((item) => this.pushByUniqueKey(item.uniqueKey, qaDoc, pageType)));
    }
  };

  function notifyCaptureSuccess(lines, toastText) {
    if (StorageService.getSettings().useAlertOnCapture) {
      alert(lines.join('\n'));
    } else {
      UIService.showToast(toastText || lines[0] || '识别成功', 'success', 3500);
    }
  }

  function tryMatchBugListPage(doc, state) {
    if (shouldSkipListScan('bug')) return false;
    const cache = StorageService.getBugCache();
    if (!isRecentCache(cache)) {
      logInfo('bug list matching skip', { pageType: 'bug-list', reason: 'cache-not-recent' });
      return false;
    }
    const title = (cache?.draft?.bugTitle || '').trim();
    if (!title) {
      logInfo('bug list matching skip', { pageType: 'bug-list', reason: 'empty-cache-title' });
      return false;
    }

    logInfo('bug list matching start', { pageType: 'bug-list', cachedTitle: title });
    const link = findTitleLink(doc, title);
    logInfo('bug list matching link', { pageType: 'bug-list', cachedTitle: title, foundTitleLink: !!link });
    if (!link) {
      logInfo('bug list match: title not found', { title });
      return false;
    }

    const href = link.href || '';
    const bugId = extractIdFromHref(href, 'bug');
    if (!bugId) {
      logInfo('bug list unmatched', { reason: 'bugId-not-found', href });
      return false;
    }
    if (isDuplicateMatchGuard(`bug:${bugId}`)) {
      logInfo('bug list matching skip', { reason: 'duplicate-guard', bugId });
      return true;
    }
    if (bugId === state.lastMatchedBugId) {
      logInfo('bug list matching skip', { reason: 'same-as-lastMatchedBugId', bugId });
      return true;
    }
    state.lastMatchedBugId = bugId;

    const creatorName = findCreator(doc, title, link);
    const sourceCaseInfo = extractBugSourceCaseInfo(link);
    const record = upsertRecord({
      entityType: 'bug',
      action: 'create',
      source: 'tampermonkey',
      clientRecordId: `bug_${bugId}_${getNow()}`,
      capturedAt: getNow(),
      topHref: cache.topHref || location.href,
      pageUrl: location.href,
      pageType: 'bug-list',
      scriptVersion: CONFIG.SCRIPT_VERSION,
      detectedAt: getNow(),
      matchedBy: 'title-link+id',
      qaDocMode: doc === document ? 'top' : 'iframe',
      listFilterSnapshot: '',
      draft: { ...cache.draft, creatorName, ...sourceCaseInfo },
      result: { zentaoBugId: bugId, zentaoBugUrl: href, ...sourceCaseInfo },
      pushStatus: 'pending',
      pushMessage: '等待推送'
    });

    logInfo('bug list matched', { bugId, title, creatorName, sourceCaseInfo, uniqueKey: record.uniqueKey });
    notifyCaptureSuccess([
      'Bug识别成功',
      `Bug ID: ${bugId}`,
      `所属产品: ${record.draft.productName || ''}`,
      `所属项目: ${record.draft.projectName || ''}`,
      `影响版本: ${record.draft.affectedVersion || ''}`,
      `Bug标题: ${record.draft.bugTitle || ''}`,
      `所属执行: ${record.draft.executionName || ''}`,
      `相关需求: ${record.draft.requirementName || ''}`,
      `创建者: ${record.draft.creatorName || ''}`,
      ...(record.draft.linkedCaseId ? [`来源用例: ${record.draft.linkedCaseId}`] : [])
    ], `Bug已识别: #${bugId}`);

    if (CONFIG.AUTO_PUSH) PushService.pushByUniqueKey(record.uniqueKey, doc, 'bug-list');
    return true;
  }

  function tryMatchTestcaseListPage(doc, state) {
    if (shouldSkipListScan('testcase')) return false;
    const cache = StorageService.getTestcaseCache();
    if (!isRecentCache(cache)) {
      logInfo('testcase list matching skip', { pageType: 'testcase-list', reason: 'cache-not-recent' });
      return false;
    }
    const title = (cache?.draft?.caseTitle || '').trim();
    if (!title) {
      logInfo('testcase list matching skip', { pageType: 'testcase-list', reason: 'empty-cache-title' });
      return false;
    }

    logInfo('testcase list matching start', { pageType: 'testcase-list', cachedTitle: title });
    const link = findTitleLink(doc, title);
    logInfo('testcase list matching link', { pageType: 'testcase-list', cachedTitle: title, foundTitleLink: !!link });
    if (!link) {
      logInfo('testcase list match: title not found', { title });
      return false;
    }

    const href = link.href || '';
    const caseId = extractIdFromHref(href, 'testcase');
    if (!caseId) {
      logInfo('testcase list unmatched', { reason: 'caseId-not-found', href });
      return false;
    }
    if (isDuplicateMatchGuard(`testcase:${caseId}`)) {
      logInfo('testcase list matching skip', { reason: 'duplicate-guard', caseId });
      return true;
    }
    if (caseId === state.lastMatchedCaseId) {
      logInfo('testcase list matching skip', { reason: 'same-as-lastMatchedCaseId', caseId });
      return true;
    }
    state.lastMatchedCaseId = caseId;

    const creatorName = findCreator(doc, title, link);
    const record = upsertRecord({
      entityType: 'testcase',
      action: 'create',
      source: 'tampermonkey',
      clientRecordId: `testcase_${caseId}_${getNow()}`,
      capturedAt: getNow(),
      topHref: cache.topHref || location.href,
      pageUrl: location.href,
      pageType: 'testcase-list',
      scriptVersion: CONFIG.SCRIPT_VERSION,
      detectedAt: getNow(),
      matchedBy: 'title-link+id',
      qaDocMode: doc === document ? 'top' : 'iframe',
      listFilterSnapshot: '',
      draft: { ...cache.draft, creatorName },
      result: { zentaoCaseId: caseId, zentaoCaseUrl: href },
      pushStatus: 'pending',
      pushMessage: '等待推送'
    });

    logInfo('testcase list matched', { caseId, title, creatorName, uniqueKey: record.uniqueKey });
    notifyCaptureSuccess([
      '用例识别成功',
      `用例 ID: ${caseId}`,
      `所属产品: ${record.draft.productName || ''}`,
      `用例名称: ${record.draft.caseTitle || ''}`,
      `相关研发需求: ${record.draft.requirementName || ''}`,
      `创建者: ${record.draft.creatorName || ''}`
    ], `用例已识别: #${caseId}`);

    if (CONFIG.AUTO_PUSH) PushService.pushByUniqueKey(record.uniqueKey, doc, 'testcase-list');
    return true;
  }

  /******************** UI 模块 ********************/
  // 维护说明：悬浮面板定位异常优先检查 positionPanelNearFab 和 handleFabDragMove。
  const UIState = { toastContainer: null, fabEl: null, panelEl: null, dragState: null, justDragged: false };

  const UIService = {
    ensureToastContainer() {
      if (UIState.toastContainer && document.body.contains(UIState.toastContainer)) return UIState.toastContainer;
      const el = document.createElement('div');
      el.id = 'zentao-capture-toast-container';
      el.style.cssText = `position:fixed;right:${CONFIG.UI.TOAST_RIGHT}px;bottom:${CONFIG.UI.TOAST_BOTTOM}px;z-index:${CONFIG.UI.Z_INDEX};display:flex;flex-direction:column;gap:8px;max-width:${CONFIG.UI.TOAST_MAX_WIDTH}px;pointer-events:none;`;
      document.body.appendChild(el);
      UIState.toastContainer = el;
      return el;
    },

    showToast(message, type = 'info', duration = 3000) {
      const container = this.ensureToastContainer();
      const el = document.createElement('div');
      const bg = type === 'success' ? '#16a34a' : (type === 'error' ? '#dc2626' : (type === 'warning' ? '#d97706' : '#2563eb'));
      el.style.cssText = 'background:' + bg + ';color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 6px 18px rgba(0,0,0,0.18);font-size:13px;line-height:1.5;word-break:break-word;pointer-events:auto;';
      el.textContent = message;
      container.appendChild(el);
      setTimeout(() => el.remove(), duration);
    },

    ensureFab() {
      if (UIState.fabEl && document.body.contains(UIState.fabEl)) return UIState.fabEl;
      const fab = document.createElement('button');
      fab.id = 'zentao-capture-fab';
      fab.textContent = '记录';
      fab.style.cssText = `position:fixed;z-index:${CONFIG.UI.Z_INDEX};width:${CONFIG.UI.FAB_SIZE}px;height:${CONFIG.UI.FAB_SIZE}px;border-radius:50%;border:none;background:#2563eb;color:#fff;font-size:14px;cursor:grab;box-shadow:0 8px 20px rgba(0,0,0,0.22);user-select:none;touch-action:none;`;
      const pos = StorageService.getFabPosition();
      if (typeof pos.left === 'number' && typeof pos.top === 'number') {
        fab.style.left = `${pos.left}px`; fab.style.top = `${pos.top}px`;
      } else {
        fab.style.right = `${CONFIG.UI.FAB_RIGHT}px`; fab.style.bottom = `${CONFIG.UI.FAB_BOTTOM}px`;
      }
      fab.addEventListener('click', () => {
        if (UIState.justDragged) { UIState.justDragged = false; return; }
        this.togglePanel();
      });
      fab.addEventListener('pointerdown', (e) => this.startFabDrag(e));
      document.body.appendChild(fab);
      UIState.fabEl = fab;
      return fab;
    },

    startFabDrag(e) {
      if (!UIState.fabEl) return;
      const rect = UIState.fabEl.getBoundingClientRect();
      UIState.dragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, moved: false };
      UIState.fabEl.setPointerCapture?.(e.pointerId);
      UIState.fabEl.style.cursor = 'grabbing';
      window.addEventListener('pointermove', this.handleFabDragMoveBound);
      window.addEventListener('pointerup', this.handleFabDragEndBound);
    },

    handleFabDragMove(e) {
      if (!UIState.dragState || !UIState.fabEl) return;
      const dx = e.clientX - UIState.dragState.startX;
      const dy = e.clientY - UIState.dragState.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) UIState.dragState.moved = true;
      const left = Math.max(0, Math.min(window.innerWidth - UIState.fabEl.offsetWidth, UIState.dragState.origLeft + dx));
      const top = Math.max(0, Math.min(window.innerHeight - UIState.fabEl.offsetHeight, UIState.dragState.origTop + dy));
      UIState.fabEl.style.left = `${left}px`;
      UIState.fabEl.style.top = `${top}px`;
      UIState.fabEl.style.right = 'auto';
      UIState.fabEl.style.bottom = 'auto';
      if (UIState.panelEl && UIState.panelEl.style.display !== 'none') this.positionPanelNearFab();
    },

    handleFabDragEnd() {
      if (!UIState.fabEl) return;
      UIState.justDragged = !!UIState.dragState?.moved;
      if (UIState.dragState?.moved) {
        const left = parseFloat(UIState.fabEl.style.left) || 0;
        const top = parseFloat(UIState.fabEl.style.top) || 0;
        StorageService.saveFabPosition({ left, top });
      }
      UIState.dragState = null;
      UIState.fabEl.style.cursor = 'grab';
      window.removeEventListener('pointermove', this.handleFabDragMoveBound);
      window.removeEventListener('pointerup', this.handleFabDragEndBound);
    },

    ensurePanel() {
      if (UIState.panelEl && document.body.contains(UIState.panelEl)) return UIState.panelEl;
      const panel = document.createElement('div');
      panel.id = 'zentao-capture-panel';
      panel.style.cssText = `position:fixed;z-index:${CONFIG.UI.Z_INDEX};width:${CONFIG.UI.PANEL_WIDTH}px;max-height:${CONFIG.UI.PANEL_MAX_HEIGHT_VH}vh;background:#fff;border-radius:14px;box-shadow:0 12px 28px rgba(0,0,0,0.22);border:1px solid #e5e7eb;overflow:hidden;display:none;font-size:13px;color:#111827;`;
      panel.innerHTML = `
        <div style="padding:12px 14px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <strong>采集记录</strong>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;white-space:nowrap;"><input id="zentao-alert-toggle" type="checkbox" />识别成功弹窗</label>
            <button id="zentao-retry-failed-btn" style="padding:4px 8px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">重试失败项</button>
            <button id="zentao-retry-all-btn" style="padding:4px 8px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">重试全部待推送</button>
            <button id="zentao-close-panel-btn" style="padding:4px 8px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">关闭</button>
          </div>
        </div>
        <div style="padding:10px;border-bottom:1px solid #e5e7eb;display:flex;gap:8px;flex-wrap:wrap;">
          <select id="zentao-filter-entity" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;"><option value="all">全部类型</option><option value="bug">只看Bug</option><option value="testcase">只看用例</option></select>
          <select id="zentao-filter-status" style="padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;"><option value="all">全部状态</option><option value="pending">待推送</option><option value="success">成功</option><option value="failed">失败</option></select>
          <input id="zentao-filter-keyword" placeholder="搜索标题" style="flex:1;min-width:120px;padding:6px 8px;border:1px solid #d1d5db;border-radius:8px;" />
        </div>
        <div id="zentao-capture-panel-list" style="max-height:calc(${CONFIG.UI.PANEL_MAX_HEIGHT_VH}vh - 110px);overflow:auto;padding:10px;"></div>
      `;
      document.body.appendChild(panel);
      UIState.panelEl = panel;

      const filters = StorageService.getPanelFilters();
      panel.querySelector('#zentao-filter-entity').value = filters.entityType || 'all';
      panel.querySelector('#zentao-filter-status').value = filters.pushStatus || 'all';
      panel.querySelector('#zentao-filter-keyword').value = filters.keyword || '';
      panel.querySelector('#zentao-alert-toggle').checked = !!StorageService.getSettings().useAlertOnCapture;

      panel.querySelector('#zentao-close-panel-btn').addEventListener('click', () => {
        panel.style.display = 'none';
        StorageService.savePanelOpen(false);
      });
      panel.querySelector('#zentao-retry-failed-btn').addEventListener('click', async () => {
        for (const item of getRecords().filter((r) => r.pushStatus === 'failed')) await PushService.pushByUniqueKey(item.uniqueKey);
      });
      panel.querySelector('#zentao-retry-all-btn').addEventListener('click', async () => { await PushService.pushAllPendingRecords(); });
      panel.querySelector('#zentao-alert-toggle').addEventListener('change', (e) => {
        const checked = !!e.target.checked;
        StorageService.saveSettings({ useAlertOnCapture: checked });
        this.showToast(`识别成功弹窗已${checked ? '开启' : '关闭'}`, 'info');
      });

      ['#zentao-filter-entity', '#zentao-filter-status', '#zentao-filter-keyword'].forEach((sel) => {
        panel.querySelector(sel).addEventListener('input', () => this.handlePanelFilterChange());
        panel.querySelector(sel).addEventListener('change', () => this.handlePanelFilterChange());
      });

      return panel;
    },

    handlePanelFilterChange() {
      if (!UIState.panelEl) return;
      StorageService.savePanelFilters({
        entityType: UIState.panelEl.querySelector('#zentao-filter-entity').value,
        pushStatus: UIState.panelEl.querySelector('#zentao-filter-status').value,
        keyword: UIState.panelEl.querySelector('#zentao-filter-keyword').value.trim()
      });
      this.renderPanelList();
    },

    positionPanelNearFab() {
      if (!UIState.fabEl || !UIState.panelEl) return;
      const fabRect = UIState.fabEl.getBoundingClientRect();
      const panelWidth = UIState.panelEl.offsetWidth || CONFIG.UI.PANEL_WIDTH;
      const panelHeight = UIState.panelEl.offsetHeight || Math.min(window.innerHeight * 0.76, 620);
      let left = fabRect.left - panelWidth - CONFIG.UI.PANEL_GAP_FROM_FAB;
      let top = fabRect.top;
      if (left < CONFIG.UI.VIEWPORT_PADDING) left = fabRect.right + CONFIG.UI.PANEL_GAP_FROM_FAB;
      if (left + panelWidth > window.innerWidth - CONFIG.UI.VIEWPORT_PADDING) left = Math.max(CONFIG.UI.VIEWPORT_PADDING, window.innerWidth - panelWidth - CONFIG.UI.VIEWPORT_PADDING);
      if (top + panelHeight > window.innerHeight - CONFIG.UI.VIEWPORT_PADDING) top = Math.max(CONFIG.UI.VIEWPORT_PADDING, window.innerHeight - panelHeight - CONFIG.UI.VIEWPORT_PADDING);
      if (top < CONFIG.UI.VIEWPORT_PADDING) top = CONFIG.UI.VIEWPORT_PADDING;
      UIState.panelEl.style.left = `${left}px`;
      UIState.panelEl.style.top = `${top}px`;
    },

    togglePanel() {
      const panel = this.ensurePanel();
      if (panel.style.display === 'none') {
        panel.querySelector('#zentao-alert-toggle').checked = !!StorageService.getSettings().useAlertOnCapture;
        panel.style.display = 'block';
        StorageService.savePanelOpen(true);
        requestAnimationFrame(() => {
          this.positionPanelNearFab();
          this.renderPanelList();
        });
      } else {
        panel.style.display = 'none';
        StorageService.savePanelOpen(false);
      }
    },

    getPanelFilteredRecords() {
      const filters = StorageService.getPanelFilters();
      return getRecords().filter((item) => {
        if (filters.entityType !== 'all' && item.entityType !== filters.entityType) return false;
        if (filters.pushStatus !== 'all' && item.pushStatus !== filters.pushStatus) return false;
        const title = item.entityType === 'bug' ? item.draft?.bugTitle : item.draft?.caseTitle;
        if (filters.keyword && !String(title || '').toLowerCase().includes(filters.keyword.toLowerCase())) return false;
        return true;
      });
    },

    renderPanelList() {
      const panel = this.ensurePanel();
      const listEl = panel.querySelector('#zentao-capture-panel-list');
      if (!listEl) return;
      const records = this.getPanelFilteredRecords();
      if (!records.length) {
        listEl.innerHTML = '<div style="padding:8px;color:#6b7280;">暂无匹配记录</div>';
        return;
      }

      listEl.innerHTML = records.map((item) => {
        const isBug = item.entityType === 'bug';
        const title = isBug ? item.draft?.bugTitle : item.draft?.caseTitle;
        const id = isBug ? item.result?.zentaoBugId : item.result?.zentaoCaseId;
        const url = isBug ? item.result?.zentaoBugUrl : item.result?.zentaoCaseUrl;
        const statusColor = item.pushStatus === 'success' ? '#16a34a' : (item.pushStatus === 'failed' ? '#dc2626' : '#d97706');
        const linkedCaseId = item.draft?.linkedCaseId || item.result?.linkedCaseId || '';
        const linkedCaseHref = item.draft?.linkedCaseHref || item.result?.linkedCaseHref || '';
        const fieldsHtml = isBug ? `
          <div><strong>所属产品：</strong>${escapeHtml(item.draft?.productName || '')}</div>
          <div><strong>所属项目：</strong>${escapeHtml(item.draft?.projectName || '')}</div>
          <div><strong>影响版本：</strong>${escapeHtml(item.draft?.affectedVersion || '')}</div>
          <div><strong>所属执行：</strong>${escapeHtml(item.draft?.executionName || '')}</div>
          <div><strong>相关需求：</strong>${escapeHtml(item.draft?.requirementName || '')}</div>
          <div><strong>创建者：</strong>${escapeHtml(item.draft?.creatorName || '')}</div>
          ${linkedCaseId ? `<div><strong>来源用例 ID：</strong>${escapeHtml(linkedCaseId)}</div>` : ''}
          ${linkedCaseHref ? `<div><strong>来源用例链接：</strong><a href="${escapeHtml(linkedCaseHref)}" target="_blank" style="color:#2563eb;">${escapeHtml(linkedCaseHref)}</a></div>` : ''}
        ` : `
          <div><strong>所属产品：</strong>${escapeHtml(item.draft?.productName || '')}</div>
          <div><strong>相关研发需求：</strong>${escapeHtml(item.draft?.requirementName || '')}</div>
          <div><strong>创建者：</strong>${escapeHtml(item.draft?.creatorName || '')}</div>
        `;
        return `
          <div style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
              <div><strong>${isBug ? 'Bug' : '用例'}</strong><span style="margin-left:8px;color:${statusColor};font-weight:600;">${escapeHtml(item.pushStatus)}</span></div>
              <div style="display:flex;gap:6px;align-items:center;">
                <button data-unique-key="${escapeHtml(item.uniqueKey)}" class="zentao-retry-one-btn" style="padding:2px 8px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">重试</button>
                ${item.pushStatus === 'failed' ? `<button data-unique-key="${escapeHtml(item.uniqueKey)}" class="zentao-delete-one-btn" style="padding:2px 8px;border:1px solid #ef4444;background:#fff;color:#ef4444;border-radius:8px;cursor:pointer;">删除</button>` : ''}
              </div>
            </div>
            <div style="margin-top:8px;"><strong>标题：</strong>${escapeHtml(title || '')}</div>
            <div><strong>编号：</strong>${escapeHtml(id || '')}</div>
            <div><strong>地址：</strong>${url ? `<a href="${escapeHtml(url)}" target="_blank" style="color:#2563eb;">${escapeHtml(url)}</a>` : ''}</div>
            ${fieldsHtml}
            <div><strong>采集时间：</strong>${escapeHtml(formatTime(item.capturedAt))}</div>
            <div><strong>最近推送：</strong>${escapeHtml(formatTime(item.lastPushAt))}</div>
            <div><strong>重试次数：</strong>${escapeHtml(String(item.retryCount || 0))}</div>
            <div><strong>消息：</strong>${escapeHtml(item.pushMessage || '')}</div>
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.zentao-retry-one-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const uniqueKey = btn.getAttribute('data-unique-key');
          if (uniqueKey) await PushService.pushByUniqueKey(uniqueKey);
        });
      });

      listEl.querySelectorAll('.zentao-delete-one-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const uniqueKey = btn.getAttribute('data-unique-key');
          if (!uniqueKey) return;
          const ok = confirm('确认删除这条失败记录吗？删除后将不再自动推送。');
          if (!ok) return;

          const removed = deleteRecord(uniqueKey);
          if (removed) {
            logInfo('record deleted', { uniqueKey });
            this.showToast('记录已删除，后续不会再推送该条', 'success');
          } else {
            this.showToast('删除失败：未找到记录', 'warning');
          }
        });
      });
    }
  };

  UIService.handleFabDragMoveBound = (e) => UIService.handleFabDragMove(e);
  UIService.handleFabDragEndBound = () => UIService.handleFabDragEnd();

  /******************** 主状态管理模块 ********************/
  const RuntimeState = {
    lastQaDoc: null,
    lastPageType: 'other',
    lastBindPageKey: '',
    boundForms: new WeakSet(),
    boundSaveControls: new WeakSet(),
    lastMatchedBugId: '',
    lastMatchedCaseId: '',
    lastRetryAt: 0,
    lastBugListScanAt: 0,
    lastTestcaseListScanAt: 0,
    recentMatchMap: {},
    fabMissCount: 0,
    lastFabTargetAt: 0,
    lastFabCheckPageType: '',
    lastFabCheckShouldShow: null,
    isFabVisible: false
  };

  function shouldSkipListScan(entityType) {
    const nowTs = getNow();
    if (entityType === 'bug') {
      if (nowTs - RuntimeState.lastBugListScanAt < CONFIG.LIST_SCAN_DEBOUNCE_MS) return true;
      RuntimeState.lastBugListScanAt = nowTs;
      return false;
    }
    if (entityType === 'testcase') {
      if (nowTs - RuntimeState.lastTestcaseListScanAt < CONFIG.LIST_SCAN_DEBOUNCE_MS) return true;
      RuntimeState.lastTestcaseListScanAt = nowTs;
      return false;
    }
    return false;
  }

  function isDuplicateMatchGuard(key) {
    const nowTs = getNow();
    for (const k of Object.keys(RuntimeState.recentMatchMap)) {
      if (nowTs - RuntimeState.recentMatchMap[k] >= CONFIG.DUPLICATE_MATCH_GUARD_MS) {
        delete RuntimeState.recentMatchMap[k];
      }
    }
    const lastTs = RuntimeState.recentMatchMap[key] || 0;
    if (nowTs - lastTs < CONFIG.DUPLICATE_MATCH_GUARD_MS) return true;
    RuntimeState.recentMatchMap[key] = nowTs;
    return false;
  }

  function resetCreateBindStateIfNeeded(doc, pageType) {
    const pageKey = `${pageType}|${location.href}`;
    if (RuntimeState.lastQaDoc !== doc || RuntimeState.lastBindPageKey !== pageKey) {
      RuntimeState.lastQaDoc = doc;
      RuntimeState.lastBindPageKey = pageKey;
      RuntimeState.boundForms = new WeakSet();
      RuntimeState.boundSaveControls = new WeakSet();
    }
  }

  function bindCreatePageHandlers(doc, pageType) {
    if (!doc) return;
    resetCreateBindStateIfNeeded(doc, pageType);

    const saveCurrentDraft = () => {
      if (pageType === 'bug-create') saveBugCreateContext(doc);
      else if (pageType === 'testcase-create') saveTestcaseCreateContext(doc);
    };

    const forms = [...doc.querySelectorAll('form')];
    forms.forEach((form) => {
      if (RuntimeState.boundForms.has(form)) return;
      form.addEventListener('submit', saveCurrentDraft, true);
      RuntimeState.boundForms.add(form);
    });

    const controls = findSaveControls(doc);
    controls.forEach((control) => {
      if (RuntimeState.boundSaveControls.has(control)) return;
      control.addEventListener('click', saveCurrentDraft, true);
      RuntimeState.boundSaveControls.add(control);
    });

    if (forms.length || controls.length) {
      logInfo('create page handlers bound', { pageType, forms: forms.length, saveControls: controls.length });
    }
  }

  /******************** 主循环入口 ********************/
  function runAutoRetryIfNeeded(qaDoc, pageType) {
    if (!CONFIG.AUTO_PUSH) return;
    if (getNow() - RuntimeState.lastRetryAt <= CONFIG.RETRY_INTERVAL_MS) return;
    RuntimeState.lastRetryAt = getNow();
    const pending = getPendingOrFailedRecords();
    if (!pending.length) return;
    logInfo('auto retry tick', { pendingCount: pending.length });
    PushService.pushAllPendingRecords(qaDoc, pageType);
  }

  function updateFabVisibility(qaDoc, pageType) {
    const nowTs = getNow();
    const targetPage = pageType !== 'other';

    if (RuntimeState.lastFabCheckPageType !== pageType || RuntimeState.lastFabCheckShouldShow !== targetPage) {
      logInfo('fab visibility check', { pageType, shouldShowFab: targetPage });
      RuntimeState.lastFabCheckPageType = pageType;
      RuntimeState.lastFabCheckShouldShow = targetPage;
    }

    if (targetPage) {
      RuntimeState.fabMissCount = 0;
      RuntimeState.lastFabTargetAt = nowTs;
      UIService.ensureFab().style.display = 'block';
      RuntimeState.isFabVisible = true;
      return;
    }

    // 面板打开时用户正在主动使用，不触发隐藏逻辑
    const isPanelOpen = UIState.panelEl && UIState.panelEl.style.display !== 'none';
    if (isPanelOpen) {
      RuntimeState.fabMissCount = 0;
      RuntimeState.lastFabTargetAt = nowTs;
      return;
    }

    RuntimeState.fabMissCount += 1;
    const inGraceByTime = (nowTs - RuntimeState.lastFabTargetAt) <= CONFIG.FAB_HIDE_GRACE_MS;
    const inGraceByCount = RuntimeState.fabMissCount < CONFIG.FAB_HIDE_MISS_COUNT;

    if (inGraceByTime || inGraceByCount) {
      logInfo('fab keep visible (grace)', {
        missCount: RuntimeState.fabMissCount,
        inGraceByTime,
        inGraceByCount
      });
      return;
    }

    if (UIState.fabEl) {
      UIState.fabEl.style.display = 'none';
      if (UIState.panelEl) UIState.panelEl.style.display = 'none';
      StorageService.savePanelOpen(false);
    }
    RuntimeState.isFabVisible = false;
    logInfo('fab hidden after debounce', {
      missCount: RuntimeState.fabMissCount,
      elapsedMs: nowTs - RuntimeState.lastFabTargetAt
    });
  }

  function tick() {
    const qaDoc = getQaDoc();
    if (!qaDoc?.body) return;

    const pageType = detectPageType(qaDoc);
    if (pageType !== RuntimeState.lastPageType) {
      RuntimeState.lastPageType = pageType;
      logInfo('page detected', {
        pageType,
        href: location.href,
        qaDocMode: qaDoc === document ? 'top' : 'iframe'
      });
    }

    updateFabVisibility(qaDoc, pageType);

    if (pageType === 'bug-create' || pageType === 'testcase-create') {
      bindCreatePageHandlers(qaDoc, pageType);
    }

    if (pageType === 'bug-list') {
      tryMatchBugListPage(qaDoc, RuntimeState);
    }

    if (pageType === 'testcase-list') {
      tryMatchTestcaseListPage(qaDoc, RuntimeState);
    }

    runAutoRetryIfNeeded(qaDoc, pageType);
  }

  function boot() {
    logInfo('boot', {
      scriptVersion: CONFIG.SCRIPT_VERSION,
      href: location.href,
      autoPush: CONFIG.AUTO_PUSH,
      endpoint: getSyncEndpoint(),
      debug: !!CONFIG.DEBUG,
      hasSyncKey: !!CONFIG.SYNC_API_KEY,
      useAlertOnCapture: !!StorageService.getSettings().useAlertOnCapture
    });

    UIService.ensureToastContainer();
    if (StorageService.getPanelOpen()) {
      const qaDoc = getQaDoc();
      if (qaDoc?.body && shouldShowFab(qaDoc)) {
        UIService.ensureFab().style.display = 'block';
        const panel = UIService.ensurePanel();
        panel.style.display = 'block';
        requestAnimationFrame(() => UIService.positionPanelNearFab());
      }
    }
    window.addEventListener('resize', () => {
      if (UIState.panelEl && UIState.panelEl.style.display !== 'none') UIService.positionPanelNearFab();
    });
    setInterval(tick, CONFIG.TICK_INTERVAL_MS);
  }

  boot();
})();

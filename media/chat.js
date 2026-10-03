"use strict";
(() => {
  // src/webview/vscode-api.ts
  var vscode = acquireVsCodeApi();
  function post(kind, payload) {
    vscode.postMessage(payload === void 0 ? { kind } : { kind, payload });
  }

  // src/webview/dom.ts
  var messagesEl = document.getElementById("messages");
  var inputEl = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var btnReload = document.getElementById("btn-reload");
  var statusBarEl = document.getElementById("status-bar");
  var sbCost = document.getElementById("sb-cost");
  var sbOut = document.getElementById("sb-out");
  var sbCache = document.getElementById("sb-cache");
  var sbBattery = document.getElementById("sb-battery");
  var sbBatteryFill = document.getElementById("sb-battery-fill");
  var sbBatteryPct = document.getElementById("sb-battery-pct");
  var footModel = document.getElementById("foot-model");
  var footCwd = document.getElementById("foot-cwd");
  var inputAreaEl = document.getElementById("input-area");
  var topArea = document.getElementById("top-area");
  var noticeToolbar = document.getElementById("notice-toolbar");
  var noticePanel = document.getElementById("notice-panel");
  var noticeList = document.getElementById("notice-list");
  var noticeEmpty = document.getElementById("notice-empty");
  var noticeCount = document.getElementById("notice-count");
  var noticeBell = document.getElementById("notice-bell");
  var noticeBadge = document.getElementById("notice-badge");
  var noticeCollapse = document.getElementById("notice-collapse");
  var noticeClear = document.getElementById("notice-clear");
  var noticeSettings = document.getElementById("notice-settings");

  // src/webview/state.ts
  var ui = {
    // ── 渲染模型（每个内容段 = 一个独立气泡）──
    /** 当前消息角色（决定对齐） */
    role: "assistant",
    /** 当前正在流式追加的气泡元素 */
    bubble: null,
    /** 最近一个思考气泡（thinking_end 时用它改文案 ✓） */
    lastThinkBubble: null,
    /** 思考开始时间（0 = 未在思考） */
    thinkStartAt: 0,
    /** 占位三点（发送后、首个数据包到达前） */
    pendingEl: null,
    /** 重连提示气泡（同一气泡原地更新 ✓） */
    retryNoticeEl: null,
    // ── 行为开关 ──
    /** 自动滚到底（用户往上翻时自动关闭 ✓） */
    autoScroll: true,
    /** 用户是否主动中断过当前任务
     *  ★ 用途：auto_retry_end 的 success 无法区分【被中断】和【真连上】✗
     *    实测两者都是 { success:true, attempt:N }（无 finalError）—— 结构一模一样 ✗ */
    userAborted: false,
    // ── 由设置驱动（applyStyleVars 时更新）──
    /** 默认折叠·思考 */
    defaultThinkCollapsed: false,
    /** 默认折叠·工具 */
    defaultToolCollapsed: false,
    // ── 顶栏 ──
    /** modelId → contextWindow（宿主推送；查不到则电池显示 "?"） */
    modelLimits: {},
    // ── 通知板（B8）──
    /** 通知镜像（权威在插件端 ✓ 这里只负责显示） */
    notices: [],
    /** 面板是否已展开 */
    panelExpanded: false,
    /** 未读数（收起状态下新到的通知数） */
    noticeUnread: 0
  };

  // src/webview/format.ts
  function fmtNum(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
    return String(v);
  }
  function fmtCost(c) {
    const v = Number(c) || 0;
    if (v === 0) return "0";
    if (v < 1e-3) return v.toFixed(6);
    if (v < 1) return v.toFixed(4);
    return v.toFixed(2);
  }
  function shortenPath(p, max) {
    const n = max || 40;
    return p.length <= n ? p : "\u2026" + p.slice(-(n - 1));
  }
  function cssNum(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function lineHeightOf(el) {
    const cs = getComputedStyle(el);
    return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
  }

  // src/webview/input.ts
  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    ui.userAborted = false;
    vscode.postMessage({ kind: "prompt", text });
    inputEl.value = "";
    autoGrow();
  }
  function syncPadding() {
    messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + 8 + "px";
  }
  function autoGrow() {
    const lineH = lineHeightOf(inputEl);
    const minH = cssNum("--pi-input-min-rows", 1) * lineH;
    const maxH = Math.max(cssNum("--pi-input-max-rows", 8) * lineH, minH);
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, minH), maxH) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > maxH ? "auto" : "hidden";
    syncPadding();
  }
  function setAgentState(state) {
    const busy = state === "working";
    sendBtn.classList.toggle("busy", busy);
    sendBtn.title = busy ? "\u70B9\u51FB\u4E2D\u65AD" : "\u53D1\u9001 (Enter)";
  }
  function showCwd(p) {
    footCwd.textContent = shortenPath(p, 40);
    footCwd.title = p;
  }
  function applyStyleVars(vars) {
    const root = document.documentElement;
    const names = [];
    for (let i = 0; i < root.style.length; i++) names.push(root.style[i]);
    for (const n of names) {
      if (n.startsWith("--pi-")) root.style.removeProperty(n);
    }
    for (const [k, v] of Object.entries(vars ?? {})) {
      root.style.setProperty(k, v);
    }
    root.classList.toggle("centered", !!vars && vars["--pi-centered-mode"] === "on");
    ui.defaultThinkCollapsed = !!vars && vars["--pi-think-collapsed"] === "on";
    ui.defaultToolCollapsed = !!vars && vars["--pi-tool-collapsed"] === "on";
  }
  function setupInput() {
    sendBtn.addEventListener("click", () => {
      if (sendBtn.classList.contains("busy")) {
        ui.userAborted = true;
        vscode.postMessage({ kind: "abort" });
      } else {
        send();
      }
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    inputEl.addEventListener("input", autoGrow);
    window.addEventListener("resize", autoGrow);
    autoGrow();
    btnReload.addEventListener("click", () => {
      vscode.postMessage({ kind: "reloadPi" });
    });
  }

  // src/webview/noticeboard.ts
  var NOTICE_ICON = {
    info: "\u24D8",
    success: "\u2713",
    warn: "\u26A0",
    error: "\u2716"
  };
  function createNoticeItem(n) {
    const el = document.createElement("div");
    el.className = "notice-item";
    el.dataset.level = n.level;
    el.dataset.id = String(n.id);
    const icon = document.createElement("span");
    icon.className = "ni-icon";
    icon.textContent = NOTICE_ICON[n.level] ?? "\u24D8";
    const time = document.createElement("span");
    time.className = "ni-time";
    time.textContent = formatTime(n.time);
    time.title = new Date(n.time).toLocaleString();
    const text = document.createElement("span");
    text.className = "ni-text";
    text.textContent = n.text;
    text.addEventListener("click", () => {
    });
    const copyBtn = document.createElement("button");
    copyBtn.className = "ni-btn";
    copyBtn.textContent = "\u29C9";
    copyBtn.title = "\u590D\u5236";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(n.text);
    });
    const closeBtn = document.createElement("button");
    closeBtn.className = "ni-btn";
    closeBtn.textContent = "\u2715";
    closeBtn.title = "\u5173\u95ED";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "noticeRemove", id: n.id });
    });
    el.append(icon, time, text, copyBtn, closeBtn);
    return el;
  }
  function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function syncBadge() {
    const hasUnread = ui.noticeUnread > 0;
    noticeBell.textContent = hasUnread ? "\u{1F514}" : "\u{1F515}";
    noticeBadge.classList.toggle("has-unread", hasUnread);
    noticeCount.textContent = String(ui.notices.length);
    noticeEmpty.style.display = ui.notices.length ? "none" : "";
    noticeBadge.title = ui.notices.length ? `\u901A\u77E5\uFF08${ui.notices.length} \u6761\uFF09` : "\u901A\u77E5";
  }
  function renderNotices() {
    noticeList.innerHTML = "";
    for (const n of ui.notices) noticeList.appendChild(createNoticeItem(n));
    syncBadge();
  }
  function appendNotice(n) {
    ui.notices.push(n);
    noticeList.appendChild(createNoticeItem(n));
    if (!ui.panelExpanded) ui.noticeUnread++;
    syncBadge();
  }
  function removeNotice(id) {
    ui.notices = ui.notices.filter((n) => n.id !== id);
    noticeList.querySelector('.notice-item[data-id="' + id + '"]')?.remove();
    syncBadge();
  }
  function resetNotices(list) {
    ui.notices = Array.isArray(list) ? list.slice() : [];
    ui.noticeUnread = 0;
    renderNotices();
    setExpanded(false);
  }
  function clearNotices() {
    ui.notices = [];
    renderNotices();
  }
  function setExpanded(next) {
    ui.panelExpanded = typeof next === "boolean" ? next : !ui.panelExpanded;
    topArea.classList.toggle("expanded", ui.panelExpanded);
    noticeToolbar.classList.toggle("collapsed", !ui.panelExpanded);
    noticePanel.classList.toggle("collapsed", !ui.panelExpanded);
    if (ui.panelExpanded) {
      ui.noticeUnread = 0;
      syncBadge();
    }
  }
  function setupNoticeBoard() {
    statusBarEl.addEventListener("click", () => setExpanded());
    noticeCollapse.addEventListener("click", () => setExpanded(false));
    noticeClear.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "noticeClearAll" });
    });
    noticeSettings.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    setupDragGesture();
    syncBadge();
  }
  function setupDragGesture() {
    let dragStartY = 0;
    let dragging = false;
    const THRESHOLD = 28;
    statusBarEl.addEventListener("pointerdown", (e) => {
      if (ui.panelExpanded) return;
      dragging = true;
      dragStartY = e.clientY;
      statusBarEl.setPointerCapture(e.pointerId);
    });
    noticeCollapse.addEventListener("pointerdown", (e) => {
      dragging = true;
      dragStartY = e.clientY;
      noticeCollapse.setPointerCapture(e.pointerId);
    });
    statusBarEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (e.clientY - dragStartY >= THRESHOLD) {
        dragging = false;
        setExpanded(true);
      }
    });
    noticeCollapse.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (e.clientY - dragStartY >= THRESHOLD) {
        dragging = false;
        setExpanded(false);
      }
    });
    const stop = () => {
      dragging = false;
    };
    statusBarEl.addEventListener("pointerup", stop);
    noticeCollapse.addEventListener("pointerup", stop);
    statusBarEl.addEventListener("pointercancel", stop);
    noticeCollapse.addEventListener("pointercancel", stop);
  }

  // src/webview/bubbles.ts
  function scrollToBottom() {
    if (ui.autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  messagesEl.addEventListener("scroll", () => {
    ui.autoScroll = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  });
  function createBubble(kind) {
    const div = document.createElement("div");
    div.className = "bubble " + kind;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }
  var CARET_SVG = '<svg class="head-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  function createHead(labelText, onToggle) {
    const head = document.createElement("div");
    head.className = "head";
    const btn = document.createElement("button");
    btn.className = "head-toggle";
    const label = document.createElement("span");
    label.className = "head-label";
    label.textContent = labelText;
    btn.appendChild(label);
    btn.insertAdjacentHTML("beforeend", CARET_SVG);
    btn.addEventListener("click", onToggle);
    const actions = document.createElement("span");
    actions.className = "head-actions";
    head.appendChild(btn);
    head.appendChild(actions);
    return head;
  }
  function showPending() {
    if (ui.pendingEl) return;
    const el = document.createElement("div");
    el.className = "bubble pending";
    el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    messagesEl.appendChild(el);
    ui.pendingEl = el;
    scrollToBottom();
  }
  function removePending() {
    if (ui.pendingEl) {
      ui.pendingEl.remove();
      ui.pendingEl = null;
    }
  }

  // src/webview/thinking.ts
  function createThinkingBubble(label) {
    const div = document.createElement("div");
    div.className = "bubble thinking";
    div.dataset.open = ui.defaultThinkCollapsed ? "false" : "true";
    const head = createHead(label || "\u6B63\u5728\u601D\u8003\u2026", () => {
      div.dataset.open = div.dataset.open === "true" ? "false" : "true";
    });
    head.querySelector(".head-label").classList.add("think-label");
    const body = document.createElement("div");
    body.className = "think-body";
    div.appendChild(head);
    div.appendChild(body);
    messagesEl.appendChild(div);
    scrollToBottom();
    ui.lastThinkBubble = div;
    return div;
  }
  function markThinkDone() {
    if (!ui.lastThinkBubble) return;
    const sec = ui.thinkStartAt ? ((Date.now() - ui.thinkStartAt) / 1e3).toFixed(1) : null;
    const label = ui.lastThinkBubble.querySelector(".think-label");
    if (label) label.textContent = sec ? `\u5DF2\u601D\u8003\uFF08\u7528\u65F6 ${sec} \u79D2\uFF09` : "\u5DF2\u601D\u8003";
  }

  // src/webview/segments.ts
  function appendSegment(kind, text) {
    removePending();
    if (kind === "thinking") {
      if (!ui.bubble || !ui.bubble.classList.contains("thinking")) {
        ui.bubble = createThinkingBubble();
        if (!ui.thinkStartAt) ui.thinkStartAt = Date.now();
      }
      ui.bubble.querySelector(".think-body").textContent += text;
    } else {
      if (!ui.bubble || !ui.bubble.classList.contains(kind)) {
        ui.bubble = createBubble(kind);
      }
      ui.bubble.textContent += text;
    }
    scrollToBottom();
  }

  // src/webview/tool.ts
  function createToolBubble(callId, toolName) {
    const div = document.createElement("div");
    div.className = "bubble tool";
    div.dataset.callId = callId;
    div.dataset.open = ui.defaultToolCollapsed ? "false" : "true";
    const head = createHead("\u{1F527} " + (toolName || "tool"), () => {
      div.dataset.open = div.dataset.open === "true" ? "false" : "true";
    });
    const body = document.createElement("div");
    body.className = "tool-body";
    const call = document.createElement("div");
    call.className = "tool-call";
    const args = document.createElement("div");
    args.className = "tool-args";
    call.appendChild(args);
    body.appendChild(call);
    div.appendChild(head);
    div.appendChild(body);
    document.getElementById("messages").appendChild(div);
    ui.bubble = div;
    scrollToBottom();
    return div;
  }
  function markStreamingDone(bubble) {
    const host = bubble.querySelector(".tool-result");
    if (host) host.dataset.streaming = "false";
  }
  function setToolState(bubble, state) {
    let el = bubble.querySelector(".tool-state");
    if (!el) {
      el = document.createElement("span");
      el.className = "tool-state";
      const toggle = bubble.querySelector(".head-toggle");
      if (toggle) toggle.appendChild(el);
    }
    el.className = "tool-state " + state;
    el.textContent = state === "running" ? "" : state === "error" ? "\u2717" : "\u2713";
  }
  function renderArgs(bubble, args) {
    const host = bubble.querySelector(".tool-args");
    if (!host) return;
    host.innerHTML = "";
    if (args === void 0 || args === null) return;
    if (typeof args !== "object" || Array.isArray(args)) {
      host.textContent = JSON.stringify(args, null, 2);
      return;
    }
    const entries = Object.entries(args);
    if (!entries.length) {
      host.textContent = "\uFF08\u65E0\u53C2\u6570\uFF09";
      return;
    }
    for (const [k, v] of entries) {
      const row = document.createElement("div");
      row.className = "arg-row";
      row.dataset.open = "true";
      const toggle = document.createElement("button");
      toggle.className = "arg-toggle";
      toggle.insertAdjacentHTML("beforeend", CARET_SVG);
      const key = document.createElement("span");
      key.className = "arg-key";
      key.textContent = k;
      toggle.appendChild(key);
      toggle.addEventListener("click", () => {
        row.dataset.open = row.dataset.open === "true" ? "false" : "true";
      });
      const val = document.createElement("span");
      val.className = "arg-val";
      val.textContent = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      row.appendChild(toggle);
      row.appendChild(val);
      host.appendChild(row);
    }
  }
  function ensureResultHost(bubble) {
    let host = bubble.querySelector(".tool-result");
    if (host) return host;
    host = document.createElement("div");
    host.className = "tool-result";
    host.dataset.open = "true";
    const head = document.createElement("button");
    head.className = "result-toggle";
    head.insertAdjacentHTML("beforeend", CARET_SVG);
    head.insertAdjacentHTML("beforeend", '<span class="result-label"></span>');
    head.addEventListener("click", () => {
      host.dataset.open = host.dataset.open === "true" ? "false" : "true";
    });
    const body = document.createElement("div");
    body.className = "result-body";
    host.appendChild(head);
    host.appendChild(body);
    (bubble.querySelector(".tool-body") || bubble).appendChild(host);
    return host;
  }
  function renderResultParts(bubble, parts, isError, streaming) {
    const host = ensureResultHost(bubble);
    host.classList.toggle("error", !!isError && !streaming);
    const body = host.querySelector(".result-body");
    body.innerHTML = "";
    for (const p of parts || []) {
      const t = p?.type;
      if (t === "text") {
        const el = document.createElement("div");
        el.className = "part-text";
        el.textContent = p.text ?? "";
        body.appendChild(el);
      } else if (t === "image") {
        const img = document.createElement("img");
        img.className = "part-image";
        img.alt = "\u56FE\u50CF\u8F93\u51FA";
        const mime = p.mimeType || "image/png";
        const data = p.data;
        if (typeof data === "string") img.src = "data:" + mime + ";base64," + data;
        body.appendChild(img);
      } else {
        const pre = document.createElement("pre");
        pre.className = "part-unknown";
        pre.textContent = JSON.stringify(p, null, 2);
        body.appendChild(pre);
      }
    }
    if (!body.childElementCount) body.textContent = streaming ? "" : "\uFF08\u65E0\u8F93\u51FA\uFF09";
    scrollToBottom();
  }

  // src/webview/notices.ts
  function showRetryNotice(p) {
    removePending();
    let el = ui.retryNoticeEl;
    if (!el || el.dataset.final === "true") {
      el = document.createElement("div");
      el.className = "bubble notice retry";
      el.dataset.final = "false";
      messagesEl.appendChild(el);
      ui.retryNoticeEl = el;
    }
    const isFinal = p.final === true;
    el.dataset.final = isFinal ? "true" : "false";
    const aborted = isFinal && ui.userAborted;
    const ok = isFinal && p.success === true && !aborted;
    el.classList.toggle("failed", aborted || isFinal && !ok);
    el.classList.toggle("retrying", !isFinal);
    el.classList.toggle("ok", ok);
    const attempt = p.attempt && p.maxAttempts ? p.attempt + "/" + p.maxAttempts : p.attempt ? String(p.attempt) : "";
    let text;
    if (isFinal) {
      if (aborted) {
        text = "\u5DF2\u4E2D\u65AD";
      } else if (ok) {
        text = "\u91CD\u8FDE\u6210\u529F" + (attempt ? "\uFF08\u7B2C " + attempt + " \u6B21\u5C1D\u8BD5\uFF09" : "");
      } else {
        text = "\u91CD\u8FDE\u5931\u8D25" + (attempt ? "\uFF08\u5DF2\u5C1D\u8BD5 " + attempt + " \u6B21\uFF09" : "") + "\uFF1A" + (p.message || "\u672A\u77E5\u9519\u8BEF");
      }
    } else {
      const parts = ["\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8BD5"];
      if (attempt) parts.push("\uFF08" + attempt + "\uFF09");
      if (p.message) parts.push(" \xB7 " + p.message);
      if (p.delayMs) parts.push(" \xB7 " + Math.round(p.delayMs / 1e3) + " \u79D2\u540E");
      text = parts.join("");
    }
    const icon = isFinal ? aborted ? '<span class="notice-mark">\u25A0</span>' : ok ? '<span class="notice-mark">\u2713</span>' : '<span class="notice-mark">\u2716</span>' : '<span class="retry-spin"></span>';
    el.innerHTML = icon + '<span class="notice-text"></span>';
    el.querySelector(".notice-text").textContent = text;
    scrollToBottom();
  }
  function appendStopNote(reason) {
    const all = messagesEl.querySelectorAll(".bubble:not(.user):not(.pending):not(.notice)");
    const target = all[all.length - 1];
    if (!target) return;
    if (target.querySelector(".bubble-note")) return;
    const MAP = {
      length: { icon: "\u26A0", text: "\u8F93\u51FA\u8FBE\u5230\u957F\u5EA6\u4E0A\u9650\uFF0C\u5DF2\u622A\u65AD", cls: "warn" },
      aborted: { icon: "\u25A0", text: "\u5DF2\u4E2D\u65AD", cls: "info" },
      error: { icon: "\u2716", text: "\u751F\u6210\u51FA\u9519", cls: "error" }
    };
    const m = MAP[reason] ?? { icon: "\u2022", text: reason, cls: "info" };
    const el = document.createElement("div");
    el.className = "bubble-note " + m.cls;
    el.textContent = m.icon + " " + m.text;
    target.appendChild(el);
    scrollToBottom();
  }

  // src/webview/topbar.ts
  function updateStatusBar(usage, model) {
    const u = usage || {};
    if (model) {
      footModel.textContent = model;
      footModel.title = "\u5F53\u524D\u6A21\u578B\uFF1A" + model;
    }
    sbCost.textContent = "\xA5 " + fmtCost(u.cost && u.cost.total);
    sbOut.textContent = "out " + fmtNum(u.output);
    const inp = Number(u.input) || 0;
    const cr = Number(u.cacheRead) || 0;
    const hit = inp + cr > 0 ? Math.round(cr / (inp + cr) * 100) : 0;
    sbCache.textContent = "cache " + hit + "%";
    const total = Number(u.totalTokens) || 0;
    const limit = model ? ui.modelLimits[model] : void 0;
    if (typeof limit === "number" && limit > 0) {
      const usedPct = Math.max(0, Math.min(100, Math.round(total / limit * 100)));
      const remain = 100 - usedPct;
      statusBarEl.classList.remove("no-limit");
      sbBatteryFill.style.width = remain + "%";
      sbBatteryPct.textContent = String(remain);
      sbBattery.classList.toggle("low", remain <= 25);
      sbBattery.classList.toggle("empty", remain <= 5);
    } else {
      statusBarEl.classList.add("no-limit");
      sbBatteryPct.textContent = "?";
    }
  }

  // src/webview/apply.ts
  function replaySnapshot(payload) {
    const snap = payload ?? {};
    const bubbles = Array.isArray(snap.bubbles) ? snap.bubbles : [];
    messagesEl.innerHTML = "";
    ui.bubble = null;
    ui.pendingEl = null;
    ui.lastThinkBubble = null;
    resetNotices(snap.notices ?? []);
    for (const b of bubbles) {
      ui.role = b.role;
      if (b.role === "user") {
        const el = createBubble("user");
        el.textContent = b.blocks.map((x) => x.text ?? "").join("");
        ui.bubble = null;
        continue;
      }
      let last = null;
      for (const blk of b.blocks) {
        if (blk.type === "tool") {
          last = createToolBubble(blk.toolCallId || "", blk.toolName);
          renderArgs(last, blk.args);
          if (blk.resultParts !== void 0) {
            renderResultParts(last, blk.resultParts, blk.resultIsError === true, false);
            setToolState(last, blk.resultIsError ? "error" : "ok");
          } else if (blk.partialParts !== void 0) {
            renderResultParts(last, blk.partialParts, false, blk.executing === true);
            setToolState(last, blk.executing ? "running" : "ok");
            if (blk.executing) ensureResultHost(last).dataset.streaming = "true";
          } else {
            setToolState(last, blk.executing ? "running" : "ok");
          }
        } else if (blk.type === "thinking") {
          if (!last || !last.classList.contains("thinking")) {
            last = createThinkingBubble("\u5DF2\u601D\u8003");
          }
          last.querySelector(".think-body").textContent += blk.text ?? "";
        } else {
          if (!last || !last.classList.contains("text")) {
            last = createBubble("text");
          }
          last.textContent += blk.text ?? "";
        }
        ui.bubble = last;
      }
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      if (bubbles[i].usage) {
        updateStatusBar(bubbles[i].usage, bubbles[i].model);
        break;
      }
    }
  }
  function applyPatch(p) {
    const kind = p.kind;
    switch (kind) {
      case "startBubble": {
        ui.role = p.role;
        ui.bubble = null;
        if (p.role === "user" && p.text) {
          const el = createBubble("user");
          el.textContent = p.text;
          ui.bubble = el;
          if (ui.pendingEl) messagesEl.appendChild(ui.pendingEl);
        }
        return;
      }
      case "append":
        appendSegment(p.block, p.text);
        return;
      case "endBubble": {
        const stopReason = p.stopReason;
        if (stopReason === "aborted" && ui.retryNoticeEl?.dataset.final !== "true") {
        } else if (stopReason) {
          appendStopNote(stopReason);
        }
        if (p.usage || p.model) {
          updateStatusBar(p.usage, p.model);
        }
        ui.bubble = null;
        return;
      }
      case "retryNotice":
        showRetryNotice(p);
        return;
      case "toolStart":
        removePending();
        setToolState(createToolBubble(p.callId, p.name), "running");
        return;
      case "thinkStart":
        removePending();
        ui.thinkStartAt = Date.now();
        return;
      case "thinkEnd":
        markThinkDone();
        ui.thinkStartAt = 0;
        return;
      case "toolArgs": {
        const host = ui.bubble?.querySelector(".tool-args");
        if (host) {
          host.dataset.raw = (host.dataset.raw || "") + p.text;
          host.textContent = host.dataset.raw;
        }
        return;
      }
      case "toolEnd":
        if (ui.bubble) renderArgs(ui.bubble, p.args);
        return;
      case "toolResult": {
        const bubble = findTool(p.callId);
        if (bubble) {
          renderResultParts(bubble, p.parts, p.isError === true, false);
          setToolState(bubble, p.isError ? "error" : "ok");
          markStreamingDone(bubble);
        }
        return;
      }
      case "toolExecStart": {
        const bubble = findTool(p.callId);
        if (bubble) {
          setToolState(bubble, "running");
          ensureResultHost(bubble).dataset.streaming = "true";
        }
        return;
      }
      case "toolExecUpdate": {
        const bubble = findTool(p.callId);
        if (bubble) {
          ensureResultHost(bubble).dataset.streaming = "true";
          renderResultParts(bubble, p.parts, false, true);
        }
        return;
      }
      case "toolExecEnd": {
        const bubble = findTool(p.callId);
        if (bubble) {
          markStreamingDone(bubble);
          setToolState(bubble, p.isError ? "error" : "ok");
        }
        return;
      }
      case "notice":
        appendNotice({
          id: p.id,
          text: p.text,
          level: p.level,
          time: p.time
        });
        return;
      case "noticeRemove":
        removeNotice(p.id);
        return;
    }
  }
  function findTool(callId) {
    return messagesEl.querySelector(
      '.bubble.tool[data-call-id="' + callId + '"]'
    );
  }
  function setupHostBridge() {
    window.addEventListener("message", (event) => {
      const data = event.data ?? {};
      switch (data.kind) {
        case "styleVars":
          applyStyleVars(data.payload);
          autoGrow();
          return;
        case "modelLimits":
          ui.modelLimits = data.payload ?? {};
          return;
        case "cwd":
          showCwd(String(data.payload ?? ""));
          return;
        case "agentState": {
          setAgentState(String(data.payload));
          if (data.payload === "working") {
            showPending();
          } else {
            ui.userAborted = false;
            removePending();
          }
          return;
        }
        case "snapshot":
          replaySnapshot(data.payload);
          return;
        case "patch":
          applyPatch(data.payload ?? {});
          return;
        case "toggleNotices":
          setExpanded();
          return;
        case "noticesCleared":
          clearNotices();
          return;
      }
    });
  }

  // src/webview/index.ts
  setupInput();
  setupNoticeBoard();
  setupHostBridge();
  post("ready");
})();

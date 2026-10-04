"use strict";
(() => {
  // src/webview/vscode-api.ts
  var vscode = acquireVsCodeApi();
  function post(kind, payload) {
    vscode.postMessage(payload === void 0 ? { kind } : { kind, payload });
  }
  function send(level, text) {
    vscode.postMessage({ kind: "webviewLog", level, text });
  }
  var log = {
    debug: (text) => send("debug", text),
    info: (text) => send("info", text),
    warn: (text) => send("warn", text),
    error: (text) => send("error", text)
  };

  // src/webview/dom.ts
  function needEl(id) {
    const el = document.getElementById(id);
    if (el) return el;
    vscode.postMessage({
      kind: "webviewLog",
      level: "error",
      text: `\u2605 \u627E\u4E0D\u5230 DOM \u5143\u7D20 #${id} \u2014\u2014 HTML \u4E0E TS \u4E0D\u4E00\u81F4\uFF1F`
    });
    return document.createElement("div");
  }
  var messagesEl = needEl("messages");
  var inputEl = needEl("input");
  var sendBtn = needEl("send");
  var btnReload = needEl("btn-reload");
  var btnCompact = needEl("btn-compact");
  var queueBarEl = needEl("queue-bar");
  var footThinking = needEl("foot-thinking");
  var btnSettings = needEl("btn-settings");
  var settingsPanel = needEl("settings-panel");
  var settingsBody = needEl("settings-body");
  var settingsSave = needEl("settings-save");
  var settingsReload = needEl("settings-reload");
  var settingsPath = needEl("settings-path");
  var btnSkills = needEl("btn-skills");
  var skillsPanel = needEl("skills-panel");
  var skillsBody = needEl("skills-body");
  var skillsReload = needEl("skills-reload");
  var skillsPath = needEl("skills-path");
  var statusBarEl = needEl("status-bar");
  var sbCost = needEl("sb-cost");
  var sbOut = needEl("sb-out");
  var sbCache = needEl("sb-cache");
  var sbBattery = needEl("sb-battery");
  var sbBatteryFill = needEl("sb-battery-fill");
  var sbBatteryPct = needEl("sb-battery-pct");
  var footModel = needEl("foot-model");
  var footCwd = needEl("foot-cwd");
  var inputAreaEl = needEl("input-area");
  var topArea = needEl("top-area");
  var noticeToolbar = needEl("notice-toolbar");
  var noticePanel = needEl("notice-panel");
  var noticeList = needEl("notice-list");
  var noticeEmpty = needEl("notice-empty");
  var noticeCount = needEl("notice-count");
  var noticeBell = needEl("notice-bell");
  var noticeBadge = needEl("notice-badge");
  var btnSessions = needEl("btn-sessions");
  var btnNewSession = needEl("btn-new-session");
  var sessionPanel = needEl("session-panel");
  var sessionList = needEl("session-list");
  var sessionEmpty = needEl("session-empty");
  var sessionPanelClose = needEl("session-panel-close");
  var btnRefreshSessions = needEl("btn-refresh-sessions");
  var sessionTitle = needEl("session-title");
  var noticeCollapse = needEl("notice-collapse");
  var noticeClear = needEl("notice-clear");

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
    /** ★ 本次压缩的气泡（B22）—— 同一批压缩原地更新 ✓ */
    compactBubbleEl: null,
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
    /** ★ 通知到达时自动展开面板（默认关 ✓） */
    noticeAutoOpen: false,
    /**
     * ★ 工具结果收起时“两头各露几行”
     *   null = 不启用（走 CSS 的 line-clamp，全部折成一行 ✓）
     *   { head, tail } = 分别露开头 / 末尾的行数 ✓
     */
    toolPeek: null,
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
  function send2() {
    const text = inputEl.value.trim();
    if (!text) return;
    ui.userAborted = false;
    vscode.postMessage({ kind: "prompt", text });
    inputEl.value = "";
    autoGrow();
  }
  function syncPadding() {
    const last = messagesEl.lastElementChild;
    const actions = last?.querySelector(".bubble-actions");
    const actionsH = actions?.offsetHeight ?? 0;
    messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + actionsH + 8 + "px";
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
    ui.noticeAutoOpen = !!vars && vars["--pi-notice-auto-open"] === "on";
    root.classList.toggle("no-arg-scroll", !!vars && vars["--pi-tool-arg-scroll"] === "off");
    root.classList.toggle(
      "no-result-scroll",
      !!vars && vars["--pi-tool-result-scroll"] === "off"
    );
    ui.toolPeek = parsePeek(vars?.["--pi-tool-peek-lines"]);
  }
  function parsePeek(raw) {
    if (!raw) return null;
    const [h, t] = String(raw).split(":");
    const head = Math.max(0, Math.floor(Number(h) || 0));
    const tail = Math.max(0, Math.floor(Number(t) || 0));
    if (head === 0 && tail === 0) return null;
    return { head, tail };
  }
  function setupInput() {
    sendBtn.addEventListener("click", () => {
      if (sendBtn.classList.contains("busy")) {
        ui.userAborted = true;
        vscode.postMessage({ kind: "abort" });
      } else {
        send2();
      }
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send2();
      }
    });
    inputEl.addEventListener("input", autoGrow);
    window.addEventListener("resize", autoGrow);
    autoGrow();
    btnReload.addEventListener("click", () => {
      vscode.postMessage({ kind: "reloadPi" });
    });
    footCwd.addEventListener("click", () => {
      vscode.postMessage({ kind: "changeCwd" });
    });
  }

  // src/webview/panels.ts
  var closers = /* @__PURE__ */ new Map();
  var active = null;
  function registerPanel(id, close) {
    closers.set(id, close);
  }
  function activatePanel(id) {
    if (active && active !== id) {
      const close = closers.get(active);
      log.info(`[panels] ${active} \u2192 ${id}\uFF08\u81EA\u52A8\u6536\u8D77\u524D\u4E00\u5757 \u2713\uFF09`);
      close?.();
    }
    active = id;
  }
  function deactivatePanel(id) {
    if (active === id) active = null;
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
    if (!ui.panelExpanded) {
      ui.noticeUnread++;
      if (ui.noticeAutoOpen) setExpanded(true);
    }
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
      activatePanel("notices");
      ui.noticeUnread = 0;
      syncBadge();
    } else {
      deactivatePanel("notices");
    }
  }
  function setupNoticeBoard() {
    registerPanel("notices", () => setExpanded(false));
    statusBarEl.addEventListener("click", () => setExpanded());
    noticeCollapse.addEventListener("click", () => setExpanded(false));
    noticePanel.addEventListener("click", (e) => {
      const t = e.target;
      if (t?.closest("button, .notice-item")) return;
      setExpanded(false);
    });
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!ui.panelExpanded || !t) return;
      if (noticePanel.contains(t)) return;
      if (statusBarEl.contains(t)) return;
      setExpanded(false);
    });
    noticeClear.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "noticeClearAll" });
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

  // src/webview/context-menu.ts
  var menuEl = null;
  function hideContextMenu() {
    menuEl?.remove();
    menuEl = null;
  }
  function showContextMenu(ev, items) {
    ev.preventDefault();
    ev.stopPropagation();
    hideContextMenu();
    const m = document.createElement("div");
    m.className = "ctx-menu";
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "ctx-item" + (it.danger ? " danger" : "");
      b.textContent = it.label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        hideContextMenu();
        it.onClick();
      });
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    const maxX = window.innerWidth - r.width - 6;
    const maxY = window.innerHeight - r.height - 6;
    m.style.left = Math.max(4, Math.min(ev.clientX, maxX)) + "px";
    m.style.top = Math.max(4, Math.min(ev.clientY, maxY)) + "px";
    menuEl = m;
  }
  document.addEventListener("click", hideContextMenu);
  document.addEventListener("contextmenu", hideContextMenu);
  window.addEventListener("blur", hideContextMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });

  // src/webview/sessions.ts
  var expanded = false;
  var currentCwd = "";
  function setSessionsExpanded(next) {
    expanded = typeof next === "boolean" ? next : !expanded;
    sessionPanel.classList.toggle("collapsed", !expanded);
    if (expanded) {
      activatePanel("sessions");
      vscode.postMessage({ kind: "listSessions" });
    } else {
      deactivatePanel("sessions");
    }
  }
  function setCurrentCwd(p) {
    currentCwd = p;
  }
  function setSessionTitle(name) {
    const el = sessionTitle;
    const text = (name ?? "").trim();
    log.info(`\u6807\u9898\uFF1A\u6536\u5230\u4F1A\u8BDD\u540D\u300C${text || "\uFF08\u7A7A\uFF09"}\u300D`);
    el.textContent = text || "\uFF08\u65E0\u540D\u5B57\uFF09";
    el.classList.toggle("empty", !text);
    el.title = text ? `\u4F1A\u8BDD\u540D\uFF1A${text}\uFF08\u70B9\u51FB\u4FEE\u6539\uFF09` : "\u8FD9\u4E2A\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u540D\u5B57\uFF08\u70B9\u51FB\u7ED9\u5B83\u547D\u540D\uFF09";
    const BASE = 13;
    const MIN = 9;
    el.style.fontSize = `${BASE}px`;
    const w = el.clientWidth;
    const sw = el.scrollWidth;
    if (w > 0 && sw > w) {
      const ratio = w / sw;
      const size = Math.max(MIN, BASE * ratio);
      el.style.fontSize = `${size}px`;
      log.debug(`\u6807\u9898\uFF1A\u5B57\u53F7 ${BASE}\u2192${size.toFixed(1)}px\uFF08\u5BB9\u5668 ${w}px / \u6587\u672C ${sw}px\uFF09`);
    } else {
      log.debug(`\u6807\u9898\uFF1A\u5B57\u53F7\u4FDD\u6301 ${BASE}px\uFF08\u5BB9\u5668 ${w}px / \u6587\u672C ${sw}px\uFF09`);
    }
  }
  function fmtTime(ts) {
    if (!ts) return "?";
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${yy}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function prettyPath(p) {
    if (!p) return "\uFF08\u672A\u77E5\u76EE\u5F55\uFF09";
    return p;
  }
  function renderSessions(list) {
    log.info(`\u4F1A\u8BDD\u5217\u8868\uFF1A\u6536\u5230 ${list.length} \u6761`);
    sessionList.innerHTML = "";
    sessionEmpty.style.display = list.length ? "none" : "";
    const groups = /* @__PURE__ */ new Map();
    for (const s of list) {
      const key = s.cwd || "";
      const arr = groups.get(key);
      if (arr) arr.push(s);
      else groups.set(key, [s]);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === currentCwd) return -1;
      if (b === currentCwd) return 1;
      const ta = groups.get(a)[0]?.createdAt ?? 0;
      const tb = groups.get(b)[0]?.createdAt ?? 0;
      return tb - ta;
    });
    for (const key of keys) {
      const items = groups.get(key);
      const isCurrent = key === currentCwd;
      const g = document.createElement("div");
      g.className = "session-group";
      g.dataset.cwd = key;
      g.dataset.open = isCurrent ? "true" : "false";
      const head = document.createElement("button");
      head.className = "sg-head";
      head.innerHTML = '<span class="sg-caret"></span>';
      const label = document.createElement("span");
      label.className = "sg-path";
      label.textContent = prettyPath(key);
      label.title = key || "\uFF08\u672A\u77E5\u76EE\u5F55\uFF09";
      const count = document.createElement("span");
      count.className = "sg-count";
      count.textContent = String(items.length);
      head.append(label, count);
      if (isCurrent) {
        const tag = document.createElement("span");
        tag.className = "sg-tag";
        tag.textContent = "\u5F53\u524D";
        head.appendChild(tag);
      }
      head.addEventListener("click", () => {
        g.dataset.open = g.dataset.open === "true" ? "false" : "true";
      });
      g.appendChild(head);
      const body = document.createElement("div");
      body.className = "sg-body";
      for (const s of items) {
        const row = document.createElement("button");
        row.className = "session-item";
        row.dataset.path = s.path;
        if (s.broken) {
          row.classList.add("broken");
          row.disabled = true;
          const warn = document.createElement("span");
          warn.className = "si-warn";
          warn.textContent = "\u26A0";
          const why = document.createElement("span");
          why.className = "si-name";
          why.textContent = s.broken;
          const f = document.createElement("span");
          f.className = "si-id";
          f.textContent = s.id.slice(0, 12);
          row.append(warn, why, f);
          row.title = `${s.broken}
${s.path}`;
          body.appendChild(row);
          continue;
        }
        const main = document.createElement("span");
        main.className = "si-name";
        main.textContent = s.name || s.id.slice(0, 8);
        main.title = s.name ? s.name : `\uFF08\u6CA1\u6709\u540D\u5B57\uFF09\u4F1A\u8BDD id: ${s.id}`;
        if (!s.name) main.classList.add("si-idname");
        const turns = document.createElement("span");
        turns.className = "si-turns";
        turns.textContent = s.turns === void 0 ? "?" : `${s.turns} \u8F6E`;
        turns.title = s.turns === void 0 ? "\u70B9\u5DE6\u4FA7 \u27F3 \u5237\u65B0\u540E\u53EF\u83B7\u5F97\u8F6E\u6B21" : `\u7528\u6237\u6D88\u606F ${s.turns} \u6761`;
        const time = document.createElement("span");
        time.className = "si-time";
        time.textContent = fmtTime(s.createdAt);
        row.append(main, turns, time);
        row.title = `${s.name ?? "\uFF08\u65E0\u540D\u5B57\uFF09"}
\u8F6E\u6B21\uFF1A${s.turns ?? "?\uFF08\u672A\u5237\u65B0\uFF09"}
\u521B\u5EFA\uFF1A${fmtTime(s.createdAt)}
${s.path}`;
        row.addEventListener("click", () => {
          vscode.postMessage({ kind: "switchSession", path: s.path, cwd: key });
          setSessionsExpanded(false);
        });
        row.addEventListener("contextmenu", (ev) => {
          showContextMenu(ev, [
            {
              label: "\u5BFC\u51FA\u4F1A\u8BDD\u2026",
              onClick: () => vscode.postMessage({ kind: "exportSession", path: s.path, name: s.name })
            },
            {
              // ★ 导入其实是“对目录”的操作 ✗ 不依赖具体哪条会话 ✓
              //   放在右键单里只是因为这里最顺手 ✓（用户定的 ✓）
              label: "\u5BFC\u5165\u4F1A\u8BDD\u2026",
              onClick: () => vscode.postMessage({ kind: "importSession" })
            },
            {
              label: "\u590D\u5236\u8DEF\u5F84",
              onClick: () => void navigator.clipboard.writeText(s.path)
            },
            {
              label: "\u5220\u9664\u4F1A\u8BDD",
              danger: true,
              onClick: () => vscode.postMessage({ kind: "deleteSession", path: s.path, name: s.name })
            }
          ]);
        });
        body.appendChild(row);
      }
      g.appendChild(body);
      sessionList.appendChild(g);
    }
  }
  function setupSessions() {
    registerPanel("sessions", () => setSessionsExpanded(false));
    btnSessions.addEventListener("click", () => setSessionsExpanded());
    btnNewSession.addEventListener("click", () => {
      vscode.postMessage({ kind: "newSession" });
    });
    sessionPanelClose.addEventListener("click", () => setSessionsExpanded(false));
    btnRefreshSessions.addEventListener("click", () => {
      log.info("\u70B9\u4E86\u3010\u5237\u65B0\u4F1A\u8BDD\u3011\u2192 \u8BF7\u5BBF\u4E3B\u5168\u91CF\u91CD\u8BFB\u4F1A\u8BDD\u6587\u4EF6");
      btnRefreshSessions.classList.add("spinning");
      vscode.postMessage({ kind: "refreshSessions" });
      setTimeout(() => btnRefreshSessions.classList.remove("spinning"), 600);
    });
    sessionTitle.addEventListener("click", () => {
      log.info("\u70B9\u4E86\u3010\u4F1A\u8BDD\u540D\u3011\u2192 \u8BF7\u5BBF\u4E3B\u5F39\u8F93\u5165\u6846\u6539\u540D");
      vscode.postMessage({ kind: "renameSession" });
    });
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!expanded || !t) return;
      if (sessionPanel.contains(t)) return;
      if (btnSessions.contains(t)) return;
      setSessionsExpanded(false);
    });
    sessionPanel.addEventListener("click", (e) => {
      const t = e.target;
      if (t?.closest("button, .session-item, .sg-head")) return;
      setSessionsExpanded(false);
    });
  }

  // src/webview/bubbles.ts
  function scrollToBottom() {
    if (ui.autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  messagesEl.addEventListener("scroll", () => {
    ui.autoScroll = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  });
  function createBubble(kind) {
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap " + kind;
    const div = document.createElement("div");
    div.className = "bubble " + kind;
    wrap.appendChild(div);
    if (kind === "text" || kind === "user") {
      wrap.appendChild(makeActions(div));
    }
    messagesEl.appendChild(wrap);
    scrollToBottom();
    return div;
  }
  function makeActions(source) {
    const box = document.createElement("div");
    box.className = "bubble-actions";
    const copy = document.createElement("button");
    copy.className = "bubble-action";
    copy.textContent = "\u590D\u5236";
    copy.title = "\u590D\u5236\u8FD9\u6761\u6D88\u606F\u7684\u6587\u672C";
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(source.textContent ?? "").then(
        () => {
          copy.textContent = "\u5DF2\u590D\u5236";
          setTimeout(() => copy.textContent = "\u590D\u5236", 1200);
        },
        () => {
          copy.textContent = "\u590D\u5236\u5931\u8D25";
          setTimeout(() => copy.textContent = "\u590D\u5236", 1200);
        }
      );
    });
    box.appendChild(copy);
    return box;
  }
  function refreshForkButtons() {
    const wraps = Array.from(messagesEl.querySelectorAll(".bubble-wrap"));
    const groupTail = /* @__PURE__ */ new Map();
    let userCount = 0;
    for (const w of wraps) {
      if (w.classList.contains("user")) {
        userCount++;
        continue;
      }
      if (w.classList.contains("text") || w.classList.contains("thinking") || w.classList.contains("tool")) {
        groupTail.set(userCount, w);
      }
    }
    const totalUsers = userCount;
    let added = false;
    for (const [n, w] of groupTail) {
      if (n >= totalUsers) continue;
      if (w.querySelector(".bubble-action-fork")) continue;
      const box = w.querySelector(".bubble-actions");
      if (box) {
        addForkButtons(box, n);
        added = true;
      }
    }
    return added;
  }
  function addForkButtons(box, afterUserCount) {
    const clone = document.createElement("button");
    clone.className = "bubble-action bubble-action-clone";
    clone.textContent = "\u514B\u9686";
    clone.title = "\u514B\u9686\u6574\u4E2A\u4F1A\u8BDD\uFF08\u4ECE\u7B2C\u4E00\u6761\u6D88\u606F\u5F00\u59CB\u590D\u5236\u6210\u4E00\u4E2A\u65B0\u4F1A\u8BDD\uFF09";
    clone.addEventListener("click", () => {
      clone.textContent = "\u514B\u9686\u4E2D\u2026";
      post("cloneSession");
    });
    const fork = document.createElement("button");
    fork.className = "bubble-action bubble-action-fork";
    fork.textContent = "\u5206\u53C9";
    fork.title = "\u4ECE\u8FD9\u91CC\u5206\u53C9\uFF1A\u4FDD\u7559\u8FD9\u6761\u6D88\u606F\u53CA\u5176\u4E4B\u524D\u7684\u6240\u6709\u5185\u5BB9\uFF0C\u4E4B\u540E\u7684\u5185\u5BB9\u4E22\u5F03";
    fork.addEventListener("click", () => {
      fork.textContent = "\u5206\u53C9\u4E2D\u2026";
      post("forkSession", { userIndex: afterUserCount });
    });
    box.appendChild(clone);
    box.appendChild(fork);
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
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap pending";
    const el = document.createElement("div");
    el.className = "bubble pending";
    el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    wrap.appendChild(el);
    messagesEl.appendChild(wrap);
    ui.pendingEl = wrap;
    scrollToBottom();
  }
  function removePending() {
    if (ui.pendingEl) {
      ui.pendingEl.remove();
      ui.pendingEl = null;
    }
  }

  // src/webview/compact.ts
  var REASON_TEXT = {
    manual: "\u624B\u52A8\u89E6\u53D1",
    threshold: "\u4E0A\u4E0B\u6587\u63A5\u8FD1\u4E0A\u9650\uFF08\u81EA\u52A8\u9884\u9632\uFF09",
    overflow: "\u2605 \u4E0A\u4E00\u6B21\u54CD\u5E94\u8D85\u7A97\u53E3\uFF08\u81EA\u52A8\u6551\u573A\uFF09"
  };
  function setupCompact() {
    btnCompact.addEventListener("click", () => {
      btnCompact.classList.add("spinning");
      vscode.postMessage({ kind: "compact" });
      setTimeout(() => btnCompact.classList.remove("spinning"), 3e4);
    });
  }
  function ensureBubble() {
    let el = ui.compactBubbleEl;
    if (!el || el.dataset.done === "true") {
      const wrap = document.createElement("div");
      wrap.className = "bubble-wrap notice";
      el = document.createElement("div");
      el.className = "bubble notice compact";
      el.dataset.done = "false";
      wrap.appendChild(el);
      messagesEl.appendChild(wrap);
      ui.compactBubbleEl = el;
      scrollToBottom();
    }
    return el;
  }
  function showCompactionStart(p) {
    const el = ensureBubble();
    el.classList.remove("failed", "ok");
    el.dataset.done = "false";
    const why = REASON_TEXT[p.reason ?? ""] ?? p.reason ?? "";
    el.textContent = `\u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587\u2026\uFF08${why}\uFF09`;
    btnCompact.classList.add("spinning");
    scrollToBottom();
  }
  function showCompactionEnd(p) {
    btnCompact.classList.remove("spinning");
    const el = ensureBubble();
    el.dataset.done = "true";
    const fmt = (n) => typeof n === "number" ? n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n) : "?";
    if (p.errorMessage) {
      el.classList.add("failed");
      el.textContent = `\u538B\u7F29\u5931\u8D25\uFF1A${p.errorMessage}`;
      return;
    }
    if (p.aborted) {
      el.textContent = "\u538B\u7F29\u88AB\u4E2D\u65AD";
      return;
    }
    el.classList.add("ok");
    const saved = typeof p.tokensBefore === "number" && typeof p.tokensAfter === "number" ? `\u3000${fmt(p.tokensBefore)} \u2192 ${fmt(p.tokensAfter)} tokens \u2713` : "";
    const retry = p.willRetry ? "\u3000\u6B63\u5728\u91CD\u8BD5\u521A\u624D\u90A3\u6B21\u8BF7\u6C42\u2026" : "";
    el.textContent = `\u538B\u7F29\u5B8C\u6210${saved}${retry}`;
  }

  // src/webview/model-picker.ts
  var cachedModels = [];
  var cachedLevels = [];
  var pickerEl = null;
  var pickerFor = null;
  function closePicker() {
    pickerEl?.remove();
    pickerEl = null;
    pickerFor = null;
  }
  function openPicker(anchor, forWhat, items) {
    closePicker();
    if (!items.length) {
      log.info(`[picker] \u5019\u9009\u4E3A\u7A7A\uFF08${forWhat}\uFF09`);
      return;
    }
    const box = document.createElement("div");
    box.className = "picker";
    for (const it of items) {
      const b = document.createElement("button");
      b.className = "picker-item";
      b.dataset.current = it.current ? "true" : "false";
      const main = document.createElement("span");
      main.textContent = it.label;
      b.appendChild(main);
      if (it.sub) {
        const sub = document.createElement("span");
        sub.className = "pk-sub";
        sub.textContent = it.sub;
        b.appendChild(sub);
      }
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        closePicker();
        it.onPick();
      });
      box.appendChild(b);
    }
    document.body.appendChild(box);
    const a = anchor.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    box.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - r.width - 6))}px`;
    box.style.top = `${Math.max(4, a.top - r.height - 4)}px`;
    if (a.top - r.height - 4 < 4) {
      box.style.top = `${Math.min(window.innerHeight - r.height - 6, a.bottom + 4)}px`;
    }
    pickerEl = box;
    pickerFor = forWhat;
  }
  document.addEventListener("click", closePicker);
  window.addEventListener("blur", closePicker);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePicker();
  });
  document.addEventListener(
    "wheel",
    (e) => {
      if (pickerEl && pickerEl.contains(e.target)) e.stopPropagation();
    },
    { capture: true, passive: true }
  );
  function setupModelPicker() {
    footModel.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pickerFor === "model") return closePicker();
      vscode.postMessage({ kind: "listModels" });
    });
    footThinking.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pickerFor === "thinking") return closePicker();
      vscode.postMessage({ kind: "listThinkingLevels" });
    });
  }
  function setModelInfo(p) {
    const model = p.model ?? "";
    const provider = p.provider ?? "";
    if (model) {
      footModel.textContent = provider ? `${model} (${provider})` : model;
      footModel.title = `\u5F53\u524D\u6A21\u578B\uFF1A${provider ? `${provider}/` : ""}${model}
\u70B9\u51FB\u5207\u6362`;
      delete footModel.dataset.empty;
    } else {
      footModel.textContent = "";
      footModel.dataset.empty = "true";
    }
    const lv = p.thinkingLevel ?? "";
    if (lv) {
      footThinking.textContent = `thinking: ${lv}`;
      footThinking.title = `\u601D\u8003\u6DF1\u5EA6\uFF1A${lv}
\u70B9\u51FB\u5207\u6362`;
      delete footThinking.dataset.empty;
    } else {
      footThinking.textContent = "";
      footThinking.dataset.empty = "true";
    }
  }
  function showModelPicker(models) {
    cachedModels = models;
    openPicker(
      footModel,
      "model",
      models.map((m) => ({
        label: m.name || m.id,
        sub: m.provider,
        current: m.current,
        onPick: () => vscode.postMessage({ kind: "setModel", provider: m.provider, modelId: m.id })
      }))
    );
  }
  function showThinkingPicker(levels, current) {
    cachedLevels = levels;
    openPicker(
      footThinking,
      "thinking",
      levels.map((lv) => ({
        label: lv,
        current: lv === current,
        onPick: () => vscode.postMessage({ kind: "setThinkingLevel", level: lv })
      }))
    );
  }

  // src/webview/settings-panel.ts
  var dirty = /* @__PURE__ */ new Map();
  var original = /* @__PURE__ */ new Map();
  var bodyBuilt = false;
  function isEditing() {
    return !settingsPanel.classList.contains("collapsed");
  }
  function markDirty(key, value, row) {
    const orig = original.get(key);
    if (JSON.stringify(orig) === JSON.stringify(value)) {
      dirty.delete(key);
      row.dataset.dirty = "false";
    } else {
      dirty.set(key, value);
      row.dataset.dirty = "true";
    }
    settingsSave.disabled = dirty.size === 0;
    settingsSave.textContent = dirty.size ? `\u4FDD\u5B58 (${dirty.size})` : "\u4FDD\u5B58";
  }
  function buildRow(f) {
    const row = document.createElement("div");
    row.className = "s-item";
    row.dataset.dirty = "false";
    const labelBox = document.createElement("div");
    labelBox.className = "s-label";
    const name = document.createElement("span");
    name.textContent = f.label;
    labelBox.appendChild(name);
    if (f.desc) {
      const d = document.createElement("span");
      d.className = "s-desc";
      d.textContent = f.desc;
      labelBox.appendChild(d);
    }
    if (f.needsRestart) {
      const r = document.createElement("span");
      r.className = "s-desc";
      r.textContent = "\u26A0 \u6539\u540E\u9700\u91CD\u542F pi";
      labelBox.appendChild(r);
    }
    const ctl = document.createElement("div");
    ctl.className = "s-ctl";
    if (f.kind === "boolean") {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = f.value === true;
      cb.addEventListener("change", () => markDirty(f.key, cb.checked, row));
      ctl.appendChild(cb);
    } else if (f.kind === "select") {
      const sel = document.createElement("select");
      for (const o of f.options ?? []) {
        const op = document.createElement("option");
        op.value = o.value;
        op.textContent = o.label;
        sel.appendChild(op);
      }
      sel.value = String(f.value ?? "");
      if (!sel.value && f.value) {
        const extra = document.createElement("option");
        extra.value = String(f.value);
        extra.textContent = `${String(f.value)}\uFF08\u5F53\u524D\u503C \xB7 \u4E0D\u5728\u5019\u9009\u5217\u8868\u91CC\uFF09`;
        sel.appendChild(extra);
        sel.value = String(f.value);
      }
      sel.addEventListener("change", () => markDirty(f.key, sel.value, row));
      ctl.appendChild(sel);
    } else if (f.kind === "number") {
      const inp = document.createElement("input");
      inp.type = "number";
      if (f.min !== void 0) inp.min = String(f.min);
      if (f.max !== void 0) inp.max = String(f.max);
      inp.value = f.value === void 0 || f.value === null ? "" : String(f.value);
      inp.addEventListener("input", () => {
        const v = inp.value.trim();
        markDirty(f.key, v === "" ? "" : Number(v), row);
      });
      ctl.appendChild(inp);
    } else if (f.kind === "list") {
      const box = document.createElement("div");
      box.className = "s-list";
      const items = Array.isArray(f.value) ? f.value.slice() : [];
      const renderItems = () => {
        box.textContent = "";
        items.forEach((it, i) => {
          const line = document.createElement("div");
          line.className = "s-list-item";
          const code = document.createElement("span");
          code.textContent = it;
          const del = document.createElement("button");
          del.textContent = "\u2715";
          del.title = "\u5220\u9664\u8FD9\u4E00\u9879";
          del.addEventListener("click", () => {
            items.splice(i, 1);
            renderItems();
            markDirty(f.key, items.slice(), row);
          });
          line.appendChild(code);
          line.appendChild(del);
          box.appendChild(line);
        });
        if (f.options?.length) {
          const sel = document.createElement("select");
          const empty = document.createElement("option");
          empty.value = "";
          empty.textContent = "\uFF0B \u4ECE\u5217\u8868\u9009\u4E00\u4E2A\u6DFB\u52A0\u2026";
          sel.appendChild(empty);
          for (const o of f.options) {
            if (items.includes(o.value)) continue;
            const op = document.createElement("option");
            op.value = o.value;
            op.textContent = o.label;
            sel.appendChild(op);
          }
          sel.addEventListener("change", () => {
            if (!sel.value) return;
            items.push(sel.value);
            renderItems();
            markDirty(f.key, items.slice(), row);
          });
          box.appendChild(sel);
        } else {
          const add = document.createElement("input");
          add.type = "text";
          add.placeholder = "\u6DFB\u52A0\u4E00\u9879\u540E\u56DE\u8F66\u2026";
          add.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const v = add.value.trim();
            if (!v) return;
            items.push(v);
            add.value = "";
            renderItems();
            markDirty(f.key, items.slice(), row);
          });
          box.appendChild(add);
        }
      };
      renderItems();
      ctl.appendChild(box);
    } else if (f.kind === "extlist") {
      const box = document.createElement("div");
      box.className = "s-extlist";
      const enabledSet = new Set(Array.isArray(f.value) ? f.value : []);
      const others = f.value?.filter(
        (x) => !(f.options ?? []).some((o) => o.value === x)
      );
      const all = [
        ...f.options ?? [],
        // ★ settings 里有、但磁盘上找不到的（如 git: 或已卸载 ✓）也列出来 ✗
        ...(others ?? []).map((x) => ({ value: x, label: x + "\uFF08\u4E0D\u5728\u672C\u5730 npm \u76EE\u5F55\uFF09" }))
      ];
      for (const o of all) {
        const line = document.createElement("label");
        line.className = "s-ext-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = enabledSet.has(o.value);
        cb.addEventListener("change", () => {
          if (cb.checked) enabledSet.add(o.value);
          else enabledSet.delete(o.value);
          const arr = all.filter((x) => enabledSet.has(x.value)).map((x) => x.value);
          markDirty(f.key, arr, row);
        });
        const txt = document.createElement("span");
        txt.textContent = o.label;
        txt.title = o.value;
        line.appendChild(cb);
        line.appendChild(txt);
        box.appendChild(line);
      }
      ctl.appendChild(box);
    } else {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = String(f.value ?? "");
      inp.addEventListener("input", () => markDirty(f.key, inp.value, row));
      ctl.appendChild(inp);
    }
    row.appendChild(labelBox);
    row.appendChild(ctl);
    return row;
  }
  function renderSettings(p) {
    settingsPath.textContent = p.path ?? "";
    settingsPath.title = p.path ?? "";
    dirty.clear();
    original = /* @__PURE__ */ new Map();
    settingsSave.disabled = true;
    settingsSave.textContent = "\u4FDD\u5B58";
    settingsBody.textContent = "";
    for (const g of p.groups ?? []) {
      const t = document.createElement("div");
      t.className = "sg-title";
      t.textContent = g.title;
      t.dataset.collapsed = "false";
      const body = document.createElement("div");
      body.className = "sg-body";
      t.addEventListener("click", () => {
        const nowCollapsed = t.dataset.collapsed !== "true";
        t.dataset.collapsed = nowCollapsed ? "true" : "false";
        body.classList.toggle("collapsed", nowCollapsed);
      });
      settingsBody.appendChild(t);
      for (const f of g.items) {
        original.set(f.key, f.value);
        body.appendChild(buildRow(f));
      }
      settingsBody.appendChild(body);
      void g;
    }
    bodyBuilt = true;
  }
  function setSettingsOpen(open) {
    settingsPanel.classList.toggle("collapsed", !open);
    if (!open) {
      deactivatePanel("settings");
      return;
    }
    activatePanel("settings");
    vscode.postMessage({ kind: "openSettings" });
  }
  function setupSettingsPanel() {
    registerPanel("settings", () => setSettingsOpen(false));
    btnSettings.addEventListener("click", (e) => {
      e.stopPropagation();
      setSettingsOpen(!isEditing());
    });
    settingsReload.addEventListener("click", () => {
      dirty.clear();
      settingsSave.disabled = true;
      settingsSave.textContent = "\u4FDD\u5B58";
      vscode.postMessage({ kind: "openSettings" });
    });
    settingsSave.addEventListener("click", () => {
      if (!dirty.size) return;
      const values = {};
      for (const [k, v] of dirty) values[k] = v;
      vscode.postMessage({ kind: "saveSettings", values });
    });
    document.addEventListener("click", (e) => {
      if (!isEditing()) return;
      const t = e.target;
      if (t?.closest(
        "#settings-panel button, #settings-panel input, #settings-panel select, #settings-panel textarea, #btn-settings"
      )) {
        return;
      }
      if (dirty.size) {
        settingsSave.focus();
        return;
      }
      setSettingsOpen(false);
    });
    void bodyBuilt;
  }

  // src/webview/skills-panel.ts
  var rendered = false;
  var detailEl = null;
  function isOpen() {
    return !skillsPanel.classList.contains("collapsed");
  }
  function setSkillsOpen(open) {
    skillsPanel.classList.toggle("collapsed", !open);
    if (!open) {
      deactivatePanel("skills");
      return;
    }
    activatePanel("skills");
    vscode.postMessage({ kind: "openSkills" });
  }
  function renderSkills(p) {
    skillsPath.textContent = p.dir ?? "";
    skillsPath.title = p.dir ?? "";
    skillsBody.textContent = "";
    const list = p.skills ?? [];
    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "s-loading";
      empty.textContent = "\u6CA1\u6709\u627E\u5230\u6280\u80FD\uFF08\u6280\u80FD\u653E <agentDir>/skills/<\u540D\u5B57>/SKILL.md \u2713\uFF09";
      skillsBody.appendChild(empty);
      rendered = true;
      return;
    }
    for (const s of list) {
      const row = document.createElement("div");
      row.className = "sk-item";
      if (s.path) row.title = s.path;
      const name = document.createElement("div");
      name.className = "sk-name";
      name.textContent = s.name;
      const desc = document.createElement("div");
      desc.className = "sk-desc";
      desc.textContent = s.description ?? "\uFF08\u6CA1\u6709\u63CF\u8FF0\uFF09";
      row.appendChild(name);
      row.appendChild(desc);
      if (s.source) {
        const src = document.createElement("div");
        src.className = "sk-src";
        src.textContent = s.source;
        row.appendChild(src);
      }
      row.addEventListener("click", () => {
        if (detailEl?.dataset.for === s.name) {
          detailEl.remove();
          detailEl = null;
          return;
        }
        vscode.postMessage({ kind: "skillDetail", name: s.name });
      });
      skillsBody.appendChild(row);
    }
    rendered = true;
    void rendered;
  }
  function renderSkillDetail(p) {
    detailEl?.remove();
    let host = null;
    for (const el of Array.from(skillsBody.querySelectorAll(".sk-item"))) {
      if (el.querySelector(".sk-name")?.textContent === p.name) {
        host = el;
        break;
      }
    }
    if (!host) return;
    const box = document.createElement("div");
    box.className = "sk-detail";
    box.dataset.for = p.name;
    const pre = document.createElement("pre");
    pre.className = "sk-content";
    pre.textContent = p.content ?? "(\u7A7A)";
    const bar = document.createElement("div");
    bar.className = "sk-actions";
    const toInput = document.createElement("button");
    toInput.textContent = "\u586B\u5165\u8F93\u5165\u6846";
    toInput.title = "\u628A\u6280\u80FD\u6B63\u6587\u8D34\u8FDB\u8F93\u5165\u6846\uFF08\u4F60\u53EF\u4EE5\u5148\u6539\u518D\u53D1 \u2713\uFF09";
    toInput.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "skillToInput", content: p.content ?? "" });
    });
    const asCmd = document.createElement("button");
    asCmd.textContent = "\u4F5C\u4E3A\u547D\u4EE4\u53D1\u9001";
    asCmd.title = `\u76F4\u63A5\u53D1\u9001 \`skill:${p.name}\`\uFF08pi \u539F\u751F\u652F\u6301 \u2713\uFF09`;
    asCmd.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "skillAsCommand", name: p.name });
    });
    bar.appendChild(toInput);
    bar.appendChild(asCmd);
    box.appendChild(bar);
    box.appendChild(pre);
    host.after(box);
    detailEl = box;
  }
  function setupSkillsPanel() {
    registerPanel("skills", () => setSkillsOpen(false));
    btnSkills.addEventListener("click", (e) => {
      e.stopPropagation();
      setSkillsOpen(!isOpen());
    });
    skillsReload.addEventListener("click", (e) => {
      e.stopPropagation();
      vscode.postMessage({ kind: "openSkills" });
    });
    document.addEventListener("click", (e) => {
      if (!isOpen()) return;
      const t = e.target;
      if (t?.closest("#skills-panel button, .sk-item, .sk-detail, #btn-skills")) return;
      setSkillsOpen(false);
    });
  }

  // src/webview/inserting.ts
  var pending = [];
  var seq = 0;
  function showInserting(text) {
    if (!text || !queueBarEl) return;
    const el = document.createElement("div");
    el.className = "queue-item";
    const txt = document.createElement("span");
    txt.className = "queue-text";
    txt.textContent = text;
    const mark = document.createElement("span");
    mark.className = "queue-mark";
    mark.textContent = "\u5F85\u63D2\u8BDD";
    el.appendChild(txt);
    el.appendChild(mark);
    queueBarEl.appendChild(el);
    queueBarEl.dataset.empty = "false";
    pending.push({ id: ++seq, text, el });
  }
  function setQueueing(steering) {
    const quota = /* @__PURE__ */ new Map();
    for (const t of steering) quota.set(t, (quota.get(t) ?? 0) + 1);
    const remain = [];
    for (const p of pending) {
      const n = quota.get(p.text) ?? 0;
      if (n > 0) {
        quota.set(p.text, n - 1);
        remain.push(p);
      } else {
        p.el.remove();
      }
    }
    pending.length = 0;
    pending.push(...remain);
    if (queueBarEl) queueBarEl.dataset.empty = pending.length ? "false" : "true";
  }

  // src/webview/thinking.ts
  function createThinkingBubble(label) {
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap thinking";
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
    wrap.appendChild(div);
    wrap.appendChild(makeActions(div));
    messagesEl.appendChild(wrap);
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
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap tool";
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
    wrap.appendChild(div);
    wrap.appendChild(makeActions(div));
    messagesEl.appendChild(wrap);
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
        body.appendChild(buildTextPart(p.text ?? ""));
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
    host.dataset.peek = body.querySelector('.part-text[data-peek="true"]') ? "true" : "false";
    if (!body.childElementCount) body.textContent = streaming ? "" : "\uFF08\u65E0\u8F93\u51FA\uFF09";
    scrollToBottom();
  }
  function buildTextPart(text) {
    const el = document.createElement("div");
    el.className = "part-text";
    const peek = ui.toolPeek;
    const lines = text.split("\n");
    if (!peek || lines.length <= peek.head + peek.tail + 1) {
      el.textContent = text;
      return el;
    }
    const full = document.createElement("div");
    full.className = "part-full";
    full.textContent = text;
    const short = document.createElement("div");
    short.className = "part-peek";
    const hidden = lines.length - peek.head - peek.tail;
    if (peek.head > 0) {
      const head = document.createElement("div");
      head.textContent = lines.slice(0, peek.head).join("\n");
      short.appendChild(head);
    }
    const more = document.createElement("div");
    more.className = "peek-more";
    more.textContent = `\u2026\uFF08\u5DF2\u6298\u53E0 ${hidden} \u884C\uFF09`;
    short.appendChild(more);
    if (peek.tail > 0) {
      const tail = document.createElement("div");
      tail.textContent = lines.slice(-peek.tail).join("\n");
      short.appendChild(tail);
    }
    el.dataset.peek = "true";
    el.append(full, short);
    return el;
  }

  // src/webview/notices.ts
  function showRetryNotice(p) {
    removePending();
    let el = ui.retryNoticeEl;
    if (!el || el.dataset.final === "true") {
      const wrap = document.createElement("div");
      wrap.className = "bubble-wrap notice";
      el = document.createElement("div");
      el.className = "bubble notice retry";
      el.dataset.final = "false";
      wrap.appendChild(el);
      messagesEl.appendChild(wrap);
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
    void model;
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
  var lastSnapshot = null;
  var replayPending = false;
  var agentBusy = false;
  function replayForConfig() {
    if (lastSnapshot === null) return;
    if (agentBusy) {
      replayPending = true;
      return;
    }
    replaySnapshot(lastSnapshot, { keepNotices: true });
  }
  function replaySnapshot(payload, opts) {
    lastSnapshot = payload;
    const snap = payload ?? {};
    const bubbles = Array.isArray(snap.bubbles) ? snap.bubbles : [];
    messagesEl.innerHTML = "";
    ui.bubble = null;
    ui.pendingEl = null;
    ui.lastThinkBubble = null;
    if (opts?.keepNotices) {
      renderNotices();
    } else {
      resetNotices(snap.notices ?? []);
    }
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
      // ★ 压缩（B22）：开始/结束共用一种 patch，原地更新同一个气泡 ✓
      case "compaction":
        if (p.phase === "start") showCompactionStart(p);
        else showCompactionEnd(p);
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
          replayForConfig();
          return;
        case "modelLimits":
          ui.modelLimits = data.payload ?? {};
          return;
        case "cwd":
          showCwd(String(data.payload ?? ""));
          setCurrentCwd(String(data.payload ?? ""));
          return;
        case "agentState": {
          setAgentState(String(data.payload));
          agentBusy = data.payload === "working";
          if (data.payload === "working") {
            showPending();
          } else {
            ui.userAborted = false;
            removePending();
            if (replayPending) {
              replayPending = false;
              replayForConfig();
            }
          }
          return;
        }
        case "snapshot":
          replaySnapshot(data.payload);
          refreshForkButtons();
          setQueueing([]);
          syncPadding();
          return;
        case "patch":
          applyPatch(data.payload ?? {});
          if (refreshForkButtons()) syncPadding();
          return;
        // ★ 模型 / 思考等级状态（B23）—— 探针 + 事件增量推来的 ✓
        case "modelInfo":
          setModelInfo(data.payload ?? {});
          return;
        // ★ 设置面板（B24）
        case "settings":
          renderSettings(data.payload ?? {});
          return;
        // ★ 技能列表（B25）
        case "skills":
          renderSkills(data.payload ?? {});
          return;
        case "skillDetail":
          renderSkillDetail(data.payload ?? {});
          return;
        // ★ 宿主让前端做的两个动作（B25）
        case "insertToInput": {
          const t = data.payload?.text ?? "";
          inputEl.value = inputEl.value ? inputEl.value + "\n" + t : t;
          autoGrow();
          inputEl.focus();
          return;
        }
        case "sendText": {
          const t = data.payload?.text ?? "";
          if (!t) return;
          vscode.postMessage({ kind: "prompt", text: t });
          return;
        }
        case "modelList":
          showModelPicker(data.payload ?? []);
          return;
        case "thinkingLevels": {
          const pl = data.payload ?? {};
          showThinkingPicker(pl.levels ?? [], pl.current);
          return;
        }
        case "queueUpdate": {
          setQueueing(data.payload?.steering ?? []);
          return;
        }
        case "inserting": {
          showInserting(String(data.payload?.text ?? ""));
          return;
        }
        case "toggleNotices":
          setExpanded();
          return;
        case "sessions":
          renderSessions(data.payload ?? []);
          return;
        case "sessionTitle": {
          const nm = String(data.payload ?? "");
          setSessionTitle(nm);
          return;
        }
        case "noticesCleared":
          clearNotices();
          return;
      }
    });
  }

  // src/webview/index.ts
  function safe(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error(`[pi-bridge] \u2605 ${name} \u521D\u59CB\u5316\u5931\u8D25:`, err);
      log.error(
        `\u2605 ${name} \u521D\u59CB\u5316\u5931\u8D25\uFF08\u5176\u4F59\u529F\u80FD\u7EE7\u7EED\uFF09: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  safe("input", setupInput);
  safe("noticeBoard", setupNoticeBoard);
  safe("sessions", setupSessions);
  safe("compact", setupCompact);
  safe("modelPicker", setupModelPicker);
  safe("settings", setupSettingsPanel);
  safe("skills", setupSkillsPanel);
  safe("hostBridge", setupHostBridge);
  post("ready");
})();

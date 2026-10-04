"use strict";
(() => {
  // src/interaction/state.ts
  var state = {
    /** 待答队列（[0] 是第一个 ✓）*/
    queue: [],
    /** ★ 答案草稿（题目 id → 答案 ✓）*/
    answers: /* @__PURE__ */ new Map(),
    /** 当前页码（0..queue.length-1 = 问题页；queue.length = 确认页 ✓）*/
    page: 0,
    /**
     * ★ 键盘选中的选项下标（B27 ✓）
     *   -1 = “输入框”那一环 ✗（只对有输入框的页有意义 ✓）
     *   ≥0 = 选项列表里的下标 ✓
     *
     * 【★ 为什么初始是 0 而不是 -1？】（用户报的体验 ✓）
     *   “我期望的是一弹过去焦点也过去 ✗ 这样我按一下 Enter 就能直接通过 ✓”
     *   → 默认就选中【第一个选项】✗ → Enter 直接提交它 ✓ 不用先按方向键 ✓
     *   → 如果用户想打字，按一下 ↑ 就回到输入框（会自动聚焦 ✓）
     */
    kbd: 0,
    /** ★ 已提交 → 前端不再响应宿主的队列更新 ✗（否则会闪 ✓）*/
    submitted: false,
    /**
     * ★★ 已答【已发送】的历史（B26 串行场景 ✓）
     *
     * 【为什么需要它？】
     *   串行扩展（ask_user_question 之类）是【一个接一个】问的 ✗
     *   它 await 第一个 ✗ 你不回就永远不发第二个 ✓
     *   → 所以【不能等它发完再答】✗ 必须答一个发一个 ✓
     *   → 但为了像 TUI 那样“多页问卷”✗ 把已发的留在页签里 ✓
     *     ★ 只读 ✓ 不能再改（已经发出去了 ✓）
     *
     * 【★ 什么时候清空？】
     *   面板关闭 → 下次是【全新加载】✗ 模块级变量自动重置 ✓
     *   → 所以这里【不需要】任何清理逻辑 ✓
     */
    history: []
  };
  var unansweredCount = () => state.queue.filter((q) => !state.answers.has(q.id)).length;
  var totalPages = () => state.history.length + state.queue.length;
  function advanceToNextUnanswered() {
    for (let p = state.page + 1; p < state.history.length + state.queue.length; p++) {
      const q = state.queue[p - state.history.length];
      if (q && !state.answers.has(q.id)) {
        state.page = p;
        return true;
      }
    }
    return false;
  }
  function applyQueue(items) {
    if (state.submitted) return;
    const old = state.answers;
    const done = new Set(state.history.map((h) => h.q.id));
    const fresh = items.filter((q) => !done.has(q.id));
    state.queue = fresh;
    const kept = /* @__PURE__ */ new Map();
    for (const q of fresh) {
      const a = old.get(q.id);
      if (a) kept.set(q.id, a);
    }
    state.answers = kept;
    if (state.page > totalPages()) state.page = totalPages();
  }

  // src/interaction/controls.ts
  var FREE_RE = /(type\s+something|^\s*\d+[.、)]?\s*(other|其他|自定义|自己(写|输入)))/i;
  function isFreeOption(opt) {
    return FREE_RE.test(opt);
  }
  function splitOptions(q) {
    const real = [];
    let freeText;
    for (const o of q.options ?? []) {
      if (isFreeOption(o) && freeText === void 0) freeText = o;
      else real.push(o);
    }
    return { real, freeText };
  }
  function buildControls(q, cur, onDraft, onCommit) {
    const body = document.createElement("div");
    if (q.method === "select") {
      body.className = "q-options";
      const { real } = splitOptions(q);
      real.forEach((opt, i) => {
        const b = document.createElement("button");
        b.className = "opt";
        b.dataset.kbdIndex = String(i);
        if (state.kbd < 0 && cur?.value === opt) b.classList.add("selected");
        if (state.kbd === i) b.classList.add("kbd");
        b.textContent = opt;
        b.addEventListener("click", () => onCommit({ value: opt }));
        body.appendChild(b);
      });
      return body;
    }
    if (q.method === "confirm") {
      body.className = "opt-row";
      const pairs = [
        ["\u786E\u5B9A", true],
        ["\u53D6\u6D88", false]
      ];
      pairs.forEach(([text, val], i) => {
        const b = document.createElement("button");
        b.className = "opt";
        b.dataset.kbdIndex = String(i);
        if (state.kbd < 0 && cur?.confirmed === val) b.classList.add("selected");
        if (state.kbd === i) b.classList.add("kbd");
        b.textContent = text;
        b.addEventListener("click", () => onCommit({ confirmed: val }));
        body.appendChild(b);
      });
      return body;
    }
    if (q.method === "editor") {
      const ta = document.createElement("textarea");
      ta.className = "editor-area";
      ta.value = cur?.value ?? q.prefill ?? "";
      ta.addEventListener("input", () => onDraft({ value: ta.value }));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onCommit({ value: ta.value });
        }
      });
      body.appendChild(ta);
      const bar = document.createElement("div");
      bar.className = "opt-row";
      bar.style.marginTop = "12px";
      const ok = document.createElement("button");
      ok.className = "opt primary";
      ok.textContent = "\u63D0\u4EA4\uFF08Ctrl+Enter\uFF09";
      ok.addEventListener("click", () => onCommit({ value: ta.value }));
      bar.append(ok);
      body.appendChild(bar);
      setTimeout(() => ta.focus(), 0);
      return body;
    }
    body.className = "q-options";
    return body;
  }
  function isFreeValue(q, cur) {
    if (!cur || cur.value === void 0) return false;
    return !(q.options ?? []).includes(cur.value);
  }

  // src/interaction/pages.ts
  function answerText(a) {
    if (a.cancelled) return "\uFF08\u53D6\u6D88\u672C\u9898\uFF09";
    if (a.confirmed !== void 0) return a.confirmed ? "\u786E\u5B9A" : "\u53D6\u6D88";
    return a.value ?? "";
  }
  function titleEl(q) {
    const t = document.createElement("div");
    t.className = "q-title";
    t.textContent = q.title || q.message || "";
    return t;
  }
  function messageEl(q) {
    if (!q.message || !q.title) return void 0;
    const m = document.createElement("div");
    m.className = "q-message";
    m.textContent = q.message;
    return m;
  }
  function historyBody(hist) {
    const wrap = document.createElement("div");
    wrap.appendChild(titleEl(hist.q));
    const row = document.createElement("div");
    row.className = "hist-row";
    const tag = document.createElement("span");
    tag.className = "hist-tag";
    tag.textContent = "\u2713 \u5DF2\u7B54\uFF08\u5DF2\u53D1\u9001\uFF09";
    const val = document.createElement("span");
    val.className = "hist-value";
    val.textContent = answerText(hist.a);
    row.append(tag, val);
    wrap.appendChild(row);
    return wrap;
  }
  function questionBody(q, cur, onDraft, onCommit) {
    const wrap = document.createElement("div");
    wrap.appendChild(titleEl(q));
    const m = messageEl(q);
    if (m) wrap.appendChild(m);
    wrap.appendChild(buildControls(q, cur, onDraft, onCommit));
    return wrap;
  }
  function confirmBody(queue, answers, onEdit, onSubmit, canSubmit, missing) {
    const wrap = document.createElement("div");
    const t = document.createElement("div");
    t.className = "q-title";
    t.textContent = "\u786E\u8BA4\u63D0\u4EA4";
    wrap.appendChild(t);
    const sub = document.createElement("div");
    sub.className = "q-message";
    sub.textContent = "\u68C0\u67E5\u4E00\u904D \u2014\u2014 \u70B9[\u63D0\u4EA4\u5168\u90E8]\u4F1A\u4E00\u6B21\u6027\u53D1\u7ED9 pi \u2713";
    wrap.appendChild(sub);
    const list = document.createElement("div");
    list.className = "qa-list";
    queue.forEach((q, i) => {
      const row = document.createElement("div");
      row.className = "qa";
      const qi = document.createElement("span");
      qi.className = "qa-q";
      qi.textContent = `${i + 1}. ${q.title.split("\n")[0].slice(0, 70)}`;
      qi.title = q.title;
      const a = answers.get(q.id);
      const ai = document.createElement("span");
      ai.className = "qa-a" + (a ? "" : " missing");
      ai.textContent = a ? answerText(a) : "\u2605 \u672A\u7B54";
      ai.title = ai.textContent;
      const edit = document.createElement("button");
      edit.className = "qa-edit";
      edit.textContent = "\u6539";
      edit.addEventListener("click", () => onEdit(i));
      row.append(qi, ai, edit);
      list.appendChild(row);
    });
    wrap.appendChild(list);
    const bar = document.createElement("div");
    bar.className = "opt-row";
    bar.style.marginTop = "14px";
    if (!canSubmit) {
      const hint = document.createElement("span");
      hint.className = "q-hint";
      hint.textContent = `\u2605 \u8FD8\u6709 ${missing} \u9898\u6CA1\u7B54`;
      bar.appendChild(hint);
    }
    const ok = document.createElement("button");
    ok.className = "opt primary";
    ok.textContent = "\u63D0\u4EA4\u5168\u90E8";
    ok.disabled = !canSubmit;
    ok.addEventListener("click", onSubmit);
    bar.appendChild(ok);
    wrap.appendChild(bar);
    return wrap;
  }

  // src/interaction/views.ts
  var isBatch = () => state.queue.length >= 2;
  var confirmPage = () => state.history.length + state.queue.length;
  function render(listEl2, h) {
    listEl2.textContent = "";
    if (state.submitted) {
      listEl2.appendChild(info("\u2713 \u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85 pi \u5173\u95ED\u9762\u677F\u2026"));
      return;
    }
    if (totalPages() === 0) return;
    listEl2.append(tabBar(h), content(h), composer(h));
  }
  function tabBar(h) {
    const bar = document.createElement("div");
    bar.className = "tabs";
    const addTab = (label, page, cls, tip) => {
      const b = document.createElement("button");
      b.className = "tab " + cls;
      if (state.page === page) b.classList.add("active");
      b.textContent = label;
      b.title = tip;
      b.addEventListener("click", () => jump(h, page));
      bar.appendChild(b);
    };
    state.history.forEach((entry, i) => {
      const cls = entry.a.cancelled ? "skipped" : "done";
      addTab(`\u2713 ${i + 1}`, i, cls, `\u5DF2\u7B54\uFF1A${entry.q.title.split("\n")[0].slice(0, 60)}`);
    });
    state.queue.forEach((q, i) => {
      const idx = state.history.length + i;
      addTab(String(idx + 1), idx, state.answers.has(q.id) ? "done" : "", q.title.split("\n")[0].slice(0, 60));
    });
    if (isBatch()) addTab("\u63D0\u4EA4", confirmPage(), "submit", "\u68C0\u67E5\u5E76\u4E00\u6B21\u6027\u63D0\u4EA4\u5168\u90E8\u7B54\u6848");
    return bar;
  }
  function content(h) {
    const box = document.createElement("div");
    box.className = "content";
    const page = document.createElement("div");
    page.className = "page";
    page.appendChild(currentPage(h));
    box.appendChild(page);
    return box;
  }
  function currentPage(h) {
    if (state.page < state.history.length) return historyBody(state.history[state.page]);
    if (isBatch() && state.page >= confirmPage()) {
      return confirmBody(
        state.queue,
        state.answers,
        (i) => jump(h, state.history.length + i),
        () => h.submitAll(),
        state.queue.every((q2) => state.answers.has(q2.id)),
        unansweredCount()
      );
    }
    const q = state.queue[state.page - state.history.length];
    if (!q) return info("\u7B49\u5F85\u4E0B\u4E00\u4E2A\u95EE\u9898\u2026");
    return questionBody(
      q,
      state.answers.get(q.id),
      (r) => {
        state.answers.set(q.id, r);
        if (isTyping()) return;
        h.redraw();
      },
      (r) => commit(h, q, r)
    );
  }
  function commit(h, q, r) {
    state.answers.set(q.id, r);
    state.kbd = 0;
    if (isBatch()) {
      if (!advanceToNextUnanswered()) state.page = confirmPage();
      h.redraw();
    } else {
      h.sendNow(q.id, r);
    }
  }
  function composer(h) {
    const wrap = document.createElement("div");
    wrap.className = "composer";
    const inner = document.createElement("div");
    inner.className = "composer-inner";
    const q = pendingQuestion();
    const hasInput = !!q && (q.method === "select" || q.method === "input");
    const bar = document.createElement("div");
    bar.className = "composer-bar";
    const send = document.createElement("button");
    send.className = "send";
    send.title = "\u63D0\u4EA4\uFF08Enter\uFF09";
    send.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 13.5a.75.75 0 0 1-.75-.75V4.56L4.53 7.28a.75.75 0 0 1-1.06-1.06l4-4a.75.75 0 0 1 1.06 0l4 4a.75.75 0 0 1-1.06 1.06L8.75 4.56v8.19a.75.75 0 0 1-.75.75Z"/></svg>';
    send.disabled = true;
    let submit;
    if (hasInput && q) {
      const ta = document.createElement("textarea");
      ta.rows = 1;
      const cur = state.answers.get(q.id);
      if (q.method === "input") {
        ta.placeholder = q.placeholder ?? "\u8F93\u5165\u540E\u6309 Enter \u63D0\u4EA4";
        ta.value = cur?.value ?? q.prefill ?? "";
      } else {
        const { freeText } = splitOptions(q);
        ta.placeholder = freeText ?? "\u270D \u4E5F\u53EF\u4EE5\u81EA\u5DF1\u5199\u2026\uFF08Enter \u63D0\u4EA4\uFF09";
        if (isFreeValue(q, cur)) ta.value = cur?.value ?? "";
      }
      ta.addEventListener("input", () => {
        state.answers.set(q.id, { value: ta.value });
        state.kbd = -1;
        autoGrow(ta);
        send.disabled = ta.value.trim() === "";
      });
      ta.addEventListener("focus", () => {
        if (state.kbd === -1) return;
        state.kbd = -1;
        document.querySelectorAll("[data-kbd-index]").forEach((el) => el.classList.remove("kbd"));
      });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit?.();
        }
        if (e.key === "Escape") ta.blur();
      });
      ta.addEventListener("dragover", (ev) => ev.preventDefault());
      ta.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const text = ev.dataTransfer?.getData("text/plain") ?? "";
        if (text) ta.value += text;
      });
      inner.appendChild(ta);
      submit = () => commit(h, q, { value: ta.value });
      send.disabled = ta.value.trim() === "";
      autoGrow(ta);
      setTimeout(() => {
        if (q.method === "input" || state.kbd < 0) ta.focus();
        autoGrow(ta);
      }, 0);
    }
    send.addEventListener("click", () => submit?.());
    inner.appendChild(bar);
    const nav = document.createElement("div");
    nav.className = "nav-row";
    const prev = mkNav("\u2190 \u4E0A\u4E00\u9875", () => jump(h, state.page - 1));
    prev.disabled = state.page <= 0;
    nav.appendChild(prev);
    const cancel = mkNav("\u53D6\u6D88\u672C\u9875", () => {
      if (q) commit(h, q, { cancelled: true });
    }, "danger");
    cancel.disabled = !q;
    nav.appendChild(cancel);
    const lastPage = isBatch() ? confirmPage() : totalPages() - 1;
    const isLastQ = isBatch() && state.page === confirmPage() - 1;
    const next = mkNav(isLastQ ? "\u53BB\u786E\u8BA4 \u2192" : "\u4E0B\u4E00\u9875 \u2192", () => jump(h, state.page + 1));
    next.disabled = state.page >= lastPage;
    nav.appendChild(next);
    nav.appendChild(send);
    inner.appendChild(nav);
    wrap.appendChild(inner);
    return wrap;
  }
  function pendingQuestion() {
    if (state.page < state.history.length) return void 0;
    if (isBatch() && state.page >= confirmPage()) return void 0;
    return state.queue[state.page - state.history.length];
  }
  function jump(h, page) {
    state.page = Math.max(0, Math.min(page, confirmPage()));
    state.kbd = 0;
    h.redraw();
  }
  function isTyping() {
    const ae = document.activeElement;
    return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
  }
  function mkNav(text, onClick, extra = "") {
    const b = document.createElement("button");
    b.className = "nav-btn " + extra;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
  }
  function info(text) {
    const d = document.createElement("div");
    d.className = "info";
    d.textContent = text;
    return d;
  }

  // src/interaction/index.ts
  var vscode = acquireVsCodeApi();
  var hostEl = document.getElementById("host");
  var listEl = document.getElementById("list");
  var redraw = () => {
    const empty = state.queue.length === 0 && state.history.length === 0 && !state.submitted;
    hostEl.dataset.empty = empty ? "true" : "false";
    render(listEl, handlers);
  };
  var handlers = {
    /** 单题/串行模式：立刻发 ✓（★ 但先复核一次队列 ✓）*/
    sendNow(id, r) {
      if (state.queue.length >= 2) {
        state.answers.set(id, r);
        const qi = state.queue.findIndex((q) => q.id !== id && !state.answers.has(q.id));
        state.page = state.history.length + (qi >= 0 ? qi : state.queue.length);
        redraw();
        return;
      }
      vscode.postMessage({ kind: "uiResponse", id, ...r });
      const i = state.queue.findIndex((q) => q.id === id);
      if (i >= 0) {
        const [q] = state.queue.splice(i, 1);
        state.history.push({ q, a: r });
        state.page = state.history.length;
      }
      redraw();
    },
    redraw,
    /** 答卷模式：一次性把 N 个答案全发 ✓ */
    submitAll() {
      state.submitted = true;
      for (const q of state.queue) {
        const r = state.answers.get(q.id);
        if (r) vscode.postMessage({ kind: "uiResponse", id: q.id, ...r });
      }
      redraw();
    }
  };
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg?.kind === "queue") {
      applyQueue(msg.payload ?? []);
      redraw();
      setTimeout(() => {
        if (!document.hasFocus()) {
          document.body.tabIndex = -1;
          document.body.focus();
        }
      }, 0);
    }
  });
  function paintKbd() {
    document.querySelectorAll("[data-kbd-index]").forEach((el) => {
      el.classList.toggle("kbd", Number(el.dataset.kbdIndex) === state.kbd);
    });
    const cur = document.activeElement;
    const inText = !!cur && (cur.tagName === "TEXTAREA" || cur.tagName === "INPUT");
    if (state.kbd >= 0 && inText) {
      cur.blur();
      document.body.tabIndex = -1;
      document.body.focus();
    }
  }
  function pendingQ() {
    if (state.page < state.history.length) return void 0;
    if (state.queue.length >= 2 && state.page >= state.history.length + state.queue.length) return void 0;
    return state.queue[state.page - state.history.length];
  }
  function optionsOf(q) {
    if (q.method === "select") return splitOptions(q).real;
    if (q.method === "confirm") return ["\u786E\u5B9A", "\u53D6\u6D88"];
    return [];
  }
  document.addEventListener("keydown", (e) => {
    if (state.submitted) return;
    const el = document.activeElement;
    const inText = !!el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT");
    const ta = inText && state.kbd < 0 ? el : null;
    const q = pendingQ();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (!q) return;
      const opts = optionsOf(q);
      if (opts.length === 0) return;
      const n = opts.length;
      const up = e.key === "ArrowUp";
      const hasBox = q.method === "select" || q.method === "input";
      if (!hasBox) {
        e.preventDefault();
        const cur = state.kbd;
        state.kbd = up ? cur <= 0 ? n - 1 : cur - 1 : cur < 0 || cur >= n - 1 ? 0 : cur + 1;
        paintKbd();
        return;
      }
      if (ta) {
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? start;
        const atEdge = up ? !ta.value.slice(0, start).includes("\n") : !ta.value.slice(end).includes("\n");
        if (!atEdge) return;
        e.preventDefault();
        state.kbd = up ? n - 1 : 0;
        paintKbd();
        return;
      }
      e.preventDefault();
      if (up) {
        state.kbd = state.kbd <= 0 ? -1 : state.kbd - 1;
      } else {
        state.kbd = state.kbd >= n - 1 ? -1 : state.kbd + 1;
      }
      paintKbd();
      if (state.kbd < 0) document.querySelector(".composer textarea")?.focus();
      return;
    }
    if (e.key === "Enter" && !inText && q && state.kbd >= 0) {
      const opt = optionsOf(q)[state.kbd];
      if (opt === void 0) return;
      e.preventDefault();
      const r = q.method === "confirm" ? { confirmed: opt === "\u786E\u5B9A" } : { value: opt };
      handlers.sendNow(q.id, r);
      return;
    }
    if (e.key === "Enter" && !inText && !q && state.queue.length >= 2) {
      const onConfirm = state.page >= state.history.length + state.queue.length;
      if (onConfirm) {
        e.preventDefault();
        if (state.queue.every((it) => state.answers.has(it.id))) handlers.submitAll();
      }
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const left = e.key === "ArrowLeft";
      if (ta) {
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? start;
        const atEdge = left ? start === 0 && end === 0 : start === ta.value.length && end === ta.value.length;
        if (!atEdge) return;
      }
      const isBatchMode = state.queue.length >= 2;
      const maxPage = isBatchMode ? state.history.length + state.queue.length : state.history.length + state.queue.length - 1;
      if (maxPage < 0) return;
      let target = left ? state.page - 1 : state.page + 1;
      if (target < 0) target = maxPage;
      if (target > maxPage) target = 0;
      if (target === state.page) return;
      e.preventDefault();
      state.page = target;
      state.kbd = -1;
      redraw();
      return;
    }
    if (e.key !== "Escape" || !q) return;
    if (inText) return;
    if (state.queue.length >= 2) {
      state.answers.set(q.id, { cancelled: true });
      advanceToNextUnanswered();
      redraw();
      return;
    }
    handlers.sendNow(q.id, { cancelled: true });
  });
  vscode.postMessage({ kind: "ready" });
})();

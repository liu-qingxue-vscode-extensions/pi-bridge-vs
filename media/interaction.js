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
  function buildControls(q, cur, onDraft, onCommit) {
    const body = document.createElement("div");
    body.className = "uir-body";
    if (q.method === "select") {
      for (const opt of q.options ?? []) {
        const b = document.createElement("button");
        b.className = "uir-opt uir-choice";
        if (cur?.value === opt) b.classList.add("selected");
        b.textContent = opt;
        b.addEventListener("click", () => {
          clearSelected(body);
          b.classList.add("selected");
          freeInp.value = "";
          onCommit({ value: opt });
        });
        body.appendChild(b);
      }
      const row = document.createElement("div");
      row.className = "free-row";
      const freeInp = document.createElement("input");
      freeInp.type = "text";
      freeInp.placeholder = "\u270D \u81EA\u5DF1\u5199\u2026";
      const isFree = cur?.value !== void 0 && !(q.options ?? []).includes(cur.value);
      if (isFree) freeInp.value = cur?.value ?? "";
      freeInp.addEventListener("input", () => {
        clearSelected(body);
        onDraft({ value: freeInp.value });
      });
      freeInp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        onCommit({ value: freeInp.value });
      });
      row.appendChild(freeInp);
      body.appendChild(row);
      return body;
    }
    if (q.method === "confirm") {
      const pairs = [
        ["\u786E\u5B9A", true],
        ["\u53D6\u6D88", false]
      ];
      for (const [text, val] of pairs) {
        const b = document.createElement("button");
        b.className = "uir-opt" + (val ? " primary" : "");
        if (cur?.confirmed === val) b.classList.add("selected");
        b.textContent = text;
        b.addEventListener("click", () => {
          clearSelected(body);
          b.classList.add("selected");
          onCommit({ confirmed: val });
        });
        body.appendChild(b);
      }
      return body;
    }
    if (q.method === "input") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = q.placeholder ?? "";
      inp.value = cur?.value ?? q.prefill ?? "";
      inp.addEventListener("input", () => onDraft({ value: inp.value }));
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit({ value: inp.value });
        }
        if (e.key === "Escape") inp.blur();
      });
      body.appendChild(inp);
      setTimeout(() => inp.focus(), 0);
      return body;
    }
    const ta = document.createElement("textarea");
    ta.value = cur?.value ?? q.prefill ?? "";
    ta.addEventListener("input", () => onDraft({ value: ta.value }));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onCommit({ value: ta.value });
      }
    });
    body.appendChild(ta);
    setTimeout(() => ta.focus(), 0);
    return body;
  }
  function clearSelected(scope) {
    scope.querySelectorAll(".selected").forEach((e) => e.classList.remove("selected"));
  }

  // src/interaction/pages.ts
  function answerText(a) {
    if (a.cancelled) return "\uFF08\u53D6\u6D88\u672C\u9898\uFF09";
    if (a.confirmed !== void 0) return a.confirmed ? "\u786E\u5B9A" : "\u53D6\u6D88";
    return a.value ?? "";
  }
  function historyBody(hist) {
    const wrap = document.createElement("div");
    wrap.className = "page-body";
    const q = document.createElement("div");
    q.className = "uir-title";
    q.textContent = hist.q.title || hist.q.message || "";
    wrap.appendChild(q);
    const row = document.createElement("div");
    row.className = "hist-answer";
    const tag = document.createElement("span");
    tag.className = "hist-tag";
    tag.textContent = "\u2713 \u5DF2\u7B54\uFF08\u5DF2\u53D1\u9001\uFF09";
    const val = document.createElement("span");
    val.className = "hist-value";
    val.textContent = answerText(hist.a);
    val.title = val.textContent;
    row.append(tag, val);
    wrap.appendChild(row);
    return wrap;
  }
  function questionBody(q, cur, onDraft, onCommit) {
    const wrap = document.createElement("div");
    wrap.className = "page-body";
    const t = document.createElement("div");
    t.className = "uir-title";
    t.textContent = q.title || q.message || "";
    wrap.appendChild(t);
    if (q.message && q.title) {
      const m = document.createElement("div");
      m.className = "uir-message";
      m.textContent = q.message;
      wrap.appendChild(m);
    }
    wrap.appendChild(buildControls(q, cur, onDraft, onCommit));
    return wrap;
  }
  function confirmBody(queue, answers, onEdit) {
    const wrap = document.createElement("div");
    wrap.className = "page-body";
    const t = document.createElement("div");
    t.className = "uir-title";
    t.textContent = "\u786E\u8BA4\u63D0\u4EA4";
    wrap.appendChild(t);
    const sub = document.createElement("div");
    sub.className = "uir-message";
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
    const box = document.createElement("div");
    box.className = "batch";
    box.append(tabBar(h), current(h), nav(h));
    listEl2.appendChild(box);
  }
  function tabBar(h) {
    const bar = document.createElement("div");
    bar.className = "tabs";
    state.history.forEach((entry, i) => {
      const b = document.createElement("button");
      b.className = "tab done";
      if (entry.a.cancelled) {
        b.classList.remove("done");
        b.classList.add("skipped");
      }
      if (state.page === i) b.classList.add("active");
      b.textContent = String(i + 1);
      b.title = `\u5DF2\u7B54\uFF1A${entry.q.title.split("\n")[0].slice(0, 60)}`;
      b.addEventListener("click", () => jump(h, i));
      bar.appendChild(b);
    });
    state.queue.forEach((q, i) => {
      const b = document.createElement("button");
      b.className = "tab";
      const idx = state.history.length + i;
      if (state.page === idx) b.classList.add("active");
      if (state.answers.has(q.id)) b.classList.add("done");
      b.textContent = String(idx + 1);
      b.title = q.title.split("\n")[0].slice(0, 60);
      b.addEventListener("click", () => jump(h, idx));
      bar.appendChild(b);
    });
    if (isBatch()) {
      const s = document.createElement("button");
      s.className = "tab submit";
      if (state.page === confirmPage()) s.classList.add("active");
      s.textContent = "\u2713 \u63D0\u4EA4";
      s.addEventListener("click", () => jump(h, confirmPage()));
      bar.appendChild(s);
    }
    const count = document.createElement("span");
    count.className = "tab-count";
    count.textContent = isBatch() ? `\u5DF2\u7B54 ${state.queue.length - unansweredCount()}/${state.queue.length}` : state.queue.length > 0 ? "\u5F85\u56DE\u7B54" : "\u7B49\u5F85\u4E0B\u4E00\u4E2A\u2026";
    bar.appendChild(count);
    return bar;
  }
  function current(h) {
    if (state.page < state.history.length) {
      return historyBody(state.history[state.page]);
    }
    if (isBatch() && state.page >= confirmPage()) {
      return confirmBody(
        state.queue,
        state.answers,
        (i) => jump(h, state.history.length + i)
      );
    }
    const qi = state.page - state.history.length;
    const q = state.queue[qi];
    if (!q) return info("\u7B49\u5F85\u4E0B\u4E00\u4E2A\u95EE\u9898\u2026");
    return questionBody(
      q,
      state.answers.get(q.id),
      // onDraft：内容变了 → ★ 只写草稿 ✗ 绝不提交 ✓
      (r) => {
        state.answers.set(q.id, r);
        if (isTyping()) return;
        h.redraw();
      },
      // onCommit：明确的“提交这个答案”动作 ✗
      (r) => {
        state.answers.set(q.id, r);
        if (isBatch()) {
          advanceToNextUnanswered();
          h.redraw();
        } else {
          h.sendNow(q.id, r);
        }
      }
    );
  }
  function nav(h) {
    const bar = document.createElement("div");
    bar.className = "nav";
    const prev = mkBtn("\u2190 \u4E0A\u4E00\u9898", () => jump(h, state.page - 1));
    prev.disabled = state.page <= 0;
    bar.appendChild(prev);
    const onQuestion = !(state.page < state.history.length) && !(isBatch() && state.page >= confirmPage());
    if (onQuestion) {
      const q = state.queue[state.page - state.history.length];
      bar.appendChild(
        mkBtn("\u53D6\u6D88\u672C\u9898", () => {
          if (!q) return;
          if (isBatch()) {
            state.answers.set(q.id, { cancelled: true });
            advanceToNextUnanswered();
            h.redraw();
          } else {
            h.sendNow(q.id, { cancelled: true });
          }
        }, "cancel")
      );
    }
    if (isBatch() && state.page < confirmPage()) {
      const last = state.page === confirmPage() - 1;
      bar.appendChild(
        mkBtn(last ? "\u53BB\u786E\u8BA4 \u2192" : "\u4E0B\u4E00\u9898 \u2192", () => jump(h, state.page + 1), "navbtn")
      );
    }
    return bar;
  }
  function jump(h, page) {
    state.page = Math.max(0, Math.min(page, confirmPage()));
    h.redraw();
  }
  function isTyping() {
    const ae = document.activeElement;
    return !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
  }
  function mkBtn(text, onClick, extra = "") {
    const b = document.createElement("button");
    b.className = "uir-opt " + extra;
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
  function info(text) {
    const d = document.createElement("div");
    d.className = "uir-info";
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
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || state.submitted || state.queue.length === 0) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (state.page < state.history.length) return;
    const q = state.queue[state.page - state.history.length];
    if (!q) return;
    if (state.queue.length >= 2) {
      state.answers.set(q.id, { cancelled: true });
      advanceToNextUnanswered();
      redraw();
      return;
    }
    handlers.sendNow(q.id, { cancelled: true });
  });
  document.addEventListener("keydown", (e) => {
    if (state.submitted) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (state.history.length + state.queue.length === 0) return;
    const last = state.history.length + state.queue.length + (state.queue.length >= 2 ? 1 : 0);
    const next = e.key === "ArrowRight" ? state.page + 1 : state.page - 1;
    const clamped = Math.max(0, Math.min(next, last));
    if (clamped === state.page) return;
    state.page = clamped;
    redraw();
  });
  vscode.postMessage({ kind: "ready" });
})();

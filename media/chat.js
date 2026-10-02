"use strict";
(() => {
  // src/webview/index.ts
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById("messages");
  var inputEl = document.getElementById("input");
  var sendBtn = document.getElementById("send");
  var statusBarEl = document.getElementById("status-bar");
  var sbCost = document.getElementById("sb-cost");
  var sbOut = document.getElementById("sb-out");
  var sbCache = document.getElementById("sb-cache");
  var sbBattery = document.getElementById("sb-battery");
  var sbBatteryFill = document.getElementById("sb-battery-fill");
  var sbBatteryPct = document.getElementById("sb-battery-pct");
  var modelLimits = {};
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
  function updateStatusBar(usage, model) {
    const u = usage || {};
    sbCost.textContent = "\xA5 " + fmtCost(u.cost && u.cost.total);
    sbOut.textContent = "out " + fmtNum(u.output);
    const inp = Number(u.input) || 0;
    const cr = Number(u.cacheRead) || 0;
    const hit = inp + cr > 0 ? Math.round(cr / (inp + cr) * 100) : 0;
    sbCache.textContent = "cache " + hit + "%";
    const total = Number(u.totalTokens) || 0;
    const limit = model ? modelLimits[model] : void 0;
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
  var currentRole = "assistant";
  var currentBubble = null;
  function scrollToBottom() {
    if (autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  var autoScroll = true;
  messagesEl.addEventListener("scroll", () => {
    autoScroll = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  });
  function createBubble(kind) {
    const div = document.createElement("div");
    div.className = "bubble " + kind;
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }
  var defaultThinkCollapsed = false;
  var defaultToolCollapsed = false;
  var lastThinkBubble = null;
  var thinkStartAt = 0;
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
  function createThinkingBubble(label) {
    const div = document.createElement("div");
    div.className = "bubble thinking";
    div.dataset.open = defaultThinkCollapsed ? "false" : "true";
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
    lastThinkBubble = div;
    return div;
  }
  function markThinkDone() {
    if (!lastThinkBubble) return;
    const sec = thinkStartAt ? ((Date.now() - thinkStartAt) / 1e3).toFixed(1) : null;
    const label = lastThinkBubble.querySelector(".think-label");
    if (label) label.textContent = sec ? `\u5DF2\u601D\u8003\uFF08\u7528\u65F6 ${sec} \u79D2\uFF09` : "\u5DF2\u601D\u8003";
  }
  var pendingEl = null;
  function showPending() {
    if (pendingEl) return;
    pendingEl = document.createElement("div");
    pendingEl.className = "bubble pending";
    pendingEl.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
    messagesEl.appendChild(pendingEl);
    scrollToBottom();
  }
  function removePending() {
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
  }
  function appendSegment(kind, text) {
    removePending();
    if (kind === "thinking") {
      if (!currentBubble || !currentBubble.classList.contains("thinking")) {
        currentBubble = createThinkingBubble();
        if (!thinkStartAt) thinkStartAt = Date.now();
      }
      currentBubble.querySelector(".think-body").textContent += text;
    } else {
      if (!currentBubble || !currentBubble.classList.contains(kind)) {
        currentBubble = createBubble(kind);
      }
      currentBubble.textContent += text;
    }
    scrollToBottom();
  }
  function createToolBubble(callId, toolName) {
    const div = document.createElement("div");
    div.className = "bubble tool";
    div.dataset.callId = callId;
    div.dataset.open = defaultToolCollapsed ? "false" : "true";
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
    messagesEl.appendChild(div);
    currentBubble = div;
    scrollToBottom();
    return div;
  }
  function markStreamingDone(bubble) {
    const host = bubble.querySelector(".tool-result");
    if (host) host.dataset.streaming = "false";
  }
  var retryNoticeEl = null;
  var userAborted = false;
  function showRetryNotice(p) {
    removePending();
    let el = retryNoticeEl;
    if (!el || el.dataset.final === "true") {
      el = document.createElement("div");
      el.className = "bubble notice retry";
      el.dataset.final = "false";
      messagesEl.appendChild(el);
      retryNoticeEl = el;
    }
    const isFinal = p.final === true;
    el.dataset.final = isFinal ? "true" : "false";
    const aborted = isFinal && userAborted;
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
    const all = messagesEl.querySelectorAll(
      ".bubble:not(.user):not(.pending):not(.notice)"
    );
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
      const t = p && p.type;
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
        if (typeof p.data === "string") img.src = "data:" + mime + ";base64," + p.data;
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
  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    userAborted = false;
    vscode.postMessage({ kind: "prompt", text });
    inputEl.value = "";
    autoGrow();
  }
  var inputAreaEl = document.getElementById("input-area");
  function cssNum(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function inputLineHeight() {
    const cs = getComputedStyle(inputEl);
    return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
  }
  function syncPadding() {
    messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + 8 + "px";
  }
  function autoGrow() {
    const lineH = inputLineHeight();
    const minH = cssNum("--pi-input-min-rows", 1) * lineH;
    const maxH = Math.max(cssNum("--pi-input-max-rows", 8) * lineH, minH);
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, minH), maxH) + "px";
    inputEl.style.overflowY = inputEl.scrollHeight > maxH ? "auto" : "hidden";
    syncPadding();
  }
  inputEl.addEventListener("input", autoGrow);
  window.addEventListener("resize", autoGrow);
  autoGrow();
  function setAgentState(state) {
    const busy = state === "working";
    sendBtn.classList.toggle("busy", busy);
    sendBtn.title = busy ? "\u70B9\u51FB\u4E2D\u65AD" : "\u53D1\u9001 (Enter)";
  }
  sendBtn.addEventListener("click", () => {
    if (sendBtn.classList.contains("busy")) {
      userAborted = true;
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
    defaultThinkCollapsed = !!vars && vars["--pi-think-collapsed"] === "on";
    defaultToolCollapsed = !!vars && vars["--pi-tool-collapsed"] === "on";
  }
  window.addEventListener("message", (event) => {
    const data = event.data ?? {};
    if (data.kind === "styleVars") {
      applyStyleVars(data.payload);
      autoGrow();
      return;
    }
    if (data.kind === "modelLimits") {
      modelLimits = data.payload ?? {};
      return;
    }
    if (data.kind === "agentState") {
      setAgentState(data.payload);
      if (data.payload === "working") {
        showPending();
      } else {
        userAborted = false;
        removePending();
      }
      return;
    }
    if (data.kind === "snapshot") {
      messagesEl.innerHTML = "";
      currentBubble = null;
      pendingEl = null;
      lastThinkBubble = null;
      for (const b of data.payload) {
        currentRole = b.role;
        if (b.role === "user") {
          const el = createBubble("user");
          el.textContent = b.blocks.map((x) => x.text).join("");
          currentBubble = null;
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
            last.querySelector(".think-body").textContent += blk.text;
          } else {
            if (!last || !last.classList.contains("text")) {
              last = createBubble("text");
            }
            last.textContent += blk.text;
          }
          currentBubble = last;
        }
      }
      for (let i = data.payload.length - 1; i >= 0; i--) {
        if (data.payload[i].usage) {
          updateStatusBar(data.payload[i].usage, data.payload[i].model);
          break;
        }
      }
      scrollToBottom();
      return;
    }
    if (data.kind === "patch") {
      const p = data.payload;
      if (p.kind === "startBubble") {
        currentRole = p.role;
        currentBubble = null;
        if (p.role === "user" && p.text) {
          const el = createBubble("user");
          el.textContent = p.text;
          currentBubble = el;
          if (pendingEl) messagesEl.appendChild(pendingEl);
        }
      } else if (p.kind === "append") {
        appendSegment(p.block, p.text);
      } else if (p.kind === "endBubble") {
        if (p.stopReason === "aborted" && retryNoticeEl && retryNoticeEl.dataset.final !== "true") {
        } else if (p.stopReason) {
          appendStopNote(p.stopReason);
        }
        if (p.usage || p.model) updateStatusBar(p.usage, p.model);
        currentBubble = null;
      } else if (p.kind === "retryNotice") {
        showRetryNotice(p);
      } else if (p.kind === "toolStart") {
        removePending();
        setToolState(createToolBubble(p.callId, p.name), "running");
      } else if (p.kind === "thinkStart") {
        removePending();
        thinkStartAt = Date.now();
      } else if (p.kind === "thinkEnd") {
        markThinkDone();
        thinkStartAt = 0;
      } else if (p.kind === "toolArgs") {
        const host = currentBubble && currentBubble.querySelector(".tool-args");
        if (host) {
          host.dataset.raw = (host.dataset.raw || "") + p.text;
          host.textContent = host.dataset.raw;
        }
        scrollToBottom();
      } else if (p.kind === "toolEnd") {
        if (currentBubble) renderArgs(currentBubble, p.args);
      } else if (p.kind === "toolResult") {
        const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + p.callId + '"]');
        if (bubble) {
          renderResultParts(bubble, p.parts, p.isError, false);
          setToolState(bubble, p.isError ? "error" : "ok");
          markStreamingDone(bubble);
        }
      } else if (p.kind === "toolExecStart") {
        const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + p.callId + '"]');
        if (bubble) {
          setToolState(bubble, "running");
          ensureResultHost(bubble).dataset.streaming = "true";
        }
      } else if (p.kind === "toolExecUpdate") {
        const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + p.callId + '"]');
        if (bubble) {
          const host = ensureResultHost(bubble);
          host.dataset.streaming = "true";
          renderResultParts(bubble, p.parts, false, true);
        }
      } else if (p.kind === "toolExecEnd") {
        const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + p.callId + '"]');
        if (bubble) {
          markStreamingDone(bubble);
          setToolState(bubble, p.isError ? "error" : "ok");
        }
      }
    }
  });
  vscode.postMessage({ kind: "ready" });
})();

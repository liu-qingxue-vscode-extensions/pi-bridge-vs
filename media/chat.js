const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    // ===== 渲染模型 =====
    // 【每个内容段 = 一个独立气泡】(user / thinking / text / tool)
    // 工具气泡比较特殊：上半 = 调用，下半 = 结果（结果来自另一条消息，用 callId 找回）
    let currentRole = "assistant";   // 当前消息的角色（决定对齐）
    let currentBubble = null;        // 当前正在流式追加的气泡元素

    function scrollToBottom() {
      // ★ 只在【用户本来就在底部】时才自动滚
      // 否则 AI 流式输出会强行把他拉回去（抖动，且无法往上翻历史）✗
      if (autoScroll) messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // 自动滚开关：由用户滚动行为决定
    let autoScroll = true;
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

    // ===== 默认折叠开关（由设置驱动，applyStyleVars 时更新）=====
    let defaultThinkCollapsed = false;
    let defaultToolCollapsed = false;

    /** 思考气泡：可折叠（点头部切展开/收起）*/
    let lastThinkBubble = null;
    let thinkStartAt = 0;

    /** 静态箭头图标（下箭头，用 SVG 尺寸可控、和文字同高）*/
    const CARET_SVG =
      '<svg class="head-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
      ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6 9l6 6 6-6"/></svg>';

    /**
     * 通用折叠头：【左】名字串（整串是一个按钮，点击折叠）【右】操作区（未来放复制等按钮）
     * @param labelText 显示文字（用 textContent 写入 → 免疫注入）
     * @param onToggle 点击名字串时的动作
     */
    function createHead(labelText, onToggle) {
      const head = document.createElement("div");
      head.className = "head";

      const btn = document.createElement("button");
      btn.className = "head-toggle";
      const label = document.createElement("span");
      label.className = "head-label";
      label.textContent = labelText;
      btn.appendChild(label);
      btn.insertAdjacentHTML("beforeend", CARET_SVG);   // 静态 SVG，安全
      btn.addEventListener("click", onToggle);

      const actions = document.createElement("span");   // ★ 未来的按钮位（现在空）
      actions.className = "head-actions";

      head.appendChild(btn);
      head.appendChild(actions);
      return head;
    }

    function createThinkingBubble(label) {
      const div = document.createElement("div");
      div.className = "bubble thinking";
      div.dataset.open = defaultThinkCollapsed ? "false" : "true";

      const head = createHead(label || "正在思考…", () => {
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

    /** 思考结束 → 把头部改成“已思考（用时 X 秒）”*/
    function markThinkDone() {
      if (!lastThinkBubble) return;
      const sec = thinkStartAt ? ((Date.now() - thinkStartAt) / 1000).toFixed(1) : null;
      const label = lastThinkBubble.querySelector(".think-label");
      if (label) label.textContent = sec ? `已思考（用时 ${sec} 秒）` : "已思考";
    }

    /** 占位三点（发送后、首个数据包到达前）*/
    let pendingEl = null;
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

    /** 追加文本到“当前气泡”（thinking / text）；类型变了就新建气泡 */
    function appendSegment(kind, text) {
      removePending();                       // ★ 真实内容来了 → 撤掉占位
      if (kind === "thinking") {
        if (!currentBubble || !currentBubble.classList.contains("thinking")) {
          currentBubble = createThinkingBubble();
          if (!thinkStartAt) thinkStartAt = Date.now(); // 兜底计时
        }
        currentBubble.querySelector(".think-body").textContent += text;
      } else {
        if (!currentBubble || !currentBubble.classList.contains(kind)) {
          currentBubble = createBubble(kind);
        }
        currentBubble.textContent += text;   // textContent：免疫 HTML 注入
      }
      scrollToBottom();
    }

    /** 新建工具气泡（外框 + 上半调用 + 下半结果占位）*/
    function createToolBubble(callId, toolName) {
      const div = document.createElement("div");
      div.className = "bubble tool";
      div.dataset.callId = callId;
      div.dataset.open = defaultToolCollapsed ? "false" : "true";

      // 折叠头：左=工具名串（按钮）· 右=操作区（未来放复制等）
      const head = createHead("🔧 " + (toolName || "tool"), () => {
        div.dataset.open = div.dataset.open === "true" ? "false" : "true";
      });

      // 内容体（可折叠）：上半调用参数 · 下半结果（结果可能晚到，用 callId 填回）
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

    /** 工具状态：转圈（running）/ 勾（ok）/ 叉（error）*/
    function setToolState(bubble, state) {
      let el = bubble.querySelector(".tool-state");
      if (!el) {
        el = document.createElement("span");
        el.className = "tool-state";
        const toggle = bubble.querySelector(".head-toggle");
        if (toggle) toggle.appendChild(el);
      }
      el.className = "tool-state " + state;
      el.textContent = state === "running" ? "" : state === "error" ? "✗" : "✓";
    }

    /**
     * 参数 → 键值对列表（通用渲染）
     * 用 grid 布局：多行值的续行会自动对齐到第二列 ✓
     * （比一坨原始 JSON 字符串好读得多）
     */
    function renderArgs(bubble, args) {
      const host = bubble.querySelector(".tool-args");
      if (!host) return;
      host.innerHTML = "";
      if (args === undefined || args === null) return;
      if (typeof args !== "object" || Array.isArray(args)) {
        host.textContent = JSON.stringify(args, null, 2);
        return;
      }
      const entries = Object.entries(args);
      if (!entries.length) {
        host.textContent = "（无参数）";
        return;
      }
      for (const [k, v] of entries) {
        const row = document.createElement("div");
        row.className = "arg-row";
        row.dataset.open = "true";

        // ★ 箭头 + 参数名 = 一个按钮（点它收起该参数 → 只显示第一行）
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

    /**
     * 结果 → 按 content 元素的 type 分发渲染（通用，不丢字段）
     * · text  → 等宽文本（保留换行）
     * · image → <img data:...>
     * · 其他  → 原始 JSON 兜底
     */
    function renderResultParts(bubble, parts, isError) {
      let host = bubble.querySelector(".tool-result");
      if (!host) {
        host = document.createElement("div");
        host.className = "tool-result";
        host.dataset.open = "true";

        // 可折叠头部（箭头 + 标签，标签文字由 CSS 变量控制）
        const head = document.createElement("button");
        head.className = "result-toggle";
        head.insertAdjacentHTML("beforeend", CARET_SVG);
        head.insertAdjacentHTML("beforeend", '<span class="result-label"></span>');
        head.addEventListener("click", () => {
          host.dataset.open = host.dataset.open === "true" ? "false" : "true";
        });

        // 内容体
        const body = document.createElement("div");
        body.className = "result-body";

        host.appendChild(head);
        host.appendChild(body);
        // ★ 必须加进 .tool-body（直接加在 .bubble 上会跑到 padding 之外 ✗）
        (bubble.querySelector(".tool-body") || bubble).appendChild(host);
      }
      host.classList.toggle("error", !!isError);
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
          img.alt = "图像输出";
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
      if (!body.childElementCount) body.textContent = "（无输出）";
      scrollToBottom();
    }

    // ===== 发送：前端 -> 扩展宿主 =====
    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      vscode.postMessage({ kind: "prompt", text });
      inputEl.value = "";
      autoGrow();
    }

    // ===== 输入框高度自适应（最小/最大【行数】可配 → 逐行爬高 → 超上限出滚动条）=====
    const inputAreaEl = document.getElementById("input-area");

    /** 从计算样式里取一个数值变量（如 --pi-input-max-rows）*/
    function cssNum(name, fallback) {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : fallback;
    }

    /** 单行高度（从 textarea 的计算样式拿，跟随字号变化 ✓）*/
    function inputLineHeight() {
      const cs = getComputedStyle(inputEl);
      return parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45;
    }

    /**
     * ★ 把消息区的底部留白同步为【输入区实际高度】
     * 否则固定留白会在“滚到底”时露出一块多余空白（用户看到的那条“缝” ✗）
     */
    function syncPadding() {
      messagesEl.style.paddingBottom = inputAreaEl.offsetHeight + 8 + "px";
    }

    function autoGrow() {
      const lineH = inputLineHeight();
      const minH = cssNum("--pi-input-min-rows", 1) * lineH;
      const maxH = Math.max(cssNum("--pi-input-max-rows", 8) * lineH, minH);
      inputEl.style.height = "auto";                 // 先重置才能量到真实高度
      inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, minH), maxH) + "px";
      inputEl.style.overflowY = inputEl.scrollHeight > maxH ? "auto" : "hidden";
      syncPadding();
    }
    inputEl.addEventListener("input", autoGrow);
    window.addEventListener("resize", autoGrow);
    autoGrow();

    // ===== 任务状态（agent_start / agent_settled 驱动）=====
    // 注：不再用中文状态文字（按钮形态本身就是指示）
    function setAgentState(state) {
      const busy = state === "working";
      sendBtn.classList.toggle("busy", busy);
      sendBtn.title = busy ? "工作中…" : "发送 (Enter)";
    }
    sendBtn.addEventListener("click", send);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // ===== 应用样式变量（设置变化时由宿主推送）=====
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
      // ★ 居中内容列开关 + 默认折叠开关（布尔不能当 CSS 变量用 → 切类 / 存全局）
      root.classList.toggle("centered", !!vars && vars["--pi-centered-mode"] === "on");
      defaultThinkCollapsed = !!vars && vars["--pi-think-collapsed"] === "on";
      defaultToolCollapsed = !!vars && vars["--pi-tool-collapsed"] === "on";
    }

    // ===== 接收宿主消息 =====
    window.addEventListener("message", (event) => {
      const data = event.data ?? {};

      if (data.kind === "styleVars") {
        applyStyleVars(data.payload);
        autoGrow();               // ★ 配置变了（如行数/字号）→ 重新算高度与留白
        return;
      }

      if (data.kind === "agentState") {
        setAgentState(data.payload);
        // 任务开始 → 立刻显示占位三点（不要空荡荡地等第一个数据包）
        if (data.payload === "working") showPending();
        else removePending();
        return;
      }

      if (data.kind === "snapshot") {
        // 全量重放（webview 重建后恢复画面）
        messagesEl.innerHTML = "";
        currentBubble = null;
        pendingEl = null;        // ★ 重建后不保留旧占位引用
        lastThinkBubble = null;
        for (const b of data.payload) {
          currentRole = b.role;
          // ★ 用户消息：整条消息就是一个 user 气泡（不走 segment 逻辑）
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
              if (blk.resultParts !== undefined) {
                renderResultParts(last, blk.resultParts, blk.resultIsError === true);
                setToolState(last, blk.resultIsError ? "error" : "ok");
              } else {
                setToolState(last, "running");
              }
            } else if (blk.type === "thinking") {
              // 历史里的思考：也是可折叠气泡（已完成，无时长可显示）
              if (!last || !last.classList.contains("thinking")) {
                last = createThinkingBubble("已思考");
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
        scrollToBottom();
        return;
      }

      if (data.kind === "patch") {
        const p = data.payload;
        if (p.kind === "startBubble") {
          currentRole = p.role;
          currentBubble = null;                 // 等第一个段到来时再建
          if (p.role === "user" && p.text) {
            // ★ 你的消息：直接建一个 user 气泡（样式、对齐、宽度都靠 .bubble.user）
            const el = createBubble("user");
            el.textContent = p.text;
            currentBubble = el;
          }
        } else if (p.kind === "append") {
          appendSegment(p.block, p.text);
        } else if (p.kind === "endBubble") {
          currentBubble = null;
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
          // 流式拼装中：先原样显示（拼完后再美化成键值对）
          const host = currentBubble && currentBubble.querySelector(".tool-args");
          if (host) {
            host.dataset.raw = (host.dataset.raw || "") + p.text;
            host.textContent = host.dataset.raw;
          }
          scrollToBottom();
        } else if (p.kind === "toolEnd") {
          // ★ 参数拼完 → 渲染成键值对
          if (currentBubble) renderArgs(currentBubble, p.args);
        } else if (p.kind === "toolResult") {
          // 结果在另一条消息里 → 按 callId 找回工具气泡
          const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + p.callId + '"]');
          if (bubble) {
            renderResultParts(bubble, p.parts, p.isError);
            setToolState(bubble, p.isError ? "error" : "ok");
          }
        }
      }
    });

    // 通知宿主：webview 已就绪 → 请求重放快照
    vscode.postMessage({ kind: "ready" });
  

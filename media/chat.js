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

    /** 追加文本到"当前气泡"（thinking / text）；类型变了就新建气泡 */
    function appendSegment(kind, text) {
      if (!currentBubble || !currentBubble.classList.contains(kind)) {
        currentBubble = createBubble(kind);
      }
      currentBubble.textContent += text;   // textContent：免疫 HTML 注入
      scrollToBottom();
    }

    /** 新建工具气泡（外框 + 上半调用 + 下半结果占位）*/
    function createToolBubble(callId, toolName) {
      const div = document.createElement("div");
      div.className = "bubble tool";
      div.dataset.callId = callId;

      const call = document.createElement("div");
      call.className = "tool-call";
      const head = document.createElement("div");
      head.className = "tool-head";
      head.textContent = "🔧 " + (toolName || "tool");
      const args = document.createElement("div");
      args.className = "tool-args";
      call.appendChild(head);
      call.appendChild(args);

      div.appendChild(call);
      messagesEl.appendChild(div);
      currentBubble = div;
      scrollToBottom();
      return div;
    }

    /** 把工具结果填回对应的工具气泡（跨消息关联）*/
    function fillToolResult(callId, text, isError) {
      const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + callId + '"]');
      if (!bubble) return false;
      let result = bubble.querySelector(".tool-result");
      if (!result) {
        result = document.createElement("div");
        result.className = "tool-result";
        bubble.appendChild(result);
      }
      if (isError) result.classList.add("error");
      result.textContent = text;   // 注意：::before 是伪元素，不影响 textContent
      scrollToBottom();
      return true;
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
      // ★ 居中内容列开关（布尔值不能当 CSS 变量用 → 切一个 CSS 类，由 :root.centered 规则接管）
      root.classList.toggle("centered", !!vars && vars["--pi-centered-mode"] === "on");
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
        return;
      }

      if (data.kind === "snapshot") {
        // 全量重放（webview 重建后恢复画面）
        messagesEl.innerHTML = "";
        currentBubble = null;
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
              last.querySelector(".tool-args").textContent = blk.text;
              if (blk.result !== undefined) {
                fillToolResult(blk.toolCallId || "", blk.result, blk.resultIsError === true);
              }
            } else {
              if (!last || last.dataset.seg !== blk.type) {
                last = createBubble(blk.type);   // thinking / text
                last.dataset.seg = blk.type;
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
          createToolBubble(p.callId, p.name);
        } else if (p.kind === "toolArgs") {
          if (currentBubble) currentBubble.querySelector(".tool-args").textContent += p.text;
          scrollToBottom();
        } else if (p.kind === "toolEnd") {
          /* 参数拼装完成（目前无额外动作）*/
        } else if (p.kind === "toolResult") {
          fillToolResult(p.callId, p.text, p.isError);
        }
      }
    });

    // 通知宿主：webview 已就绪 → 请求重放快照
    vscode.postMessage({ kind: "ready" });
  

const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");
    // 顶部状态栏
    const statusBarEl = document.getElementById("status-bar");
    const sbCost = document.getElementById("sb-cost");
    const sbOut = document.getElementById("sb-out");
    const sbCache = document.getElementById("sb-cache");
    const sbBattery = document.getElementById("sb-battery");
    const sbBatteryFill = document.getElementById("sb-battery-fill");
    const sbBatteryPct = document.getElementById("sb-battery-pct");
    // 输入区下方极简栏
    const footModel = document.getElementById("foot-model");
    const footCwd = document.getElementById("foot-cwd");

    /** modelId → contextWindow（由宿主推送；查不到则电池显示 "?"）*/
    let modelLimits = {};

    /** 数字缩写：12345 → 12.3k */
    function fmtNum(n) {
      const v = Number(n) || 0;
      if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
      return String(v);
    }

    /** 花费：小额多给几位小数 */
    function fmtCost(c) {
      const v = Number(c) || 0;
      if (v === 0) return "0";
      if (v < 0.001) return v.toFixed(6);
      if (v < 1) return v.toFixed(4);
      return v.toFixed(2);
    }

    /**
     * 路径太长 → 保留【尾部】（前面的目录省略 ✓ 像终端那样）
     * ★ 不用 CSS 的 direction:rtl —— 那会让路径里的 / 显示位置错乱 ✗
     */
    function shortenPath(p, max) {
      const n = max || 40;
      return p.length <= n ? p : "…" + p.slice(-(n - 1));
    }

    /**
     * 刷新顶部状态栏（数据源：message_end.message.usage / model）
     * 四列（视觉左→右）：花费 · 输出 token · 缓存命中率 · 电池（对话长度）
     */
    function updateStatusBar(usage, model) {
      const u = usage || {};

      // ★ 输入区下方：当前模型
      if (model) {
        footModel.textContent = model;
        footModel.title = "当前模型：" + model;
      }

      // 花费
      sbCost.textContent = "¥ " + fmtCost(u.cost && u.cost.total);

      // 输出 token
      sbOut.textContent = "out " + fmtNum(u.output);

      // 缓存命中率 = cacheRead / (input + cacheRead)
      const inp = Number(u.input) || 0;
      const cr = Number(u.cacheRead) || 0;
      const hit = inp + cr > 0 ? Math.round((cr / (inp + cr)) * 100) : 0;
      sbCache.textContent = "cache " + hit + "%";

      // 电池 = 【剩余】上下文比例（reverse 语义：越用越少 ✓）
      const total = Number(u.totalTokens) || 0;
      const limit = model ? modelLimits[model] : undefined;
      if (typeof limit === "number" && limit > 0) {
        const usedPct = Math.max(0, Math.min(100, Math.round((total / limit) * 100)));
        const remain = 100 - usedPct;                  // ★ 显示剩余 ✓
        statusBarEl.classList.remove("no-limit");
        sbBatteryFill.style.width = remain + "%";      // ★ 填充 = 剩余 ✓
        sbBatteryPct.textContent = String(remain);     // 数字在电池【内部】✓
        sbBattery.classList.toggle("low", remain <= 25);
        sbBattery.classList.toggle("empty", remain <= 5);
      } else {
        // 拿不到分母 → 整个电池区变成一个问号 ✓（不显示绝对 token ✗）
        statusBarEl.classList.add("no-limit");
        sbBatteryPct.textContent = "?";
      }
    }

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

    /** 结束“执行中…”状态（头部标签恢复成“结果”）*/
    function markStreamingDone(bubble) {
      const host = bubble.querySelector(".tool-result");
      if (host) host.dataset.streaming = "false";
    }

    // ===== 重连提示（auto_retry_start / auto_retry_end）=====
    // ★ 不进快照 → webview 重建后自然消失 ✓
    // ★ 出现之后【一直留着】（下次对话也不挤掉 ✗）
    let retryNoticeEl = null;

    /**
     * ★ 用户是否主动中断过当前任务
     * 用途：auto_retry_end 的 success 无法区分【被中断】和【真的连上了】✗
     *   实测两者都是 { success:true, attempt:N }（无 finalError）—— 结构一模一样 ✗
     *   唯一判据就是【我们自己的 abort 按钮】（用户点了才知道 ✓）
     */
    let userAborted = false;

    /**
     * 重连提示气泡（同一个气泡内【原地更新】→ 能看到 1/3 → 2/3 → 3/3 的变化 ✓）
     * p: ChatPatch 里的 retryNotice 字段（attempt / maxAttempts / delayMs / message / final / success）
     */
    function showRetryNotice(p) {
      // ★ 进入重试状态 → 占位三点应该消失（被重试气泡取代 ✓）
      removePending();
      // ★ 什么时候开【新】气泡？
      //   判据：上一个气泡已经【终结】（final=true）→ 那才是新一批 ✓
      //   不能用 p.attempt === 1 ✗：实测 attempt 会跨批次重置（1,2,3 … 又是 1,2）✗
      //   → 用 attempt===1 会在旧气泡还活着时就新建 → 旧气泡变成【僵尸】永远转圈 ✗
      let el = retryNoticeEl;
      if (!el || el.dataset.final === "true") {
        el = document.createElement("div");
        el.className = "bubble notice retry";
        el.dataset.final = "false";
        messagesEl.appendChild(el);
        retryNoticeEl = el;
      }
      const isFinal = p.final === true;
      el.dataset.final = isFinal ? "true" : "false";   // ★ 供下一次判定“是否新一批”使用 ✓
      // ★ 中断 ≠ 成功：pi 两者都发 success:true 无 finalError ✗ → 用我们自己的标志判定 ✓
      const aborted = isFinal && userAborted;
      const ok = isFinal && p.success === true && !aborted;
      el.classList.toggle("failed", aborted || (isFinal && !ok));
      el.classList.toggle("retrying", !isFinal);
      el.classList.toggle("ok", ok);

      // 进度：1/3
      const attempt =
        p.attempt && p.maxAttempts
          ? p.attempt + "/" + p.maxAttempts
          : p.attempt
            ? String(p.attempt)
            : "";

      // 文案：尽量复用 pi 给的原文（errorMessage / finalError）✓
      let text;
      if (isFinal) {
        if (aborted) {
          text = "已中断";
        } else if (ok) {
          text = "重连成功" + (attempt ? "（第 " + attempt + " 次尝试）" : "");
        } else {
          text =
            "重连失败" +
            (attempt ? "（已尝试 " + attempt + " 次）" : "") +
            "：" +
            (p.message || "未知错误");
        }
      } else {
        const parts = ["连接中断，正在重试"];
        if (attempt) parts.push("（" + attempt + "）");
        if (p.message) parts.push(" · " + p.message);
        if (p.delayMs) parts.push(" · " + Math.round(p.delayMs / 1000) + " 秒后");
        text = parts.join("");
      }

      // 图标：进行中 = 转圈（红色 ✓）；最终 = ✖ / ✓
      const icon = isFinal
        ? aborted
          ? '<span class="notice-mark">■</span>'
          : ok
            ? '<span class="notice-mark">✓</span>'
            : '<span class="notice-mark">✖</span>'
        : '<span class="retry-spin"></span>';

      // ★ 固定结构（只在第一次建）+ textContent 写入（防注入 ✓）
      el.innerHTML = icon + '<span class="notice-text"></span>';
      el.querySelector(".notice-text").textContent = text;
      scrollToBottom();
    }

    /**
     * 异常结束提示（stopReason）—— ★ 突发情况，要【正常大小/正常颜色】地显示 ✓
     * 只处理三种异常：length（截断）/ aborted（中断）/ error（出错）
     * 正常结束（stop / toolUse）根本不会进来 ✓
     */
    function appendStopNote(reason) {
      // 挂在【最后一条 AI 气泡】底部（思考/正文/工具气泡都算）
      // ★ 必须排除 .notice（重试气泡）：否则提示会跑到重试气泡里面 ✗（两个气泡叠在一起）
      const all = messagesEl.querySelectorAll(
        ".bubble:not(.user):not(.pending):not(.notice)",
      );
      const target = all[all.length - 1];
      if (!target) return;
      if (target.querySelector(".bubble-note")) return; // 防重复
      const MAP = {
        length: { icon: "⚠", text: "输出达到长度上限，已截断", cls: "warn" },
        aborted: { icon: "■", text: "已中断", cls: "info" },
        error: { icon: "✖", text: "生成出错", cls: "error" },
      };
      const m = MAP[reason] ?? { icon: "•", text: reason, cls: "info" };
      const el = document.createElement("div");
      el.className = "bubble-note " + m.cls;
      el.textContent = m.icon + " " + m.text;
      target.appendChild(el);
      scrollToBottom();
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

    /** 在工具气泡上【取得或创建】结果区（含可折叠头部）*/
    function ensureResultHost(bubble) {
      let host = bubble.querySelector(".tool-result");
      if (host) return host;
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
      return host;
    }

    /**
     * 结果 → 按 content 元素的 type 分发渲染（通用，不丢字段）
     * · text  → 等宽文本（保留换行）
     * · image → <img data:...>
     * · 其他  → 原始 JSON 兜底
     *
     * streaming=true 时用于【执行中】的实时输出（累积全文 → 每次整块替换 ✓）
     */
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
      // 流式中还没输出（第 1 个 update 是空的）→ 留空，不要显示“（无输出）”✗
      if (!body.childElementCount) body.textContent = streaming ? "" : "（无输出）";
      scrollToBottom();
    }

    // ===== 发送：前端 -> 扩展宿主 =====
    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      userAborted = false;   // ★ 新任务开始 → 清中断标志 ✓
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
      sendBtn.title = busy ? "点击中断" : "发送 (Enter)";
    }
    // ★ 点击发送按钮：工作中 → 中断；空闲 → 发送
    //（转圈本身就表示“正在跑”，点击它 = 中断，设计上天然对应 ✓）
    sendBtn.addEventListener("click", () => {
      if (sendBtn.classList.contains("busy")) {
        userAborted = true;   // ★ 记住：这次是【我们主动中断】的（用于区分重连“成功”和“被中断”✓）
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

      if (data.kind === "modelLimits") {
        // ★ 模型上下文窗口表（电池的分母）
        modelLimits = data.payload ?? {};
        return;
      }

      if (data.kind === "cwd") {
        // ★ 工作目录（输入区下方极简栏；完整路径放 title ✓）
        const p = String(data.payload ?? "");
        footCwd.textContent = shortenPath(p, 40);
        footCwd.title = p;
        return;
      }

      if (data.kind === "agentState") {
        setAgentState(data.payload);
        // 任务开始 → 立刻显示占位三点（不要空荡荡地等第一个数据包）
        if (data.payload === "working") {
          // 注：【不】移除重连提示 ✓（用户要求：留着，别挤掉）
          showPending();
        } else {
          // ★ 任务彻底结束（settled 一定晚于 auto_retry_end ✓）→ 清中断标志
          userAborted = false;
          removePending();
        }
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
              // 优先显示最终结果，其次显示执行中的实时内容
              if (blk.resultParts !== undefined) {
                renderResultParts(last, blk.resultParts, blk.resultIsError === true, false);
                setToolState(last, blk.resultIsError ? "error" : "ok");
              } else if (blk.partialParts !== undefined) {
                renderResultParts(last, blk.partialParts, false, blk.executing === true);
                setToolState(last, blk.executing ? "running" : "ok");
                if (blk.executing) ensureResultHost(last).dataset.streaming = "true";
              } else {
                setToolState(last, blk.executing ? "running" : "ok");
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
        // ★ 顶部状态栏也从快照恢复（取最后一条带 usage 的气泡）
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
          currentBubble = null;                 // 等第一个段到来时再建
          if (p.role === "user" && p.text) {
            // ★ 你的消息：直接建一个 user 气泡（样式、对齐、宽度都靠 .bubble.user）
            const el = createBubble("user");
            el.textContent = p.text;
            currentBubble = el;
            // ★ 占位三点要始终跟在最后 → 用户气泡插进来后把它挪回末尾 ✓
            //   （否则三点会跑到用户消息【上方】，看着很奇怪 ✗）
            if (pendingEl) messagesEl.appendChild(pendingEl);
          }
        } else if (p.kind === "append") {
          appendSegment(p.block, p.text);
        } else if (p.kind === "endBubble") {
          // ★ 异常结束（截断/中断/出错）→ 在最后一条 AI 气泡底部补一行提示
          //   但“中断”且已有重试气泡时：由重试气泡负责显示“已中断”✓（不重复挂 ✗）
          if (p.stopReason === "aborted" && retryNoticeEl && retryNoticeEl.dataset.final !== "true") {
            // 重试气泡已经在讲了 → 什么都不做 ✓
          } else if (p.stopReason) {
            appendStopNote(p.stopReason);
          }
          // ★ 注意：【不在这里】清 userAborted
          //   实测时序：aborted 先到，auto_retry_end 后到 ✗
          //   若在这里清，auto_retry_end 就会误判成“成功”✗✗✗
          //   清标志的时机 → agent_settled（任务彻底结束，必然晚于 auto_retry_end ✓）
          // ★ 顶部状态栏（token 用量 + 模型名）
          if (p.usage || p.model) updateStatusBar(p.usage, p.model);
          currentBubble = null;
        } else if (p.kind === "retryNotice") {
          // ★ 重连提示：同一气泡原地更新（不进快照 ✓ 一直留着 ✗ 不挤掉）
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
            renderResultParts(bubble, p.parts, p.isError, false);
            setToolState(bubble, p.isError ? "error" : "ok");
            markStreamingDone(bubble);
          }
        } else if (p.kind === "toolExecStart") {
          // ★ 工具开始执行 → 结果区先建好，头部显示“执行中…”
          const bubble = messagesEl.querySelector('.bubble.tool[data-call-id="' + p.callId + '"]');
          if (bubble) {
            setToolState(bubble, "running");
            ensureResultHost(bubble).dataset.streaming = "true";
          }
        } else if (p.kind === "toolExecUpdate") {
          // ★ 执行中的实时输出（累积全文 → 整块替换 ✓）
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
            // 状态先按 exec 的 isError 定；若随后 toolResult 到达会再覆盖一次 ✓
            setToolState(bubble, p.isError ? "error" : "ok");
          }
        }
      }
    });

    // 通知宿主：webview 已就绪 → 请求重放快照
    vscode.postMessage({ kind: "ready" });
  

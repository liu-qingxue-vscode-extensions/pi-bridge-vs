const vscode = acquireVsCodeApi();
    const logEl = document.getElementById("log");
    const countEl = document.getElementById("count");
    let count = 0;

    function escapeHtml(s) {
      return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    // ===== 分类：决定色条颜色（一眼看出这是哪类事件）=====
    function categorize(type) {
      if (!type) return "other";
      if (type === "stderr") return "error";
      if (type.startsWith("message_update")) return "stream";   // 流式增量（高频）
      if (type.startsWith("message_")) return "message";        // 消息边界
      if (type.startsWith("extension_")) return "extension";     // pi 扩展请求
      if (type.startsWith("tool")) return "tools";               // 工具调用
      if (type.startsWith("agent_") || type.startsWith("turn_")) return "lifecycle";
      return "other";
    }

    // ===== JSON 语法高亮 =====
    // 一次正则扫描所有 token（多次 replace 会互相破坏，这里一次搞定）
    function highlightJson(obj) {
      const s = escapeHtml(JSON.stringify(obj, null, 2));
      return s.replace(
        /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        (m) => {
          let cls = "n";                                    // 数字
          if (m.startsWith('"')) {
            cls = m.trim().endsWith(":") ? "k" : "s";        // key / 字符串
          } else if (m === "true" || m === "false") {
            cls = "b";
          } else if (m === "null") {
            cls = "x";
          }
          return '<span class="' + cls + '">' + m + "</span>";
        }
      );
    }

    function bumpCount() {
      count++;
      countEl.textContent = count + " 条";
    }

    /** 普通条目：一节完整车厢（时间戳 + 类型 + JSON 内容） */
    function renderEntry(payload, ts) {
      const type = payload && payload.type ? payload.type : "?";
      const div = document.createElement("div");
      div.className = "entry";
      div.dataset.cat = categorize(type);
      div.innerHTML =
        '<div class="meta"><span class="ts">' + new Date(ts).toLocaleTimeString() + "</span>" +
        '<span class="kind">' + escapeHtml(type) + "</span></div>" +
        '<div class="j">' + highlightJson(payload) + "</div>";
      return div;
    }

    /**
     * 折叠条目：【同样是一节完整车厢】—— 有自己的时间戳，不搭别人的车头
     * （命中忽略列表的类型，只显示 `类型 × 条数`，位置与数量都保留 → 时序不错乱）
     */
    function renderFolded(type, n, ts) {
      const div = document.createElement("div");
      div.className = "entry folded";
      div.dataset.cat = categorize(type);
      div.dataset.fold = type;
      div.innerHTML =
        '<div class="meta"><span class="ts">' + new Date(ts).toLocaleTimeString() + "</span>" +
        '<span class="kind">' + escapeHtml(type) + "</span>" +
        '<span class="fold-count">×' + n + "</span>" +
        '<span class="fold-hint">（已忽略，仅计数）</span></div>';
      return div;
    }

    // ===== 接收宿主消息 =====
    //   { kind: "debug", payload, ts }              ← 普通条目（原始数据 + 宿主时间戳）
    //   { kind: "debug-fold", type, count, ts }     ← 折叠条目（命中忽略列表）
    window.addEventListener("message", (event) => {
      const msg = event.data;

      if (msg.kind === "debug") {
        bumpCount();
        logEl.appendChild(renderEntry(msg.payload, msg.ts));
        logEl.scrollTop = logEl.scrollHeight;
        return;
      }

      if (msg.kind === "debug-fold") {
        bumpCount();
        const last = logEl.lastElementChild;
        if (last && last.dataset.fold === msg.type) {
          // 同一折叠段 → 只更新计数（时间戳保持段开始的时刻）
          last.querySelector(".fold-count").textContent = "×" + msg.count;
        } else {
          logEl.appendChild(renderFolded(msg.type, msg.count, msg.ts));
        }
        logEl.scrollTop = logEl.scrollHeight;
      }
    });

    document.getElementById("clear").addEventListener("click", () => {
      logEl.innerHTML = "";
      count = 0;
      countEl.textContent = "0 条";
      // 通知宿主清空它的环形缓冲（否则关掉面板重开会把旧数据刷回来）
      vscode.postMessage({ kind: "clear" });
    });

    // 导出：把宿主【环形缓冲】里的数据导出成 JSON 文件
    document.getElementById("export").addEventListener("click", () => {
      vscode.postMessage({ kind: "export" });
    });

    // 通知扩展：调试板已打开，请把缓冲刷过来
    vscode.postMessage({ kind: "debug-ready" });
  

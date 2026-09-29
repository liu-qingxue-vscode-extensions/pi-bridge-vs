/**
 * 调试板的 HTML（第一步的主角：所有数据原样打在这里）
 *
 * 迭代方向：调试板里的每一类数据，逐个"消灭"成聊天视图里的真实 UI。
 * 调试板长期保留，作为开发/排障工具。
 */
export const debugHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  #toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  #toolbar button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
  }
  #count { color: var(--vscode-descriptionForeground); margin-left: auto; }
  #log {
    flex: 1;
    overflow-y: auto;
    padding: 8px 10px;
  }
  .entry {
    padding: 2px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    white-space: pre-wrap;
    word-break: break-all;
  }
  .ts { color: var(--vscode-descriptionForeground); }
  .kind { color: var(--vscode-textLink-foreground); font-weight: bold; }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="clear">清空</button>
    <span id="count">0 条</span>
  </div>
  <div id="log"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const logEl = document.getElementById("log");
    const countEl = document.getElementById("count");
    let count = 0;

    // 扩展到调试板的消息格式：{ kind: "debug", payload: <原始对象> }
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.kind !== "debug") return;

      count++;
      countEl.textContent = count + " 条";

      const div = document.createElement("div");
      div.className = "entry";

      const ts = new Date().toLocaleTimeString();
      const type = msg.payload && msg.payload.type ? msg.payload.type : "?";
      div.innerHTML =
        '<span class="ts">' + ts + "</span> " +
        '<span class="kind">' + type + "</span>\\n" +
        escapeHtml(JSON.stringify(msg.payload, null, 2));

      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    });

    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    document.getElementById("clear").addEventListener("click", () => {
      logEl.innerHTML = "";
      count = 0;
      countEl.textContent = "0 条";
    });

    // 通知扩展：调试板已打开，请把缓冲刷过来
    vscode.postMessage({ kind: "debug-ready" });
  </script>
</body>
</html>`;

/**
 * 聊天视图的 HTML 骨架（第一步：空 UI）
 *
 * 现状：只有"消息区占位 + 输入框"，不做任何渲染逻辑。
 * 迭代方向：调试板里看清数据后，把每一类数据逐个渲染成 UI 气泡。
 */
export const chatHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
  }
  #input-area {
    display: flex;
    gap: 6px;
    padding: 10px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
  }
  #input {
    flex: 1;
    padding: 6px 10px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border-radius: 4px;
    font-family: inherit;
    font-size: inherit;
    resize: none;
    outline: none;
  }
  #send {
    padding: 6px 16px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
</style>
</head>
<body>
  <!-- 消息区：第一步先空着，数据在调试板里看 -->
  <div id="messages"></div>

  <div id="input-area">
    <textarea id="input" rows="1" placeholder="输入 prompt... (Enter 发送, Shift+Enter 换行)"></textarea>
    <button id="send">发送</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    // ===== 发送：前端 -> 扩展宿主 =====
    function send() {
      const text = inputEl.value.trim();
      if (!text) return;

      // TODO(你): 这里现在往调试板里塞一条，方便确认"发出了什么"
      // 例：postMessage({ kind: "prompt", text })
      vscode.postMessage({ kind: "prompt", text });

      inputEl.value = "";
    }

    sendBtn.addEventListener("click", send);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });

    // ===== 接收：扩展宿主 -> 前端 =====
    window.addEventListener("message", (event) => {
      const msg = event.data;
      // TODO(你): 第一步先什么都不渲染（数据看调试板）
      // 第二步开始，按 msg.kind 逐个加 UI：
      //   case "pi": ...
      //   case "system": ...
      //   case "error": ...
      console.log("[chat] 收到:", msg);
    });
  </script>
</body>
</html>`;

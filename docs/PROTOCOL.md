# pi RPC 协议字段手册（自动生成）

> **生成方式**：`node scripts/schema-debug.mjs test_date/*.json`
> **数据来源**：真实抓包（调试板导出）
> **颗粒度**：按【事件 type】分组，列出每个字段的路径 / 类型 / 取值分布
> **`⚠缺N次` 的含义**：该字段在这 N 次里【不存在】→ 说明它是可选的 ✓

## 怎么用这份手册

```
· 想知道某个 type 长什么样  → 搜 '=== message_end'
· 想知道某字段有哪些取值    → 看该行后面的 值(次数) 列表
· 想知道某字段是不是必有    → 看有没有 ⚠缺N次
· 想知道字段的嵌套结构      → 看路径里的 . 与 []
```

---

文件：test_date/pi-debug-1790779666865.json, test_date/pi-debug-1.json, test_date/pi-debug-20261002-153349.json
总记录数：718

═══ message_update（444 次）═══
  assistantMessageEvent                      object    
  assistantMessageEvent.content              string    "用户只是打招呼。我应该简洁回应，并询问需要什么帮助。用中文。"(1) | "你好！有什么我可以帮你的吗？\n\n比如：\n- 阅读/分析某个项目的代码\n- 排查 bug 或异常现象\n- 写脚本、改配置、重构\n- 搭建新功能（含日志体系设计）\n\n直接告诉我目标或贴出相关路径即可。如果需要，我也可以先和你对齐需求再动手。"(1) | "好"(1) | "用户想让我演示工具调用。就调用一个简单的 bash 命令吧。"(1) | "工具调用正常 ✅\n\n- 工具：`bash`\n- 结果：`工具调用正常：2026-10-02 14:40:10`\n\n需要我测试其他工具（read / edit / write）吗？或者直接说测试目标，我来配合。"(1) | "用户要我调用一个会卡住的工具，以便测试中断。用 bash 执行 sleep 长命令。设一个较长的 timeout，比如 sleep 600。\n\n注意：工具超时参数默认无。用 sleep 600 让它卡住。用户会中断。\n\n我应该说明正在做什么。用户中断后我无法看到输出，但无所谓。"(1)  ⚠缺431次
  assistantMessageEvent.contentIndex         number    0(297) | 1(147)
  assistantMessageEvent.delta                string    "。"(22) | " "(18) | "-"(11) | "\""(10) | "，"(9) | "测试"(9)  ⚠缺30次
  assistantMessageEvent.id                   string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)  ⚠缺442次
  assistantMessageEvent.toolCall             object      ⚠缺442次
  assistantMessageEvent.toolCall.arguments   object      ⚠缺442次
  assistantMessageEvent.toolCall.arguments.command string    "echo \"工具调用正常：$(date '+%F %T')\""(1) | "echo \"开始卡住测试: $(date '+%T')\"; sleep 600; echo \"不应该看到这行\""(1)  ⚠缺442次
  assistantMessageEvent.toolCall.arguments.timeout number    600(1)  ⚠缺443次
  assistantMessageEvent.toolCall.id          string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)  ⚠缺442次
  assistantMessageEvent.toolCall.name        string    "bash"(2)  ⚠缺442次
  assistantMessageEvent.toolCall.type        string    "toolCall"(2)  ⚠缺442次
  assistantMessageEvent.toolName             string    "bash"(2)  ⚠缺442次
  assistantMessageEvent.type                 string    "text_delta"(237) | "thinking_delta"(112) | "toolcall_delta"(65) | "text_start"(9) | "text_end"(9) | "thinking_start"(4)
  type                                       string    "message_update"(444)
  usage                                      object    
  usage.cacheRead                            number    0(416) | 2816(17) | 2944(8) | 3072(3)
  usage.cacheWrite                           number    0(444)
  usage.cost                                 object    
  usage.cost.cacheRead                       number    0(444)
  usage.cost.cacheWrite                      number    0(444)
  usage.cost.input                           number    0(444)
  usage.cost.output                          number    0(444)
  usage.cost.total                           number    0(444)
  usage.input                                number    0(416) | 198(11) | 242(6) | 160(3) | 192(2) | 232(2)
  usage.output                               number    0(416) | 31(6) | 11(6) | 57(3) | 88(2) | 67(2)
  usage.reasoning                            number    0(20) | 17(2) | 16(2) | 71(2) | 8(2)  ⚠缺416次
  usage.totalTokens                          number    0(416) | 3045(6) | 3069(6) | 3071(3) | 3102(2) | 3203(2)

═══ message_start（50 次）═══
  message                                    object    
  message.api                                string    "openai-completions"(33)  ⚠缺17次
  message.content                            array     
  message.content[][].text                   string    "测试\n简单回复"(8) | "你好"(4) | "我要做测试，需要你协助我。\n现在先尝试一下工具调用吧，回响一个字。"(1) | "工具调用?"(1) | "工具调用正常：2026-10-02 14:40:10\n"(1) | "调用一个卡住工具，我要中断它。"(1)  ⚠缺33次
  message.content[][].type                   string    "text"(17)  ⚠缺33次
  message.details                            object      ⚠缺49次
  message.errorMessage                       string    "Connection error."(18) | "Request aborted"(2) | "This operation was aborted"(1) | "Request timed out."(1)  ⚠缺28次
  message.isError                            boolean   false(1) | true(1)  ⚠缺48次
  message.model                              string    "deepseek-v4-flash"(33)  ⚠缺17次
  message.provider                           string    "deepseek"(33)  ⚠缺17次
  message.role                               string    "assistant"(33) | "user"(15) | "toolResult"(2)
  message.stopReason                         string    "error"(20) | "pending"(11) | "aborted"(2)  ⚠缺17次
  message.timestamp                          number    1790923209647(2) | 1790923210500(2) | 1790923451527(2) | 1790923453414(2) | 1790923477806(2) | 1790925368401(2)
  message.toolCallId                         string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)  ⚠缺48次
  message.toolName                           string    "bash"(2)  ⚠缺48次
  message.usage                              object      ⚠缺17次
  message.usage.cacheRead                    number    0(33)  ⚠缺17次
  message.usage.cacheWrite                   number    0(33)  ⚠缺17次
  message.usage.cost                         object      ⚠缺17次
  message.usage.cost.cacheRead               number    0(33)  ⚠缺17次
  message.usage.cost.cacheWrite              number    0(33)  ⚠缺17次
  message.usage.cost.input                   number    0(33)  ⚠缺17次
  message.usage.cost.output                  number    0(33)  ⚠缺17次
  message.usage.cost.total                   number    0(33)  ⚠缺17次
  message.usage.input                        number    0(33)  ⚠缺17次
  message.usage.output                       number    0(33)  ⚠缺17次
  message.usage.totalTokens                  number    0(33)  ⚠缺17次
  type                                       string    "message_start"(50)

═══ message_end（50 次）═══
  message                                    object    
  message.api                                string    "openai-completions"(33)  ⚠缺17次
  message.content                            array     
  message.content[][].text                   string    "测试\n简单回复"(8) | "你好"(4) | "我要做测试，需要你协助我。\n现在先尝试一下工具调用吧，回响一个字。"(1) | "好"(1) | "工具调用?"(1) | "工具调用正常：2026-10-02 14:40:10\n"(1)  ⚠缺26次
  message.content[][].thinking               string    "用户只是打招呼。我应该简洁回应，并询问需要什么帮助。用中文。"(1) | "用户想让我演示工具调用。就调用一个简单的 bash 命令吧。"(1) | "用户要我调用一个会卡住的工具，以便测试中断。用 bash 执行 sleep 长命令。设一个较长的 timeout，比如 sleep 600。\n\n注意：工具超时参数默认无。用 sleep 600 让它卡住。用户会中断。\n\n我应该说明正在做什么。用户中断后我无法看到输出，但无所谓。"(1) | "用户重复测试。简单回复即可。"(1)  ⚠缺46次
  message.content[][].thinkingSignature      string    "reasoning_content"(4)  ⚠缺46次
  message.content[][].type                   string    "text"(24) | "thinking"(4)  ⚠缺22次
  message.details                            object      ⚠缺49次
  message.errorMessage                       string    "Connection error."(18) | "Request aborted"(2) | "This operation was aborted"(1) | "Request timed out."(1)  ⚠缺28次
  message.isError                            boolean   false(1) | true(1)  ⚠缺48次
  message.model                              string    "deepseek-v4-flash"(33)  ⚠缺17次
  message.provider                           string    "deepseek"(33)  ⚠缺17次
  message.rawStopReason                      string    "stop"(9) | "tool_calls"(2)  ⚠缺39次
  message.responseId                         string    "0accdee2-2b43-47fb-8f36-bc64cc80c396"(1) | "9511d81a-894b-4cfb-bb7f-00281a6b3e21"(1) | "a8e37320-461b-4808-8f89-a9e972e4d01c"(1) | "af2c2abc-9a27-461f-b926-810e4fd72ba7"(1) | "7b08fd6c-2e7a-4745-a107-3af3dae0bd5c"(1) | "9a24f70a-941f-4765-8066-409bc1ab71b5"(1)  ⚠缺39次
  message.responseModel                      string    "deepseek-flash"(11)  ⚠缺39次
  message.role                               string    "assistant"(33) | "user"(15) | "toolResult"(2)
  message.stopReason                         string    "error"(20) | "stop"(9) | "toolUse"(2) | "aborted"(2)  ⚠缺17次
  message.timestamp                          number    1790923209647(2) | 1790923210500(2) | 1790923451527(2) | 1790923453414(2) | 1790923477806(2) | 1790925368401(2)
  message.toolCallId                         string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)  ⚠缺48次
  message.toolName                           string    "bash"(2)  ⚠缺48次
  message.usage                              object      ⚠缺17次
  message.usage.cacheRead                    number    0(22) | 2944(5) | 2816(4) | 3072(2)  ⚠缺17次
  message.usage.cacheWrite                   number    0(33)  ⚠缺17次
  message.usage.cost                         object      ⚠缺17次
  message.usage.cost.cacheRead               number    0(33)  ⚠缺17次
  message.usage.cost.cacheWrite              number    0(33)  ⚠缺17次
  message.usage.cost.input                   number    0(33)  ⚠缺17次
  message.usage.cost.output                  number    0(33)  ⚠缺17次
  message.usage.cost.total                   number    0(33)  ⚠缺17次
  message.usage.input                        number    0(22) | 198(3) | 160(2) | 183(1) | 192(1) | 232(1)  ⚠缺17次
  message.usage.output                       number    0(22) | 88(1) | 2(1) | 67(1) | 58(1) | 149(1)  ⚠缺17次
  message.usage.reasoning                    number    0(7) | 17(1) | 16(1) | 71(1) | 8(1)  ⚠缺39次
  message.usage.totalTokens                  number    0(22) | 3102(1) | 3129(1) | 3203(1) | 3290(1) | 3453(1)  ⚠缺17次
  type                                       string    "message_end"(50)

═══ turn_start（33 次）═══
  type                                       string    "turn_start"(33)

═══ turn_end（33 次）═══
  message                                    object    
  message.api                                string    "openai-completions"(33)
  message.content                            array     
  message.content[][].text                   string    "好"(1) | "工具调用正常 ✅\n\n- 工具：`bash`\n- 结果：`工具调用正常：2026-10-02 14:40:10`\n\n需要我测试其他工具（read / edit / write）吗？或者直接说测试目标，我来配合。"(1) | "你好！有什么可以帮你的吗？\n\n我可以帮你：\n- 阅读、搜索、修改代码\n- 执行命令、排查问题\n- 技术选型讨论与方案设计\n\n当前工作目录是 `/home/liuqingxue`。你想做点什么？"(1) | "收到，测试正常。👍"(1) | "你好！有什么可以帮你的吗？\n\n需要我协助处理代码、查看文件、调试问题，还是讨论技术方案？直接说需求就行。"(1) | "收到，测试正常。有需要随时说。"(1)  ⚠缺26次
  message.content[][].thinking               string    "用户只是打招呼。我应该简洁回应，并询问需要什么帮助。用中文。"(1) | "用户想让我演示工具调用。就调用一个简单的 bash 命令吧。"(1) | "用户要我调用一个会卡住的工具，以便测试中断。用 bash 执行 sleep 长命令。设一个较长的 timeout，比如 sleep 600。\n\n注意：工具超时参数默认无。用 sleep 600 让它卡住。用户会中断。\n\n我应该说明正在做什么。用户中断后我无法看到输出，但无所谓。"(1) | "用户重复测试。简单回复即可。"(1)  ⚠缺29次
  message.content[][].thinkingSignature      string    "reasoning_content"(4)  ⚠缺29次
  message.content[][].type                   string    "text"(7) | "thinking"(4)  ⚠缺22次
  message.errorMessage                       string    "Connection error."(18) | "Request aborted"(2) | "This operation was aborted"(1) | "Request timed out."(1)  ⚠缺11次
  message.model                              string    "deepseek-v4-flash"(33)
  message.provider                           string    "deepseek"(33)
  message.rawStopReason                      string    "stop"(9) | "tool_calls"(2)  ⚠缺22次
  message.responseId                         string    "0accdee2-2b43-47fb-8f36-bc64cc80c396"(1) | "9511d81a-894b-4cfb-bb7f-00281a6b3e21"(1) | "a8e37320-461b-4808-8f89-a9e972e4d01c"(1) | "af2c2abc-9a27-461f-b926-810e4fd72ba7"(1) | "7b08fd6c-2e7a-4745-a107-3af3dae0bd5c"(1) | "9a24f70a-941f-4765-8066-409bc1ab71b5"(1)  ⚠缺22次
  message.responseModel                      string    "deepseek-flash"(11)  ⚠缺22次
  message.role                               string    "assistant"(33)
  message.stopReason                         string    "error"(20) | "stop"(9) | "toolUse"(2) | "aborted"(2)
  message.timestamp                          number    1790923165513(1) | 1790923198320(1) | 1790923209647(1) | 1790923210500(1) | 1790923451527(1) | 1790923453414(1)
  message.usage                              object    
  message.usage.cacheRead                    number    0(22) | 2944(5) | 2816(4) | 3072(2)
  message.usage.cacheWrite                   number    0(33)
  message.usage.cost                         object    
  message.usage.cost.cacheRead               number    0(33)
  message.usage.cost.cacheWrite              number    0(33)
  message.usage.cost.input                   number    0(33)
  message.usage.cost.output                  number    0(33)
  message.usage.cost.total                   number    0(33)
  message.usage.input                        number    0(22) | 198(3) | 160(2) | 183(1) | 192(1) | 232(1)
  message.usage.output                       number    0(22) | 88(1) | 2(1) | 67(1) | 58(1) | 149(1)
  message.usage.reasoning                    number    0(7) | 17(1) | 16(1) | 71(1) | 8(1)  ⚠缺22次
  message.usage.totalTokens                  number    0(22) | 3102(1) | 3129(1) | 3203(1) | 3290(1) | 3453(1)
  toolResults                                array     
  toolResults[][].content                    array       ⚠缺31次
  toolResults[][].content[][].text           string    "工具调用正常：2026-10-02 14:40:10\n"(1) | "开始卡住测试: 14:44:13\n\n\nCommand aborted"(1)  ⚠缺31次
  toolResults[][].content[][].type           string    "text"(2)  ⚠缺31次
  toolResults[][].details                    object      ⚠缺32次
  toolResults[][].isError                    boolean   false(1) | true(1)  ⚠缺31次
  toolResults[][].role                       string    "toolResult"(2)  ⚠缺31次
  toolResults[][].timestamp                  number    1790923210500(1) | 1790923453414(1)  ⚠缺31次
  toolResults[][].toolCallId                 string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)  ⚠缺31次
  toolResults[][].toolName                   string    "bash"(2)  ⚠缺31次
  type                                       string    "turn_end"(33)

═══ agent_start（31 次）═══
  type                                       string    "agent_start"(31)

═══ agent_end（31 次）═══
  messages                                   array     
  messages[][].api                           string    "openai-completions"(16)  ⚠缺15次
  messages[][].content                       array     
  messages[][].content[][].text              string    "测试\n简单回复"(8) | "你好"(4) | "我要做测试，需要你协助我。\n现在先尝试一下工具调用吧，回响一个字。"(1) | "工具调用?"(1) | "调用一个卡住工具，我要中断它。"(1) | "测试通过 ✅"(1)  ⚠缺15次
  messages[][].content[][].thinking          string    "用户重复测试。简单回复即可。"(1)  ⚠缺30次
  messages[][].content[][].thinkingSignature string    "reasoning_content"(1)  ⚠缺30次
  messages[][].content[][].type              string    "text"(16) | "thinking"(1)  ⚠缺14次
  messages[][].errorMessage                  string    "Connection error."(12) | "Request aborted"(2)  ⚠缺17次
  messages[][].model                         string    "deepseek-v4-flash"(16)  ⚠缺15次
  messages[][].provider                      string    "deepseek"(16)  ⚠缺15次
  messages[][].rawStopReason                 string    "stop"(2)  ⚠缺29次
  messages[][].responseId                    string    "a710c14c-9480-4339-b1b7-1a65c47b9ba9"(1) | "35128784-73de-4570-9bea-11de6244c124"(1)  ⚠缺29次
  messages[][].responseModel                 string    "deepseek-flash"(2)  ⚠缺29次
  messages[][].role                          string    "assistant"(16) | "user"(15)
  messages[][].stopReason                    string    "error"(12) | "aborted"(2) | "stop"(2)  ⚠缺15次
  messages[][].timestamp                     number    1790923165498(1) | 1790923198319(1) | 1790923209647(1) | 1790923451527(1) | 1790923477806(1) | 1790923490300(1)
  messages[][].usage                         object      ⚠缺15次
  messages[][].usage.cacheRead               number    0(14) | 2944(2)  ⚠缺15次
  messages[][].usage.cacheWrite              number    0(16)  ⚠缺15次
  messages[][].usage.cost                    object      ⚠缺15次
  messages[][].usage.cost.cacheRead          number    0(16)  ⚠缺15次
  messages[][].usage.cost.cacheWrite         number    0(16)  ⚠缺15次
  messages[][].usage.cost.input              number    0(16)  ⚠缺15次
  messages[][].usage.cost.output             number    0(16)  ⚠缺15次
  messages[][].usage.cost.total              number    0(16)  ⚠缺15次
  messages[][].usage.input                   number    0(14) | 160(1) | 138(1)  ⚠缺15次
  messages[][].usage.output                  number    0(14) | 13(1) | 4(1)  ⚠缺15次
  messages[][].usage.reasoning               number    8(1) | 0(1)  ⚠缺29次
  messages[][].usage.totalTokens             number    0(14) | 3117(1) | 3086(1)  ⚠缺15次
  type                                       string    "agent_end"(31)
  willRetry                                  boolean   true(16) | false(15)

═══ auto_retry_start（16 次）═══
  attempt                                    number    1(7) | 2(6) | 3(3)
  delayMs                                    number    2000(7) | 4000(6) | 8000(3)
  errorMessage                               string    "Connection error."(15) | "Request timed out."(1)
  maxAttempts                                number    3(16)
  type                                       string    "auto_retry_start"(16)

═══ agent_settled（15 次）═══
  type                                       string    "agent_settled"(15)

═══ auto_retry_end（7 次）═══
  attempt                                    number    3(3) | 2(3) | 1(1)
  finalError                                 string    "Connection error."(3)  ⚠缺4次
  success                                    boolean   true(4) | false(3)
  type                                       string    "auto_retry_end"(7)

═══ tool_execution_update（4 次）═══
  args                                       object    
  args.command                               string    "echo \"工具调用正常：$(date '+%F %T')\""(2) | "echo \"开始卡住测试: $(date '+%T')\"; sleep 600; echo \"不应该看到这行\""(2)
  args.timeout                               number    600(2)  ⚠缺2次
  partialResult                              object    
  partialResult.content                      array     
  partialResult.content[][].text             string    "工具调用正常：2026-10-02 14:40:10\n"(1) | "开始卡住测试: 14:44:13\n"(1)  ⚠缺2次
  partialResult.content[][].type             string    "text"(2)  ⚠缺2次
  partialResult.details                      object      ⚠缺2次
  toolCallId                                 string    "call_00_1US75cNyVO7uEjoLg4UT2584"(2) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(2)
  toolName                                   string    "bash"(4)
  type                                       string    "tool_execution_update"(4)

═══ tool_execution_start（2 次）═══
  args                                       object    
  args.command                               string    "echo \"工具调用正常：$(date '+%F %T')\""(1) | "echo \"开始卡住测试: $(date '+%T')\"; sleep 600; echo \"不应该看到这行\""(1)
  args.timeout                               number    600(1)  ⚠缺1次
  toolCallId                                 string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)
  toolName                                   string    "bash"(2)
  type                                       string    "tool_execution_start"(2)

═══ tool_execution_end（2 次）═══
  isError                                    boolean   false(1) | true(1)
  result                                     object    
  result.content                             array     
  result.content[][].text                    string    "工具调用正常：2026-10-02 14:40:10\n"(1) | "开始卡住测试: 14:44:13\n\n\nCommand aborted"(1)
  result.content[][].type                    string    "text"(2)
  result.details                             object      ⚠缺1次
  toolCallId                                 string    "call_00_1US75cNyVO7uEjoLg4UT2584"(1) | "call_00_PfJsH47rXX9VPlDJUqdJ0754"(1)
  toolName                                   string    "bash"(2)
  type                                       string    "tool_execution_end"(2)


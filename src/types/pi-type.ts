// ⚠️ 自动生成，请勿手动修改
// 生成时间: 2026/11/12 10:47:07

// =========================================
// 1. RpcResponse 相关
// =========================================

/** RpcResponse 的 type 字段字面量 (通常只有 "response") */
export const RPC_RESPONSE_TYPES = [
  "response",
] as const;
export type RpcResponseType = typeof RPC_RESPONSE_TYPES[number];

/** RpcResponse 的 command 字段字面量 (具体业务分发) */
export const RPC_COMMANDS = [
  "abort",
  "abort_bash",
  "abort_retry",
  "bash",
  "clear_queue",
  "clone",
  "compact",
  "cycle_model",
  "cycle_thinking_level",
  "export_html",
  "follow_up",
  "fork",
  "get_available_models",
  "get_available_thinking_levels",
  "get_commands",
  "get_entries",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_messages",
  "get_session_stats",
  "get_state",
  "get_tree",
  "new_session",
  "prompt",
  "set_auto_compaction",
  "set_auto_retry",
  "set_follow_up_mode",
  "set_model",
  "set_session_name",
  "set_steering_mode",
  "set_thinking_level",
  "steer",
  "switch_session",
] as const;
export type RpcCommandType = typeof RPC_COMMANDS[number];

// =========================================
// 2. JsonAgentSessionEvent 相关
// =========================================

/** JsonAgentSessionEvent 的 type 字段字面量数组 */
export const JSON_AGENT_SESSION_EVENT_TYPES = [
  "agent_end",
  "agent_settled",
  "agent_start",
  "auto_retry_end",
  "auto_retry_start",
  "bash_execution_update",
  "compaction_end",
  "compaction_start",
  "entry_appended",
  "message_end",
  "message_start",
  "message_update",
  "queue_update",
  "session_info_changed",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "summarization_retry_scheduled",
  "thinking_level_changed",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
  "turn_end",
  "turn_start",
] as const;
export type JsonAgentSessionEventType = typeof JSON_AGENT_SESSION_EVENT_TYPES[number];

// =========================================
// 3. 联合与校验
// =========================================

/** 两者联合的 Type */
export type piPkgType = RpcResponseType | JsonAgentSessionEventType;

/** 两者联合的字符串数组 (用于运行时判断) */
export const PI_RESPONSE_TYPES = [
  ...RPC_RESPONSE_TYPES,
  ...JSON_AGENT_SESSION_EVENT_TYPES,
] as const;

/** 运行时校验：判断任意字符串是否属于 piResponseType */
export function isPiResponseType(s: string): s is piPkgType {
  return (PI_RESPONSE_TYPES as readonly string[]).includes(s);
}

/** 运行时校验：判断是否为合法的 RpcCommand */
export function isRpcCommand(s: string): s is RpcCommandType {
  return (RPC_COMMANDS as readonly string[]).includes(s);
}

// Build a follow-up assistant tool message without discarding DeepSeek reasoning context.
// Only forward fields accepted by the Chat Completions message schema.
export function agentAssistantMessage(message) {
  const result = {
    role: 'assistant',
    content: message?.content ?? '',
    tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls : [],
  };
  if (typeof message?.reasoning_content === 'string') {
    result.reasoning_content = message.reasoning_content;
  }
  return result;
}

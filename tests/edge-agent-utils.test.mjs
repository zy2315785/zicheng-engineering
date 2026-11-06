import test from 'node:test';
import assert from 'node:assert/strict';
import { agentAssistantMessage } from '../edge-functions/_lib/agent-utils.mjs';

test('保留 DeepSeek 工具调用轮次所需的 reasoning_content', () => {
  const incoming = {
    role: 'assistant',
    content: null,
    reasoning_content: 'private-reasoning-placeholder',
    tool_calls: [{
      id: 'call_1',
      type: 'function',
      function: { name: 'search_docs', arguments: '{"query":"施工许可"}' },
    }],
  };
  assert.deepEqual(agentAssistantMessage(incoming), {
    role: 'assistant',
    content: '',
    reasoning_content: 'private-reasoning-placeholder',
    tool_calls: incoming.tool_calls,
  });
});

test('没有推理内容时不伪造 reasoning_content', () => {
  assert.deepEqual(agentAssistantMessage({ content: '已完成', tool_calls: [] }), {
    role: 'assistant',
    content: '已完成',
    tool_calls: [],
  });
});

test('工具调用始终具有有效的消息结构', () => {
  assert.deepEqual(agentAssistantMessage(null), {
    role: 'assistant', content: '', tool_calls: [],
  });
});

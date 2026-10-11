import { expect, it, spyOn } from 'bun:test';
import { llmLogRequest, llmLogResult, llmLogTool } from '../src/llm-logger.js';

it('prints indented request JSON while preserving escaped message newlines', () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    llmLogRequest('test', { model: 'provider/model', params: { temperature: 0.7 }, messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'first\nsecond' }] });
    const output = String(log.mock.calls[0]?.[0]);
    expect(output).toContain('"role": "user"');
    expect(output).toContain('"content": "first\\nsecond"');
    expect(output).toContain('"content": "System"');
    expect(output).not.toContain('{"role"');
  } finally { log.mockRestore(); }
});

it('prints all thinking lines and long tool results', () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const reasoning = Array.from({ length: 12 }, (_, i) => `thought-${i}`).join('\n');
    llmLogResult('test', 'provider/model', 100, { text: 'reply', reasoning });
    expect(String(log.mock.calls[0]?.[0])).toContain('thought-11');
    llmLogTool(1, 'read', {}, { text: 'x'.repeat(200) + 'END' });
    expect(String(log.mock.calls[1]?.[0])).toContain('END');
  } finally { log.mockRestore(); }
});

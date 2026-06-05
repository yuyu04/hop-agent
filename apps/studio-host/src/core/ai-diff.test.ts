import { describe, expect, it } from 'vitest';
import { buildDiffModel } from './ai-diff';
import type { ActionScript, DocumentContext } from './ai-bridge';

const context: DocumentContext = {
  document_metadata: { total_sections: 1 },
  content: [
    { type: 'paragraph', id: 'sec[0].p[0]', text: '첫 문단' },
    { type: 'paragraph', id: 'sec[0].p[1]', text: '둘째 문단' },
  ],
};

function script(edits: ActionScript['edits']): ActionScript {
  return { edits };
}

describe('buildDiffModel', () => {
  it('INSERT_AFTER yields only afterText', () => {
    const [item] = buildDiffModel(
      script([{ command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: '새 문단' } }]),
      context,
    );
    expect(item).toEqual({ command: 'INSERT_AFTER', targetId: 'sec[0].p[0]', afterText: '새 문단' });
  });

  it('REPLACE carries original before and new after text', () => {
    const [item] = buildDiffModel(
      script([{ command: 'REPLACE', target_id: 'sec[0].p[1]', payload: { text: '교체됨' } }]),
      context,
    );
    expect(item).toEqual({
      command: 'REPLACE',
      targetId: 'sec[0].p[1]',
      beforeText: '둘째 문단',
      afterText: '교체됨',
    });
  });

  it('DELETE carries original before text only', () => {
    const [item] = buildDiffModel(
      script([{ command: 'DELETE', target_id: 'sec[0].p[0]', payload: {} }]),
      context,
    );
    expect(item).toEqual({ command: 'DELETE', targetId: 'sec[0].p[0]', beforeText: '첫 문단' });
  });

  it('unknown target id leaves before text undefined', () => {
    const [item] = buildDiffModel(
      script([{ command: 'REPLACE', target_id: 'sec[9].p[9]', payload: { text: 'x' } }]),
      context,
    );
    expect(item.beforeText).toBeUndefined();
    expect(item.afterText).toBe('x');
  });
});

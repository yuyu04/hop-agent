// 회귀 테스트: AI 패널이 커서 채팅처럼 보이고 동작한다 (F-15098e10).
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

/**
 * F-15098e10 AC-0643a456: 변경 목록을 변경마다 한 줄로 보여주고,
 * 줄 끝에 제외 버튼을 두며, 목록 위에는 '변경 N건 · 추가 a · 바꿈 b · 삭제 c' 요약이 있다.
 */
describe('AC-0643a456: Change list builds correct diff model for one-line summary display', () => {
  it('AC-0643a456: INSERT creates a DiffItem with afterText only', () => {
    const [item] = buildDiffModel(
      script([{ command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: '새 문단' } }]),
      context,
    );
    expect(item.command).toBe('INSERT_AFTER');
    expect(item.afterText).toBe('새 문단');
    expect(item.beforeText).toBeUndefined();
  });

  it('AC-0643a456: REPLACE creates DiffItem with both before and after text for comparison', () => {
    const [item] = buildDiffModel(
      script([{ command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { text: '교체됨' } }]),
      context,
    );
    expect(item.command).toBe('REPLACE');
    expect(item.beforeText).toBe('첫 문단');
    expect(item.afterText).toBe('교체됨');
  });

  it('AC-0643a456: DELETE creates DiffItem with beforeText only', () => {
    const [item] = buildDiffModel(
      script([{ command: 'DELETE', target_id: 'sec[0].p[1]', payload: {} }]),
      context,
    );
    expect(item.command).toBe('DELETE');
    expect(item.beforeText).toBe('둘째 문단');
    expect(item.afterText).toBeUndefined();
  });

  it('AC-0643a456: Multiple edits create separate DiffItems for list display', () => {
    const items = buildDiffModel(
      script([
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: '추가 1' } },
        { command: 'REPLACE', target_id: 'sec[0].p[1]', payload: { text: '교체' } },
        { command: 'DELETE', target_id: 'sec[0].p[0]', payload: {} },
      ]),
      context,
    );
    expect(items).toHaveLength(3);
    expect(items[0].command).toBe('INSERT_AFTER');
    expect(items[1].command).toBe('REPLACE');
    expect(items[2].command).toBe('DELETE');
  });

  it('AC-0643a456: Format-only edits omit beforeText (unchanged text)', () => {
    const contextWithFormat = {
      document_metadata: { total_sections: 1 },
      content: [{ type: 'paragraph' as const, id: 'sec[0].p[0]', text: '문단' }],
    };
    const [item] = buildDiffModel(
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[0]',
          payload: { type: 'para_format' as const }, // Format only, no text
        },
      ]),
      contextWithFormat,
    );
    // Format-only edits should have no beforeText in diff display
    expect(item.beforeText).toBeUndefined();
  });
});

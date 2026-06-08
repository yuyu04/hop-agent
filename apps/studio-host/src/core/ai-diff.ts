/**
 * 승인 전 보여줄 표현용 Diff 모델(스펙 4장).
 *
 * Action Script와 직렬화 컨텍스트(원문)를 합쳐, 편집별 before/after 텍스트를
 * 만든다. 실제 문서는 건드리지 않는 휘발성 미리보기 데이터다.
 */

import type { ActionScript, ContentNode, DocumentContext, EditCommand } from './ai-bridge';

export interface DiffItem {
  command: EditCommand;
  targetId: string;
  /** REPLACE/DELETE에서 사라지는 원문(빨강). */
  beforeText?: string;
  /** INSERT/REPLACE로 들어오는 텍스트(초록). */
  afterText?: string;
}

function textOf(node: ContentNode | undefined): string | undefined {
  if (node && node.type === 'paragraph') return node.text;
  return undefined;
}

export function buildDiffModel(script: ActionScript, context: DocumentContext): DiffItem[] {
  const byId = new Map<string, ContentNode>();
  for (const node of context.content) byId.set(node.id, node);

  return script.edits.map((edit) => {
    const original = textOf(byId.get(edit.target_id));
    // 표 생성은 텍스트가 없으므로 "[표 R×C]"로 표시한다.
    const table = edit.payload.type === 'table' ? edit.payload.table_data : undefined;
    const inserted = table ? `[표 ${table.rows}×${table.cols}]` : edit.payload.text;
    switch (edit.command) {
      case 'DELETE':
        return { command: edit.command, targetId: edit.target_id, beforeText: original };
      case 'REPLACE':
        return {
          command: edit.command,
          targetId: edit.target_id,
          beforeText: original,
          afterText: inserted,
        };
      case 'INSERT_BEFORE':
      case 'INSERT_AFTER':
      default:
        return { command: edit.command, targetId: edit.target_id, afterText: inserted };
    }
  });
}

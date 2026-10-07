/**
 * 승인 전 보여줄 표현용 Diff 모델(스펙 4장).
 *
 * Action Script와 직렬화 컨텍스트(원문)를 합쳐, 편집별 before/after 텍스트를
 * 만든다. 실제 문서는 건드리지 않는 휘발성 미리보기 데이터다.
 */

import type { ActionScript, ContentNode, DocumentContext, EditCommand, EditPayload } from './ai-bridge';

export interface DiffItem {
  command: EditCommand;
  targetId: string;
  /** REPLACE/DELETE에서 사라지는 원문(빨강). */
  beforeText?: string;
  /** INSERT/REPLACE로 들어오는 텍스트(초록). */
  afterText?: string;
  /** 본문 문단이 아닌 편집의 종류(표·그림·서식 등). 변경 목록의 아이콘·라벨에 쓴다. */
  payloadType?: NonNullable<EditPayload['type']>;
}

/** 글 내용은 그대로 두고 모양만 바꾸는 편집 종류. */
const FORMAT_ONLY_TYPES = new Set<string>(['format', 'para_format', 'page_setup', 'page_number']);

/** 텍스트가 없는 편집(서식·용지·그림 등)을 한 줄로 설명한다. */
function describePayload(payload: EditPayload): string | undefined {
  switch (payload.type) {
    case 'image':
      return payload.image_index !== undefined ? `[그림 ${payload.image_index + 1}]` : '[그림]';
    case 'chart':
      return `[차트${payload.chart_data?.title ? `: ${payload.chart_data.title}` : ''}]`;
    case 'format': {
      const f = payload.char_format ?? {};
      const parts = [
        f.bold ? '굵게' : '',
        f.italic ? '기울임' : '',
        f.underline ? '밑줄' : '',
        f.strikethrough ? '취소선' : '',
        f.font_size_pt ? `${f.font_size_pt}pt` : '',
        f.font_family ?? '',
        f.text_color ? `글자색 ${f.text_color}` : '',
        f.highlight_color ? '형광펜' : '',
      ].filter(Boolean);
      const where = payload.format_target ? `「${payload.format_target}」 ` : '';
      return `[${where}글자 서식${parts.length ? `: ${parts.join(' · ')}` : ''}]`;
    }
    case 'para_format':
      return '[문단 서식]';
    case 'page_setup':
      return '[용지 설정]';
    case 'page_number':
      return '[쪽 번호]';
    case 'table_edit':
      return '[표 고치기]';
    case 'table_formula':
      return '[표 계산식]';
    case 'footnote':
      return payload.text !== undefined ? undefined : '[각주]';
    default:
      return undefined;
  }
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
    // 양식 표 복제(양식 이어쓰기)는 채울 값칸 수로 미리보기를 만든다(구조는 원본 동일).
    const clone = edit.payload.type === 'clone_table' ? edit.payload.clone_table : undefined;
    const inserted = table
      ? `[표 ${table.rows}×${table.cols}]`
      : clone
        ? `[양식 항목 추가 — 값 ${clone.cell_fills?.length ?? 0}칸]`
        : (edit.payload.text ?? describePayload(edit.payload));
    // 문단이 아닌 편집만 종류를 단다(본문 문단 diff 모양은 그대로 둔다).
    const kind =
      edit.payload.type && edit.payload.type !== 'paragraph' ? { payloadType: edit.payload.type } : {};
    switch (edit.command) {
      case 'DELETE':
        return { command: edit.command, targetId: edit.target_id, beforeText: original, ...kind };
      case 'REPLACE':
        return {
          command: edit.command,
          targetId: edit.target_id,
          // 서식만 바꾸는 편집은 글이 사라지지 않는다 — 원문을 지운 것처럼 보이지 않게 한다.
          beforeText: FORMAT_ONLY_TYPES.has(edit.payload.type ?? '') && edit.payload.text === undefined
            ? undefined
            : original,
          afterText: inserted,
          ...kind,
        };
      case 'INSERT_BEFORE':
      case 'INSERT_AFTER':
      default:
        return { command: edit.command, targetId: edit.target_id, afterText: inserted, ...kind };
    }
  });
}

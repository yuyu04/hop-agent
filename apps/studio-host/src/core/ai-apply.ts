/**
 * Action Script를 라이브 WASM 문서 엔진에 적용한다(스펙 4장 — 승인 시점).
 *
 * 화면 문서는 WASM rhwp 엔진이 그리므로, 승인된 편집은 이 엔진에 적용한 뒤
 * `eventBus.emit('document-changed')`로 재렌더한다(적용은 호출 측에서 트리거).
 * 여기서는 순수하게 편집 변환만 수행해 테스트 가능하게 한다.
 */

import type { ActionScript, Edit } from './ai-bridge';

/** `applyActionScript`가 의존하는 최소 WASM 편집 표면(WasmBridge가 구조적으로 충족). */
export interface WasmEditing {
  getParagraphLength(sec: number, para: number): number;
  insertText(sec: number, para: number, charOffset: number, text: string): string;
  deleteText(sec: number, para: number, charOffset: number, count: number): string;
  splitParagraph(sec: number, para: number, charOffset: number): string;
  mergeParagraph(sec: number, para: number): string;
}

export interface ApplySkip {
  targetId: string;
  reason: string;
}

export interface ApplyResult {
  applied: number;
  skipped: ApplySkip[];
}

const TARGET_PATTERN = /^sec\[(\d+)\]\.p\[(\d+)\]$/;

/** `sec[s].p[p]` 형식의 문단 타깃을 파싱한다. 다른 형식이면 `null`. */
export function parseParagraphTarget(targetId: string): { sec: number; para: number } | null {
  const match = TARGET_PATTERN.exec(targetId);
  if (!match) return null;
  return { sec: Number(match[1]), para: Number(match[2]) };
}

interface LocatedEdit {
  edit: Edit;
  sec: number;
  para: number;
}

/**
 * Action Script의 각 편집을 WASM 편집 프리미티브로 변환·적용한다.
 *
 * 다중 편집은 문단 인덱스가 큰 것부터(내림차순) 적용해, 앞선 편집의 문단
 * 삽입/삭제가 뒤따르는 `target_id`의 인덱스를 어긋나게 만들지 않도록 한다.
 */
export function applyActionScript(wasm: WasmEditing, script: ActionScript): ApplyResult {
  const located: LocatedEdit[] = [];
  const skipped: ApplySkip[] = [];

  for (const edit of script.edits) {
    const target = parseParagraphTarget(edit.target_id);
    if (!target) {
      skipped.push({
        targetId: edit.target_id,
        reason: '문단 대상이 아닙니다(표/셀 등은 아직 미지원).',
      });
      continue;
    }
    located.push({ edit, sec: target.sec, para: target.para });
  }

  located.sort((a, b) => b.sec - a.sec || b.para - a.para);

  let applied = 0;
  for (const item of located) {
    try {
      applyOne(wasm, item);
      applied += 1;
    } catch (error) {
      skipped.push({ targetId: item.edit.target_id, reason: String(error) });
    }
  }

  return { applied, skipped };
}

function applyOne(wasm: WasmEditing, { edit, sec, para }: LocatedEdit): void {
  const text = edit.payload.text ?? '';
  switch (edit.command) {
    case 'INSERT_AFTER': {
      const length = wasm.getParagraphLength(sec, para);
      wasm.splitParagraph(sec, para, length);
      wasm.insertText(sec, para + 1, 0, text);
      break;
    }
    case 'INSERT_BEFORE': {
      // 오프셋 0에서 분할하면 빈 문단이 para 위치에 생기고 원문은 para+1로 밀린다.
      wasm.splitParagraph(sec, para, 0);
      wasm.insertText(sec, para, 0, text);
      break;
    }
    case 'REPLACE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      wasm.insertText(sec, para, 0, text);
      break;
    }
    case 'DELETE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      // 문단 경계를 이웃과 병합해 빈 문단을 제거한다.
      wasm.mergeParagraph(sec, para > 0 ? para : 1);
      break;
    }
  }
}

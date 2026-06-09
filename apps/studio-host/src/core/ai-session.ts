/**
 * AI 편집 트랜잭션 상태 머신(스펙 7장).
 *
 *   IDLE → REQUESTING → DIFF_PENDING → (FINALIZED | ROLLED_BACK) → IDLE
 *
 * `DIFF_PENDING`(미확정 Diff)에서 새 요청이 들어오면 기존 트랜잭션을 자동
 * 롤백(Reject)한 뒤 진행한다. 화면에 둘 이상의 미확정 Diff가 겹치지 않도록
 * 보장한다. 부수효과(WASM 적용/오버레이 정리)는 호출 측 콜백으로 위임한다.
 */

export type AiSessionState =
  | 'IDLE'
  | 'REQUESTING'
  | 'DIFF_PENDING'
  | 'FINALIZED'
  | 'ROLLED_BACK';

export interface AiSessionCallbacks {
  /** DIFF_PENDING 상태를 폐기할 때(오버레이/하이라이트 제거). */
  onRollback?(): void;
}

export class AiSessionMachine {
  private current: AiSessionState = 'IDLE';

  constructor(private readonly callbacks: AiSessionCallbacks = {}) {}

  get state(): AiSessionState {
    return this.current;
  }

  get isPending(): boolean {
    return this.current === 'DIFF_PENDING';
  }

  /** 요청 시작. 미확정 Diff가 있으면 먼저 롤백한다. 반환: REQUESTING 진입 여부. */
  startRequest(): boolean {
    if (this.current === 'DIFF_PENDING') {
      this.rollback();
    }
    this.current = 'REQUESTING';
    return true;
  }

  /** 검증된 Action Script 수신 → 미리보기 대기. REQUESTING에서만 유효. */
  onReady(): boolean {
    if (this.current !== 'REQUESTING') return false;
    this.current = 'DIFF_PENDING';
    return true;
  }

  /** 요청 실패 → IDLE. */
  onFailed(): void {
    if (this.current === 'REQUESTING') this.current = 'IDLE';
  }

  /** 편집 없는 응답(질문/요약 모드) 완료 → IDLE. REQUESTING에서만 유효. */
  complete(): boolean {
    if (this.current !== 'REQUESTING') return false;
    this.current = 'IDLE';
    return true;
  }

  /** 요청 취소 → IDLE(REQUESTING) 또는 롤백(DIFF_PENDING). */
  cancel(): void {
    if (this.current === 'REQUESTING') {
      this.current = 'IDLE';
    } else if (this.current === 'DIFF_PENDING') {
      this.rollback();
    }
  }

  /** 승인. DIFF_PENDING에서만 유효. 반환: 적용 진행 여부. */
  accept(): boolean {
    if (this.current !== 'DIFF_PENDING') return false;
    this.current = 'FINALIZED';
    this.current = 'IDLE';
    return true;
  }

  /** 거부. DIFF_PENDING에서만 유효. */
  reject(): boolean {
    if (this.current !== 'DIFF_PENDING') return false;
    this.rollback();
    return true;
  }

  private rollback(): void {
    this.current = 'ROLLED_BACK';
    this.callbacks.onRollback?.();
    this.current = 'IDLE';
  }
}

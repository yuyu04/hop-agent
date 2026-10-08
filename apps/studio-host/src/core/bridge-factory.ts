// 실행 환경(Tauri 데스크톱/웹)에 맞는 문서 브리지를 만든다.
import { WasmBridge } from '@/upstream/core';
import { TauriBridge } from './tauri-bridge';

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && (
      '__TAURI_INTERNALS__' in window
      || window.location?.protocol === 'tauri:'
    );
}

export function createBridge(): WasmBridge {
  if (isTauriRuntime()) {
    return new TauriBridge();
  }
  return new WasmBridge();
}

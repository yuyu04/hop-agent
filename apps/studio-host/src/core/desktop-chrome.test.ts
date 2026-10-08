// 회귀 테스트: 원본 HOP에서 이어받은 데스크톱 앱 셸이 HOP AI에서도 그대로 동작한다 (F-4848212d).
import { describe, expect, it } from 'vitest';
import { normalizeDesktopChromeTitle } from './desktop-chrome';
import { normalizeShortcutLabel } from './platform';

describe('desktop-chrome', () => {
  it('normalizes macOS shortcut labels', () => {
    expect(normalizeShortcutLabel('Ctrl+Shift+S', 'macos')).toBe('⌘⇧S');
    expect(normalizeDesktopChromeTitle('찾기 (Ctrl+F)', 'macos')).toBe('찾기 (⌘F)');
  });

  it('does not rewrite non-shortcut tooltips', () => {
    expect(normalizeDesktopChromeTitle('줄 간격 증가 (+5%)', 'macos')).toBe('줄 간격 증가 (+5%)');
    expect(normalizeDesktopChromeTitle('파일 이름 + 쪽 번호', 'macos')).toBe('파일 이름 + 쪽 번호');
  });
});

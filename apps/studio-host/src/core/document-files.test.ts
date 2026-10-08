// 회귀 테스트: 원본 HOP에서 이어받은 데스크톱 앱 셸이 HOP AI에서도 그대로 동작한다 (F-4848212d).
import { describe, expect, it } from 'vitest';
import {
  findLatestSupportedDocumentPath,
  hasSupportedDocumentPath,
  isSupportedDocumentPath,
} from './document-files';

describe('document-files', () => {
  it('matches supported document paths case-insensitively', () => {
    expect(isSupportedDocumentPath('report.hwp')).toBe(true);
    expect(isSupportedDocumentPath('report.HWPX')).toBe(true);
    expect(isSupportedDocumentPath('report.pdf')).toBe(false);
  });

  it('detects whether a path list contains a supported document', () => {
    expect(hasSupportedDocumentPath(['notes.txt', 'report.hwpx'])).toBe(true);
    expect(hasSupportedDocumentPath(['notes.txt', 'report.pdf'])).toBe(false);
  });

  it('returns the most recent supported document path', () => {
    expect(
      findLatestSupportedDocumentPath(['older.hwp', 'notes.txt', 'newer.hwpx']),
    ).toBe('newer.hwpx');
    expect(findLatestSupportedDocumentPath(['notes.txt', 'report.pdf'])).toBeNull();
  });
});

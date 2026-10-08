// 열 수 있는 문서 파일(HWP/HWPX) 경로를 판별·선택한다.
export function isSupportedDocumentPath(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.endsWith('.hwp') || lower.endsWith('.hwpx');
}

export function hasSupportedDocumentPath(paths: string[]): boolean {
  return paths.some(isSupportedDocumentPath);
}

export function findLatestSupportedDocumentPath(paths: string[]): string | null {
  return [...paths].reverse().find(isSupportedDocumentPath) ?? null;
}

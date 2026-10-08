// upstream 로컬 글꼴 모듈 포트 — HOP 코드는 이 경로로만 rhwp-studio 로컬 글꼴을 쓴다.
import * as implementation from '@upstream/core/local-fonts';

export type {
  DetectLocalFontsOptions,
  GetLocalFontsOptions,
  LocalFontDetectionSource,
  LocalFontRecord,
  LocalFontSnapshot,
  LocalFontState,
  LocalFontStorageKind,
  LocalFontStyleRequest,
} from '@upstream/core/local-fonts';
export type { HostFontData, HostFontProvider } from '@upstream/core/host-font-provider';
export const upstreamLocalFonts = implementation;

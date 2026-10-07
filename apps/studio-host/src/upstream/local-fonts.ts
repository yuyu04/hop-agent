import * as implementation from '@upstream/core/local-fonts';

export type {
  DetectLocalFontsOptions,
  GetLocalFontsOptions,
  LocalFontDetectionSource,
  LocalFontRecord,
  LocalFontSnapshot,
  LocalFontState,
  LocalFontStorageKind,
} from '@upstream/core/local-fonts';
export const upstreamLocalFonts = implementation;

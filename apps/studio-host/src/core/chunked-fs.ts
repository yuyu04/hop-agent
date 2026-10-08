// 큰 문서 파일을 청크로 읽고 써서 IPC 한 번에 담기 어려운 크기도 주고받는다.
import { open as openFs, stat } from '@tauri-apps/plugin-fs';

const FILE_IO_CHUNK_SIZE = 4 * 1024 * 1024;
const FNV1A_32_OFFSET = 0x811c9dc5;

export interface ChunkedReadResult {
  bytes: Uint8Array;
  contentHash: number;
}

export function finiteFileSize(size: number | null | undefined): number | undefined {
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : undefined;
}

export function hashBytes(bytes: Uint8Array, initialHash = FNV1A_32_OFFSET): number {
  let next = initialHash;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    next ^= bytes[index] ?? 0;
    next = Math.imul(next, 0x01000193);
  }
  return next >>> 0;
}

export async function readFileInChunks(path: string, knownSize?: number): Promise<ChunkedReadResult> {
  const file = await openFs(path, { read: true });
  try {
    if (typeof knownSize === 'number') {
      const bytes = new Uint8Array(knownSize);
      let hash = FNV1A_32_OFFSET;
      let offset = 0;
      while (offset < bytes.byteLength) {
        const chunk = bytes.subarray(offset, offset + FILE_IO_CHUNK_SIZE);
        const read = await file.read(chunk);
        if (read === null) break;
        hash = hashBytes(chunk.subarray(0, read), hash);
        offset += read;
      }
      const finalBytes = offset === bytes.byteLength ? bytes : bytes.slice(0, offset);
      return { bytes: finalBytes, contentHash: hash >>> 0 };
    }

    const chunks: Uint8Array[] = [];
    let hash = FNV1A_32_OFFSET;
    let totalSize = 0;
    while (true) {
      const buffer = new Uint8Array(FILE_IO_CHUNK_SIZE);
      const read = await file.read(buffer);
      if (read === null) break;
      const chunk = buffer.slice(0, read);
      hash = hashBytes(chunk, hash);
      chunks.push(chunk);
      totalSize += chunk.byteLength;
    }

    const bytes = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentHash: hash >>> 0 };
  } finally {
    await file.close();
  }
}

export async function writeFileInChunks(path: string, bytes: Uint8Array): Promise<void> {
  const file = await openFs(path, { write: true, create: true, truncate: true });
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const chunkEnd = Math.min(offset + FILE_IO_CHUNK_SIZE, bytes.byteLength);
      while (offset < chunkEnd) {
        const written = await file.write(bytes.subarray(offset, chunkEnd));
        if (written <= 0) {
          throw new Error('staging 파일 쓰기 실패: no bytes written');
        }
        offset += written;
      }
    }
  } finally {
    await file.close();
  }

  const written = await stat(path);
  if (finiteFileSize(written.size) !== bytes.byteLength) {
    throw new Error(
      `staging 파일 크기 검증 실패: expected ${bytes.byteLength}, got ${written.size ?? 'unknown'}`,
    );
  }
}

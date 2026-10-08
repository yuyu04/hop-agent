// 회귀 테스트: 원본 HOP에서 이어받은 데스크톱 앱 셸이 HOP AI에서도 그대로 동작한다 (F-4848212d).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finiteFileSize, hashBytes, readFileInChunks, writeFileInChunks } from './chunked-fs';

const fsOpenMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/plugin-fs', () => ({
  open: fsOpenMock,
  stat: statMock,
}));

describe('chunked fs helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statMock.mockResolvedValue({ size: 5, isFile: true });
  });

  it('normalizes finite file sizes', () => {
    expect(finiteFileSize(0)).toBe(0);
    expect(finiteFileSize(5)).toBe(5);
    expect(finiteFileSize(-1)).toBeUndefined();
    expect(finiteFileSize(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(finiteFileSize(null)).toBeUndefined();
  });

  it('hashes incrementally with the same result as one-shot hashing', () => {
    const oneShot = hashBytes(new Uint8Array([1, 2, 3, 4, 5]));
    const first = hashBytes(new Uint8Array([1, 2]));
    const incremental = hashBytes(new Uint8Array([3, 4, 5]), first);

    expect(incremental).toBe(oneShot);
  });

  it('reads a known-size file and trims short reads', async () => {
    const handle = readHandle([1, 2, 3]);
    fsOpenMock.mockResolvedValue(handle);

    const result = await readFileInChunks('/tmp/source.hwp', 5);

    expect(fsOpenMock).toHaveBeenCalledWith('/tmp/source.hwp', { read: true });
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.contentHash).toBe(hashBytes(new Uint8Array([1, 2, 3])));
    expect(handle.close).toHaveBeenCalled();
  });

  it('retries partial writes until the full byte range is written', async () => {
    const handle = writeHandle({ maxBytesPerWrite: 2 });
    fsOpenMock.mockResolvedValue(handle);

    await writeFileInChunks('/tmp/staged.hwp', new Uint8Array([1, 2, 3, 4, 5]));

    expect(fsOpenMock).toHaveBeenCalledWith('/tmp/staged.hwp', {
      write: true,
      create: true,
      truncate: true,
    });
    expect(handle.write).toHaveBeenCalledTimes(3);
    expect(handle.write.mock.calls.map(([chunk]) => Array.from(chunk))).toEqual([
      [1, 2, 3, 4, 5],
      [3, 4, 5],
      [5],
    ]);
    expect(handle.close).toHaveBeenCalled();
    expect(statMock).toHaveBeenCalledWith('/tmp/staged.hwp');
  });

  it('closes the file and rejects zero-byte writes', async () => {
    const handle = writeHandle({ maxBytesPerWrite: 0 });
    fsOpenMock.mockResolvedValue(handle);

    await expect(writeFileInChunks('/tmp/staged.hwp', new Uint8Array([1]))).rejects.toThrow(
      'staging 파일 쓰기 실패',
    );

    expect(handle.close).toHaveBeenCalled();
    expect(statMock).not.toHaveBeenCalled();
  });
});

function readHandle(bytes: ArrayLike<number>) {
  const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let offset = 0;
  return {
    read: vi.fn(async (buffer: Uint8Array) => {
      if (offset >= data.length) return null;
      const count = Math.min(buffer.byteLength, data.length - offset);
      buffer.set(data.subarray(offset, offset + count));
      offset += count;
      return count;
    }),
    close: vi.fn(async () => undefined),
  };
}

function writeHandle(options: { maxBytesPerWrite?: number } = {}) {
  return {
    write: vi.fn(async (bytes: Uint8Array) =>
      Math.min(bytes.byteLength, options.maxBytesPerWrite ?? bytes.byteLength),
    ),
    close: vi.fn(async () => undefined),
  };
}

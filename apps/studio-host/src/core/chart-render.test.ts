import { describe, expect, it } from 'vitest';
import { renderChartToPng, validateChartData, type ChartData } from './chart-render';

/** 정상 막대 차트 데이터. */
function bar(): ChartData {
  return {
    kind: 'bar',
    title: '분기별 매출',
    labels: ['1분기', '2분기'],
    series: [{ name: '매출', values: [120.5, 98] }],
  };
}

describe('validateChartData', () => {
  it('accepts well-formed bar/line/pie data', () => {
    expect(validateChartData(bar())).toBeNull();
    expect(validateChartData({ ...bar(), kind: 'line' })).toBeNull();
    expect(
      validateChartData({ kind: 'pie', labels: ['a', 'b'], series: [{ values: [1, 2] }] }),
    ).toBeNull();
  });

  it('rejects an unsupported kind', () => {
    const data = { ...bar(), kind: 'donut' as ChartData['kind'] };
    expect(validateChartData(data)).toContain('지원하지 않는 차트 종류');
  });

  it('rejects empty labels or series', () => {
    expect(validateChartData({ ...bar(), labels: [] })).toContain('labels');
    expect(validateChartData({ ...bar(), series: [] })).toContain('series');
  });

  it('rejects a series whose length differs from labels', () => {
    const data = { ...bar(), series: [{ name: '매출', values: [1] }] };
    expect(validateChartData(data)).toContain('매출');
    expect(validateChartData(data)).toContain('labels 개수');
  });

  it('names the exact non-numeric value (AC4)', () => {
    const data = {
      ...bar(),
      series: [{ name: '매출', values: [120.5, '10억' as unknown as number] }],
    };
    const error = validateChartData(data);
    expect(error).toContain('매출');
    expect(error).toContain('2분기');
    expect(error).toContain('10억');
  });

  it('rejects multi-series or negative pie data', () => {
    expect(
      validateChartData({
        kind: 'pie',
        labels: ['a'],
        series: [{ values: [1] }, { values: [2] }],
      }),
    ).toContain('시리즈 1개');
    expect(
      validateChartData({ kind: 'pie', labels: ['a', 'b'], series: [{ values: [1, -2] }] }),
    ).toContain('음수');
  });
});

describe('renderChartToPng', () => {
  it('returns null when no canvas is available (test env)', () => {
    // vitest 환경엔 캔버스 2D 컨텍스트가 없다 — 그릴 수 없으면 null로 보고해
    // 호출 측(agent-sidebar)이 편집을 제외하고 사유를 알린다.
    expect(renderChartToPng(bar())).toBeNull();
  });
});

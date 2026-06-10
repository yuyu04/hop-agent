/**
 * 데이터 → 차트 PNG 렌더(F-d0dce3). AI의 payload.chart_data를 오프스크린 캔버스로
 * 그려 기존 이미지 삽입 파이프라인(ImageForInsert)에 태운다. 막대/선/원형 지원.
 * 문서는 건드리지 않는다 — 순수 그리기 + 검증.
 */

import type { EditPayload } from './ai-bridge';
import type { ImageForInsert } from './ai-apply';

export type ChartData = NonNullable<EditPayload['chart_data']>;

const CHART_W = 880;
const CHART_H = 520;
const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];

/**
 * 차트 데이터를 검증한다. 문제가 있으면 '어떤 값이 왜' 안 되는지 한국어 사유를,
 * 정상이면 null을 반환한다(AC4 — 숫자가 아니면 삽입 중단 + 사유).
 */
export function validateChartData(data: ChartData): string | null {
  if (data.kind !== 'bar' && data.kind !== 'line' && data.kind !== 'pie') {
    return `지원하지 않는 차트 종류입니다: ${String(data.kind)} (bar/line/pie만 가능)`;
  }
  if (!Array.isArray(data.labels) || data.labels.length === 0) {
    return '차트 labels(범주)가 비어 있습니다.';
  }
  if (!Array.isArray(data.series) || data.series.length === 0) {
    return '차트 series(데이터)가 비어 있습니다.';
  }
  if (data.kind === 'pie' && data.series.length > 1) {
    return '원형(pie) 차트는 시리즈 1개만 가능합니다.';
  }
  for (let s = 0; s < data.series.length; s += 1) {
    const series = data.series[s];
    const name = series.name || `시리즈 ${s + 1}`;
    if (!Array.isArray(series.values) || series.values.length !== data.labels.length) {
      return `'${name}'의 값 개수(${series.values?.length ?? 0})가 labels 개수(${data.labels.length})와 다릅니다.`;
    }
    for (let i = 0; i < series.values.length; i += 1) {
      const v = series.values[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return `'${name}'의 '${data.labels[i]}' 값(${JSON.stringify(v)})이 숫자가 아닙니다.`;
      }
      if (data.kind === 'pie' && v < 0) {
        return `원형 차트 값은 음수일 수 없습니다: '${data.labels[i]}' = ${v}`;
      }
    }
  }
  return null;
}

/**
 * 차트를 PNG로 렌더한다. 캔버스를 쓸 수 없는 환경(테스트 등)에서는 null.
 * 호출 전에 validateChartData로 검증되어 있어야 한다.
 */
export function renderChartToPng(data: ChartData): ImageForInsert | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = CHART_W;
  canvas.height = CHART_H;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, CHART_W, CHART_H);

  let top = 24;
  if (data.title) {
    ctx.fillStyle = '#1A1A1A';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(data.title, CHART_W / 2, 36);
    top = 56;
  }
  const legendH = drawLegend(ctx, data, top);
  const plot = { x: 64, y: top + legendH, w: CHART_W - 96, h: CHART_H - (top + legendH) - 56 };

  if (data.kind === 'pie') drawPie(ctx, data, plot);
  else drawAxesChart(ctx, data, plot);

  const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
  if (!base64) return null;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return { bytes, extension: 'png', naturalWidthPx: CHART_W, naturalHeightPx: CHART_H };
}

/** 시리즈가 2개 이상이거나 이름이 있으면 상단에 범례를 그린다. 반환: 차지한 높이(px). */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  top: number,
): number {
  if (data.kind === 'pie') return 0; // pie는 조각 라벨로 충분.
  const named = data.series.some((s) => s.name) || data.series.length > 1;
  if (!named) return 0;
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'left';
  let x = 64;
  const y = top + 14;
  data.series.forEach((s, i) => {
    const label = s.name || `시리즈 ${i + 1}`;
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(x, y - 10, 12, 12);
    ctx.fillStyle = '#333333';
    ctx.fillText(label, x + 18, y);
    x += 18 + ctx.measureText(label).width + 24;
  });
  return 28;
}

/** 막대/선 공통: 축·눈금·그리드 + 시리즈를 그린다. */
function drawAxesChart(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  plot: { x: number; y: number; w: number; h: number },
): void {
  const all = data.series.flatMap((s) => s.values);
  const maxV = Math.max(...all, 0);
  const minV = Math.min(...all, 0);
  const span = maxV - minV || 1;
  const yMax = maxV + span * 0.1;
  const yMin = minV < 0 ? minV - span * 0.1 : 0;
  const toY = (v: number) => plot.y + plot.h - ((v - yMin) / (yMax - yMin)) * plot.h;

  // 그리드 + y축 값(5단계).
  ctx.strokeStyle = '#E0E3E8';
  ctx.fillStyle = '#666666';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 5; i += 1) {
    const v = yMin + ((yMax - yMin) * i) / 5;
    const y = toY(v);
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
    ctx.fillText(formatNumber(v), plot.x - 8, y + 4);
  }

  const n = data.labels.length;
  const slot = plot.w / n;

  // x축 라벨.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#333333';
  data.labels.forEach((label, i) => {
    ctx.fillText(clipLabel(label), plot.x + slot * (i + 0.5), plot.y + plot.h + 20);
  });

  if (data.kind === 'bar') {
    const groupW = slot * 0.7;
    const barW = groupW / data.series.length;
    data.series.forEach((s, si) => {
      ctx.fillStyle = PALETTE[si % PALETTE.length];
      s.values.forEach((v, i) => {
        const x = plot.x + slot * i + (slot - groupW) / 2 + barW * si;
        const y0 = toY(Math.max(0, yMin));
        const y1 = toY(v);
        ctx.fillRect(x, Math.min(y0, y1), Math.max(1, barW - 2), Math.abs(y0 - y1));
      });
    });
  } else {
    data.series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = plot.x + slot * (i + 0.5);
        const y = toY(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.fillStyle = color;
      s.values.forEach((v, i) => {
        ctx.beginPath();
        ctx.arc(plot.x + slot * (i + 0.5), toY(v), 4, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }

  // 축선.
  ctx.strokeStyle = '#999999';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.x, plot.y);
  ctx.lineTo(plot.x, plot.y + plot.h);
  ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
  ctx.stroke();
}

/** 원형 차트: 조각 + 바깥쪽 라벨(이름 비율%). */
function drawPie(
  ctx: CanvasRenderingContext2D,
  data: ChartData,
  plot: { x: number; y: number; w: number; h: number },
): void {
  const values = data.series[0].values;
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const r = Math.min(plot.w, plot.h) / 2 - 40;
  let angle = -Math.PI / 2;
  ctx.font = '14px sans-serif';
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fill();
    // 라벨은 조각 중앙 각도의 바깥쪽에.
    const mid = angle + sweep / 2;
    const lx = cx + Math.cos(mid) * (r + 18);
    const ly = cy + Math.sin(mid) * (r + 18);
    ctx.fillStyle = '#333333';
    ctx.textAlign = Math.cos(mid) >= 0 ? 'left' : 'right';
    const pct = Math.round((v / total) * 100);
    ctx.fillText(`${clipLabel(data.labels[i])} ${pct}%`, lx, ly + 4);
    angle += sweep;
  });
}

function clipLabel(text: string): string {
  return text.length > 12 ? `${text.slice(0, 12)}…` : text;
}

function formatNumber(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

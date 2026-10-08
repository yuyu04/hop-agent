// 인쇄 미리보기용 SVG를 안전하게 파싱한다.
const BLOCKED_PREVIEW_ELEMENTS = 'script, foreignObject, iframe, object, embed, link, meta';
const URL_ATTRIBUTE_NAMES = new Set(['href', 'xlink:href', 'src']);

export function parsePreviewSvg(svgMarkup: string): SVGSVGElement | null {
  const parsed = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return null;

  const svgElement = parsed.documentElement;
  if (svgElement.tagName.toLowerCase() !== 'svg') return null;

  svgElement.setAttribute('preserveAspectRatio', 'xMidYMin slice');
  svgElement.setAttribute('width', '100%');
  svgElement.setAttribute('height', '100%');

  sanitizePreviewSvg(svgElement);
  return document.importNode(svgElement, true) as unknown as SVGSVGElement;
}

function sanitizePreviewSvg(root: Element): void {
  root.querySelectorAll(BLOCKED_PREVIEW_ELEMENTS).forEach((node) => {
    node.remove();
  });

  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (shouldRemoveAttribute(attribute)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function shouldRemoveAttribute(attribute: Attr): boolean {
  const name = attribute.name.toLowerCase();
  const value = attribute.value.trim().toLowerCase();
  if (name.startsWith('on')) return true;
  if (value.includes('javascript:')) return true;
  if (name === 'style' && hasUnsafeStyleValue(value)) return true;
  if (URL_ATTRIBUTE_NAMES.has(name) && !isAllowedPreviewUrl(value)) return true;
  return false;
}

function hasUnsafeStyleValue(value: string): boolean {
  return value.includes('expression(')
    || value.includes('-moz-binding')
    || value.includes('url(javascript:');
}

function isAllowedPreviewUrl(value: string): boolean {
  return value === ''
    || value.startsWith('#')
    || value.startsWith('data:image/')
    || value.startsWith('blob:');
}

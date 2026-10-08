// 제품 정보 대화상자 — upstream 것에 HOP 버전을 덧붙인다.
import { AboutDialog as UpstreamAboutDialog } from '@/upstream/ui';

export class AboutDialog extends UpstreamAboutDialog {
  protected override createBody(): HTMLElement {
    const body = super.createBody();
    const version = body.querySelector('.about-version');

    const hopVersion = document.createElement('div');
    hopVersion.className = 'about-hop-version';
    hopVersion.textContent = `HOP ${__HOP_VERSION__}`;

    if (version?.parentNode) {
      version.parentNode.insertBefore(hopVersion, version.nextSibling);
    } else {
      body.appendChild(hopVersion);
    }

    return body;
  }
}

# HOP AI

**HOP is Open HWP — 그리고 AI가 함께 씁니다.**

HOP AI는 오픈소스 HWP 편집기 [HOP](https://github.com/golbin/hop)에 AI 편집 도우미를 더한 macOS, Windows, Linux용 데스크톱 앱입니다. 문서를 열어 두고 말로 지시하면 AI가 본문·표·서식을 HWP 문서에 직접 쓰고 고치며, 바뀐 곳을 문서 위에서 확인한 뒤 승인합니다.

문서 파싱과 렌더링은 [rhwp](https://github.com/edwardkim/rhwp)를, 앱 껍데기는 [HOP](https://github.com/golbin/hop)를 기반으로 합니다.

![HOP AI editor](assets/screenshots/hop-ai-editor.webp)

다운로드 페이지: https://yuyu04.github.io/hop-agent/

## 할 수 있는 일

* AI로 문서 쓰기·고치기 — "사업계획서 초안 써줘", "표의 합계 행 추가해줘", "이 문단 더 격식 있게"
* 문서 위 검토 — 바뀐 문단 강조, 변경마다 승인/거절, 모두 승인(⌘⏎)/모두 거절(⌘⌫)
* 문서 유형에 맞는 작성 지침(사업계획서·보고서·공문 등)을 AI가 스스로 골라 적용
* Claude·GPT·Gemini API 키, 로컬 Ollama, 또는 Claude Code 구독(키 없이)으로 동작
* HWP/HWPX 열기·저장, PDF 내보내기, 인쇄, 파일 연결, 여러 창 (HOP 기본 기능)

## 다운로드

최신 릴리즈는 아래 링크에서 받을 수 있습니다.

* [macOS Apple Silicon (.dmg)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-macos-arm64.dmg)
* [macOS Intel (.dmg)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-macos-x64.dmg)
* [Windows x64 (.msi)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-windows-x64.msi)
* [Linux x64 (.deb, Ubuntu/Debian 계열 권장)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-linux-x64.deb)
* [Linux x64 (.rpm, Fedora/openSUSE 계열)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-linux-x64.rpm)
* [Linux x64 (AppImage, portable)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-linux-x64.AppImage)
* [Linux arm64 (.deb, Ubuntu/Debian 계열)](https://github.com/yuyu04/hop-agent/releases/latest/download/HOP-linux-arm64.deb)

개발자 서명 없이 배포합니다. macOS는 처음 열 때 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 누르고, "손상되었기 때문에 열 수 없습니다"가 뜨면 터미널에서 한 번 실행하세요.

```sh
xattr -dr com.apple.quarantine "/Applications/HOP AI.app"
```

Windows에서 "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르세요. HOP AI는 원본 HOP와 이름·식별자가 달라 함께 설치해 쓸 수 있습니다.

전체 릴리즈는 [GitHub Releases](https://github.com/yuyu04/hop-agent/releases)에서 확인할 수 있습니다.

## 설치 유의사항

### Windows

Windows 빌드는 아직 서명되지 않아 Edge나 Windows SmartScreen에서 "일반적으로 다운로드되지 않습니다" 또는 실행 경고가 뜰 수 있습니다. 다운로드 항목의 `...` 메뉴에서 `유지`를 선택한 뒤 다운로드할 수 있습니다.

### Linux

Linux에서는 한글 IME와 WebKitGTK 런타임 안정성을 위해 배포판에 맞는 네이티브 패키지를 우선 사용해 주세요. arm64 Linux는 Ubuntu/Debian 계열 `.deb`를 먼저 지원합니다. AppImage는 portable 실행이 필요할 때만 권장하며, 일부 Wayland/IME 환경에서는 한영 전환이나 창 표시가 불안정할 수 있습니다.

Arch, CachyOS, EndeavourOS 계열은 AUR의 `hop-openhwp-bin` 패키지로 설치할 수 있습니다. 이 패키지는 [seunghun-kim](https://github.com/seunghun-kim)님이 올려주셨습니다.

```sh
yay -S hop-openhwp-bin
# 또는
paru -S hop-openhwp-bin
```

## 개발하기

개발 환경 준비, 실행 명령, 프로젝트 구조, `rhwp`와의 관계는 [개발 문서](docs/DEVELOPMENT.md)에 정리해 두었습니다.

## Credits

HOP는 [rhwp](https://github.com/edwardkim/rhwp)를 기반으로 합니다. HWP 엔진을 공개해 주신 개발자분께 감사드립니다.

License: MIT

// 다운로드 페이지 — 최신 릴리스 파일로 링크를 잇고, 접속한 운영체제에 맞는 설치 파일을 앞세운다.
const repository = "yuyu04/hop-agent";
const releasesUrl = `https://github.com/${repository}/releases`;
const latestReleaseApiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
const latestDownload = (asset) => `${releasesUrl}/latest/download/${asset}`;

const downloadLinks = Array.from(document.querySelectorAll("[data-download-asset]"));
const downloadStatus = document.querySelector("#download-status");
const versionPill = document.querySelector("[data-release-version]");

/** 운영체제별 히어로 버튼 — 이름·부가 설명·파일. */
const PRIMARY = {
    "mac-arm64": { label: "macOS용 다운로드", sub: "Apple Silicon · .dmg", asset: "HOP-macos-arm64.dmg", platform: "mac" },
    "mac-x64": { label: "macOS용 다운로드", sub: "Intel · .dmg", asset: "HOP-macos-x64.dmg", platform: "mac" },
    windows: { label: "Windows용 다운로드", sub: "x64 · .msi", asset: "HOP-windows-x64.msi", platform: "windows" },
    linux: { label: "Linux용 다운로드", sub: "x64 · .deb", asset: "HOP-linux-x64.deb", platform: "linux" },
};

/** 접속한 기기의 운영체제(데스크톱만). 판단할 수 없거나 모바일이면 null. */
async function detectPlatform() {
    const ua = navigator.userAgent || "";
    const platform = navigator.userAgentData?.platform || navigator.platform || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua) || navigator.userAgentData?.mobile) return { mobile: true };
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return { key: "windows" };
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) {
        // Chromium은 CPU 종류를 알려 준다. Safari·Firefox는 알 수 없어 최신 Mac(Apple Silicon)을 기본으로.
        try {
            const hints = await navigator.userAgentData?.getHighEntropyValues?.(["architecture"]);
            if (hints?.architecture === "x86") return { key: "mac-x64" };
        } catch {
            /* 힌트를 못 받으면 기본값 */
        }
        return { key: "mac-arm64" };
    }
    if (/Linux/i.test(platform) || /Linux/i.test(ua)) return { key: "linux" };
    return null;
}

async function personalize() {
    const detected = await detectPlatform();
    const button = document.querySelector("[data-primary-download]");
    const label = document.querySelector("[data-primary-label]");
    const sub = document.querySelector("[data-primary-sub]");
    const note = document.querySelector("[data-primary-note]");
    if (!button || !label || !sub) return;

    if (detected?.mobile) {
        label.textContent = "데스크톱에서 설치하세요";
        sub.textContent = "macOS · Windows · Linux용 앱입니다";
        if (note) note.textContent = "이 페이지를 컴퓨터에서 열면 맞는 설치 파일을 바로 받을 수 있습니다.";
        return;
    }
    const choice = detected?.key ? PRIMARY[detected.key] : null;
    if (!choice) return;

    label.textContent = choice.label;
    sub.textContent = choice.sub;
    button.href = latestDownload(choice.asset);
    button.dataset.downloadAsset = choice.asset;
    downloadLinks.push(button);
    document.querySelector(`[data-platform="${choice.platform}"]`)?.classList.add("is-current");
}

function formatDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
}

/** 최신 릴리스의 실제 파일로 링크를 잇고 버전·날짜를 보인다. API가 막히면 latest/download 주소를 그대로 둔다. */
async function hydrateDownloadLinks() {
    const response = await fetch(latestReleaseApiUrl, {
        headers: { Accept: "application/vnd.github+json" },
    });

    if (response.status === 404) {
        for (const link of downloadLinks) {
            link.href = releasesUrl;
            link.dataset.available = "false";
        }
        if (downloadStatus) {
            downloadStatus.textContent = "아직 공개된 릴리스가 없습니다. 릴리스 목록에서 준비 상태를 확인하세요.";
        }
        return;
    }
    if (!response.ok) return;

    const release = await response.json();
    const assets = new Map(release.assets.map((asset) => [asset.name, asset.browser_download_url]));
    let missing = 0;
    for (const link of downloadLinks) {
        const url = assets.get(link.dataset.downloadAsset);
        if (url) {
            link.href = url;
            link.dataset.available = "true";
        } else {
            link.href = `${releasesUrl}/tag/${release.tag_name}`;
            link.dataset.available = "false";
            missing += 1;
        }
    }

    const version = release.tag_name;
    const date = formatDate(release.published_at);
    if (versionPill) versionPill.textContent = version;
    const sub = document.querySelector("[data-primary-sub]");
    if (sub && document.querySelector("[data-primary-download]")?.dataset.downloadAsset) {
        sub.textContent = `${sub.textContent} · ${version}`;
    }
    if (downloadStatus) {
        downloadStatus.textContent = missing
            ? `${version} — 일부 파일이 아직 준비되지 않았습니다. 릴리스 목록에서 전체 파일을 확인하세요.`
            : `최신 ${version}${date ? ` · ${date} 공개` : ""} · 무료`;
    }
}

function wireCopyButtons() {
    for (const button of document.querySelectorAll("[data-copy-target]")) {
        button.addEventListener("click", async () => {
            const text = document.getElementById(button.dataset.copyTarget)?.textContent ?? "";
            try {
                await navigator.clipboard.writeText(text);
                button.textContent = "복사됨";
            } catch {
                button.textContent = "직접 선택해 복사하세요";
            }
            setTimeout(() => {
                button.textContent = "복사";
            }, 1600);
        });
    }
}

wireCopyButtons();
personalize()
    .catch(() => {})
    .finally(() => {
        hydrateDownloadLinks().catch(() => {
            // API에 닿지 못하면 정적인 latest/download 주소를 그대로 둔다.
        });
    });

// 바닥글 통계 — 방문 수(hitscounter.dev)와 릴리스 설치 파일 다운로드 수(GitHub API)를 보인다.
(() => {
    const repository = "yuyu04/hop-agent";
    const SITE_URL = "https://yuyu04.github.io/hop-agent/";
    // 로컬 미리보기에서 연 횟수가 실제 방문 수에 섞이지 않게 키를 나눈다.
    const counterKey = location.hostname === "yuyu04.github.io" ? SITE_URL : `${SITE_URL}preview`;
    const counterUrl = `https://hitscounter.dev/api/hit?url=${encodeURIComponent(counterKey)}&output=json&tz=Asia%2FSeoul`;
    const SESSION_KEY = "hop-ai-visit";

    /** 사용자가 받는 설치 파일만 센다(.sig·업데이터 묶음·latest.json 제외). */
    const INSTALLER = /\.(dmg|msi|exe|deb|rpm|AppImage)$/;
    const OS_OF = (name) => (/macos/i.test(name) ? "mac" : /windows/i.test(name) ? "windows" : /linux/i.test(name) ? "linux" : null);

    const number = (n) => n.toLocaleString("ko-KR");
    const setStat = (key, text) => {
        const el = document.querySelector(`[data-stat="${key}"]`);
        if (el) el.textContent = text;
    };

    function readSession() {
        try {
            return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
        } catch {
            return null;
        }
    }

    function writeSession(value) {
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
        } catch {
            /* 저장이 막혀 있으면 다음 새로고침에서 한 번 더 셀 뿐이다 */
        }
    }

    /** 한 탭에서 새로고침할 때마다 세지 않도록, 같은 세션에서는 처음 받은 숫자를 다시 보인다. */
    async function loadVisits() {
        const cached = readSession();
        let hits = cached;
        if (!cached) {
            const response = await fetch(counterUrl);
            if (!response.ok) throw new Error(String(response.status));
            const data = await response.json();
            hits = { today: Number(data.today_hits) || 0, total: Number(data.total_hits) || 0 };
            writeSession(hits);
        }
        setStat("today", number(hits.today));
        setStat("total", number(hits.total));
    }

    async function loadDownloads() {
        const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
            headers: { Accept: "application/vnd.github+json" },
        });
        if (!response.ok) throw new Error(String(response.status));
        const releases = await response.json();
        const byOs = { mac: 0, windows: 0, linux: 0 };
        for (const release of releases) {
            if (release.draft) continue;
            for (const asset of release.assets ?? []) {
                const os = OS_OF(asset.name);
                if (os && INSTALLER.test(asset.name)) byOs[os] += asset.download_count ?? 0;
            }
        }
        const total = byOs.mac + byOs.windows + byOs.linux;
        setStat("downloads", number(total));
        for (const [os, count] of Object.entries(byOs)) {
            const label = document.querySelector(`[data-split="${os}"]`);
            if (label) label.textContent = number(count);
            const bar = document.querySelector(`.split-bar [data-os="${os}"]`);
            if (bar) bar.style.width = total ? `${(count / total) * 100}%` : "0";
        }
        const note = document.querySelector("[data-stats-note]");
        const published = releases.filter((release) => !release.draft).length;
        if (note && published) {
            note.textContent = `방문은 이 페이지를 연 횟수, 다운로드는 릴리스 ${published}개에 올린 설치 파일을 받은 횟수입니다.`;
        }
    }

    loadVisits().catch(() => {
        // 카운터에 닿지 못하면 '—'를 그대로 둔다.
    });
    loadDownloads().catch(() => {});
})();

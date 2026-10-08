// 문제 알리기 페이지 — 입력한 내용으로 GitHub 새 이슈 화면을 채워 열고, 최근 이슈를 보인다.
(() => {
    const repository = "yuyu04/hop-agent";
    const issuesUrl = `https://github.com/${repository}/issues`;
    /** GitHub가 받아 주는 주소 길이에 여유를 둔 한도 — 넘으면 본문은 클립보드로 넘긴다. */
    const MAX_URL = 7000;

    const form = document.getElementById("report-form");
    const note = document.getElementById("form-note");
    const list = document.getElementById("recent-issues");
    const versionPill = document.querySelector("[data-release-version]");
    const versionInput = document.getElementById("version");
    const value = (id) => document.getElementById(id)?.value.trim() ?? "";

    function currentKind() {
        return form.querySelector('input[name="kind"]:checked')?.value === "feature" ? "feature" : "bug";
    }

    function syncKind() {
        const kind = currentKind();
        for (const group of form.querySelectorAll("[data-kind]")) {
            group.hidden = group.dataset.kind !== kind;
        }
    }

    /** 이슈 양식(.github/ISSUE_TEMPLATE)과 같은 제목 순서로 본문을 만든다. 빈 칸은 '(적지 않음)'. */
    function buildBody(kind) {
        const block = (heading, text) => `### ${heading}\n${text || "(적지 않음)"}`;
        const parts =
            kind === "bug"
                ? [
                      block("어디서 생겼나요?", value("area")),
                      block("무슨 일이 있었나요?", value("what")),
                      block("다시 일으키는 방법", value("steps")),
                      block("기대한 동작", value("expected")),
                      block(
                          "사용 환경",
                          [
                              `- 운영체제: ${value("os")}`,
                              `- HOP AI 버전: ${value("version") || "모름"}`,
                              `- AI 공급자: ${value("provider")}`,
                              `- 모델: ${value("model") || "모름"}`,
                          ].join("\n"),
                      ),
                  ]
                : [
                      block("어느 부분인가요?", value("area")),
                      block("어떤 점이 불편한가요?", value("problem")),
                      block("원하는 기능", value("solution")),
                  ];
        parts.push(block("추가 정보", value("extra")));
        return `${parts.join("\n\n")}\n\n<sub>사이트의 문제 알리기 페이지에서 작성했습니다.</sub>`;
    }

    function newIssueUrl(title, body) {
        const params = new URLSearchParams({ title });
        if (body) params.set("body", body);
        return `${issuesUrl}/new?${params.toString()}`;
    }

    function showNote(text, tone = "info") {
        note.textContent = text;
        note.dataset.tone = tone;
    }

    function firstMissing(kind) {
        if (!value("title")) return "title";
        if (kind === "bug" && !value("what")) return "what";
        if (kind === "feature" && !value("problem")) return "problem";
        return null;
    }

    async function onSubmit(event) {
        event.preventDefault();
        const kind = currentKind();
        const missing = firstMissing(kind);
        if (missing) {
            const label = form.querySelector(`label[for="${missing}"]`)?.firstChild?.textContent.trim();
            showNote(`'${label}' 칸을 채워 주세요.`, "error");
            document.getElementById(missing)?.focus();
            return;
        }
        if (!document.getElementById("privacy").checked) {
            showNote("민감한 내용을 적지 않았는지 확인하고 체크해 주세요.", "error");
            document.getElementById("privacy").focus();
            return;
        }

        const title = `${kind === "bug" ? "[버그]" : "[제안]"} ${value("title")}`;
        const body = buildBody(kind);
        let url = newIssueUrl(title, body);

        // 너무 길면 주소에 실을 수 없다 — 본문은 클립보드로 넘기고 붙여 넣기를 안내한다.
        if (url.length > MAX_URL) {
            let copied = false;
            try {
                await navigator.clipboard.writeText(body);
                copied = true;
            } catch {
                copied = false;
            }
            url = newIssueUrl(title, copied ? "(여기에 붙여 넣어 주세요 — 클립보드에 복사되어 있습니다)" : "");
            showNote(
                copied
                    ? "내용이 길어 본문은 클립보드에 복사했습니다. 열린 화면의 본문 칸에 붙여 넣어 주세요."
                    : "내용이 길어 주소에 다 담지 못했습니다. 이 페이지의 내용을 이슈 본문에 옮겨 적어 주세요.",
                "warn",
            );
        } else {
            showNote("새 창에서 GitHub 이슈 화면을 열었습니다. 내용을 확인하고 Create를 누르면 접수됩니다.", "ok");
        }

        // 'noopener'를 주면 window.open이 늘 null을 돌려줘 팝업 차단과 구분할 수 없다 — 열고 나서 끊는다.
        const opened = window.open(url, "_blank");
        if (opened) {
            opened.opener = null;
        } else {
            // 팝업이 막히면 같은 창에서 연다.
            window.location.href = url;
        }
    }

    /** 접속한 기기로 운영체제 칸을 미리 고른다(맞지 않으면 사용자가 바꾼다). */
    function preselectOs() {
        const select = document.getElementById("os");
        const ua = navigator.userAgent || "";
        const platform = navigator.userAgentData?.platform || navigator.platform || "";
        let choice = null;
        if (/Win/i.test(platform) || /Windows/i.test(ua)) choice = "Windows";
        else if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) choice = "macOS (Apple Silicon)";
        else if (/Linux/i.test(platform) && !/Android/i.test(ua)) choice = "Linux";
        if (choice) select.value = choice;
        navigator.userAgentData
            ?.getHighEntropyValues?.(["architecture"])
            .then((hints) => {
                if (choice?.startsWith("macOS") && hints?.architecture === "x86") select.value = "macOS (Intel)";
            })
            .catch(() => {});
    }

    function formatDate(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        return `${date.getMonth() + 1}월 ${date.getDate()}일`;
    }

    function renderIssues(issues) {
        list.replaceChildren();
        if (!issues.length) {
            const empty = document.createElement("li");
            empty.className = "issues-empty";
            empty.textContent = "아직 올라온 이슈가 없습니다. 첫 신고를 남겨 주세요.";
            list.append(empty);
            return;
        }
        for (const issue of issues) {
            const item = document.createElement("li");
            const state = document.createElement("span");
            const open = issue.state === "open";
            state.className = `issue-state ${open ? "is-open" : "is-closed"}`;
            state.textContent = open ? "열림" : "해결";
            const link = document.createElement("a");
            link.href = issue.html_url;
            link.textContent = issue.title;
            const meta = document.createElement("small");
            meta.textContent = `#${issue.number} · ${formatDate(issue.created_at)}`;
            item.append(state, link, meta);
            list.append(item);
        }
    }

    async function loadRecentIssues() {
        try {
            const response = await fetch(
                `https://api.github.com/repos/${repository}/issues?state=all&per_page=10`,
                { headers: { Accept: "application/vnd.github+json" } },
            );
            if (!response.ok) throw new Error(String(response.status));
            const issues = (await response.json()).filter((issue) => !issue.pull_request).slice(0, 5);
            renderIssues(issues);
        } catch {
            list.replaceChildren();
            const failed = document.createElement("li");
            failed.className = "issues-empty";
            failed.textContent = "최근 이슈를 불러오지 못했습니다. '전체 보기'에서 확인해 주세요.";
            list.append(failed);
        }
    }

    async function loadLatestVersion() {
        try {
            const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
                headers: { Accept: "application/vnd.github+json" },
            });
            if (!response.ok) return;
            const tag = (await response.json()).tag_name ?? "";
            if (versionPill && tag) versionPill.textContent = tag;
            if (versionInput && tag) versionInput.placeholder = `예: ${tag.replace(/^v/, "")} (최신)`;
        } catch {
            /* 버전을 못 받아도 양식은 그대로 쓴다 */
        }
    }

    for (const radio of form.querySelectorAll('input[name="kind"]')) {
        radio.addEventListener("change", syncKind);
    }
    form.addEventListener("submit", onSubmit);
    syncKind();
    preselectOs();
    loadRecentIssues();
    loadLatestVersion();
})();

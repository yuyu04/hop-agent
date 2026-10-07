//! 글쓰기 '스킬' — 문서 유형별 작성 지침을 파일(.md)로 관리한다(Claude Skills 식).
//!
//! 거대한 단일 시스템 프롬프트 대신, 요청에 맞는 스킬 본문을 골라 프롬프트에 주입해
//! 더 풍부하고 일관된 글을 쓰게 한다. 기본 스킬은 앱 데이터 폴더에 처음 한 번 써 두고,
//! 사용자가 그 폴더의 .md를 편집하거나 외부 스킬을 복사해 넣을 수 있다.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 파싱된 스킬 하나(프런트엔드로 전달).
#[derive(Debug, Clone, Serialize)]
pub struct Skill {
    /// 파일명(확장자 제외) = 식별자.
    pub id: String,
    pub name: String,
    pub description: String,
    /// 자동 선택용 트리거 키워드.
    pub triggers: Vec<String>,
    /// 프롬프트에 주입할 본문(작성 지침).
    pub body: String,
    /// `edit`이면 기존 문서 편집 전용 — 새로 작성하는 요청에는 자동 선택하지 않는다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// 앱 데이터 폴더 아래 스킬 디렉터리.
fn skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 폴더를 찾지 못했습니다: {}", e))?;
    Ok(base.join("skills"))
}

/// 기본 스킬 (파일명, 내용). 폴더가 비어 있으면 이 파일들을 써 둔다.
const DEFAULT_SKILLS: &[(&str, &str)] = &[
    ("사업계획서.md", include_str!("skills_default/proposal.md")),
    ("보고서.md", include_str!("skills_default/report.md")),
    ("문서-문체.md", include_str!("skills_default/style.md")),
    ("한글-문서-편집.md", include_str!("skills_default/hwp_edit.md")),
    ("공문.md", include_str!("skills_default/gongmun.md")),
];

/// 스킬 폴더를 보장하고, 비어 있으면 기본 스킬을 기록한다.
fn ensure_dir_with_defaults(dir: &PathBuf) -> Result<(), String> {
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("스킬 폴더 생성 실패: {}", e))?;
    }
    // 기본 스킬 중 '파일이 없는' 것만 보충한다. 폴더가 비어 처음 까는 경우는 물론,
    // 앱 업데이트로 새 기본 스킬(예: 한글 문서 편집)이 추가됐을 때 기존 사용자에게도
    // 전달된다. 이미 있는 파일(사용자가 편집한 것 포함)은 덮어쓰지 않는다.
    for (name, content) in DEFAULT_SKILLS {
        let path = dir.join(name);
        if !path.exists() {
            let _ = std::fs::write(&path, content);
        }
    }
    Ok(())
}

/// 간단한 프런트매터(--- key: value ---)를 파싱한다. 없으면 본문 전체가 body.
fn parse_skill(id: &str, content: &str) -> Skill {
    let mut name = id.to_string();
    let mut description = String::new();
    let mut triggers: Vec<String> = Vec::new();
    let mut mode: Option<String> = None;
    let mut body = content.trim().to_string();

    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let header = &rest[..end];
            body = rest[end + 4..].trim().to_string();
            for line in header.lines() {
                let line = line.trim();
                if let Some((k, v)) = line.split_once(':') {
                    let (k, v) = (k.trim(), v.trim());
                    match k {
                        "name" => name = v.to_string(),
                        "description" => description = v.to_string(),
                        "mode" if !v.is_empty() => mode = Some(v.to_string()),
                        "triggers" => {
                            triggers = v
                                .split(',')
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty())
                                .collect()
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Skill {
        id: id.to_string(),
        name,
        description,
        triggers,
        body,
        mode,
    }
}

/// 스킬 목록을 반환한다(폴더 보장 + 기본 스킬 보충 후 *.md 파싱).
pub fn list(app: &AppHandle) -> Result<Vec<Skill>, String> {
    let dir = skills_dir(app)?;
    ensure_dir_with_defaults(&dir)?;
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("스킬 폴더 읽기 실패: {}", e))?;
    let mut entries: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .collect();
    entries.sort();
    for path in entries {
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            out.push(parse_skill(&id, &content));
        }
    }
    Ok(out)
}

/// 스킬 목록을 JSON 문자열로 반환한다.
#[tauri::command]
pub fn ai_list_skills(app: AppHandle) -> Result<String, String> {
    let skills = list(&app)?;
    serde_json::to_string(&skills).map_err(|e| format!("스킬 직렬화 실패: {}", e))
}

/// 스킬 폴더를 OS 파일 탐색기로 연다(없으면 만들고 기본 스킬을 깐다).
#[tauri::command]
pub fn ai_open_skills_dir(app: AppHandle) -> Result<(), String> {
    let dir = skills_dir(&app)?;
    ensure_dir_with_defaults(&dir)?;
    let path = dir.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&path)
        .spawn()
        .map_err(|e| format!("스킬 폴더 열기 실패: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let content = "---\nname: 사업계획서\ndescription: 설명\ntriggers: 사업계획서, R&D\n---\n본문 내용입니다.";
        let s = parse_skill("file", content);
        assert_eq!(s.name, "사업계획서");
        assert_eq!(s.description, "설명");
        assert_eq!(s.triggers, vec!["사업계획서", "R&D"]);
        assert_eq!(s.body, "본문 내용입니다.");
    }

    #[test]
    fn no_frontmatter_uses_whole_body_and_id_name() {
        let s = parse_skill("내문서", "그냥 지침 텍스트");
        assert_eq!(s.name, "내문서");
        assert!(s.triggers.is_empty());
        assert_eq!(s.body, "그냥 지침 텍스트");
    }

    // ── F-a7b2c7ba AC-8e9f717d: 기본 스킬 '공문' ──

    /// 앱 스킬 폴더에 깔리는 그대로의 '공문' 스킬(파일명 → id).
    fn bundled_gongmun() -> Skill {
        let (file, content) = DEFAULT_SKILLS
            .iter()
            .find(|(name, _)| *name == "공문.md")
            .expect("기본 스킬에 '공문.md'가 있어야 한다");
        parse_skill(file.trim_end_matches(".md"), content)
    }

    fn position(body: &str, needle: &str) -> usize {
        body.find(needle)
            .unwrap_or_else(|| panic!("공문 지침에 '{needle}'이(가) 없다:\n{body}"))
    }

    #[test]
    fn f_a7b2c7ba_ac_8e9f717d_gongmun_is_a_bundled_default_skill_for_authoring() {
        let (_, content) = DEFAULT_SKILLS.iter().find(|(name, _)| *name == "공문.md").unwrap();
        assert_eq!(*content, include_str!("skills_default/gongmun.md"));
        let skill = bundled_gongmun();
        assert_eq!(skill.id, "공문");
        assert_eq!(skill.name, "공문");
        assert!(!skill.description.is_empty());
        // 편집 전용(mode: edit)이 아니라 작성 요청에 자동으로 고를 수 있는 스킬이다.
        assert_eq!(skill.mode, None);
    }

    #[test]
    fn f_a7b2c7ba_ac_8e9f717d_gongmun_triggers_cover_official_letter_and_draft_requests() {
        let triggers = bundled_gongmun().triggers;
        for word in ["공문", "기안", "기안문", "시행문", "공문서", "협조 요청"] {
            assert!(triggers.iter().any(|t| t == word), "트리거에 '{word}' 없음: {triggers:?}");
        }
        // 다른 기본 스킬의 트리거와 겹치지 않아야 공문 요청이 다른 스킬로 새지 않는다.
        for (file, content) in DEFAULT_SKILLS.iter().filter(|(name, _)| *name != "공문.md") {
            let other = parse_skill(file, content);
            for word in ["공문", "기안", "기안문", "공문서"] {
                assert!(!other.triggers.iter().any(|t| t == word), "{file}도 '{word}' 트리거를 가진다");
            }
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_8e9f717d_gongmun_lists_parts_in_official_order() {
        let body = bundled_gongmun().body;
        // 수신 → (경유) → 제목 → 본문 → 붙임 → '끝.' → 발신명의
        let order = [
            position(&body, "2. 수신"),
            position(&body, "3. (경유)"),
            position(&body, "4. 제목"),
            position(&body, "5. 본문"),
            position(&body, "6. 붙임"),
            position(&body, "\"끝.\"을 붙입니다"),
            position(&body, "8. 발신명의"),
        ];
        assert!(order.windows(2).all(|w| w[0] < w[1]), "순서가 어긋났다: {order:?}");
    }

    #[test]
    fn f_a7b2c7ba_ac_8e9f717d_gongmun_body_uses_the_1_ga_1paren_gaparen_hierarchy() {
        let body = bundled_gongmun().body;
        let line = body
            .lines()
            .find(|l| l.contains("5. 본문"))
            .expect("본문 항목 줄");
        let levels = [
            position(line, "1., 2., 3."),
            position(line, "가., 나., 다."),
            position(line, "1), 2)"),
            position(line, "가), 나)"),
        ];
        assert!(levels.windows(2).all(|w| w[0] < w[1]), "항목 체계 순서: {line}");
    }

    #[test]
    fn f_a7b2c7ba_ac_8e9f717d_gongmun_forbids_unrequested_attachments_and_stays_short() {
        let body = bundled_gongmun().body;
        assert!(body.contains("사용자가 첨부를 말했을 때만"), "{body}");
        assert!(body.contains("요청하지 않은 붙임(계획서·양식·명단 등)을 지어내지 마세요"), "{body}");
        assert!(body.contains("붙임 문서의 본문도 만들지 않습니다"), "{body}");
        assert!(body.contains("1~2쪽 안에서 끝내세요"), "{body}");
    }
}

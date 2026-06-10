//! 디자인 '테마' — 생성 문서의 시각 수치(간격·크기·색)를 파일(.json)로 관리한다.
//!
//! 글의 구조·표현은 스킬(.md)이, 간격·글자 크기 같은 수치는 테마(.json)가 담당한다.
//! 하드코딩 대신 사용자가 앱 데이터 폴더의 테마를 편집하거나 새 테마를 추가할 수 있다
//! (스킬과 같은 모델). 수치는 사람이 읽기 쉬운 pt 단위로 쓰고, 적용 측(ai-apply)이
//! HWP 저장 스케일로 변환한다.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 앱 데이터 폴더 아래 테마 디렉터리.
fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 폴더를 찾지 못했습니다: {}", e))?;
    Ok(base.join("themes"))
}

/// 기본 테마 (파일명, 내용). 폴더에 .json이 하나도 없으면 이 파일들을 써 둔다.
const DEFAULT_THEMES: &[(&str, &str)] = &[
    ("기본.json", include_str!("themes_default/default.json")),
    ("촘촘하게.json", include_str!("themes_default/compact.json")),
    ("여유있게.json", include_str!("themes_default/airy.json")),
    ("문서스타일.json", include_str!("themes_default/docstyle.json")),
];

/// 테마 폴더를 보장하고, 비어 있으면 기본 테마를 기록한다.
fn ensure_dir_with_defaults(dir: &PathBuf) -> Result<(), String> {
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| format!("테마 폴더 생성 실패: {}", e))?;
    }
    let has_json = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .any(|e| e.path().extension().is_some_and(|x| x == "json"))
        })
        .unwrap_or(false);
    if !has_json {
        for (name, content) in DEFAULT_THEMES {
            let _ = std::fs::write(dir.join(name), content);
        }
    }
    Ok(())
}

/// 테마 JSON에 `id`(파일명)를 주입해 객체로 반환한다. 형식이 깨진 파일은 None.
fn parse_theme(id: &str, content: &str) -> Option<serde_json::Value> {
    let mut value: serde_json::Value = serde_json::from_str(content).ok()?;
    let obj = value.as_object_mut()?;
    obj.insert("id".to_string(), serde_json::Value::String(id.to_string()));
    if !obj.contains_key("name") {
        obj.insert("name".to_string(), serde_json::Value::String(id.to_string()));
    }
    Some(value)
}

/// 테마 목록을 JSON 배열 문자열로 반환한다(폴더 보장 + 기본 테마 보충 후 *.json 파싱).
/// 스키마 해석·단위 변환은 프런트(core/doc-theme.ts)가 담당한다.
#[tauri::command]
pub fn ai_list_themes(app: AppHandle) -> Result<String, String> {
    let dir = themes_dir(&app)?;
    ensure_dir_with_defaults(&dir)?;
    let mut out: Vec<serde_json::Value> = Vec::new();
    let rd = std::fs::read_dir(&dir).map_err(|e| format!("테마 폴더 읽기 실패: {}", e))?;
    let mut entries: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
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
            if let Some(theme) = parse_theme(&id, &content) {
                out.push(theme);
            }
        }
    }
    serde_json::to_string(&out).map_err(|e| format!("테마 직렬화 실패: {}", e))
}

/// 테마 폴더를 OS 파일 탐색기로 연다(없으면 만들고 기본 테마를 깐다).
#[tauri::command]
pub fn ai_open_themes_dir(app: AppHandle) -> Result<(), String> {
    let dir = themes_dir(&app)?;
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
        .map_err(|e| format!("테마 폴더 열기 실패: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_theme_injects_id_and_falls_back_name() {
        let v = parse_theme("내테마", r#"{"styles":{}}"#).unwrap();
        assert_eq!(v["id"], "내테마");
        assert_eq!(v["name"], "내테마");
        let v2 = parse_theme("file", r#"{"name":"기본","styles":{}}"#).unwrap();
        assert_eq!(v2["name"], "기본");
        assert!(parse_theme("bad", "not json").is_none());
    }

    #[test]
    fn bundled_default_themes_are_valid_json_with_styles() {
        for (name, content) in DEFAULT_THEMES {
            let v: serde_json::Value =
                serde_json::from_str(content).unwrap_or_else(|e| panic!("{}: {}", name, e));
            assert!(v.get("styles").is_some(), "{}에 styles 없음", name);
            assert!(v.get("name").is_some(), "{}에 name 없음", name);
            // body 스타일은 모든 테마의 필수 기본값이다(미지정 INSERT 문단에 적용).
            assert!(v["styles"].get("body").is_some(), "{}에 body 없음", name);
        }
    }
}

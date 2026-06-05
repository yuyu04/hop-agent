//! API 키 보안 저장(스펙 6장).
//!
//! OS 보안 저장소(macOS Keychain / Windows Credential Manager / Linux Secret
//! Service)에 provider별 키를 보관한다. **키를 평문 파일에 저장하거나 로그·에러·
//! 프론트엔드로 반환하지 않는다.** 프론트는 존재 여부(`ai_has_api_key`)만 조회할
//! 수 있고, 저장된 키 자체를 읽어가는 커맨드는 제공하지 않는다.

use keyring::Entry;

const SERVICE: &str = "hop-ai";

fn entry(provider_id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, provider_id).map_err(|e| format!("보안 저장소 항목 생성 실패: {}", e))
}

pub fn set_api_key(provider_id: &str, api_key: &str) -> Result<(), String> {
    entry(provider_id)?
        .set_password(api_key)
        .map_err(|e| format!("API 키 저장 실패: {}", e))
}

/// 저장된 키를 읽는다(네이티브 내부 전용). 없으면 `Ok(None)`.
pub fn get_api_key(provider_id: &str) -> Result<Option<String>, String> {
    match entry(provider_id)?.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("API 키 조회 실패: {}", e)),
    }
}

pub fn delete_api_key(provider_id: &str) -> Result<(), String> {
    match entry(provider_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("API 키 삭제 실패: {}", e)),
    }
}

pub fn has_api_key(provider_id: &str) -> Result<bool, String> {
    Ok(get_api_key(provider_id)?.is_some())
}

#[tauri::command]
pub fn ai_set_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API 키가 비어 있습니다".to_string());
    }
    set_api_key(&provider_id, &api_key)
}

#[tauri::command]
pub fn ai_delete_api_key(provider_id: String) -> Result<(), String> {
    delete_api_key(&provider_id)
}

#[tauri::command]
pub fn ai_has_api_key(provider_id: String) -> Result<bool, String> {
    has_api_key(&provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // keyring 목 크리덴셜은 Entry 인스턴스마다 별도 저장소라, 모듈 함수(매 호출
    // Entry 새로 생성)를 통한 set→get 라운드트립은 실제 OS 저장소가 필요하다(E2E).
    // 여기서는 OS 저장소를 건드리지 않는 입력 검증만 확인한다.
    #[test]
    fn set_api_key_command_rejects_empty_key() {
        assert!(ai_set_api_key("openai".to_string(), "   ".to_string()).is_err());
        assert!(ai_set_api_key("openai".to_string(), "".to_string()).is_err());
    }
}

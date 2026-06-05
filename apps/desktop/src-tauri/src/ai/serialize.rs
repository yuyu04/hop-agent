//! 문서 직렬화 및 인덱싱 매핑(스펙 2장).
//!
//! rhwp `DocumentCore`를 순회하여 계층적 Path-based ID(`sec[s].p[p]`)를 부여한
//! LLM 피딩용 컨텍스트를 만든다. 동시에 부여한 모든 ID를 세션 화이트리스트로
//! 모아, LLM 응답의 `target_id` 환각을 검증할 수 있게 한다(스펙 7장).
//!
//! 표 내부 셀 텍스트의 행렬 직렬화는 후속 작업으로 남긴다. PR1은 문단 단위
//! 직렬화로 직렬화→화이트리스트→검증 경로 전체를 확립한다.

use rhwp::DocumentCore;
use serde::Serialize;
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocumentMetadata {
    pub total_sections: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_cursor_path: Option<String>,
}

/// 직렬화된 콘텐츠 노드. `type` 태그로 종류를 구분한다(스펙 2장 JSON 포맷).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentNode {
    Paragraph { id: String, text: String },
}

impl ContentNode {
    /// PR3 적용 단계에서 target_id 매핑에 사용한다.
    #[allow(dead_code)]
    pub fn id(&self) -> &str {
        match self {
            ContentNode::Paragraph { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocumentContext {
    pub document_metadata: DocumentMetadata,
    pub content: Vec<ContentNode>,
}

/// `DocumentCore`를 순회해 `DocumentContext`와 ID 화이트리스트를 함께 만든다.
pub fn build_document_context(
    core: &DocumentCore,
) -> Result<(DocumentContext, HashSet<String>), String> {
    let total_sections = section_count(core)?;
    let mut content = Vec::new();
    let mut whitelist = HashSet::new();

    for section_idx in 0..total_sections as usize {
        let paragraph_count = core
            .get_paragraph_count_native(section_idx)
            .map_err(|e| format!("문단 수 조회 실패(sec {}): {}", section_idx, e))?;

        for para_idx in 0..paragraph_count {
            let length = core
                .get_paragraph_length_native(section_idx, para_idx)
                .map_err(|e| {
                    format!("문단 길이 조회 실패(sec {}, p {}): {}", section_idx, para_idx, e)
                })?;
            let text = core
                .get_text_range_native(section_idx, para_idx, 0, length)
                .map_err(|e| {
                    format!("문단 텍스트 조회 실패(sec {}, p {}): {}", section_idx, para_idx, e)
                })?;

            let id = format!("sec[{}].p[{}]", section_idx, para_idx);
            whitelist.insert(id.clone());
            content.push(ContentNode::Paragraph { id, text });
        }
    }

    let context = DocumentContext {
        document_metadata: DocumentMetadata {
            total_sections,
            current_cursor_path: None,
        },
        content,
    };
    Ok((context, whitelist))
}

/// `get_document_info()` JSON에서 `sectionCount`를 읽는다.
fn section_count(core: &DocumentCore) -> Result<u32, String> {
    let info: serde_json::Value = serde_json::from_str(&core.get_document_info())
        .map_err(|e| format!("문서 정보 파싱 실패: {}", e))?;
    info.get("sectionCount")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or_else(|| "문서 정보에 sectionCount가 없습니다".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank_core() -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core
    }

    #[test]
    fn serializes_blank_document_with_path_ids() {
        let core = blank_core();
        let (context, whitelist) = build_document_context(&core).unwrap();

        assert!(context.document_metadata.total_sections >= 1);
        // 빈 문서도 최소 한 문단을 가지며 ID가 부여되어야 한다.
        assert!(!context.content.is_empty());
        let first_id = context.content[0].id();
        assert_eq!(first_id, "sec[0].p[0]");
        assert!(whitelist.contains("sec[0].p[0]"));
        assert_eq!(whitelist.len(), context.content.len());
    }

    #[test]
    fn serializes_inserted_text() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "추진 배경").unwrap();

        let (context, whitelist) = build_document_context(&core).unwrap();
        let ContentNode::Paragraph { id, text } = &context.content[0];
        assert_eq!(id, "sec[0].p[0]");
        assert_eq!(text, "추진 배경");
        assert!(whitelist.contains("sec[0].p[0]"));
    }

    #[test]
    fn whitelist_matches_every_serialized_id() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "첫 문단").unwrap();
        core.split_paragraph_native(0, 0, core.get_paragraph_length_native(0, 0).unwrap())
            .unwrap();

        let (context, whitelist) = build_document_context(&core).unwrap();
        for node in &context.content {
            assert!(
                whitelist.contains(node.id()),
                "화이트리스트에 {} 누락",
                node.id()
            );
        }
        assert_eq!(whitelist.len(), context.content.len());
    }
}

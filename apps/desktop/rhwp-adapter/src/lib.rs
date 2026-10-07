//! Stable HOP-facing boundary around the upstream `rhwp` crate.
//!
//! Keep direct `rhwp` imports and feature forwarding in this crate. Product crates
//! depend on this adapter so an upstream package/module move has one repair point.

#[cfg(feature = "native-skia")]
pub use rhwp::document_core::queries::rendering::PngExportOptions;
pub use rhwp::parser::extract_thumbnail_only;
pub use rhwp::DocumentCore;
use std::path::PathBuf;

/// Split a paragraph for a normal HOP editing action.
///
/// Upstream also accepts paragraph metadata for merge-undo restoration. That
/// internal recovery protocol does not belong in the desktop command payload.
pub fn split_paragraph_for_editing(
    core: &mut DocumentCore,
    section_index: usize,
    paragraph_index: usize,
    char_offset: usize,
) -> Result<String, String> {
    core.split_paragraph_native(section_index, paragraph_index, char_offset, None)
        .map_err(|error| error.to_string())
}

/// Convert prepared SVG pages to a searchable PDF using rhwp's PDF protocol.
///
/// HOP may rewrite font families before this boundary, but PDF object assembly,
/// font embedding, and ToUnicode mapping remain upstream responsibilities.
pub fn searchable_pdf_from_svg_pages(
    svg_pages: &[String],
    font_paths: Vec<PathBuf>,
) -> Result<Vec<u8>, String> {
    let options = searchable_pdf_options(font_paths);
    rhwp::renderer::pdf::svgs_to_pdf_with_options(svg_pages, &options)
}

fn searchable_pdf_options(font_paths: Vec<PathBuf>) -> rhwp::renderer::pdf::PdfExportOptions {
    rhwp::renderer::pdf::PdfExportOptions {
        fallback_serif: "Noto Sans KR".to_string(),
        fallback_sans: "Noto Sans KR".to_string(),
        fallback_mono: "Noto Sans KR".to_string(),
        font_paths,
        embed_text: true,
        ..Default::default()
    }
}

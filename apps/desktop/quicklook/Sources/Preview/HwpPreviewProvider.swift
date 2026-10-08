import Foundation
import OSLog
import QuickLookUI
import UniformTypeIdentifiers

final class HwpPreviewProvider: QLPreviewProvider, QLPreviewingController {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "net.yuyu04.hop-ai.quicklook.preview",
        category: "PreviewProvider"
    )

    func providePreview(for request: QLFilePreviewRequest) async throws -> QLPreviewReply {
        Self.logger.debug("Preview requested file=\(request.fileURL.lastPathComponent, privacy: .public)")
        do {
            let fileData = try hopQuickLookReadFile(request.fileURL)
            let result = fileData.withUnsafeBytes { rawBuffer -> HopQuickLookRenderResult in
                let ptr = rawBuffer.bindMemory(to: UInt8.self).baseAddress
                return hop_ql_render_preview_pdf(ptr, fileData.count)
            }

            guard result.status == HopQuickLookStatus.ok.rawValue else {
                throw hopQuickLookError(for: result.status)
            }

            let data = try hopQuickLookData(from: result.bytes)
            let size = CGSize(width: max(1, result.width), height: max(1, result.height))
            Self.logger.debug("Preview ready file=\(request.fileURL.lastPathComponent, privacy: .public) pages=\(result.page_count, privacy: .public) bytes=\(data.count, privacy: .public)")
            return QLPreviewReply(dataOfContentType: .pdf, contentSize: size) { reply in
                reply.title = request.fileURL.lastPathComponent
                return data
            }
        } catch {
            Self.logger.warning("Preview fallback file=\(request.fileURL.lastPathComponent, privacy: .public) reason=\(hopQuickLookFallbackReason(for: error), privacy: .public)")
            let message = hopQuickLookFallbackMessage(for: error)
            return QLPreviewReply(
                dataOfContentType: .plainText,
                contentSize: CGSize(width: 560, height: 140)
            ) { reply in
                reply.title = request.fileURL.lastPathComponent
                return Data(message.utf8)
            }
        }
    }
}

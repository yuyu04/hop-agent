import CoreGraphics
import Foundation
import ImageIO
import OSLog
import QuickLookThumbnailing
import UniformTypeIdentifiers

final class HwpThumbnailProvider: QLThumbnailProvider {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "net.yuyu04.hop-ai.quicklook.thumbnail",
        category: "ThumbnailProvider"
    )

    override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        Self.logger.debug("Thumbnail requested file=\(request.fileURL.lastPathComponent, privacy: .public)")
        do {
            let fileData = try hopQuickLookReadFile(request.fileURL)
            let requestedMaxDimension = max(request.maximumSize.width, request.maximumSize.height) * request.scale
            let maxPixelDimension = UInt32(max(1, min(requestedMaxDimension, CGFloat(hopQuickLookMaxThumbnailDimension))))

            if let embedded = try? Self.embeddedThumbnail(from: fileData, maximumPixelDimension: maxPixelDimension) {
                handler(Self.reply(for: request, image: embedded.image, imageSize: embedded.size), nil)
                return
            }

            let rendered = try Self.renderedThumbnail(
                from: fileData,
                maximumPixelDimension: maxPixelDimension
            )
            handler(Self.reply(for: request, image: rendered.image, imageSize: rendered.size), nil)
        } catch {
            Self.logger.warning("Thumbnail fallback file=\(request.fileURL.lastPathComponent, privacy: .public) reason=\(hopQuickLookFallbackReason(for: error), privacy: .public)")
            handler(Self.fallbackReply(for: request), nil)
        }
    }

    private static func embeddedThumbnail(
        from data: Data,
        maximumPixelDimension: UInt32
    ) throws -> (image: CGImage, size: CGSize) {
        let result = data.withUnsafeBytes { rawBuffer -> HopQuickLookThumbnailResult in
            let ptr = rawBuffer.bindMemory(to: UInt8.self).baseAddress
            return hop_ql_extract_embedded_thumbnail(ptr, data.count)
        }
        guard result.status == HopQuickLookStatus.ok.rawValue else {
            throw hopQuickLookError(for: result.status)
        }
        let imageData = try hopQuickLookData(from: result.bytes)
        guard let image = decodeImage(imageData, maximumPixelDimension: maximumPixelDimension) else {
            throw HopQuickLookError.renderFailed
        }
        return (
            image,
            CGSize(
                width: max(1, Int(result.width) == 0 ? image.width : Int(result.width)),
                height: max(1, Int(result.height) == 0 ? image.height : Int(result.height))
            )
        )
    }

    private static func renderedThumbnail(
        from data: Data,
        maximumPixelDimension: UInt32
    ) throws -> (image: CGImage, size: CGSize) {
        let result = data.withUnsafeBytes { rawBuffer -> HopQuickLookRenderResult in
            let ptr = rawBuffer.bindMemory(to: UInt8.self).baseAddress
            return hop_ql_render_first_page_png(ptr, data.count, maximumPixelDimension)
        }
        guard result.status == HopQuickLookStatus.ok.rawValue else {
            throw hopQuickLookError(for: result.status)
        }
        let pngData = try hopQuickLookData(from: result.bytes)
        guard let image = decodeImage(pngData, maximumPixelDimension: maximumPixelDimension) else {
            throw HopQuickLookError.renderFailed
        }
        return (
            image,
            CGSize(width: max(1, result.width), height: max(1, result.height))
        )
    }

    private static func decodeImage(_ data: Data, maximumPixelDimension: UInt32) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return nil
        }
        let options: CFDictionary = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(maximumPixelDimension)
        ] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
            ?? CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private static func reply(
        for request: QLFileThumbnailRequest,
        image: CGImage,
        imageSize: CGSize
    ) -> QLThumbnailReply {
        let contextSize = aspectFit(imageSize, within: request.maximumSize)
        let reply = QLThumbnailReply(contextSize: contextSize) { context in
            draw(image: image, in: context, fallbackSize: contextSize)
            return true
        }
        reply.extensionBadge = request.fileURL.pathExtension.uppercased()
        return reply
    }

    private static func fallbackReply(for request: QLFileThumbnailRequest) -> QLThumbnailReply {
        let contextSize = safeContextSize(request.maximumSize)
        let reply = QLThumbnailReply(contextSize: contextSize) { context in
            let rect = drawingBounds(in: context, fallbackSize: contextSize)
            context.saveGState()
            context.setFillColor(red: 0.94, green: 0.94, blue: 0.94, alpha: 1)
            context.fill(rect)
            context.setStrokeColor(red: 0.55, green: 0.55, blue: 0.55, alpha: 1)
            context.setLineWidth(max(1, min(rect.width, rect.height) * 0.04))
            context.stroke(rect.insetBy(dx: 2, dy: 2))
            context.restoreGState()
            return true
        }
        reply.extensionBadge = request.fileURL.pathExtension.uppercased()
        return reply
    }

    private static func aspectFit(_ source: CGSize, within maximumSize: CGSize) -> CGSize {
        guard source.width > 0, source.height > 0, maximumSize.width > 0, maximumSize.height > 0 else {
            return CGSize(width: 128, height: 128)
        }
        let scale = min(maximumSize.width / source.width, maximumSize.height / source.height)
        return CGSize(width: max(1, source.width * scale), height: max(1, source.height * scale))
    }

    private static func safeContextSize(_ size: CGSize) -> CGSize {
        guard size.width > 0, size.height > 0 else {
            return CGSize(width: 128, height: 128)
        }
        return size
    }

    private static func draw(image: CGImage, in context: CGContext, fallbackSize: CGSize) {
        let rect = drawingBounds(in: context, fallbackSize: fallbackSize)
        context.saveGState()
        context.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        context.fill(rect)
        context.draw(image, in: rect)
        context.restoreGState()
    }

    private static func drawingBounds(in context: CGContext, fallbackSize: CGSize) -> CGRect {
        let clipBounds = context.boundingBoxOfClipPath
        guard !clipBounds.isNull, !clipBounds.isInfinite, clipBounds.width > 0, clipBounds.height > 0 else {
            return CGRect(origin: .zero, size: fallbackSize)
        }
        return clipBounds
    }
}

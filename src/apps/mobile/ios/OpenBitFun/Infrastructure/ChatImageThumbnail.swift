import Foundation
import ImageIO

/// Decode chat previews at bounded resolution, including photos from older peers.
enum ChatImageThumbnail {
    static let maximumPixelSize = 1024
    static let fullScreenMaximumPixelSize = 2560

    static func decode(_ data: Data, maximumPixelSize: Int = maximumPixelSize) -> CGImage? {
        guard maximumPixelSize > 0 else { return nil }
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }
}

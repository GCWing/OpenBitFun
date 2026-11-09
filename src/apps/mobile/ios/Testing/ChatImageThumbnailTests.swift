import Foundation
import CoreGraphics
import ImageIO

@main
struct ChatImageThumbnailTests {
    static func main() {
        let large = encodedImage(width: 4000, height: 3000)
        let decoded = ChatImageThumbnail.decode(large)!
        precondition(decoded.width == 1024 && decoded.height == 768)
        precondition(decoded.bytesPerRow * decoded.height <= 1024 * 1024 * 4,
                     "Decoded preview memory must be bounded, independent of original pixels")
        let fullScreen = ChatImageThumbnail.decode(large, maximumPixelSize: ChatImageThumbnail.fullScreenMaximumPixelSize)!
        precondition(fullScreen.width == 2560 && fullScreen.height == 1920,
                     "Opening a photo keeps more detail than its chat thumbnail")

        let rotated = ChatImageThumbnail.decode(encodedImage(width: 4000, height: 3000, orientation: 6))!
        precondition(rotated.width == 768 && rotated.height == 1024,
                     "Camera orientation must be applied while creating the thumbnail")
        let small = ChatImageThumbnail.decode(encodedImage(width: 32, height: 24))!
        precondition(small.width == 32 && small.height == 24)
        precondition(ChatImageThumbnail.decode(Data()) == nil)
        precondition(ChatImageThumbnail.decode(Data("not an image".utf8)) == nil)
        print("Chat image thumbnail tests passed")
    }

    static func encodedImage(width: Int, height: Int, orientation: Int = 1) -> Data {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.6, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!,
                                  [kCGImagePropertyOrientation: orientation] as CFDictionary)
        precondition(CGImageDestinationFinalize(destination))
        return data as Data
    }
}

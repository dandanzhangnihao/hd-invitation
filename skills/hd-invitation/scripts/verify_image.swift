// macOS 本地 OCR / 二维码核验，不上传素材、不访问二维码链接。
import Foundation
import Vision
import CryptoKit

func barcodeHashes(_ file: String) throws -> [String] {
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    try VNImageRequestHandler(url: URL(fileURLWithPath: file)).perform([request])
    return (request.results ?? []).compactMap { observation in
        guard let payload = observation.payloadStringValue else { return nil }
        return SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined()
    }.sorted()
}

func emit(_ result: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let mode = args.first else { throw NSError(domain: "用法: swift verify_image.swift ocr 图片 | qr-match 源二维码 最终整图", code: 1) }
    if mode == "ocr", args.count == 2 {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(url: URL(fileURLWithPath: args[1])).perform([request])
        let rows = (request.results ?? []).compactMap { observation -> [String: Any]? in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return ["text": candidate.string, "confidence": candidate.confidence,
                    "left": box.minX, "top": 1-box.maxY, "width": box.width, "height": box.height]
        }
        try emit(["rows": rows, "note": "归一化左上角坐标；仍须逐行视觉核验，OCR不代表字形正确"])
    } else if mode == "qr-match", args.count == 3 {
        let source = try barcodeHashes(args[1]), final = try barcodeHashes(args[2])
        let pass = !source.isEmpty && source == final
        try emit(["sourceCount": source.count, "finalCount": final.count, "sameDecodedContent": pass,
                  "payloadHashes": final])
        if !pass { exit(2) }
    } else {
        throw NSError(domain: "无效参数: ocr 需要一个图片路径；qr-match 需要源图和最终整图", code: 1)
    }
} catch {
    FileHandle.standardError.write(Data(("核验失败: \(error)\n").utf8))
    exit(1)
}

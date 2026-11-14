import AVFoundation
import Speech
import SwiftUI

final class SpeechInputController: ObservableObject {
    @Published private(set) var isListening = false

    private var generation: UInt64 = 0
    private var recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var tapInstalled = false

    func start(
        localeIdentifier: String,
        onPartial: @escaping (String) -> Void,
        onFailure: @escaping (String) -> Void
    ) {
        stop()
        let attempt = generation
        recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier))
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            DispatchQueue.main.async {
                guard let self, self.generation == attempt else { return }
                guard speechStatus == .authorized else {
                    onFailure("请在系统设置中允许语音识别")
                    return
                }
                AVAudioSession.sharedInstance().requestRecordPermission { [weak self] granted in
                    DispatchQueue.main.async {
                        guard let self, self.generation == attempt else { return }
                        guard granted else { onFailure("请在系统设置中允许麦克风访问"); return }
                        self.beginRecognition(onPartial: onPartial, onFailure: onFailure)
                    }
                }
            }
        }
    }

    func stop() {
        generation &+= 1
        recognitionTask?.finish()
        finishRecognition()
    }

    private func beginRecognition(
        onPartial: @escaping (String) -> Void,
        onFailure: @escaping (String) -> Void
    ) {
        guard let recognizer, recognizer.isAvailable else {
            onFailure("当前设备暂时无法使用语音识别")
            return
        }

        finishRecognition()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            self.request = request

            let input = audioEngine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                request.append(buffer)
            }
            tapInstalled = true
            audioEngine.prepare()
            try audioEngine.start()
            isListening = true

            let attempt = generation
            recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self, self.generation == attempt else { return }
                    if let text = result?.bestTranscription.formattedString, !text.isEmpty {
                        onPartial(text)
                    }
                    if result?.isFinal == true || error != nil {
                        if error != nil && result == nil { onFailure("语音识别已中断，请重试") }
                        self.finishRecognition()
                    }
                }
            }
        } catch {
            finishRecognition()
            onFailure("无法启动语音输入，请检查麦克风")
        }
    }

    private func finishRecognition() {
        let hadAudioCapture = request != nil || tapInstalled || audioEngine.isRunning
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()
        request = nil
        recognitionTask?.cancel()
        recognitionTask = nil
        isListening = false
        // Editing an idle draft may invalidate authorization callbacks too, but
        // must not deactivate audio owned by another feature.
        if hadAudioCapture {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

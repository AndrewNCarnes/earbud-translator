import AVFoundation

/// Speaks translations through the app's audio session (the AirPods when connected).
@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var continuation: CheckedContinuation<Void, Never>?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  /// Returns once the utterance finishes or is cancelled.
  func speak(_ text: String, language: LanguageCode) async {
    finish()
    await withCheckedContinuation { continuation in
      self.continuation = continuation
      let utterance = AVSpeechUtterance(string: text)
      utterance.voice = AVSpeechSynthesisVoice(language: SpeechModels.identifiers[language])
      synthesizer.speak(utterance)
    }
  }

  func stop() {
    synthesizer.stopSpeaking(at: .immediate)
    finish()
  }

  private func finish() {
    continuation?.resume()
    continuation = nil
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.finish() }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in self.finish() }
  }
}

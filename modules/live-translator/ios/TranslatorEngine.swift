import AVFoundation
import CoreMedia
import Speech

/// Runs the pipeline: mic → two recognizers (en, es) → language pick → translate → speak.
@MainActor
final class TranslatorEngine {
  typealias Emit = (_ event: String, _ body: [String: Any]) -> Void

  /// Keeps the tail of spoken output from being picked up by the mic.
  private static let echoTail: Duration = .milliseconds(300)

  private let emit: Emit
  private let router = AudioRouter()
  private let translator = Translator()
  private let speaker = Speaker()
  private let audioEngine = AVAudioEngine()

  private var running = false
  private var lanes: [RecognitionLane] = []
  private var tasks: [Task<Void, Never>] = []
  private var tap: AudioTap?
  private var resolver: UtteranceResolver?
  private var utterances: AsyncStream<Utterance>.Continuation?
  private var volatile: [LanguageCode: Segment] = [:]
  private var observers: [NSObjectProtocol] = []

  init(emit: @escaping Emit) {
    self.emit = emit
  }

  func start(_ options: StartOptions) async throws {
    guard !running else {
      return
    }
    running = true
    setState("preparing")

    do {
      guard await SpeechModels.isInstalled(), await Translator.isInstalled() else {
        throw LanguagesNotInstalledException()
      }
      try router.configure(inputMode: options.inputMode)
      try await translator.prepare()

      lanes = [try await RecognitionLane(language: .en), try await RecognitionLane(language: .es)]

      let (utteranceStream, utterances) = AsyncStream<Utterance>.makeStream()
      let resolver = UtteranceResolver { utterances.yield($0) }
      self.utterances = utterances
      self.resolver = resolver

      for lane in lanes {
        tasks.append(Task { await self.consume(lane, resolver: resolver) })
      }
      tasks.append(Task { await self.process(utteranceStream, speak: options.speak) })

      let input = audioEngine.inputNode
      let micFormat = input.outputFormat(forBus: 0)
      guard micFormat.sampleRate > 0, micFormat.channelCount > 0 else {
        throw NoAudioInputException()
      }
      let tap = AudioTap(lanes: lanes)
      self.tap = tap
      input.installTap(onBus: 0, bufferSize: 4096, format: micFormat, block: tap.makeBlock())

      observeInterruptions()
      audioEngine.prepare()
      try audioEngine.start()
      setState("listening")
    } catch {
      await stop()
      throw error
    }
  }

  func stop() async {
    guard running else {
      return
    }
    running = false

    observers.forEach(NotificationCenter.default.removeObserver)
    observers = []
    if audioEngine.isRunning {
      audioEngine.stop()
    }
    audioEngine.inputNode.removeTap(onBus: 0)
    speaker.stop()

    await resolver?.cancel()
    utterances?.finish()
    for lane in lanes {
      await lane.finish()
    }
    tasks.forEach { $0.cancel() }

    tasks = []
    lanes = []
    tap = nil
    resolver = nil
    utterances = nil
    volatile = [:]
    await translator.reset()
    router.deactivate()
    setState("idle")
  }

  private func consume(_ lane: RecognitionLane, resolver: UtteranceResolver) async {
    do {
      for try await result in lane.transcriber.results {
        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
          continue
        }
        let segment = Segment(
          language: lane.language,
          text: text,
          confidence: result.text.averageConfidence,
          start: result.range.start.seconds,
          end: result.range.end.seconds
        )
        if result.isFinal {
          volatile[lane.language] = nil
          await resolver.add(segment)
        } else {
          showVolatile(segment)
        }
      }
    } catch {
      if running {
        emitError("recognition_failed", error.localizedDescription)
      }
    }
  }

  private func process(_ stream: AsyncStream<Utterance>, speak: Bool) async {
    for await utterance in stream {
      guard running else {
        break
      }
      emit("onTranscript", [
        "id": utterance.id,
        "text": utterance.text,
        "language": utterance.language.rawValue,
        "isFinal": true,
      ])
      setState("translating")

      do {
        let translated = try await translator.translate(utterance.text, from: utterance.language)
        emit("onTranslation", [
          "id": utterance.id,
          "sourceText": utterance.text,
          "sourceLanguage": utterance.language.rawValue,
          "translatedText": translated,
          "targetLanguage": utterance.language.other.rawValue,
        ])
        if speak && running {
          setState("speaking")
          tap?.setMuted(true)
          await speaker.speak(translated, language: utterance.language.other)
          try? await Task.sleep(for: Self.echoTail)
          tap?.setMuted(false)
        }
      } catch {
        emitError("translation_failed", error.localizedDescription)
      }

      if running {
        setState("listening")
      }
    }
  }

  /// Shows live text from whichever recognizer currently sounds most sure of itself.
  private func showVolatile(_ segment: Segment) {
    volatile[segment.language] = segment
    guard let best = volatile.values.max(by: { $0.confidence < $1.confidence }),
          best.language == segment.language else {
      return
    }
    emit("onTranscript", [
      "id": "live",
      "text": best.text,
      "language": best.language.rawValue,
      "isFinal": false,
    ])
  }

  private func observeInterruptions() {
    let center = NotificationCenter.default
    let halt: (String, String) -> (Notification) -> Void = { code, message in
      { [weak self] _ in
        Task { @MainActor in
          guard let self, self.running else {
            return
          }
          self.emitError(code, message)
          await self.stop()
        }
      }
    }
    observers = [
      center.addObserver(
        forName: .AVAudioEngineConfigurationChange,
        object: audioEngine,
        queue: .main,
        using: halt("audio_route_changed", "Your audio device changed. Tap Start to resume.")
      ),
      center.addObserver(
        forName: AVAudioSession.interruptionNotification,
        object: nil,
        queue: .main,
        using: halt("audio_interrupted", "Audio was interrupted (for example by a call). Tap Start to resume.")
      ),
    ]
  }

  private func setState(_ state: String) {
    emit("onStateChange", ["state": state])
  }

  private func emitError(_ code: String, _ message: String) {
    emit("onError", ["code": code, "message": message])
  }
}

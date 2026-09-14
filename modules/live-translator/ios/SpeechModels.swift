import AVFoundation
import Speech

enum SpeechModels {
  static let identifiers: [LanguageCode: String] = [.en: "en-US", .es: "es-ES"]

  static func locale(for language: LanguageCode) async -> Locale? {
    await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifiers[language]!))
  }

  static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
    SpeechTranscriber(
      locale: locale,
      transcriptionOptions: [],
      reportingOptions: [.volatileResults],
      attributeOptions: [.transcriptionConfidence]
    )
  }

  static func isInstalled() async -> Bool {
    let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }
    for language in LanguageCode.allCases {
      guard let locale = await locale(for: language),
            installed.contains(locale.identifier(.bcp47)) else {
        return false
      }
    }
    return true
  }

  static func install() async throws {
    for language in LanguageCode.allCases {
      guard let locale = await locale(for: language) else {
        throw SpeechLocaleUnsupportedException(identifiers[language]!)
      }
      let transcriber = makeTranscriber(locale: locale)
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
    }
  }
}

/// One on-device recognizer for one language. Both lanes hear the same audio;
/// `LanguagePicker` decides which one understood it.
final class RecognitionLane {
  let language: LanguageCode
  let transcriber: SpeechTranscriber
  let format: AVAudioFormat
  let input: AsyncStream<AnalyzerInput>.Continuation
  private let analyzer: SpeechAnalyzer

  init(language: LanguageCode) async throws {
    guard let locale = await SpeechModels.locale(for: language) else {
      throw SpeechLocaleUnsupportedException(SpeechModels.identifiers[language]!)
    }
    let transcriber = SpeechModels.makeTranscriber(locale: locale)
    guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
      throw AudioFormatUnavailableException()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    try await analyzer.start(inputSequence: stream)

    self.language = language
    self.transcriber = transcriber
    self.format = format
    self.input = input
    self.analyzer = analyzer
  }

  func finish() async {
    input.finish()
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
  }
}

extension AttributedString {
  /// Character-weighted recognizer confidence, 0...1. A recognizer hearing the
  /// wrong language produces low-confidence words.
  var averageConfidence: Double {
    var total = 0.0
    var weight = 0
    for run in runs {
      guard let confidence = run.transcriptionConfidence else {
        continue
      }
      let length = self[run.range].characters.count
      total += confidence * Double(length)
      weight += length
    }
    return weight > 0 ? total / Double(weight) : 0.5
  }
}

import Foundation
import NaturalLanguage

enum LanguagePicker {
  /// Below this score the audio was probably noise, not speech in either language.
  static let minimumScore = 0.35

  /// Picks the language whose recognizer best understood a cluster of overlapping segments.
  static func pick(_ cluster: [Segment]) -> Utterance? {
    var best: (language: LanguageCode, text: String, score: Double)?

    for language in LanguageCode.allCases {
      let segments = cluster.filter { $0.language == language }.sorted { $0.start < $1.start }
      let text = segments.map(\.text).joined(separator: " ")
      guard !text.isEmpty else {
        continue
      }
      let characters = segments.reduce(0) { $0 + $1.text.count }
      let confidence = segments.reduce(0.0) { $0 + $1.confidence * Double($1.text.count) } / Double(max(characters, 1))
      // Confidence is the main signal. Each recognizer forces text into its own
      // language, so the text classifier mostly breaks ties.
      let score = 0.75 * confidence + 0.25 * probability(of: language, in: text)

      if best == nil || score > best!.score {
        best = (language, text, score)
      }
    }

    guard let best, best.score >= minimumScore else {
      return nil
    }
    return Utterance(id: UUID().uuidString, language: best.language, text: best.text)
  }

  private static func probability(of language: LanguageCode, in text: String) -> Double {
    let recognizer = NLLanguageRecognizer()
    recognizer.languageConstraints = [.english, .spanish]
    recognizer.processString(text)
    return recognizer.languageHypotheses(withMaximum: 2)[language == .en ? .english : .spanish] ?? 0
  }
}

/// Collects final segments from both recognizers and, once speech pauses,
/// groups the ones covering the same audio and decides their language.
actor UtteranceResolver {
  private static let quietPeriod: Duration = .milliseconds(700)
  private static let joinGap = 0.25

  private let onUtterance: @Sendable (Utterance) -> Void
  private var pending: [Segment] = []
  private var flushTask: Task<Void, Never>?

  init(onUtterance: @escaping @Sendable (Utterance) -> Void) {
    self.onUtterance = onUtterance
  }

  func add(_ segment: Segment) {
    pending.append(segment)
    flushTask?.cancel()
    flushTask = Task {
      try? await Task.sleep(for: Self.quietPeriod)
      guard !Task.isCancelled else {
        return
      }
      self.flush()
    }
  }

  func cancel() {
    flushTask?.cancel()
    pending = []
  }

  private func flush() {
    let segments = pending.sorted { $0.start < $1.start }
    pending = []

    var clusters: [[Segment]] = []
    for segment in segments {
      if let last = clusters.last, let end = last.map(\.end).max(), segment.start < end + Self.joinGap {
        clusters[clusters.count - 1].append(segment)
      } else {
        clusters.append([segment])
      }
    }
    for cluster in clusters {
      if let utterance = LanguagePicker.pick(cluster) {
        onUtterance(utterance)
      }
    }
  }
}

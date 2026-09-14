import SwiftUI
import Translation

/// On-device translation between English and Spanish.
/// Sessions created without a view only work once the language packs are installed;
/// `TranslationDownloadView` is what shows Apple's download sheet.
actor Translator {
  static let english = Locale.Language(identifier: "en")
  static let spanish = Locale.Language(identifier: "es")

  private var sessions: [LanguageCode: TranslationSession] = [:]

  static func language(_ code: LanguageCode) -> Locale.Language {
    code == .en ? english : spanish
  }

  static func isInstalled() async -> Bool {
    let availability = LanguageAvailability()
    let spanishToEnglish = await availability.status(from: spanish, to: english)
    let englishToSpanish = await availability.status(from: english, to: spanish)
    return spanishToEnglish == .installed && englishToSpanish == .installed
  }

  func prepare() async throws {
    for source in LanguageCode.allCases where sessions[source] == nil {
      let session = try TranslationSession(installedSource: Self.language(source), target: Self.language(source.other))
      try await session.prepareTranslation()
      sessions[source] = session
    }
  }

  func translate(_ text: String, from source: LanguageCode) async throws -> String {
    try await prepare()
    return try await sessions[source]!.translate(text).targetText
  }

  func reset() {
    sessions = [:]
  }
}

/// Invisible view that asks the system to download both translation directions.
struct TranslationDownloadView: View {
  let onFinish: () -> Void

  @State private var configuration: TranslationSession.Configuration? = .init(
    source: Translator.spanish,
    target: Translator.english
  )
  @State private var didFirstDirection = false

  var body: some View {
    Color.clear
      .ignoresSafeArea()
      .translationTask(configuration) { session in
        do {
          try await session.prepareTranslation()
        } catch {
          onFinish()
          return
        }
        if didFirstDirection {
          onFinish()
        } else {
          didFirstDirection = true
          configuration = .init(source: Translator.english, target: Translator.spanish)
        }
      }
  }
}

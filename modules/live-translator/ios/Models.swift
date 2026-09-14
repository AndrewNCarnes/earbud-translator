import ExpoModulesCore

enum LanguageCode: String, CaseIterable, Sendable {
  case en
  case es

  var other: LanguageCode { self == .en ? .es : .en }
}

enum InputMode: String, Enumerable {
  case phone
  case airpods
}

struct StartOptions: Record {
  @Field
  var inputMode: InputMode = .phone

  @Field
  var speak: Bool = true
}

/// A final transcription from one language's recognizer, positioned in audio time.
struct Segment: Sendable {
  let language: LanguageCode
  let text: String
  let confidence: Double
  let start: Double
  let end: Double
}

/// A chunk of speech whose language has been decided.
struct Utterance: Sendable {
  let id: String
  let language: LanguageCode
  let text: String
}

final class LanguagesNotInstalledException: Exception {
  override var reason: String {
    "Language packs are missing. Tap \"Download languages\" first."
  }
}

final class AirPodsMicUnavailableException: Exception {
  override var reason: String {
    "The AirPods microphone isn't available. Connect your AirPods or switch to the iPhone mic."
  }
}

final class NoAudioInputException: Exception {
  override var reason: String {
    "No microphone input is available."
  }
}

final class SpeechLocaleUnsupportedException: GenericException<String> {
  override var reason: String {
    "On-device speech recognition doesn't support '\(param)' on this iPhone."
  }
}

final class AudioFormatUnavailableException: Exception {
  override var reason: String {
    "Couldn't find an audio format the speech recognizer accepts."
  }
}

final class AudioConversionException: Exception {
  override var reason: String {
    "Couldn't convert microphone audio for the speech recognizer."
  }
}

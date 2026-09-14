import AVFoundation
import ExpoModulesCore
import Speech
import SwiftUI

public class LiveTranslatorModule: Module {
  @MainActor
  private lazy var engine = TranslatorEngine { [weak self] event, body in
    self?.sendEvent(event, body)
  }

  public func definition() -> ModuleDefinition {
    Name("LiveTranslator")

    Events("onTranscript", "onTranslation", "onStateChange", "onError")

    AsyncFunction("requestPermissions") { () async -> Bool in
      let microphone = await AVAudioApplication.requestRecordPermission()
      let speech = await withCheckedContinuation { continuation in
        SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
      }
      return microphone && speech
    }

    AsyncFunction("getLanguageStatus") { () async -> [String: Bool] in
      await Self.languageStatus()
    }

    AsyncFunction("downloadLanguages") { () async throws -> [String: Bool] in
      try await SpeechModels.install()
      if await !Translator.isInstalled() {
        await self.presentTranslationDownload()
      }
      return await Self.languageStatus()
    }

    AsyncFunction("start") { (options: StartOptions) async throws in
      try await self.engine.start(options)
    }

    AsyncFunction("stop") { () async in
      await self.engine.stop()
    }

    OnDestroy {
      Task { @MainActor in
        await self.engine.stop()
      }
    }
  }

  private static func languageStatus() async -> [String: Bool] {
    [
      "speechReady": await SpeechModels.isInstalled(),
      "translationReady": await Translator.isInstalled(),
    ]
  }

  /// Hosts an invisible SwiftUI view so Apple's translation download sheet can appear.
  @MainActor
  private func presentTranslationDownload() async {
    guard let presenter = appContext?.utils?.currentViewController() else {
      return
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      var host: UIHostingController<TranslationDownloadView>?
      host = UIHostingController(rootView: TranslationDownloadView {
        host?.dismiss(animated: false) {
          continuation.resume()
        }
        host = nil
      })
      host!.view.backgroundColor = .clear
      host!.modalPresentationStyle = .overFullScreen
      presenter.present(host!, animated: false)
    }
  }
}

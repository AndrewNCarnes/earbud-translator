import AVFoundation

/// Configures where audio comes from and goes to.
///
/// AirPods mics are tuned to pick up the wearer's voice, so `.phone` (iPhone mic in,
/// AirPods out over high-quality A2DP) is usually better for hearing other people.
/// `.airpods` uses the AirPods mic over HFP, which also drops output to call quality.
final class AudioRouter {
  func configure(inputMode: InputMode) throws {
    let session = AVAudioSession.sharedInstance()

    switch inputMode {
    case .phone:
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.allowBluetoothA2DP, .duckOthers, .defaultToSpeaker]
      )
      try session.setActive(true)
      if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
        try session.setPreferredInput(builtInMic)
      }

    case .airpods:
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.allowBluetoothHFP, .duckOthers]
      )
      try session.setActive(true)
      guard let airPodsMic = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) else {
        throw AirPodsMicUnavailableException()
      }
      try session.setPreferredInput(airPodsMic)
    }
  }

  func deactivate() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

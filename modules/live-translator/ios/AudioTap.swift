import AVFoundation
import Speech
import os

/// Converts microphone buffers into the format a speech analyzer expects.
/// The mic format (often 48 kHz, or 16/24 kHz over Bluetooth) rarely matches,
/// and a mismatch makes SpeechAnalyzer return nothing without an error.
final class BufferConverter {
  private var converter: AVAudioConverter?

  func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    if buffer.format == format {
      return buffer
    }
    if converter == nil || converter?.inputFormat != buffer.format || converter?.outputFormat != format {
      converter = AVAudioConverter(from: buffer.format, to: format)
      converter?.primeMethod = .none
    }
    guard let converter else {
      throw AudioConversionException()
    }

    let ratio = format.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
    guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
      throw AudioConversionException()
    }

    var consumed = false
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
      if consumed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .error {
      throw conversionError ?? AudioConversionException()
    }
    return output
  }
}

/// Fans microphone audio out to every recognizer. Runs on the audio thread, so it
/// holds no actor isolation and guards its only mutable flag with a lock.
final class AudioTap: @unchecked Sendable {
  private struct Target {
    let format: AVAudioFormat
    let input: AsyncStream<AnalyzerInput>.Continuation
    let converter = BufferConverter()
  }

  private let targets: [Target]
  private let muted = OSAllocatedUnfairLock(initialState: false)

  init(lanes: [RecognitionLane]) {
    targets = lanes.map { Target(format: $0.format, input: $0.input) }
  }

  /// Muted while speaking translations, so the app doesn't translate its own voice.
  func setMuted(_ value: Bool) {
    muted.withLock { $0 = value }
  }

  func makeBlock() -> AVAudioNodeTapBlock {
    return { [self] buffer, _ in
      if muted.withLock({ $0 }) {
        return
      }
      for target in targets {
        guard let converted = try? target.converter.convert(buffer, to: target.format),
              converted.frameLength > 0 else {
          continue
        }
        target.input.yield(AnalyzerInput(buffer: converted))
      }
    }
  }
}

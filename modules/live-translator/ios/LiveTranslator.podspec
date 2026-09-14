Pod::Spec.new do |s|
  s.name           = 'LiveTranslator'
  s.version        = '1.0.0'
  s.summary        = 'On-device speech translation'
  s.description    = 'Listens for English and Spanish, translates on-device, and speaks the result.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '26.0'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Speech', 'Translation', 'NaturalLanguage', 'SwiftUI'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

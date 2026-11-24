# A tiny VST3 (gain + polarity, with latency) the engine self-tests host.
juce_add_plugin(MergeTestGain
  PRODUCT_NAME "Merge Test Gain"
  COMPANY_NAME "Merge"
  PLUGIN_MANUFACTURER_CODE Mrge
  PLUGIN_CODE MtGn
  FORMATS VST3
  IS_SYNTH FALSE
  NEEDS_MIDI_INPUT FALSE
  COPY_PLUGIN_AFTER_BUILD FALSE
  VST3_CATEGORIES Fx Tools)

target_sources(MergeTestGain PRIVATE TestGain.cpp)
target_compile_definitions(MergeTestGain PUBLIC JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
target_link_libraries(MergeTestGain
  PRIVATE juce::juce_audio_utils
  PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)

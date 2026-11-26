cmake_minimum_required(VERSION 3.22)
project(MergeEngine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(MERGE_BUILD_TEST_PLUGIN "Build the MergeTestGain VST3 used by the self-tests" ON)
set(MERGE_ASIO_SDK_DIR "" CACHE PATH "Path to the Steinberg ASIO SDK (Windows only, enables ASIO)")

include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG 8.0.9
  GIT_SHALLOW TRUE)
FetchContent_MakeAvailable(JUCE)

# Windows: WebView2 (Edge) renders the console; link it statically so there's no extra DLL
if(WIN32)
  set(MERGE_WEBVIEW2_ARGS NEEDS_WEBVIEW2 TRUE)
endif()

juce_add_gui_app(MergeEngine
  ${MERGE_WEBVIEW2_ARGS}
  NEEDS_WEB_BROWSER TRUE
  PRODUCT_NAME "Merge"
  COMPANY_NAME "Merge"
  BUNDLE_ID "audio.merge.engine"
  VERSION ${PROJECT_VERSION}
  # Audio-interface inputs on macOS need the microphone permission
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Merge Engine needs access to your audio interface inputs."
  # Hosting third-party plugins (incl. iLok/PACE, Waves, NI, UA protected ones) from a signed,
  # notarized app: allow loading code signed by other vendors, and the JIT / executable-memory
  # exceptions some copy protection needs. The App Sandbox must stay off (iLok service, USB keys).
  HARDENED_RUNTIME_ENABLED TRUE
  HARDENED_RUNTIME_OPTIONS
    com.apple.security.cs.disable-library-validation
    com.apple.security.cs.allow-jit
    com.apple.security.cs.allow-unsigned-executable-memory
    com.apple.security.device.audio-input
  APP_SANDBOX_ENABLED FALSE)

target_sources(MergeEngine PRIVATE
  src/Main.cpp
  src/Engine.cpp
  src/Mixer.cpp
  src/Multitrack.cpp
  src/Plan.cpp
  src/PluginHost.cpp
  src/WebSocketServer.cpp
  src/SelfTest.cpp
  src/TruePeak.cpp
  src/ConsoleWindow.cpp)
if(APPLE)
  target_sources(MergeEngine PRIVATE src/MacSupport.mm)
endif()

target_compile_definitions(MergeEngine PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=1
  JUCE_PLUGINHOST_LV2=0
  JUCE_WEB_BROWSER=1                     # the console UI is embedded in the app window
  JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
  JUCE_USE_CURL=0
  JUCE_JACK=0
  JUCE_MODAL_LOOPS_PERMITTED=1
  JUCE_APPLICATION_NAME_STRING="$<TARGET_PROPERTY:MergeEngine,JUCE_PRODUCT_NAME>"
  JUCE_APPLICATION_VERSION_STRING="$<TARGET_PROPERTY:MergeEngine,JUCE_VERSION>"
  MERGE_ENGINE_VERSION="${PROJECT_VERSION}")

if(WIN32 AND MERGE_ASIO_SDK_DIR)
  target_include_directories(MergeEngine PRIVATE "${MERGE_ASIO_SDK_DIR}/common")
  target_compile_definitions(MergeEngine PRIVATE JUCE_ASIO=1)
endif()

target_link_libraries(MergeEngine
  PRIVATE
    juce::juce_audio_utils
    juce::juce_audio_processors
    juce::juce_audio_devices
    juce::juce_dsp
    juce::juce_gui_basics
    juce::juce_gui_extra
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

# Bundle the built console (npm run build -> ../dist) into the app:
#   macOS: Merge.app/Contents/Resources/ui    Windows/Linux: <exe dir>/ui
set(MERGE_UI_DIST "${CMAKE_CURRENT_SOURCE_DIR}/../dist")
if(APPLE)
  set(MERGE_UI_DEST "$<TARGET_BUNDLE_CONTENT_DIR:MergeEngine>/Resources/ui")
else()
  set(MERGE_UI_DEST "$<TARGET_FILE_DIR:MergeEngine>/ui")
endif()
# Runs on every build (not only when the engine relinks), so console-only changes are picked up.
set(MERGE_BUNDLE_COMMANDS
  COMMAND ${CMAKE_COMMAND} -DSRC=${MERGE_UI_DIST} -DDEST=${MERGE_UI_DEST} -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/CopyUi.cmake)
if(APPLE)
  # Adding the UI changes the bundle after the linker signed it, which macOS reports as
  # "damaged". Re-sign the whole bundle (ad-hoc) so the signature covers the UI files.
  list(APPEND MERGE_BUNDLE_COMMANDS
    COMMAND codesign --force --deep --sign - "$<TARGET_BUNDLE_DIR:MergeEngine>"
    COMMAND codesign --verify --deep --strict "$<TARGET_BUNDLE_DIR:MergeEngine>")
endif()
add_custom_target(MergeBundleUi ALL ${MERGE_BUNDLE_COMMANDS} VERBATIM)
add_dependencies(MergeBundleUi MergeEngine)

if(MERGE_BUILD_TEST_PLUGIN)
  add_subdirectory(testplugin)
endif()

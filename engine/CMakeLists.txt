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

juce_add_gui_app(MergeEngine
  PRODUCT_NAME "Merge Engine"
  COMPANY_NAME "Merge"
  BUNDLE_ID "audio.merge.engine"
  VERSION ${PROJECT_VERSION})

target_sources(MergeEngine PRIVATE
  src/Main.cpp
  src/Engine.cpp
  src/Mixer.cpp
  src/Plan.cpp
  src/PluginHost.cpp
  src/WebSocketServer.cpp
  src/SelfTest.cpp)

target_compile_definitions(MergeEngine PRIVATE
  JUCE_PLUGINHOST_VST3=1
  JUCE_PLUGINHOST_AU=1
  JUCE_PLUGINHOST_LV2=0
  JUCE_WEB_BROWSER=0
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
  PUBLIC
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

if(MERGE_BUILD_TEST_PLUGIN)
  add_subdirectory(testplugin)
endif()

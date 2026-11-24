#pragma once
#include <juce_gui_extra/juce_gui_extra.h>
#include <optional>

namespace merge
{

class Engine;

/** Where the bundled console UI lives (inside Merge.app, or next to the executable). */
juce::File findUiDirectory();

/** Serve one file of the console UI to the web view. Rejects paths outside `uiDir`. */
std::optional<juce::WebBrowserComponent::Resource> loadUiResource (const juce::File& uiDir, const juce::String& path);

juce::String mimeTypeFor (const juce::String& fileExtension);

/**
 * The Merge app window: the console UI (React, bundled in the app) running in the
 * platform web view (WebKit on macOS, WebView2 on Windows), talking to the engine in
 * this same process over the localhost control socket.
 */
class ConsoleWindow : public juce::DocumentWindow, private juce::Timer
{
public:
    /** devUrl: load the console from a dev server (e.g. http://localhost:5173) instead of the bundle. */
    ConsoleWindow (Engine& engine, const juce::String& devUrl = {});
    ~ConsoleWindow() override;

    void closeButtonPressed() override;

private:
    void timerCallback() override;
    juce::PropertiesFile& settings();

    Engine& engine;
    juce::File uiDir;
    std::unique_ptr<juce::WebBrowserComponent> browser;
    std::unique_ptr<juce::PropertiesFile> props;
};

} // namespace merge

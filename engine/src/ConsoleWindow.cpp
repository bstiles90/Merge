#include "ConsoleWindow.h"
#include "Engine.h"
#include <iostream>

namespace merge
{

juce::File findUiDirectory()
{
    if (auto env = juce::SystemStats::getEnvironmentVariable ("MERGE_UI_DIR", {}); env.isNotEmpty())
        return juce::File (env);
#if JUCE_MAC
    return juce::File::getSpecialLocation (juce::File::currentApplicationFile).getChildFile ("Contents/Resources/ui");
#else
    return juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory().getChildFile ("ui");
#endif
}

juce::String mimeTypeFor (const juce::String& ext)
{
    const auto e = ext.toLowerCase().trimCharactersAtStart (".");
    if (e == "html" || e == "htm") return "text/html";
    if (e == "js" || e == "mjs") return "text/javascript";
    if (e == "css") return "text/css";
    if (e == "json" || e == "map") return "application/json";
    if (e == "svg") return "image/svg+xml";
    if (e == "png") return "image/png";
    if (e == "jpg" || e == "jpeg") return "image/jpeg";
    if (e == "ico") return "image/x-icon";
    if (e == "woff2") return "font/woff2";
    if (e == "woff") return "font/woff";
    if (e == "wasm") return "application/wasm";
    return "application/octet-stream";
}

std::optional<juce::WebBrowserComponent::Resource> loadUiResource (const juce::File& uiDir, const juce::String& rawPath)
{
    // "/assets/index-abc.js?x=1" -> "assets/index-abc.js"; "/" -> "index.html"
    auto path = rawPath.upToFirstOccurrenceOf ("?", false, false).upToFirstOccurrenceOf ("#", false, false);
    path = juce::URL::removeEscapeChars (path).trimCharactersAtStart ("/");
    if (path.isEmpty()) path = "index.html";
    if (path.contains ("..")) return std::nullopt;

    const auto file = uiDir.getChildFile (path);
    if (! file.existsAsFile() || ! file.isAChildOf (uiDir)) return std::nullopt;

    juce::MemoryBlock mb;
    if (! file.loadFileAsData (mb)) return std::nullopt;
    juce::WebBrowserComponent::Resource r;
    r.data.resize (mb.getSize());
    std::memcpy (r.data.data(), mb.getData(), mb.getSize());
    r.mimeType = mimeTypeFor (file.getFileExtension());
    return r;
}

static juce::WebBrowserComponent::Resource htmlResource (const juce::String& html)
{
    juce::WebBrowserComponent::Resource r;
    const auto utf8 = html.toStdString();
    r.data.resize (utf8.size());
    std::memcpy (r.data.data(), utf8.data(), utf8.size());
    r.mimeType = "text/html";
    return r;
}

ConsoleWindow::ConsoleWindow (Engine& e, const juce::String& devUrl)
    : DocumentWindow ("Merge", juce::Colour (0xff111316), DocumentWindow::allButtons), engine (e), uiDir (findUiDirectory())
{
    setUsingNativeTitleBar (true);
    setResizable (true, true);
    setResizeLimits (1024, 640, 10000, 10000);

    const auto dir = uiDir;
    auto options = juce::WebBrowserComponent::Options {}
                       .withBackend (juce::WebBrowserComponent::Options::Backend::webview2)
                       .withWinWebView2Options (juce::WebBrowserComponent::Options::WinWebView2 {}
                                                    .withUserDataFolder (juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                                                                             .getChildFile ("Merge/WebView2")))
                       .withKeepPageLoadedWhenBrowserIsHidden()
                       // required for the resource provider on Linux (JUCE registers the juce:// scheme with it)
                       .withNativeIntegrationEnabled()
                       .withResourceProvider ([dir] (const juce::String& path) -> std::optional<juce::WebBrowserComponent::Resource> {
                           static const bool debug = juce::SystemStats::getEnvironmentVariable ("MERGE_DEBUG_UI", {}).isNotEmpty();
                           auto r = loadUiResource (dir, path);
                           if (debug) std::cerr << "[ui] " << path << (r ? " -> ok" : " -> not found") << std::endl;
                           if (r) return r;
                           if (path == "/" || path.startsWith ("/index.html"))
                               return htmlResource ("<html><body style='background:#111316;color:#e6e8eb;font:15px system-ui;padding:40px'>"
                                                    "<h2>Merge console not found</h2><p>The console UI wasn't bundled into this build. "
                                                    "Run <code>npm install &amp;&amp; npm run build</code> in the repo, then rebuild the app.</p></body></html>");
                           return std::nullopt;
                       });

    // the console files are also available over plain HTTP on the engine's localhost port
    engine.server().onHttpGet = [dir] (const juce::String& path) -> std::optional<WebSocketServer::HttpResponse> {
        auto r = loadUiResource (dir, path);
        if (! r) return std::nullopt;
        return WebSocketServer::HttpResponse { r->mimeType, juce::MemoryBlock (r->data.data(), r->data.size()) };
    };

    browser = std::make_unique<juce::WebBrowserComponent> (options);
    browser->setSize (1600, 1000);
    setContentNonOwned (browser.get(), true);

    // restore the last window position/size
    const auto state = settings().getValue ("windowState");
    if (state.isEmpty() || ! restoreWindowStateFromString (state))
        centreWithSize (1600, 1000);
    setVisible (true);

    // load the console once the window (and so the web view) is actually on screen
    const auto port = engine.server().getPort();
    const auto query = "?embedded=1&port=" + juce::String (port);
   #if JUCE_LINUX
    // JUCE's Linux web view can't pass resources >64 KB through its helper-process pipe,
    // so on Linux the engine serves the console over its own localhost port instead.
    const auto bundled = "http://127.0.0.1:" + juce::String (port) + "/index.html";
   #else
    const auto bundled = juce::WebBrowserComponent::getResourceProviderRoot() + "index.html";
   #endif
    const auto url = devUrl.isNotEmpty() ? devUrl + query : bundled + query;
    juce::Component::SafePointer<juce::WebBrowserComponent> safe (browser.get());
    juce::MessageManager::callAsync ([safe, url] { if (safe) safe->goToURL (url); });
    startTimerHz (1);
}

ConsoleWindow::~ConsoleWindow()
{
    settings().setValue ("windowState", getWindowStateAsString());
    settings().saveIfNeeded();
    clearContentComponent();
}

juce::PropertiesFile& ConsoleWindow::settings()
{
    if (! props)
    {
        juce::PropertiesFile::Options o;
        o.applicationName = "window";
        o.folderName = "Merge";
        o.filenameSuffix = ".settings";
        o.osxLibrarySubFolder = "Application Support";
        props = std::make_unique<juce::PropertiesFile> (o);
    }
    return *props;
}

void ConsoleWindow::closeButtonPressed()
{
    juce::JUCEApplication::getInstance()->systemRequestedQuit();
}

void ConsoleWindow::timerCallback()
{
    // title shows the audio device at a glance (e.g. "Merge — CoreAudio: BlackHole 16ch · 48 kHz / 256")
    const auto line = engine.statusText().fromFirstOccurrenceOf ("\n", false, false);
    const auto title = "Merge — " + line;
    if (getName() != title) setName (title);
}

} // namespace merge

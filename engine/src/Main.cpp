#include <fstream>
#include <mutex>
#if defined (__APPLE__) || defined (__linux__)
 #include <csignal>
 #include <sys/stat.h>
 #include <unistd.h>
#endif
#include <juce_gui_basics/juce_gui_basics.h>
#include "Engine.h"
#include "ConsoleWindow.h"
#include "PluginHost.h"

namespace merge { int runSelfTest (const juce::StringArray& args); }


#if JUCE_MAC
namespace merge { juce::String macMicrophonePermission(); } // MacSupport.mm
#endif

namespace
{
/** Writes everything logged to the log file, and also to the original console output when that is
    a terminal or a file. Thread-safe (the engine logs from several threads). */
struct TeeBuf : std::streambuf
{
    TeeBuf (std::streambuf* fileBuf, std::streambuf* consoleBuf) : file (fileBuf), console (consoleBuf) {}
    int overflow (int c) override
    {
        if (c == EOF) return 0;
        const std::lock_guard<std::mutex> g (lock());
        file->sputc ((char) c);
        if (console != nullptr) console->sputc ((char) c);
        return c; // never fail the stream: logging must not break the app
    }
    int sync() override
    {
        const std::lock_guard<std::mutex> g (lock());
        file->pubsync();
        if (console != nullptr) console->pubsync();
        return 0;
    }
    static std::mutex& lock() { static std::mutex m; return m; }
    std::streambuf *file, *console;
};

/** Where the app's console output goes: a terminal / file is safe to write to; when opened from
    Finder it can be a pipe nobody reads, and writing to it can block the app. */
juce::String consoleKind (int fd)
{
   #if JUCE_MAC || JUCE_LINUX
    struct stat st {};
    if (fstat (fd, &st) != 0) return "closed";
    if (isatty (fd)) return "terminal";
    if (S_ISREG (st.st_mode)) return "file";
    if (S_ISFIFO (st.st_mode)) return "pipe";
    if (S_ISSOCK (st.st_mode)) return "socket";
    if (S_ISCHR (st.st_mode)) return "device";
    return "other";
   #else
    juce::ignoreUnused (fd);
    return "none";
   #endif
}

juce::File logFolder()
{
   #if JUCE_MAC
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory).getChildFile ("Library/Logs/Merge");
   #else
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("Merge/Logs");
   #endif
}

void startLogFile()
{
    static std::ofstream file;
    static std::unique_ptr<TeeBuf> outTee, errTee;
    const auto dir = logFolder();
    dir.createDirectory();
    const auto log = dir.getChildFile ("merge.log");
    if (log.existsAsFile()) log.moveFileTo (dir.getChildFile ("merge-previous.log"));
    file.open (log.getFullPathName().toStdString(), std::ios::out | std::ios::trunc);
    if (! file.is_open()) return;
   #if JUCE_MAC || JUCE_LINUX
    signal (SIGPIPE, SIG_IGN); // a closed console pipe must never kill the app
   #endif
    const auto out = consoleKind (1);
    const bool echo = out == "terminal" || out == "file";
    outTee = std::make_unique<TeeBuf> (file.rdbuf(), echo ? std::cout.rdbuf() : nullptr);
    errTee = std::make_unique<TeeBuf> (file.rdbuf(), echo ? std::cerr.rdbuf() : nullptr);
    std::cout.rdbuf (outTee.get());
    std::cerr.rdbuf (errTee.get());
    std::cout << "Merge " << MERGE_ENGINE_VERSION << " started " << juce::Time::getCurrentTime().toString (true, true) << " ("
              << juce::SystemStats::getOperatingSystemName() << ")" << std::endl;
    std::cout << "launch: console output is " << out << (echo ? " (logging there too)" : " (log file only)")
              << ", working folder " << juce::File::getCurrentWorkingDirectory().getFullPathName() << std::endl;
   #if JUCE_MAC
    std::cout << "macOS microphone permission for Merge: " << merge::macMicrophonePermission() << std::endl;
   #endif
}
} // namespace

class MergeEngineApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "Merge"; }
    const juce::String getApplicationVersion() override { return MERGE_ENGINE_VERSION; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise (const juce::String& commandLine) override
    {
        const auto args = juce::StringArray::fromTokens (commandLine, true);
        if (const auto params = getCommandLineParameterArray(); params.contains ("--scan-one"))
        {
            // plugin-scan helper: load one plugin file, write what it contains, exit. Runs in its own
            // process so a plugin that hangs or crashes can't take the app down with it.
            const int i = params.indexOf ("--scan-one");
           #if JUCE_MAC
            juce::Process::setDockIconVisible (false);
           #endif
            const auto format = params[i + 1], id = params[i + 2];
            const juce::File out (params[i + 3]);
            juce::MessageManager::callAsync ([format, id, out] {
                const int n = merge::PluginHost::scanOneToFile (format, id, out);
                std::fflush (stdout);
                std::_Exit (n > 0 ? 0 : 2);
            });
            return;
        }
        if (args.contains ("--print-plugin-ids"))
        {
            // lists the scanned plugins (id <tab> name); used by CI to build a test show
            merge::PluginHost host;
            const auto plugins = host.describePlugins(); // keep the var alive while iterating
            if (auto* list = plugins.getArray())
                for (auto& d : *list)
                    std::cout << d["id"].toString() << "\t" << d["name"].toString() << std::endl;
            std::fflush (stdout);
            std::_Exit (0);
        }
        if (args.contains ("--selftest"))
        {
            // run once the message loop is up (plugin hosting needs it)
            juce::MessageManager::callAsync ([args] {
                const int failures = merge::runSelfTest (args);
                // Test runner only: the nested dispatch loops the tests use can leave JUCE's Linux
                // message queue unable to wake for the quit message, so exit directly with the result.
                std::fflush (stdout);
                std::_Exit (failures == 0 ? 0 : 1);
            });
            return;
        }
        startLogFile(); // the app itself (not the scan helper / tests)
        merge::Engine::Options opt;
        if (const int i = args.indexOf ("--port"); i >= 0) opt.port = args[i + 1].getIntValue();
        opt.virtualDevice = args.contains ("--virtual");
        engine = std::make_unique<merge::Engine>();
        if (! engine->start (opt))
        {
            std::cerr << "Could not listen on ports " << opt.port << "-" << opt.port + 9 << std::endl;
            setApplicationReturnValue (2);
            quit();
            return;
        }
        std::cout << "Merge " << MERGE_ENGINE_VERSION << " — " << engine->statusText() << std::endl;
        if (! args.contains ("--headless"))
        {
            const int ui = args.indexOf ("--ui-url"); // development: load the console from the Vite dev server
            window = std::make_unique<merge::ConsoleWindow> (*engine, ui >= 0 ? args[ui + 1] : juce::String());
        }
    }

    void shutdown() override
    {
        window.reset();
        engine.reset();
    }

private:
    std::unique_ptr<merge::Engine> engine;
    std::unique_ptr<merge::ConsoleWindow> window;
};

START_JUCE_APPLICATION (MergeEngineApp)

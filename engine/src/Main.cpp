#include "Edition.h"
#include <juce_gui_basics/juce_gui_basics.h>
#include "Engine.h"
#include "ConsoleWindow.h"
#include "PluginHost.h"

namespace merge { int runSelfTest (const juce::StringArray& args); }

class MergeEngineApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return MERGE_APP_NAME; }
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
        std::cout << MERGE_APP_NAME " " << MERGE_ENGINE_VERSION << " — " << engine->statusText() << std::endl;
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

#include <juce_gui_basics/juce_gui_basics.h>
#include "Engine.h"

namespace merge { int runSelfTest (const juce::StringArray& args); }

/** Small status window; the console UI itself is the React app talking over ws://. */
class StatusWindow : public juce::DocumentWindow, private juce::Timer
{
public:
    explicit StatusWindow (merge::Engine& e)
        : DocumentWindow ("Merge Engine", juce::Colour (0xff111316), DocumentWindow::minimiseButton | DocumentWindow::closeButton), engine (e)
    {
        setUsingNativeTitleBar (true);
        label.setJustificationType (juce::Justification::centredLeft);
        label.setColour (juce::Label::textColourId, juce::Colours::white);
        label.setFont (juce::FontOptions (14.0f));
        label.setSize (520, 70);
        setContentNonOwned (&label, true);
        centreWithSize (520, 70);
        setVisible (true);
        startTimerHz (2);
        timerCallback();
    }
    void closeButtonPressed() override { juce::JUCEApplication::getInstance()->systemRequestedQuit(); }

private:
    void timerCallback() override { label.setText (engine.statusText(), juce::dontSendNotification); }
    merge::Engine& engine;
    juce::Label label;
};

class MergeEngineApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override { return "Merge Engine"; }
    const juce::String getApplicationVersion() override { return MERGE_ENGINE_VERSION; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise (const juce::String& commandLine) override
    {
        const auto args = juce::StringArray::fromTokens (commandLine, true);
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
            std::cerr << "Could not listen on port " << opt.port << " (another engine running?)" << std::endl;
            setApplicationReturnValue (2);
            quit();
            return;
        }
        std::cout << "Merge Engine " << MERGE_ENGINE_VERSION << " — " << engine->statusText() << std::endl;
        if (! args.contains ("--headless")) window = std::make_unique<StatusWindow> (*engine);
    }

    void shutdown() override
    {
        window.reset();
        engine.reset();
    }

private:
    std::unique_ptr<merge::Engine> engine;
    std::unique_ptr<StatusWindow> window;
};

START_JUCE_APPLICATION (MergeEngineApp)

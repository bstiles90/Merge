#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_utils/juce_audio_utils.h>

// Minimal effect used to verify hosting: a gain parameter (dB) and a fixed
// reported latency so plugin delay compensation can be exercised.
// Test hook: when MERGE_TEST_PLUGIN_HANG is set, never finish loading (like a plugin stuck in a
// copy-protection or licence check as its file is loaded), so the host's scan safety can be tested.
static const bool mergeTestHang = [] {
    if (juce::SystemStats::getEnvironmentVariable ("MERGE_TEST_PLUGIN_HANG", {}).isNotEmpty())
        for (;;) juce::Thread::sleep (1000);
    return false;
}();

class TestGain final : public juce::AudioProcessor
{
public:
    TestGain()
        : AudioProcessor (BusesProperties().withInput ("In", juce::AudioChannelSet::stereo())
                                           .withOutput ("Out", juce::AudioChannelSet::stereo()))
    {
        addParameter (gain = new juce::AudioParameterFloat ({ "gain", 1 }, "Gain", -24.0f, 24.0f, 0.0f));
        addParameter (invert = new juce::AudioParameterBool ({ "invert", 1 }, "Invert", false));
        setLatencySamples (64);
    }

    bool isBusesLayoutSupported (const BusesLayout& l) const override
    {
        const auto in = l.getMainInputChannelSet(), out = l.getMainOutputChannelSet();
        return in == out && (in == juce::AudioChannelSet::mono() || in == juce::AudioChannelSet::stereo());
    }

    void prepareToPlay (double, int) override
    {
        const int ch = getTotalNumInputChannels();
        delay.setSize (ch, 64);
        delay.clear();
        pos = 0;
    }
    void releaseResources() override {}

    void processBlock (juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override
    {
        const float g = juce::Decibels::decibelsToGain (gain->get()) * (invert->get() ? -1.0f : 1.0f);
        const int n = buf.getNumSamples();
        for (int c = 0; c < juce::jmin (buf.getNumChannels(), delay.getNumChannels()); ++c)
        {
            auto* d = buf.getWritePointer (c);
            auto* line = delay.getWritePointer (c);
            int p = pos;
            for (int i = 0; i < n; ++i)
            {
                const float x = d[i];
                d[i] = line[p] * g;
                line[p] = x;
                p = (p + 1) % 64;
            }
        }
        pos = (pos + n) % 64;
    }

    juce::AudioProcessorEditor* createEditor() override { return new juce::GenericAudioProcessorEditor (*this); }
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return "Merge Test Gain"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& dest) override
    {
        juce::MemoryOutputStream out (dest, false);
        out.writeFloat (gain->get());
        out.writeBool (invert->get());
    }
    void setStateInformation (const void* data, int size) override
    {
        juce::MemoryInputStream in (data, (size_t) size, false);
        *gain = in.readFloat();
        *invert = in.readBool();
    }

private:
    juce::AudioParameterFloat* gain;
    juce::AudioParameterBool* invert;
    juce::AudioBuffer<float> delay;
    int pos = 0;
};

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new TestGain(); }

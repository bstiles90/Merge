#include "Multitrack.h"

namespace merge
{

Multitrack::Multitrack()
{
    formats.registerBasicFormats(); // WAV, AIFF, FLAC, Ogg (+ CoreAudio formats on macOS)
    readThread.startThread (juce::Thread::Priority::high);
    writeThread.startThread (juce::Thread::Priority::high);
}

Multitrack::~Multitrack()
{
    cache.clear();
    readThread.stopThread (2000);
    writeThread.stopThread (4000);
}

std::shared_ptr<PlaybackFile> Multitrack::open (const juce::String& path)
{
    if (auto it = cache.find (path); it != cache.end())
        if (auto sp = it->second.lock()) return sp;
    std::unique_ptr<juce::AudioFormatReader> r (formats.createReaderFor (juce::File (path)));
    if (r == nullptr) return nullptr;
    auto pf = std::make_shared<PlaybackFile>();
    pf->sampleRate = r->sampleRate;
    pf->numChannels = (int) juce::jmin (2u, r->numChannels);
    pf->length = r->lengthInSamples;
    // about 5 s read ahead per file
    auto* buffered = new juce::BufferingAudioReader (r.release(), readThread, (int) (pf->sampleRate * 5));
    buffered->setReadTimeout (readTimeoutMs);
    pf->reader.reset (buffered);
    cache[path] = pf;
    // forget files nothing uses any more
    for (auto it = cache.begin(); it != cache.end();)
        it = it->second.expired() ? cache.erase (it) : std::next (it);
    return pf;
}

std::optional<Multitrack::FileInfo> Multitrack::describe (const juce::File& f)
{
    std::unique_ptr<juce::AudioFormatReader> r (formats.createReaderFor (f));
    if (r == nullptr || r->sampleRate <= 0) return std::nullopt;
    return FileInfo { f.getFullPathName(), f.getFileNameWithoutExtension(), (double) r->lengthInSamples / r->sampleRate, r->sampleRate,
                      (int) r->numChannels };
}

std::vector<uint8_t> Multitrack::peaks (const juce::File& f, int perSecond)
{
    std::vector<uint8_t> out;
    std::unique_ptr<juce::AudioFormatReader> r (formats.createReaderFor (f));
    if (r == nullptr || r->sampleRate <= 0) return out;
    const int bucket = juce::jmax (1, (int) (r->sampleRate / perSecond));
    const int nch = (int) juce::jmin (2u, r->numChannels);
    const int chunk = bucket * 256;
    juce::AudioBuffer<float> buf (nch, chunk);
    out.reserve ((size_t) (r->lengthInSamples / bucket + 1));
    for (juce::int64 pos = 0; pos < r->lengthInSamples; pos += chunk)
    {
        const int n = (int) juce::jmin ((juce::int64) chunk, r->lengthInSamples - pos);
        r->read (&buf, 0, n, pos, true, nch > 1);
        for (int b = 0; b < n; b += bucket)
        {
            float m = 0;
            for (int c = 0; c < nch; ++c)
                m = juce::jmax (m, buf.getMagnitude (c, b, juce::jmin (bucket, n - b)));
            out.push_back ((uint8_t) juce::jlimit (0, 255, (int) std::lround (juce::jmin (1.0f, m) * 255)));
        }
    }
    return out;
}

std::unique_ptr<RecordSession> Multitrack::createSession (const juce::File& folder, const std::vector<Track>& tracks, bool program,
                                                          double sampleRate, int numChannels)
{
    if (! folder.createDirectory()) return nullptr;
    auto s = std::make_unique<RecordSession>();
    s->channel.resize ((size_t) numChannels);
    s->channelWidth.assign ((size_t) numChannels, 1);
    s->channelFile.resize ((size_t) numChannels);
    juce::WavAudioFormat wav;
    auto makeWriter = [&] (const juce::File& f, int width) -> std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> {
        f.deleteFile();
        std::unique_ptr<juce::OutputStream> os = std::make_unique<juce::FileOutputStream> (f);
        if (static_cast<juce::FileOutputStream*> (os.get())->failedToOpen()) return nullptr;
        // 24-bit WAV (JUCE switches to RF64 past 4 GB)
        auto* w = wav.createWriterFor (os.get(), sampleRate, (unsigned) width, 24, {}, 0);
        if (w == nullptr) return nullptr;
        os.release(); // the writer owns the stream now
        // 10 s of FIFO between the audio thread and the disk
        return std::make_unique<juce::AudioFormatWriter::ThreadedWriter> (w, writeThread, (int) (sampleRate * 10));
    };
    for (const auto& t : tracks)
    {
        if (t.channelIndex < 0 || t.channelIndex >= numChannels) continue;
        const auto name = juce::File::createLegalFileName (juce::String (t.channelIndex + 1).paddedLeft ('0', 2) + " " + t.name);
        const auto f = folder.getChildFile (name + ".wav");
        s->channel[(size_t) t.channelIndex] = makeWriter (f, t.width);
        s->channelWidth[(size_t) t.channelIndex] = t.width;
        if (s->channel[(size_t) t.channelIndex]) s->channelFile[(size_t) t.channelIndex] = f.getFullPathName();
    }
    if (program)
    {
        const auto f = folder.getChildFile ("PGM (Main LR).wav");
        s->program = makeWriter (f, 2);
        if (s->program) s->programFile = f.getFullPathName();
    }
    return s;
}

} // namespace merge

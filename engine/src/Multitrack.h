// Native multitrack recording and playback (virtual soundcheck).
//
//  Recording: each armed channel's source (raw input, before gain) goes to its own WAV file
//  through a JUCE ThreadedWriter: the audio thread only pushes into a lock-free FIFO, a disk
//  thread writes. The programme (Main LR, post fader) can be recorded too.
//
//  Playback: channels in playback mode read their clips (recordings or imported multitrack
//  stems) at the transport position. Files are opened on the message thread and read ahead on
//  a disk thread (BufferingAudioReader); the audio thread never waits for the disk: data that
//  isn't buffered yet plays as silence.
#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <map>
#include <optional>
#include <memory>
#include <vector>

namespace merge
{

/** An audio file opened for playback (shared by every clip that uses it). */
struct PlaybackFile
{
    std::unique_ptr<juce::AudioFormatReader> reader; // a BufferingAudioReader
    double sampleRate = 48000;
    int numChannels = 1;
    juce::int64 length = 0;
};

/** A recording in progress: one writer per armed channel (indexed by channel), plus programme. */
struct RecordSession
{
    std::vector<std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter>> channel; // kNumChannels, null = not armed
    std::vector<int> channelWidth;                                                  // 1 mono, 2 stereo
    std::vector<juce::String> channelFile;                                          // what each writer writes to
    std::unique_ptr<juce::AudioFormatWriter::ThreadedWriter> program;
    juce::String programFile;
    std::atomic<juce::int64> startSample { -1 };  // transport position of the first recorded block
    std::atomic<juce::int64> samplesWritten { 0 };
    std::atomic<bool> overrun { false };       // the disk couldn't keep up (some audio was dropped)
};

class Multitrack
{
public:
    Multitrack();
    ~Multitrack();

    /** Message thread: open (or reuse) a file for playback; null if it can't be read. */
    std::shared_ptr<PlaybackFile> open (const juce::String& path);

    struct FileInfo
    {
        juce::String path, name;
        double duration = 0, sampleRate = 0;
        int channels = 0;
    };
    /** Message thread: what an audio file is (for imports). */
    std::optional<FileInfo> describe (const juce::File& f);

    /** Waveform overview: max |x| per bucket, 8 bit, `perSecond` buckets a second. Any thread. */
    std::vector<uint8_t> peaks (const juce::File& f, int perSecond);

    struct Track
    {
        int channelIndex = 0;
        juce::String name;
        int width = 1;
    };
    /** Message thread: create the files for a recording in `folder`. */
    std::unique_ptr<RecordSession> createSession (const juce::File& folder, const std::vector<Track>& tracks, bool program,
                                                  double sampleRate, int numChannels);

    /** For tests: let playback reads wait for the disk (milliseconds, 0 = never wait). */
    void setReadTimeout (int ms) { readTimeoutMs = ms; }

    juce::AudioFormatManager formats;

private:
    juce::TimeSliceThread readThread { "Merge playback" }, writeThread { "Merge recorder" };
    std::map<juce::String, std::weak_ptr<PlaybackFile>> cache;
    int readTimeoutMs = 0;
};

} // namespace merge

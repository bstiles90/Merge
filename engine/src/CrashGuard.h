// Crash attribution: which plugin was Merge running when it crashed?
//
// Each thread marks the plugin it is calling into (rendering audio, being created, getting its
// settings). If Merge then crashes, a signal / exception handler writes that plugin's slot to a
// file (async-signal-safe: plain open/write/close of a pre-built string), and the next launch
// reads it so the console can switch that one plugin off instead of crashing again.
#pragma once

#include <juce_core/juce_core.h>
#include <optional>

namespace merge::crash
{

/** A pre-built tag: "render\tslotId\tname\n" or "load\tslotId\tname\n". */
struct Tag
{
    char text[320] {};
    void set (const char* kind, const juce::String& slotId, const juce::String& name);
};

/** The plugin the calling thread is inside right now (null = none). */
void enter (const Tag* t) noexcept;
const Tag* current() noexcept;

/** RAII: mark the calling thread as inside a plugin for a scope. */
struct Scope
{
    explicit Scope (const Tag* t) noexcept : prev (current()) { enter (t); }
    ~Scope() { enter (prev); }
    const Tag* prev;
};

/** Install the handlers; the culprit is written to `file`. */
void install (const juce::File& file);

struct Report
{
    juce::String kind, slotId, name;
};
/** The plugin blamed for the last crash, if any (the file is removed). */
std::optional<Report> takeReport (const juce::File& file);

} // namespace merge::crash

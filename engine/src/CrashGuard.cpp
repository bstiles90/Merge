#include "CrashGuard.h"
#include <csignal>
#include <cstring>
#if JUCE_WINDOWS
 #include <windows.h>
 #include <io.h>
 #include <fcntl.h>
#else
 #include <fcntl.h>
 #include <unistd.h>
#endif

namespace merge::crash
{

namespace
{
thread_local const Tag* tCurrent = nullptr;
char gPath[2048] {};

void writeCulprit() noexcept
{
    const Tag* t = tCurrent;
    if (t == nullptr || gPath[0] == 0) return;
#if JUCE_WINDOWS
    int fd = _open (gPath, _O_WRONLY | _O_CREAT | _O_TRUNC | _O_BINARY, _S_IREAD | _S_IWRITE);
    if (fd < 0) return;
    _write (fd, t->text, (unsigned) std::strlen (t->text));
    _close (fd);
#else
    int fd = ::open (gPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) return;
    ssize_t r = ::write (fd, t->text, std::strlen (t->text));
    (void) r;
    ::close (fd);
#endif
}

#if JUCE_WINDOWS
LONG WINAPI onException (EXCEPTION_POINTERS*)
{
    writeCulprit();
    return EXCEPTION_CONTINUE_SEARCH;
}
#else
void onSignal (int sig)
{
    writeCulprit();
    // SA_RESETHAND restored the default action: crash for real (the system crash report still names it)
    ::raise (sig);
}
#endif
} // namespace

void Tag::set (const char* kind, const juce::String& slotId, const juce::String& name)
{
    const auto s = juce::String (kind) + "\t" + slotId.removeCharacters ("\t\n") + "\t" + name.removeCharacters ("\t\n") + "\n";
    s.copyToUTF8 (text, sizeof (text));
    // copyToUTF8 may cut the newline off a very long name: the reader doesn't need it
}

void enter (const Tag* t) noexcept { tCurrent = t; }
const Tag* current() noexcept { return tCurrent; }

void install (const juce::File& file)
{
    file.getFullPathName().copyToUTF8 (gPath, sizeof (gPath));
#if JUCE_WINDOWS
    SetUnhandledExceptionFilter (onException);
#else
    struct sigaction sa {};
    sa.sa_handler = onSignal;
    sigemptyset (&sa.sa_mask);
    sa.sa_flags = SA_RESETHAND;
    for (int sig : { SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT })
        sigaction (sig, &sa, nullptr);
#endif
}

std::optional<Report> takeReport (const juce::File& file)
{
    if (! file.existsAsFile()) return std::nullopt;
    const auto parts = juce::StringArray::fromTokens (file.loadFileAsString().trim(), "\t", "");
    file.deleteFile();
    if (parts.size() < 3 || parts[1].isEmpty()) return std::nullopt;
    return Report { parts[0], parts[1], parts[2] };
}

} // namespace merge::crash

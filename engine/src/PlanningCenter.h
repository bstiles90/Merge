#pragma once
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <atomic>
#include <functional>
#include <memory>

namespace merge
{

/** Read-only access to Planning Center Services for the console (this week's plan, item
    "Person" notes, scheduled people). The console asks for API paths; the engine adds the
    credentials, which live only in this computer's app data, never in show files. */
class PlanningCenterClient
{
public:
    PlanningCenterClient();
    ~PlanningCenterClient();

    bool hasCredentials() const;
    /** Saves (or with empty strings, removes) the Personal Access Token: application id + secret. */
    void setCredentials (const juce::String& appId, const juce::String& secret);

    /** GET https://api.planningcenteronline.com<path> on a background thread.
        done(status, json) arrives on the message thread. Only /services/v2/ paths are allowed. */
    void get (const juce::String& path, std::function<void (int, const juce::var&)> done);

    static bool isAllowedPath (const juce::String& path);
    static juce::String authHeader (const juce::String& appId, const juce::String& secret);

private:
    juce::File file;
    juce::String appId, secret;
    std::shared_ptr<std::atomic<bool>> alive = std::make_shared<std::atomic<bool>> (true);
};

} // namespace merge

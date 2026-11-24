#include "PlanningCenter.h"
#include <iostream>
#if JUCE_MAC || JUCE_LINUX
 #include <sys/stat.h>
#endif

namespace merge
{

PlanningCenterClient::PlanningCenterClient()
{
    file = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory).getChildFile ("Merge/planning-center.json");
    if (auto v = juce::JSON::parse (file); v.isObject())
    {
        appId = v["appId"].toString();
        secret = v["secret"].toString();
    }
}

PlanningCenterClient::~PlanningCenterClient() { alive->store (false); }

bool PlanningCenterClient::hasCredentials() const { return appId.isNotEmpty() && secret.isNotEmpty(); }

void PlanningCenterClient::setCredentials (const juce::String& id, const juce::String& sec)
{
    appId = id.trim();
    secret = sec.trim();
    if (! hasCredentials()) { file.deleteFile(); return; }
    file.getParentDirectory().createDirectory();
    auto* o = new juce::DynamicObject();
    o->setProperty ("appId", appId);
    o->setProperty ("secret", secret);
    file.replaceWithText (juce::JSON::toString (juce::var (o)));
    // readable by this user only
   #if JUCE_MAC || JUCE_LINUX
    chmod (file.getFullPathName().toRawUTF8(), 0600);
   #endif
}

bool PlanningCenterClient::isAllowedPath (const juce::String& path)
{
    return path.startsWith ("/services/v2/") && ! path.contains ("..") && ! path.containsAnyOf (" \r\n\t");
}

juce::String PlanningCenterClient::authHeader (const juce::String& id, const juce::String& sec)
{
    const auto raw = (id + ":" + sec).toStdString();
    return "Authorization: Basic " + juce::Base64::toBase64 (raw.data(), raw.size());
}

void PlanningCenterClient::get (const juce::String& path, std::function<void (int, const juce::var&)> done)
{
    auto finish = [flag = alive, done] (int status, juce::var body) {
        juce::MessageManager::callAsync ([flag, done, status, body] { if (flag->load() && done) done (status, body); });
    };
    if (! isAllowedPath (path)) { finish (400, juce::var ("Only Planning Center Services paths are allowed")); return; }
    if (! hasCredentials()) { finish (401, juce::var ("Planning Center isn't linked yet")); return; }
    const auto header = authHeader (appId, secret) + "\r\nAccept: application/json";
    // MERGE_PCO_BASE: tests point this at a local stand-in for Planning Center
    static const auto base = juce::SystemStats::getEnvironmentVariable ("MERGE_PCO_BASE", "https://api.planningcenteronline.com");
    const juce::URL url (base + path);
    juce::Thread::launch ([url, header, finish] {
        int status = 0;
        auto stream = url.createInputStream (juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                                                 .withExtraHeaders (header)
                                                 .withConnectionTimeoutMs (15000)
                                                 .withStatusCode (&status));
        if (stream == nullptr) { finish (0, juce::var ("Can't reach Planning Center (no internet?)")); return; }
        const auto text = stream->readEntireStreamAsString();
        juce::var body;
        if (! juce::JSON::parse (text, body).wasOk()) body = text;
        if (status != 200) std::cout << "[planning center] HTTP " << status << " for " << url.toString (false) << std::endl;
        finish (status, body);
    });
}

} // namespace merge

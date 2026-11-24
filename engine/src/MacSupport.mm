// macOS: keep Merge fully awake. A live console often sits behind OBS / ProPresenter, and macOS
// would otherwise "App Nap" it and throttle the web view's timers, delaying console updates.
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#include <juce_core/juce_core.h>

namespace merge
{

static void relaxWebViews (NSView* v)
{
    static Class wk = NSClassFromString (@"WKWebView");
    if (wk != nil && [v isKindOfClass: wk])
    {
        @try
        {
            // macOS 14+: WKPreferences.inactiveSchedulingPolicy = WKInactiveSchedulingPolicyNone (2)
            id prefs = [[v valueForKey: @"configuration"] valueForKey: @"preferences"];
            if ([prefs respondsToSelector: NSSelectorFromString (@"setInactiveSchedulingPolicy:")])
                [prefs setValue: @2 forKey: @"inactiveSchedulingPolicy"];
            // allow Safari's Web Inspector (Develop menu) to attach, for troubleshooting the console
            if ([v respondsToSelector: NSSelectorFromString (@"setInspectable:")])
                [v setValue: @YES forKey: @"inspectable"];
        }
        @catch (NSException*) {}
    }
    for (NSView* sub in [v subviews])
        relaxWebViews (sub);
}

void macKeepAwake (void* windowNSView)
{
    static id activity = nil;
    if (activity == nil)
    {
        activity = [[NSProcessInfo processInfo] beginActivityWithOptions: (NSActivityUserInitiated | NSActivityLatencyCritical)
                                                                  reason: @"Live audio console"];
       #if ! __has_feature(objc_arc)
        [activity retain];
       #endif
    }
    if (windowNSView != nullptr)
        relaxWebViews ((NSView*) windowNSView);
}

juce::String macMicrophonePermission()
{
    if (@available (macOS 10.14, *))
    {
        switch ([AVCaptureDevice authorizationStatusForMediaType: AVMediaTypeAudio])
        {
            case AVAuthorizationStatusAuthorized:    return "allowed";
            case AVAuthorizationStatusDenied:        return "DENIED (System Settings > Privacy & Security > Microphone)";
            case AVAuthorizationStatusRestricted:    return "restricted";
            case AVAuthorizationStatusNotDetermined: return "not asked yet";
        }
    }
    return "unknown";
}

} // namespace merge

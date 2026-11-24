#include "TruePeak.h"
#include <algorithm>
#include <cmath>

namespace merge
{

// ======================================================================= detector
TruePeakDetector::TruePeakDetector()
{
    // 64-tap windowed-sinc low-pass at the original Nyquist, for a 4x upsampler,
    // split into 4 polyphase branches. Blackman-Harris window.
    constexpr int N = kTaps * kPhases;
    const double pi = 3.14159265358979323846;
    double proto[N];
    for (int i = 0; i < N; ++i)
    {
        const double t = (i - (N - 1) / 2.0) / kPhases; // in original-sample units
        const double sinc = t == 0 ? 1.0 : std::sin (pi * t) / (pi * t);
        const double w = 0.35875 - 0.48829 * std::cos (2 * pi * i / (N - 1)) + 0.14128 * std::cos (4 * pi * i / (N - 1))
                         - 0.01168 * std::cos (6 * pi * i / (N - 1));
        proto[i] = sinc * w;
    }
    for (int p = 0; p < kPhases; ++p)
    {
        double sum = 0;
        for (int j = 0; j < kTaps; ++j) sum += proto[j * kPhases + p];
        for (int j = 0; j < kTaps; ++j) coef[(size_t) p][(size_t) j] = (float) (proto[j * kPhases + p] / sum); // unity DC per phase
    }
}

void TruePeakDetector::reset()
{
    hist.fill (0.0f);
    pos = 0;
}

float TruePeakDetector::process (float x) noexcept
{
    hist[(size_t) pos] = x;
    hist[(size_t) (pos + kTaps)] = x;
    if (++pos >= kTaps) pos = 0;
    // window: hist[pos .. pos+kTaps-1] is oldest..newest
    const float* w = hist.data() + pos;
    float peak = 0.0f;
    for (int p = 0; p < kPhases; ++p)
    {
        const auto& c = coef[(size_t) p];
        float y = 0.0f;
        for (int j = 0; j < kTaps; ++j) y += c[(size_t) j] * w[kTaps - 1 - j];
        peak = std::max (peak, std::abs (y));
    }
    return peak;
}

} // namespace merge

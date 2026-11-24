#include "TruePeak.h"
#include <algorithm>

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

// ======================================================================= limiter
void TruePeakLimiter::prepare (double sr)
{
    sampleRate = sr;
    look = std::max (8, (int) std::lround (0.0015 * sr)); // 1.5 ms look-ahead
    hold = look + 2;                                       // slack for interpolated points either side of a sample
    latency = look + TruePeakDetector::kDelay;
    delayL.assign ((size_t) latency, 0.0f);
    delayR.assign ((size_t) latency, 0.0f);
    dqVal.assign ((size_t) hold + 4, 1.0f);
    dqIdx.assign ((size_t) hold + 4, 0);
    avgBuf.assign ((size_t) look, 1.0f);
    reset();
}

void TruePeakLimiter::reset()
{
    det[0].reset();
    det[1].reset();
    std::fill (delayL.begin(), delayL.end(), 0.0f);
    std::fill (delayR.begin(), delayR.end(), 0.0f);
    std::fill (avgBuf.begin(), avgBuf.end(), 1.0f);
    dpos = 0;
    dqHead = dqTail = 0;
    sampleIndex = 0;
    avgPos = 0;
    avgSum = look;
    env = 1.0f;
    minGain = 1.0f;
}

float TruePeakLimiter::takeGainReductionDb() noexcept
{
    const float g = minGain;
    minGain = 1.0f;
    return g < 1.0f ? 20.0f * std::log10 (std::max (g, 1e-6f)) : 0.0f;
}

void TruePeakLimiter::process (float* l, float* r, int n, bool enabled, float ceiling, float releaseMs) noexcept
{
    const int cap = (int) dqVal.size();
    const float rel = 1.0f - std::exp (-1.0f / (float) (sampleRate * std::max (1.0f, releaseMs) * 0.001));
    // tiny safety margin: gain modulation can nudge interpolated peaks very slightly
    const float target = ceiling * 0.989f; // -0.1 dB
    for (int i = 0; i < n; ++i)
    {
        const float tp = std::max (det[0].process (l[i]), det[1].process (r[i]));
        const float required = (enabled && tp > target) ? target / tp : 1.0f;

        // sliding minimum over the last `hold` required-gain values
        while (dqTail != dqHead && dqVal[(size_t) ((dqTail - 1 + cap) % cap)] >= required)
            dqTail = (dqTail - 1 + cap) % cap;
        dqVal[(size_t) dqTail] = required;
        dqIdx[(size_t) dqTail] = sampleIndex;
        dqTail = (dqTail + 1) % cap;
        while (dqIdx[(size_t) dqHead] <= sampleIndex - hold) dqHead = (dqHead + 1) % cap;
        const float held = dqVal[(size_t) dqHead];
        ++sampleIndex;

        // instant attack to the held minimum, exponential release
        env = held < env ? held : env + (held - env) * rel;

        // moving average over the look-ahead length -> smooth, never late
        avgSum += env - avgBuf[(size_t) avgPos];
        avgBuf[(size_t) avgPos] = env;
        if (++avgPos >= look) avgPos = 0;
        if (++sinceRecalc >= 8192) // recompute the running sum occasionally (float drift)
        {
            sinceRecalc = 0;
            double s = 0;
            for (float v : avgBuf) s += v;
            avgSum = s;
        }
        const float gain = std::min (1.0f, (float) (avgSum / look));
        minGain = std::min (minGain, gain);

        // delay the audio by the detector delay + look-ahead, then apply the gain
        const float dl = delayL[(size_t) dpos], dr = delayR[(size_t) dpos];
        delayL[(size_t) dpos] = l[i];
        delayR[(size_t) dpos] = r[i];
        if (++dpos >= latency) dpos = 0;
        l[i] = dl * gain;
        r[i] = dr * gain;
    }
}

} // namespace merge

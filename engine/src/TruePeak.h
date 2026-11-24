#pragma once
#include <array>
#include <cmath>

namespace merge
{

/**
 * ITU-R BS.1770 style true-peak detector: 4x oversampling with a windowed-sinc
 * polyphase interpolator. process() returns the largest absolute value among the
 * four interpolated points for the newest sample (group delay kTaps/2 samples).
 * Realtime safe: fixed arrays, no allocation after construction.
 */
class TruePeakDetector
{
public:
    static constexpr int kPhases = 4;
    static constexpr int kTaps = 16; // per phase (64-tap prototype)
    static constexpr int kDelay = kTaps / 2;

    TruePeakDetector();
    void reset();
    float process (float x) noexcept;

private:
    std::array<std::array<float, kTaps>, kPhases> coef {};
    std::array<float, kTaps * 2> hist {}; // doubled ring so a contiguous window always exists
    int pos = 0;
};

} // namespace merge

#include "Mixer.h"

namespace merge
{

// ======================================================================= Loudness
void LoudnessMeter::prepare (double fs)
{
    // K-weighting for arbitrary sample rates (as in libebur128 / pyloudnorm)
    double f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    double K = std::tan (juce::MathConstants<double>::pi * f0 / fs), Vh = std::pow (10.0, G / 20), Vb = std::pow (Vh, 0.4996667741545416);
    double a0 = 1 + K / Q + K * K;
    Biquad s { (Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0 };
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = std::tan (juce::MathConstants<double>::pi * f0 / fs);
    a0 = 1 + K / Q + K * K;
    Biquad h { 1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0 };
    shelf = { s, s };
    hp = { h, h };
    blockLen = (int) std::round (fs * 0.1);
    count = 0; acc = 0; numBlocks = 0; blockWrite = 0;
    gated.assign (36000, 0.0); // 1 hour of 100 ms steps
    gatedCount = 0;
}

void LoudnessMeter::process (const float* l, const float* r, int n) noexcept
{
    if (resetRequested.exchange (false)) { gatedCount = 0; integrated = -INFINITY; }
    for (int i = 0; i < n; ++i)
    {
        const double yl = hp[0].run (shelf[0].run (l[i]));
        const double yr = hp[1].run (shelf[1].run (r[i]));
        acc += yl * yl + yr * yr;
        if (++count >= blockLen) finishBlock();
    }
}

void LoudnessMeter::finishBlock() noexcept
{
    blocks[(size_t) blockWrite] = acc / count;
    blockWrite = (blockWrite + 1) % 30;
    numBlocks = juce::jmin (30, numBlocks + 1);
    acc = 0; count = 0;
    auto lufs = [] (double ms) { return ms > 0 ? -0.691 + 10 * std::log10 (ms) : -INFINITY; };
    auto meanLast = [this] (int k) {
        double s = 0;
        for (int j = 0; j < k; ++j) s += blocks[(size_t) ((blockWrite - 1 - j + 30) % 30)];
        return s / k;
    };
    if (numBlocks >= 4)
    {
        const double m = meanLast (4);
        momentary = (float) lufs (m);
        if (lufs (m) > -70 && gatedCount < gated.size()) gated[gatedCount++] = m;
    }
    shortTerm = (float) lufs (meanLast (numBlocks));
    if (gatedCount)
    {
        double s = 0;
        for (size_t i = 0; i < gatedCount; ++i) s += gated[i];
        const double rel = lufs (s / (double) gatedCount) - 10;
        double k = 0; size_t kc = 0;
        for (size_t i = 0; i < gatedCount; ++i)
            if (lufs (gated[i]) > rel) { k += gated[i]; ++kc; }
        if (kc) integrated = (float) lufs (k / (double) kc);
    }
}

// ======================================================================= Mixer
Mixer::Mixer() = default;

Mixer::~Mixer()
{
    running = false;
    delete current.exchange (nullptr);
    for (auto& r : retired) delete r.first;
}

void Mixer::prepare (double sr, int block, int, int)
{
    running = false;
    sampleRate = sr;
    maxBlock = juce::jmax (16, block);
    smoothCoef = (float) (1.0 - std::exp (-1.0 / (0.010 * sr))); // ~10 ms
    for (auto& c : ch)
    {
        c.delay.prepare ((int) sr + 1);    // up to 1 s channel delay
        c.pdc.prepare (16384);             // plugin delay compensation
        for (auto& d : c.tapPdc) d.prepare (16384);
    }
    for (auto& b : bus)
    {
        for (auto& d : b.delay) d.prepare ((int) sr + 1);
        for (auto& d : b.chanPdc) d.prepare (16384);
        for (auto& d : b.outPdc) d.prepare (16384);
    }
    for (auto& d : mainDirectPdc) d.prepare (16384);
    for (auto& d : mainDelay) d.prepare ((int) (2 * sr) + 1); // lip-sync up to 2 s
    chanBuf.setSize (kNumChannels, maxBlock);
    tapBuf.setSize (kMaxInserts, maxBlock);
    busBuf.setSize (kNumBuses * 2, maxBlock);
    busFeed.setSize (kNumBuses * 2, maxBlock);
    mainFromBuses.setSize (2, maxBlock);
    mainBuf.setSize (2, maxBlock);
    cueBuf.setSize (2, maxBlock);
    monBuf.setSize (2, maxBlock);
    loudness.prepare (sr);
    outTp[0].reset();
    outTp[1].reset();
    running = true;
}

void Mixer::release()
{
    running = false;
    collectGarbage();
}

void Mixer::setPlan (std::unique_ptr<MixPlan> plan)
{
    auto* old = current.exchange (plan.release(), std::memory_order_acq_rel);
    if (old) retired.push_back ({ old, blocksDone.load() });
    collectGarbage();
}

void Mixer::collectGarbage()
{
    const auto done = blocksDone.load();
    const bool idle = ! running.load();
    retired.erase (std::remove_if (retired.begin(), retired.end(), [&] (auto& r) {
                       if (idle || done >= r.second + 2) { delete r.first; return true; }
                       return false;
                   }),
                   retired.end());
}

float Mixer::sourceSample (ChannelState& c, const ChannelPlan& p, const float* const* in, int numIn, int i) noexcept
{
    if (p.playback) return 0.0f; // native recorder/playback is a later milestone
    switch (p.source)
    {
        case ChannelPlan::Source::input:
            return (p.inputChannel >= 0 && p.inputChannel < numIn && in[p.inputChannel]) ? in[p.inputChannel][i] : 0.0f;
        case ChannelPlan::Source::tone:
        {
            c.phase += p.toneFreq / sampleRate;
            if (c.phase >= 1.0) c.phase -= 1.0;
            return 0.125f * (float) std::sin (c.phase * juce::MathConstants<double>::twoPi); // -18 dBFS
        }
        case ChannelPlan::Source::noise:
        case ChannelPlan::Source::speech:
        {
            const float w = c.rng.nextFloat() * 2.0f - 1.0f;
            auto& b = c.b;
            b[0] = 0.99886f * b[0] + w * 0.0555179f;
            b[1] = 0.99332f * b[1] + w * 0.0750759f;
            b[2] = 0.969f * b[2] + w * 0.153852f;
            b[3] = 0.8665f * b[3] + w * 0.3104856f;
            b[4] = 0.55f * b[4] + w * 0.5329522f;
            b[5] = -0.7616f * b[5] - w * 0.016898f;
            const float pink = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362f) * 0.08f;
            b[6] = w * 0.115926f;
            if (p.source == ChannelPlan::Source::noise) return pink;
            // crude talker: band-limited noise with syllable envelope and pauses
            if (--c.syllLeft <= 0)
            {
                c.syllLeft = (int) (sampleRate * (0.12 + c.rng.nextFloat() * 0.18));
                c.syllTarget = c.rng.nextFloat() < 0.15f ? 0.0f : 0.4f + c.rng.nextFloat() * 0.6f;
            }
            c.syll += (c.syllTarget - c.syll) * 0.002f;
            c.lp += (pink - c.lp) * 0.25f;
            return c.lp * c.syll * 3.0f;
        }
        case ChannelPlan::Source::none:
        default:
            return 0.0f;
    }
}

void Mixer::process (const float* const* in, int numIn, float* const* out, int numOut, int numSamples) noexcept
{
    juce::ScopedNoDenormals noDenormals;
    int offset = 0;
    while (offset < numSamples)
    {
        const int n = juce::jmin (maxBlock, numSamples - offset);
        // offset views onto the device buffers
        const float* inPtrs[64] {};
        float* outPtrs[64] {};
        const int ni = juce::jmin (numIn, 64), no = juce::jmin (numOut, 64);
        for (int i = 0; i < ni; ++i) inPtrs[i] = in[i] ? in[i] + offset : nullptr;
        for (int i = 0; i < no; ++i) outPtrs[i] = out[i] ? out[i] + offset : nullptr;

        MixPlan* plan = current.load (std::memory_order_acquire);
        if (plan == nullptr || ! running)
        {
            for (int i = 0; i < no; ++i) if (outPtrs[i]) juce::FloatVectorOperations::clear (outPtrs[i], n);
            offset += n;
            continue;
        }
        const float k = smoothCoef;

        // plugin delay compensation: delay every channel up to the slowest one
        int chanLat[kNumChannels] {};
        int maxLat = 0;
        for (int c = 0; c < kNumChannels; ++c)
        {
            for (auto& r : plan->channels[(size_t) c].inserts)
                if (r.insert) chanLat[c] += r.insert->getLatency();
            maxLat = juce::jmax (maxLat, chanLat[c]);
        }
        maxLat = juce::jmin (maxLat, 16000);

        // delay compensation through the bus tree: every path into a bus (and into Main LR)
        // arrives at the same time, whatever plugins sit on the buses along the way
        int inLat[kNumBuses], outLat[kNumBuses];
        for (int b = 0; b < kNumBuses; ++b) inLat[b] = maxLat;
        int mainIn = maxLat;
        for (int oi = 0; oi < kNumBuses; ++oi)
        {
            const int b = plan->busOrder[(size_t) oi];
            int lat = 0;
            for (auto& r : plan->buses[(size_t) b].inserts)
                if (r.insert) lat += r.insert->getLatency();
            outLat[b] = juce::jmin (inLat[b] + lat, 16000);
            const int t = plan->buses[(size_t) b].to;
            if (t >= 0) inLat[t] = juce::jmax (inLat[t], outLat[b]);
            else if (t == -2) mainIn = juce::jmax (mainIn, outLat[b]);
        }
        pdcSamples.store (mainIn, std::memory_order_relaxed);

        busBuf.clear (0, n);
        busFeed.clear (0, n);
        mainFromBuses.clear (0, n);
        mainBuf.clear (0, n);
        cueBuf.clear (0, n);
        float* mainL = mainBuf.getWritePointer (0);
        float* mainR = mainBuf.getWritePointer (1);
        float* cueL = cueBuf.getWritePointer (0);
        float* cueR = cueBuf.getWritePointer (1);

        // ------------------------------------------------------------ channels
        for (int c = 0; c < kNumChannels; ++c)
        {
            auto& st = ch[(size_t) c];
            const auto& cp = plan->channels[(size_t) c];
            const float panAngle = (cp.pan + 1.0f) * juce::MathConstants<float>::pi * 0.25f;
            st.post.set (cp.post);
            st.main.set (cp.mainGain);
            st.panL.set (std::cos (panAngle));
            st.panR.set (std::sin (panAngle));
            st.cue.set (cp.cue);
            for (int b = 0; b < kNumBuses; ++b) st.sends[(size_t) b].set (cp.sendGain[(size_t) b]);

            if (cp.source == ChannelPlan::Source::none && ! cp.playback && cp.inserts.empty())
            {
                meters[(size_t) c].raise (0, 0);
                continue; // nothing patched: skip DSP
            }

            float* x = chanBuf.getWritePointer (c);
            const int delaySamples = (int) (cp.delayMs * 0.001 * sampleRate);
            const uint32_t taps = cp.tapMask;
            float* tapIn = (taps & 1u) ? tapBuf.getWritePointer (0) : nullptr;
            // Channels have no built-in processing: input gain/polarity and delay, then the plugin rack.
            for (int i = 0; i < n; ++i)
            {
                float smp = sourceSample (st, cp, inPtrs, ni, i) * cp.gain;
                if (tapIn) tapIn[i] = smp; // INPUT tap: gain only
                if (delaySamples > 0) smp = st.delay.run (smp, delaySamples);
                x[i] = smp;
            }
            // the rack, capturing mid-rack PRE taps (after k plugins) on the way
            int latSoFar = 0;
            int tapLat[kMaxInserts] {};
            for (int k = 0; k < (int) cp.inserts.size(); ++k)
            {
                if (k > 0 && k < kMaxInserts && (taps & (1u << k)))
                {
                    juce::FloatVectorOperations::copy (tapBuf.getWritePointer (k), x, n);
                    tapLat[k] = latSoFar;
                }
                if (auto& r = cp.inserts[(size_t) k]; r.insert)
                {
                    r.insert->process (&x, 1, n);
                    latSoFar += r.insert->getLatency();
                }
            }
            const int comp = maxLat - chanLat[c];
            if (comp > 0)
                for (int i = 0; i < n; ++i) x[i] = st.pdc.run (x[i], comp);
            // earlier taps get the rest of the delay, so every tap stays in time with everything else
            for (int k = 0; k < kMaxInserts; ++k)
            {
                if (! (taps & (1u << k))) continue;
                const int tc = juce::jlimit (0, 16000, maxLat - tapLat[k]);
                float* t = tapBuf.getWritePointer (k);
                if (tc > 0)
                    for (int i = 0; i < n; ++i) t[i] = st.tapPdc[(size_t) k].run (t[i], tc);
            }

            // only the sends that are on (or still fading out): 64 buses, most unused per channel
            int active[kNumBuses];
            const float* src[kNumBuses];
            int numActive = 0;
            for (int b = 0; b < kNumBuses; ++b)
            {
                auto& sm = st.sends[(size_t) b];
                if (sm.target != 0.0f || std::abs (sm.cur) > 1.0e-6f)
                {
                    const auto tap = cp.sendTap[(size_t) b];
                    const int after = cp.sendAfter[(size_t) b];
                    src[numActive] = tap == ChannelPlan::Tap::input ? tapBuf.getReadPointer (0)
                                   : tap == ChannelPlan::Tap::pre && after < kMaxInserts && (taps & (1u << after)) ? tapBuf.getReadPointer (after)
                                                                                                                 : x;
                    active[numActive++] = b;
                }
                else sm.cur = 0.0f;
            }

            float peak = 0;
            constexpr float sqrt2 = juce::MathConstants<float>::sqrt2;
            for (int i = 0; i < n; ++i)
            {
                const float s = x[i];
                peak = juce::jmax (peak, std::abs (s));
                const float post = st.post.next (k);
                const float pl = st.panL.next (k), pr = st.panR.next (k);
                const float m = s * post * st.main.next (k);
                mainL[i] += m * pl;
                mainR[i] += m * pr;
                const float cue = st.cue.next (k);
                if (cue != 0)
                {
                    if (cp.cuePre) { cueL[i] += s * cue; cueR[i] += s * cue; }
                    else { cueL[i] += s * cue * pl; cueR[i] += s * cue * pr; }
                }
                for (int a = 0; a < numActive; ++a)
                {
                    const int b = active[a];
                    const float g = st.sends[(size_t) b].next (k);
                    if (g == 0) continue;
                    // route: panned exactly like Main LR; psp: panned, unity at centre;
                    // input / pre / post: mono into both sides of the bus
                    const auto tap = cp.sendTap[(size_t) b];
                    const float gl = tap == ChannelPlan::Tap::route ? pl : tap == ChannelPlan::Tap::psp ? pl * sqrt2 : 1.0f;
                    const float gr = tap == ChannelPlan::Tap::route ? pr : tap == ChannelPlan::Tap::psp ? pr * sqrt2 : 1.0f;
                    const float v = src[a][i] * g;
                    busBuf.getWritePointer (b * 2)[i] += v * gl;
                    busBuf.getWritePointer (b * 2 + 1)[i] += v * gr;
                }
            }
            meters[(size_t) c].raise (peak, peak);
        }

        // ------------------------------------------------------------ talkback
        if (plan->talkbackGain > 0 && plan->talkbackInput >= 0 && plan->talkbackInput < ni && inPtrs[plan->talkbackInput])
            for (int b = 0; b < kNumBuses; ++b)
                if (plan->talkbackDest[(size_t) b])
                    for (int side = 0; side < 2; ++side)
                        juce::FloatVectorOperations::addWithMultiply (busBuf.getWritePointer (b * 2 + side), inPtrs[plan->talkbackInput], plan->talkbackGain, n);

        // ------------------------------------------------------------ buses
        for (int oi = 0; oi < kNumBuses; ++oi)
        {
            const int b = plan->busOrder[(size_t) oi]; // sources before the buses they feed
            auto& st = bus[(size_t) b];
            const auto& bp = plan->buses[(size_t) b];
            float* lr[2] = { busBuf.getWritePointer (b * 2), busBuf.getWritePointer (b * 2 + 1) };
            // channel part delayed to line up with other buses feeding this one, then add those
            if (const int cd = inLat[b] - maxLat; cd > 0)
                for (int side = 0; side < 2; ++side)
                    for (int i = 0; i < n; ++i) lr[side][i] = st.chanPdc[(size_t) side].run (lr[side][i], cd);
            for (int side = 0; side < 2; ++side)
                juce::FloatVectorOperations::add (lr[side], busFeed.getReadPointer (b * 2 + side), n);
            const int d = (int) (bp.delayMs * 0.001 * sampleRate);
            if (d > 0)
                for (int side = 0; side < 2; ++side)
                    for (int i = 0; i < n; ++i) lr[side][i] = st.delay[(size_t) side].run (lr[side][i], d);
            for (auto& r : bp.inserts)
                if (r.insert) r.insert->process (lr, 2, n);
            st.out.set (bp.out);
            st.cuePre.set (bp.cuePre);
            st.cuePost.set (bp.cuePost);
            float pl = 0, pr = 0;
            for (int i = 0; i < n; ++i)
            {
                const float cpre = st.cuePre.next (k);
                cueL[i] += lr[0][i] * cpre;
                cueR[i] += lr[1][i] * cpre;
                const float g = st.out.next (k);
                lr[0][i] *= g;
                lr[1][i] *= g;
                const float cpost = st.cuePost.next (k);
                cueL[i] += lr[0][i] * cpost;
                cueR[i] += lr[1][i] * cpost;
                pl = juce::jmax (pl, std::abs (lr[0][i]));
                pr = juce::jmax (pr, std::abs (lr[1][i]));
            }
            meters[(size_t) (kNumChannels + b)].raise (pl, pr);

            // on to Main LR or the next bus, delayed to line up with the other paths into it
            if (bp.to != -1)
            {
                const int target = bp.to == -2 ? mainIn : inLat[bp.to];
                const int od = juce::jlimit (0, 16000, target - outLat[b]);
                for (int side = 0; side < 2; ++side)
                {
                    float* dst = bp.to == -2 ? mainFromBuses.getWritePointer (side) : busFeed.getWritePointer (bp.to * 2 + side);
                    if (od > 0)
                        for (int i = 0; i < n; ++i) dst[i] += st.outPdc[(size_t) side].run (lr[side][i], od);
                    else
                        juce::FloatVectorOperations::add (dst, lr[side], n);
                }
            }
        }

        // ------------------------------------------------------------ main
        {
            // channels straight to Main LR, lined up with the bus paths, plus the buses
            if (const int md = mainIn - maxLat; md > 0)
                for (int i = 0; i < n; ++i) { mainL[i] = mainDirectPdc[0].run (mainL[i], md); mainR[i] = mainDirectPdc[1].run (mainR[i], md); }
            juce::FloatVectorOperations::add (mainL, mainFromBuses.getReadPointer (0), n);
            juce::FloatVectorOperations::add (mainR, mainFromBuses.getReadPointer (1), n);
            float* lr[2] = { mainL, mainR };
            for (auto& r : plan->main.inserts)
                if (r.insert) r.insert->process (lr, 2, n);
            const int d = (int) (plan->main.delayMs * 0.001 * sampleRate);
            mainOut.set (plan->main.out);
            float pl = 0, pr = 0;
            for (int i = 0; i < n; ++i)
            {
                if (d > 0) { mainL[i] = mainDelay[0].run (mainL[i], d); mainR[i] = mainDelay[1].run (mainR[i], d); }
                const float g = mainOut.next (k);
                mainL[i] *= g;
                mainR[i] *= g;
                pl = juce::jmax (pl, std::abs (mainL[i]));
                pr = juce::jmax (pr, std::abs (mainR[i]));
            }
            // true-peak metering of the final program (after inserts, delay and fader)
            float tpl = 0, tpr = 0;
            pl = pr = 0;
            for (int i = 0; i < n; ++i)
            {
                tpl = juce::jmax (tpl, outTp[0].process (mainL[i]));
                tpr = juce::jmax (tpr, outTp[1].process (mainR[i]));
                pl = juce::jmax (pl, std::abs (mainL[i]));
                pr = juce::jmax (pr, std::abs (mainR[i]));
            }
            if (tpl > mainTruePeak[0].load (std::memory_order_relaxed)) mainTruePeak[0].store (tpl, std::memory_order_relaxed);
            if (tpr > mainTruePeak[1].load (std::memory_order_relaxed)) mainTruePeak[1].store (tpr, std::memory_order_relaxed);
            meters[kMeterMain].raise (pl, pr);
            loudness.process (mainL, mainR, n);
        }

        // ------------------------------------------------------------ monitor
        {
            const float* srcL = mainL;
            const float* srcR = mainR;
            if (plan->monitorSource == -3) { srcL = cueL; srcR = cueR; }
            else if (plan->monitorSource >= 0 && plan->monitorSource < kNumBuses)
            {
                srcL = busBuf.getReadPointer (plan->monitorSource * 2);
                srcR = busBuf.getReadPointer (plan->monitorSource * 2 + 1);
            }
            monGain.set (plan->monitorGain);
            float* ml = monBuf.getWritePointer (0);
            float* mr = monBuf.getWritePointer (1);
            float pl = 0, pr = 0;
            for (int i = 0; i < n; ++i)
            {
                const float g = monGain.next (k);
                ml[i] = srcL[i] * g;
                mr[i] = srcR[i] * g;
                pl = juce::jmax (pl, std::abs (ml[i]));
                pr = juce::jmax (pr, std::abs (mr[i]));
            }
            meters[kMeterMonitor].raise (pl, pr);
        }

        // ------------------------------------------------------------ output patch
        for (int o = 0; o < no; ++o)
        {
            if (! outPtrs[o]) continue;
            const OutputRoute r = o < (int) plan->outputs.size() ? plan->outputs[(size_t) o] : OutputRoute {};
            const float* src = nullptr;
            const int side = juce::jlimit (0, 1, r.side);
            if (r.source == -2) src = mainBuf.getReadPointer (side);
            else if (r.source == -1) src = monBuf.getReadPointer (side);
            else if (r.source >= 0 && r.source < kNumBuses) src = busBuf.getReadPointer (r.source * 2 + side);
            if (src) juce::FloatVectorOperations::copy (outPtrs[o], src, n);
            else juce::FloatVectorOperations::clear (outPtrs[o], n);
        }
        offset += n;
    }
    blocksDone.fetch_add (1, std::memory_order_release);
}

} // namespace merge

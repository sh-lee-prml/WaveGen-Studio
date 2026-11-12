#pragma once
// Original deterministic character DSP for WaveGen Studio. No model/runtime dependency.
// Processing is mono 24 kHz, keeps the exact sample count, and never extends tails.
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>

namespace wavegen_character {
constexpr int RATE=24000;
constexpr double PI=3.1415926535897932384626433832795;
constexpr float CEILING=23197.0f/32768.0f; // PCM16-grid ceiling at or below -3 dBFS.
struct Cancelled:std::runtime_error{Cancelled():std::runtime_error("Character processing cancelled"){};};
using Cancel=std::function<bool()>;
struct Profile {
    const char* id;const char* category;double semitones,drive,highpass,lowpass,ring_hz,ring_mix;
    double chorus_ms,chorus_depth_ms,chorus_hz,chorus_mix,echo_ms,echo_mix,sub_mix;
    int bits,hold;double digital_mix;
};
inline const std::array<Profile,24>& profiles(){
    static const std::array<Profile,24> value={{
        {"basalt","monster",-5,1.9,45,4200,0,0,0,0,0,0,0,0,0,16,1,0},
        {"obsidian","monster",-3,1.35,55,2700,0,0,0,0,0,0,87,.22,0,16,1,0},
        {"abyss","monster",-6.5,1.15,30,4200,0,0,0,0,0,0,0,0,.10,16,1,0},
        {"orbit","alien",3,1,180,6200,43,.32,0,0,0,0,0,0,0,16,1,0},
        {"vega","alien",5.5,1,100,8500,0,0,9,.6,4.6,.35,0,0,0,16,1,0},
        {"helmet","space",0,1.45,350,3200,0,0,0,0,0,0,67,.2,0,16,1,0},
        {"tin","robot",0,1.15,180,6000,72,.57,0,0,0,0,0,0,0,16,1,0},
        {"pixel","robot",0,1.25,90,7000,0,0,0,0,0,0,0,0,0,8,3,.64},
        {"prism","fantasy",4,1,110,9000,0,0,12,2.2,.85,.28,0,0,0,16,1,0},
        {"wisp","fantasy",0,1,620,7500,0,0,19,4.5,.42,.48,113,.15,0,16,1,0},
        {"pip","strange",7,1.65,130,8000,0,0,0,0,0,0,0,0,0,16,1,0},
        {"tidal","strange",0,1,120,6800,0,0,16,6.0,1.55,.58,41,.13,0,16,1,0},
        {"ember","narration",0,1.08,65,5900,0,0,0,0,0,0,0,0,0,16,1,0},
        {"atlas","narration",-1.75,1.16,60,6000,0,0,0,0,0,0,0,0,0,16,1,0},
        {"lumen","narration",0,1,155,10300,0,0,0,0,0,0,0,0,0,16,1,0},
        {"nova","animation",1.75,1.08,110,9500,0,0,0,0,0,0,0,0,0,16,1,0},
        {"sprocket","animation",3,1.32,125,7800,0,0,0,0,0,0,0,0,0,16,1,0},
        {"valor","game",-1,1.38,75,6600,0,0,0,0,0,0,0,0,0,16,1,0},
        {"shade","game",-.75,1.12,280,4500,0,0,0,0,0,0,29,.055,0,16,1,0},
        {"briar","fantasy",-2.5,1.10,80,5600,0,0,0,0,0,0,22,.04,0,16,1,0},
        {"rune","fantasy",-1.5,1,160,7800,0,0,15,.75,.32,.15,85,.07,0,16,1,0},
        {"sprite","fantasy",2.75,1,120,9400,0,0,16,1.1,1.25,.20,0,0,0,16,1,0},
        {"moss","monster",-4,1.50,50,3900,0,0,0,0,0,0,43,.10,0,16,1,0},
        {"drake","monster",-5.5,1.65,40,4700,0,0,0,0,0,0,0,0,.065,16,1,0}
    }};return value;
}
inline const Profile& profile(const std::string& id){for(const auto& item:profiles())if(id==item.id)return item;throw std::invalid_argument("Unknown character effect: "+id);}
inline void check_cancel(const Cancel& cancel){if(cancel&&cancel())throw Cancelled();}
inline void fft(std::vector<std::complex<double>>& a,bool inverse){
    const size_t n=a.size();
    for(size_t i=1,j=0;i<n;++i){size_t bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j)std::swap(a[i],a[j]);}
    for(size_t length=2;length<=n;length<<=1){const double angle=(inverse?2:-2)*PI/length;const std::complex<double> step(std::cos(angle),std::sin(angle));
        for(size_t first=0;first<n;first+=length){std::complex<double> phase(1,0);for(size_t j=0;j<length/2;++j){const auto even=a[first+j],odd=a[first+j+length/2]*phase;a[first+j]=even+odd;a[first+j+length/2]=even-odd;phase*=step;}}}
    if(inverse)for(auto& sample:a)sample/=double(n);
}
inline std::vector<float> pitch(const std::vector<float>& input,double semitones,const Cancel& cancel={}){
    if(std::abs(semitones)<1e-12||input.size()<64)return input;
    // STFT instantaneous-frequency remapping. Hann analysis/synthesis and overlap
    // weights preserve duration; pitch also intentionally shifts spectral color.
    constexpr size_t n=1024,hop=128,bins=n/2+1;
    const double ratio=std::exp2(semitones/12.0),advance=2*PI*hop/n;
    std::vector<double> previous(bins),phase(bins),magnitude(bins),frequency(bins),weight(input.size()),sum(input.size());
    std::vector<std::complex<double>> frame(n);
    std::array<double,n> window{};for(size_t i=0;i<n;++i)window[i]=.5-.5*std::cos(2*PI*i/n);
    bool first=true;
    for(int64_t start=-int64_t(n);start<int64_t(input.size());start+=hop){
        check_cancel(cancel);
        for(size_t i=0;i<n;++i){const auto at=start+int64_t(i);frame[i]=at>=0&&size_t(at)<input.size()?double(input[size_t(at)])*window[i]:0;}
        fft(frame,false);std::fill(magnitude.begin(),magnitude.end(),0);std::fill(frequency.begin(),frequency.end(),0);
        for(size_t k=0;k<bins;++k){
            const double angle=std::arg(frame[k]),amplitude=std::abs(frame[k]);
            const double delta=std::remainder(angle-previous[k]-advance*k,2*PI);previous[k]=angle;
            const double instantaneous=(double(k)+delta/advance)*ratio;
            const auto target=size_t(std::llround(k*ratio));
            if(target<bins){magnitude[target]+=amplitude;frequency[target]+=amplitude*instantaneous;}
        }
        std::fill(frame.begin(),frame.end(),std::complex<double>(0,0));
        for(size_t k=0;k<bins;++k){
            const double f=magnitude[k]>1e-18?frequency[k]/magnitude[k]:double(k);
            phase[k]=std::remainder(phase[k]+advance*f,2*PI);
            frame[k]=std::polar(magnitude[k],phase[k]);
            if(k==0||k==n/2)frame[k]={frame[k].real(),0};else frame[n-k]=std::conj(frame[k]);
        }
        fft(frame,true);
        for(size_t i=0;i<n;++i){const auto at=start+int64_t(i);if(at>=0&&size_t(at)<input.size()){sum[size_t(at)]+=frame[i].real()*window[i];weight[size_t(at)]+=window[i]*window[i];}}
        first=false;
    }
    std::vector<float> output(input.size());
    for(size_t i=0;i<input.size();++i)output[i]=float(weight[i]>1e-12?sum[i]/weight[i]:0);
    return output;
}
inline double sample_at(const std::vector<float>& samples,double position){
    if(position<0||position>=double(samples.size()-1))return position==double(samples.size()-1)?samples.back():0;
    const auto index=size_t(position);const double fraction=position-index;return samples[index]*(1-fraction)+samples[index+1]*fraction;
}
struct Result {std::vector<float> samples;double peak=0,gain=1;bool silence_bypass=false;};
inline Result process(const std::vector<float>& input,const std::string& id,const Cancel& cancel={}){
    const auto& p=profile(id);check_cancel(cancel);
    if(input.empty())throw std::invalid_argument("Character audio must not be empty");
    double input_power=0;bool nonzero=false;
    for(size_t i=0;i<input.size();++i){if((i&8191)==0)check_cancel(cancel);if(!std::isfinite(input[i]))throw std::invalid_argument("Character audio contains a nonfinite sample");input_power+=double(input[i])*input[i];nonzero|=input[i]!=0;}
    if(!nonzero)return {input,0,1,true};
    auto work=pitch(input,p.semitones,cancel);
    if(p.sub_mix>0){auto sub=pitch(input,p.semitones-12,cancel);for(size_t i=0;i<work.size();++i)work[i]=float((1-p.sub_mix)*work[i]+p.sub_mix*sub[i]);}
    const double hp=std::exp(-2*PI*p.highpass/RATE),lp=1-std::exp(-2*PI*p.lowpass/RATE);
    double old_input=0,high=0,low=0;const double drive_denominator=std::tanh(p.drive);
    for(size_t i=0;i<work.size();++i){
        if((i&8191)==0)check_cancel(cancel);
        double x=work[i];high=hp*(high+x-old_input);old_input=x;low+=lp*(high-low);x=low;
        if(p.drive>1)x=std::tanh(x*p.drive)/drive_denominator;
        if(p.ring_mix>0)x*=1-p.ring_mix+p.ring_mix*std::sin(2*PI*p.ring_hz*i/RATE);
        work[i]=float(x);
    }
    if(p.digital_mix>0){double held=0;const double steps=std::ldexp(1.0,p.bits-1);for(size_t i=0;i<work.size();++i){if((i&8191)==0)check_cancel(cancel);if(i%size_t(p.hold)==0)held=std::round(work[i]*steps)/steps;work[i]=float((1-p.digital_mix)*work[i]+p.digital_mix*held);}}
    if(p.chorus_mix>0||p.echo_mix>0){const auto dry=work;for(size_t i=0;i<work.size();++i){
        if((i&8191)==0)check_cancel(cancel);double x=dry[i];
        if(p.chorus_mix>0){const double delay=(p.chorus_ms+p.chorus_depth_ms*std::sin(2*PI*p.chorus_hz*i/RATE))*RATE/1000;
            const double second=(p.chorus_ms*1.37+p.chorus_depth_ms*.73*std::sin(2*PI*p.chorus_hz*.81*i/RATE+1.2))*RATE/1000;
            x=(1-p.chorus_mix)*x+p.chorus_mix*.5*(sample_at(dry,double(i)-delay)+sample_at(dry,double(i)-second));}
        if(p.echo_mix>0)x+=p.echo_mix*sample_at(dry,double(i)-p.echo_ms*RATE/1000);
        work[i]=float(x);
    }}
    double power=0,peak=0;for(size_t i=0;i<work.size();++i){if((i&8191)==0)check_cancel(cancel);if(!std::isfinite(work[i]))throw std::runtime_error("Character processing produced a nonfinite sample");power+=double(work[i])*work[i];peak=std::max(peak,std::abs(double(work[i])));}
    // Match the source's RMS gently, then reserve 3 dB of peak headroom. No
    // threshold turns quiet input into silence and no unrelated noise is added.
    double gain=power>0?std::min(2.0,std::sqrt(input_power/power)):1;
    if(peak>0)gain=std::min(gain,double(CEILING)/peak);
    for(size_t i=0;i<work.size();++i){if((i&8191)==0)check_cancel(cancel);work[i]=float(std::clamp(double(work[i])*gain,-double(CEILING),double(CEILING)));}
    check_cancel(cancel);return {std::move(work),peak*gain,gain,false};
}
} // namespace wavegen_character

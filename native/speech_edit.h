#pragma once

// Pure PCM editing helpers. Source samples are copied unchanged except for
// 5 ms ramps immediately at an edit boundary; no resampling/time stretching.
namespace wavegen_edit {
struct Range {size_t start=0,end=0;};
inline Range select(size_t samples,double start_seconds,double end_seconds){
    require(std::isfinite(start_seconds)&&std::isfinite(end_seconds)&&start_seconds>=0&&end_seconds>start_seconds,"Select a valid audio range");
    require(end_seconds<=double(samples)/SAMPLE_RATE+0.5/SAMPLE_RATE,"Selected range exceeds source audio");
    Range range{size_t(std::llround(start_seconds*SAMPLE_RATE)),size_t(std::llround(end_seconds*SAMPLE_RATE))};
    require(range.end<=samples&&range.end>range.start&&range.end-range.start>=size_t(SAMPLE_RATE/10),"Select at least 0.1 seconds of audio");
    return range;
}
inline void fade_in(std::vector<float>& samples,size_t start,size_t end){
    const size_t length=std::min(size_t(SAMPLE_RATE/200),end-start);
    if(length<2)return;
    for(size_t i=0;i<length;++i)samples[start+i]*=float(i)/float(length-1);
}
inline void fade_out(std::vector<float>& samples,size_t start,size_t end){
    const size_t length=std::min(size_t(SAMPLE_RATE/200),end-start);
    if(length<2)return;
    for(size_t i=0;i<length;++i)samples[end-1-i]*=float(i)/float(length-1);
}
inline std::vector<float> apply(const std::vector<float>& source,Range range,const std::string& operation,const std::vector<float>& replacement={}){
    require(range.start<range.end&&range.end<=source.size(),"Invalid edit sample range");
    if(operation=="keep"){
        std::vector<float> output(source.begin()+range.start,source.begin()+range.end);
        fade_in(output,0,output.size());fade_out(output,0,output.size());return output;
    }
    require(operation=="cut"||operation=="regenerate","Unsupported edit operation");
    require(operation!="regenerate"||!replacement.empty(),"Replacement audio is empty");
    const size_t inserted=operation=="regenerate"?replacement.size():0;
    require(source.size()-(range.end-range.start)+inserted>0,"The edit would remove all audio");
    std::vector<float> output;output.reserve(source.size()-(range.end-range.start)+inserted);
    output.insert(output.end(),source.begin(),source.begin()+range.start);
    if(inserted)output.insert(output.end(),replacement.begin(),replacement.end());
    output.insert(output.end(),source.begin()+range.end,source.end());
    const size_t right=range.start+inserted;
    if(range.start)fade_out(output,0,range.start);
    if(inserted){fade_in(output,range.start,right);fade_out(output,range.start,right);}
    if(right<output.size())fade_in(output,right,output.size());
    return output;
}
} // namespace wavegen_edit

#pragma once
#ifndef WAVEGEN_EMBEDDED
#define WAVEGEN_EMBEDDED
#define WAVEGEN_RESIDENT_UNDEFINE_EMBEDDED
#endif
#include "main.cpp"
#ifdef WAVEGEN_RESIDENT_UNDEFINE_EMBEDDED
#undef WAVEGEN_EMBEDDED
#undef WAVEGEN_RESIDENT_UNDEFINE_EMBEDDED
#endif
#include <atomic>
#include <functional>
#include <mutex>

namespace wavegen_resident {

struct Config {
    fs::path model_path, assets_directory, cuda_dll_directory;
    bool use_tf32=false;
    std::string model_id="flash";
};
struct Status {
    bool ready=false,busy=false;
    uint64_t load_count=0,completed_requests=0,binding_rebuild_count=0;
    std::string session_id,precision,model_id="flash";
    double model_load_seconds=0;
    size_t current_frames=0;
    uint32_t load_thread_id=0,last_generation_thread_id=0;
    size_t steps=4,model_evaluations=0,ort_runs=0,step_index=0,step_count=0;
    double cfg_strength=0;
};
struct Segment {
    std::string text;
    size_t frames=0;
    double duration_seconds=0,generation_seconds=0;
    size_t samples=0;
};
struct Plan {
    std::vector<Segment> segments;
    double duration_seconds=0;
    size_t prompt_frames=0;
    size_t samples=0;
};
class Cancelled : public std::runtime_error {
public:
    Cancelled():std::runtime_error("Generation cancelled"){}
};
using ProgressCallback=std::function<void(size_t completed,size_t total,const std::string& chunk_text)>;
using StepProgressCallback=std::function<void(size_t completed,size_t total)>;
struct Result {
    fs::path output_path;
    double duration_seconds=0,synthesis_seconds=0,frontend_seconds=0,request_seconds=0,model_load_seconds=0;
    uint64_t load_count=0,request_index=0,binding_rebuild_count=0;
    std::string session_id,precision,frontend_precision,model_id="flash";
    size_t frames=0,prompt_frames=0;
    std::vector<Segment> segments;
    size_t steps=4,model_evaluations=0,ort_runs=0;
    double cfg_strength=0;
};
struct ReferenceInfo {
    int sample_rate=SAMPLE_RATE;
    size_t samples=0;
    double duration_seconds=0,rms=0;
};

// Exactly one ORT session and one GPU weight allocation for the object's lifetime.
// The graph stays dynamic. Changing utterance length replaces only I/O buffers;
// no padding buckets, graph re-export, session recreation or model reload occur.
class ResidentEngine {
    Config config_;
    Ort::Env environment_{ORT_LOGGING_LEVEL_WARNING,"wavegen_resident"};
    Ort::SessionOptions session_options_;
    std::unique_ptr<GpuContext> gpu_;
    std::unique_ptr<Ort::Session> session_;
    std::unique_ptr<CudaBinding> binding_;
    std::unique_ptr<VSpecCudaBinding> vspec_binding_;
    std::vector<float> vspec_times_;
    mutable std::mutex generation_mutex_;
    std::atomic<bool> busy_{false};
    std::atomic<uint64_t> completed_{0},binding_rebuilds_{0};
    std::atomic<size_t> current_frames_{0};
    std::atomic<uint32_t> generation_thread_{0};
    std::atomic<size_t> model_evaluations_{0},ort_runs_{0},step_index_{0},step_count_{0};
    double load_seconds_=0;
    std::string session_id_,precision_="BF16";
    uint32_t load_thread_=0;
    using ContextGet=int(*)(void**);
    using ContextSet=int(*)(void*);
    using SetDevice=int(*)(int);
    ContextSet set_context_=nullptr;
    SetDevice set_device_=nullptr;
    void* cuda_context_=nullptr;

    void activate_context() const {
        require(set_device_&&set_context_&&cuda_context_,"Resident CUDA context is not initialized");
        require(set_device_(0)==0,"Cannot activate CUDA device 0 on request thread");
        require(set_context_(cuda_context_)==0,"Cannot bind resident CUDA context to request thread");
    }
public:
    explicit ResidentEngine(const Config& config):config_(config){
        auto start=Clock::now();load_thread_=GetCurrentThreadId();
        config_.model_path=fs::absolute(config_.model_path);
        config_.assets_directory=fs::absolute(config_.assets_directory);
        config_.cuda_dll_directory=fs::absolute(config_.cuda_dll_directory);
        require(fs::is_regular_file(config_.model_path),"Resident ONNX model is missing");
        require(fs::is_directory(config_.assets_directory),"Resident model assets directory is missing");
        require(config_.model_id=="flash"||config_.model_id=="vspec","Unknown resident model_id");
        const bool vspec=config_.model_id=="vspec";
        if(vspec)vspec_times_=VSpecCudaBinding::schedule(config_.assets_directory);
        setup_dlls(config_.cuda_dll_directory);
        gpu_=std::make_unique<GpuContext>();
        session_options_.SetIntraOpNumThreads(1);
        session_options_.SetInterOpNumThreads(1);
        session_options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        // Do not call AddFreeDimensionOverrideByName: frames can vary per request.
        const std::string stream=std::to_string(reinterpret_cast<uintptr_t>(gpu_->stream));
        OrtCUDAProviderOptionsV2* cuda=nullptr;
        Ort::ThrowOnError(Ort::GetApi().CreateCUDAProviderOptions(&cuda));
        const char* keys[]={"device_id","cudnn_conv_algo_search","do_copy_in_default_stream","use_tf32","user_compute_stream","enable_cuda_graph"};
        const char* values[]={"0","HEURISTIC","1",config_.use_tf32?"1":"0",stream.c_str(),"0"};
        try {
            Ort::ThrowOnError(Ort::GetApi().UpdateCUDAProviderOptions(cuda,keys,values,6));
            session_options_.AppendExecutionProvider_CUDA_V2(*cuda);
        } catch(...) { Ort::GetApi().ReleaseCUDAProviderOptions(cuda);throw; }
        Ort::GetApi().ReleaseCUDAProviderOptions(cuda);
        session_=std::make_unique<Ort::Session>(environment_,config_.model_path.c_str(),session_options_);
        require(session_->GetInputCount()==(vspec?9:6)&&session_->GetOutputCount()==2,"Selected model does not match the resident graph interface");
        Ort::AllocatorWithDefaultOptions allocator;
        auto metadata=session_->GetModelMetadata();
        auto model_id=metadata.LookupCustomMetadataMapAllocated("model_id",allocator);
        require((vspec&&model_id&&std::string(model_id.get())=="vspec")||(!vspec&&(!model_id||std::string(model_id.get())=="flash")),"Selected model does not match graph model_id metadata");
        const char* flash_names[]={"wav_state","mel_state","wav_cond","mel_cond","text_ids","time"};
        const char* vspec_names[]={"wav_state","mel_state","wav_cond","mel_cond","text_ids","time","prompt_frames","step_index","bottleneck_keep"};
        for(size_t i=0;i<session_->GetInputCount();++i){auto name=session_->GetInputNameAllocated(i,allocator);require(std::string(name.get())==(vspec?vspec_names[i]:flash_names[i]),"Selected model graph has an unexpected input name");}
        for(size_t i=0;i<2;++i){auto name=session_->GetOutputNameAllocated(i,allocator);require(std::string(name.get())==(vspec?(i?"mel_velocity":"wav_velocity"):(i?"pred_mel":"pred_wav")),"Selected model graph has an unexpected output name");}
        auto precision=metadata.LookupCustomMetadataMapAllocated("precision",allocator);
        if(precision)precision_=precision.get();
        gpu_->compile();
        HMODULE runtime=GetModuleHandleW(L"cudart64_12.dll");
        HMODULE driver=GetModuleHandleW(L"nvcuda.dll");
        require(runtime&&driver,"Resident CUDA libraries are missing");
        set_device_=reinterpret_cast<SetDevice>(GetProcAddress(runtime,"cudaSetDevice"));
        set_context_=reinterpret_cast<ContextSet>(GetProcAddress(driver,"cuCtxSetCurrent"));
        auto get_context=reinterpret_cast<ContextGet>(GetProcAddress(driver,"cuCtxGetCurrent"));
        require(get_context&&get_context(&cuda_context_)==0&&cuda_context_,"Cannot capture resident CUDA context");
        activate_context();
        std::ostringstream identity;identity<<"ort_session_"<<std::hex<<reinterpret_cast<uintptr_t>(session_.get());session_id_=identity.str();
        load_seconds_=elapsed(start);
    }
    ResidentEngine(const ResidentEngine&)=delete;
    ResidentEngine& operator=(const ResidentEngine&)=delete;
    ~ResidentEngine(){
        // Destruction may occur on a different thread from construction too.
        try{activate_context();}catch(...){/* Destructors cannot report errors. */}
    }
    Status status() const {
        Status s;s.ready=bool(session_);s.busy=busy_.load();s.load_count=session_?1:0;
        s.completed_requests=completed_.load();s.binding_rebuild_count=binding_rebuilds_.load();
        s.session_id=session_id_;s.precision=precision_;s.model_load_seconds=load_seconds_;
        s.current_frames=current_frames_.load();s.load_thread_id=load_thread_;s.last_generation_thread_id=generation_thread_.load();
        s.model_id=config_.model_id;s.steps=config_.model_id=="vspec"?50:4;s.cfg_strength=config_.model_id=="vspec"?1.25:0;
        s.model_evaluations=model_evaluations_.load();s.ort_runs=ort_runs_.load();s.step_index=step_index_.load();s.step_count=step_count_.load();return s;
    }
    static ReferenceInfo validate_reference(const fs::path& path){
        auto samples=read_wav(path);double square_sum=0;for(float x:samples)square_sum+=double(x)*x;
        ReferenceInfo info;info.samples=samples.size();info.duration_seconds=double(samples.size())/SAMPLE_RATE;info.rms=std::sqrt(square_sum/samples.size());
        require(info.rms>1e-8,"Reference audio is silent");
        require(info.duration_seconds<30,"Reference audio must leave room for generation within 30 seconds");return info;
    }
    static std::vector<std::string> split_text(size_t reference_samples,const std::string& ref_text,const std::string& text,double speed){
        require(!text.empty()&&text.size()<=5000,"Text must contain between 1 and 5000 UTF-8 bytes");
        require(!ref_text.empty()&&std::isfinite(speed)&&speed>0,"Invalid transcript or speed");
        normalize_english(text);normalize_english(ref_text);
        const std::string ref=reference_text_prefix(ref_text);
        auto fits=[&](size_t bytes){const auto d=estimate_duration(reference_samples,ref.size(),bytes,speed);return d.frames<=1500&&d.generated<=18*SAMPLE_RATE;};
        std::vector<std::string> chunks;size_t begin=0;
        while(begin<text.size()){
            require(chunks.size()<100,"Text requires more than 100 segments; reduce text or increase speed");
            size_t low=0,high=text.size()-begin;
            while(low<high){size_t middle=low+(high-low+1)/2;if(fits(middle))low=middle;else high=middle-1;}
            require(low>0,"Reference duration/speed leaves no room for generated text");
            size_t limit=begin+low,end=limit;
            if(limit<text.size()){
                size_t sentence=begin,word=begin;
                for(size_t i=begin;i<limit;++i){unsigned char c=text[i];if(std::isspace(c))word=i+1;
                    if(c=='\n'||((c=='.'||c=='?'||c=='!')&&(i+1==text.size()||std::isspace(static_cast<unsigned char>(text[i+1])))))sentence=i+1;
                }
                end=sentence>begin?sentence:word>begin?word:limit;
                while(end<limit&&std::isspace(static_cast<unsigned char>(text[end])))++end;
                // Last-resort split for a single overlong word preserves UTF-8.
                while(end>begin&&end<text.size()&&(static_cast<unsigned char>(text[end])&0xc0)==0x80)--end;
            }
            require(end>begin,"Cannot split text at a valid boundary");
            std::string chunk=text.substr(begin,end-begin);
            if(chunk.find_first_not_of(" \t\r\n")==std::string::npos){
                require(!chunks.empty(),"Leading whitespace exceeds the segment budget");
                require(fits(chunks.back().size()+chunk.size()),"Trailing whitespace exceeds the segment budget");chunks.back()+=chunk;
            }else chunks.push_back(std::move(chunk));
            begin=end;
        }
        std::string joined;for(const auto& chunk:chunks)joined+=chunk;require(joined==text,"Text splitting omitted input content");return chunks;
    }
    // Reads only the WAV; no model, vocabulary, CUDA context or ORT session is
    // required. The server can offer this while the model is still loading.
    static Plan plan(const fs::path& reference_wav,const std::string& ref_text,const std::string& text,double speed,bool split_long_text=true,double duration_seconds=0){
        require(!ref_text.empty()&&ref_text.find_first_not_of(" \t\r\n")!=std::string::npos,"Reference transcript is empty");
        require(!text.empty()&&text.find_first_not_of(" \t\r\n")!=std::string::npos,"Generation text is empty");
        require(text.size()<=5000,"Generation text exceeds 5000 UTF-8 bytes");
        require(std::isfinite(duration_seconds)&&(duration_seconds==0||(duration_seconds>=0.2&&duration_seconds<=600)),"Target duration must be 0 (automatic) or between 0.2 and 600 seconds");
        if(duration_seconds>0)speed=1;
        require(std::isfinite(speed)&&speed>=0.25&&speed<=4.0,"Speed must be between 0.25 and 4");
        normalize_english(ref_text);normalize_english(text);
        const auto reference=validate_reference(reference_wav);
        const std::string prefix=reference_text_prefix(ref_text);
        const size_t requested_samples=duration_seconds>0?size_t(std::llround(duration_seconds*SAMPLE_RATE)):0;
        // Fixed mode asks the model for its output sample budget directly. The
        // ratio below chooses text boundaries; it never time-stretches audio.
        const auto auto_length=estimate_duration(reference.samples,prefix.size(),text.size(),speed);
        const double split_speed=requested_samples?double(auto_length.prompt)/prefix.size()*text.size()/requested_samples:speed;
        const auto chunks=split_long_text?split_text(reference.samples,ref_text,text,split_speed):std::vector<std::string>{text};
        std::vector<size_t> fixed_samples(chunks.size(),0);
        if(requested_samples){
            const size_t gaps=(chunks.size()-1)*size_t(SAMPLE_RATE*0.12);
            require(requested_samples>gaps+chunks.size(),"Target duration is too short for the required sections and gaps");
            const size_t available=requested_samples-gaps;
            size_t allocated=0;
            for(size_t i=0;i<chunks.size();++i){fixed_samples[i]=size_t((static_cast<long double>(available)*chunks[i].size())/text.size());allocated+=fixed_samples[i];}
            for(size_t i=0;allocated<available;++allocated,++i)++fixed_samples[i%fixed_samples.size()];
        }
        Plan result;size_t total_samples=0;
        for(size_t index=0;index<chunks.size();++index){
            const auto& chunk=chunks[index];
            const auto d=requested_samples?estimate_duration_samples(reference.samples,fixed_samples[index]):estimate_duration(reference.samples,prefix.size(),chunk.size(),speed);
            require(d.generated>0,"Predicted output is empty; use a longer reference or slower speed");
            require(d.frames<=1500,"Prompt plus generated audio exceeds 30 seconds; enable automatic splitting or shorten text/reference");
            // Inference stores one token character per frame. Refuse inputs that
            // would otherwise silently lose text, without altering valid tokens.
            require(tokenize_characters(prefix+chunk).size()<=d.frames,"Reference transcript or generation text is too dense for the audio duration; check the reference transcript, use a longer reference or lower the speed");
            result.segments.push_back({chunk,d.frames,double(d.generated)/SAMPLE_RATE,0,d.generated});
            result.prompt_frames=d.prompt/FRAME;total_samples+=d.generated;
        }
        total_samples+=(chunks.size()-1)*size_t(SAMPLE_RATE*0.12);
        require(!requested_samples||total_samples==requested_samples,"Fixed duration allocation failed");
        result.samples=total_samples;result.duration_seconds=double(total_samples)/SAMPLE_RATE;return result;
    }
    Result synthesize(const fs::path& reference_wav,const std::string& ref_text,const std::string& text,uint64_t seed,double speed,const fs::path& output_wav,ProgressCallback progress={},bool split_long_text=true,std::function<bool()> cancelled={},double duration_seconds=0,StepProgressCallback step_progress={}){
        std::lock_guard<std::mutex> lock(generation_mutex_);
        struct ResetBusy {std::atomic<bool>& flag;~ResetBusy(){flag=false;}} reset{busy_};busy_=true;
        auto start=Clock::now();generation_thread_=GetCurrentThreadId();
        model_evaluations_=0;ort_runs_=0;step_index_=0;step_count_=0;
        const bool vspec=config_.model_id=="vspec";const size_t steps=vspec?50:4;
        const auto check_cancelled=[&](){if(cancelled&&cancelled())throw Cancelled();};
        check_cancelled();
        require(!output_wav.empty(),"Output WAV path is empty");
        Options options;options.model=config_.model_path;options.assets=config_.assets_directory;
        options.cuda_dir=config_.cuda_dll_directory;options.reference=reference_wav;options.ref_text=ref_text;options.text=text;
        options.output=output_wav;options.metrics=fs::path(output_wav.wstring()+L".metrics.json");
        options.seed=seed;options.speed=speed;options.cuda_graph=false;options.gpu_euler=true;
        validate_output_paths(options);
        const auto planned=plan(reference_wav,ref_text,text,speed,split_long_text,duration_seconds);
        const auto& segments=planned.segments;
        step_count_=segments.size()*steps;
        check_cancelled();
        activate_context();
        Result result;result.model_id=config_.model_id;result.steps=steps;result.cfg_strength=vspec?1.25:0;std::vector<float> combined;
        if(progress){progress(0,segments.size(),segments.front().text);check_cancelled();}
        for(size_t chunk_index=0;chunk_index<segments.size();++chunk_index){
            check_cancelled();
            options.text=segments[chunk_index].text;options.seed=seed+chunk_index;
            options.generated_samples=duration_seconds>0?segments[chunk_index].samples:0;
            auto prepared=prepare(options); // Exact per-segment prediction validates <=1500 frames.
            require(prepared.frames==segments[chunk_index].frames&&prepared.prompt/FRAME==planned.prompt_frames&&double(prepared.predicted-prepared.prompt)/SAMPLE_RATE==segments[chunk_index].duration_seconds,"Reference audio changed after planning; retry generation");
            check_cancelled();
            auto synthesis_start=Clock::now();
            if((vspec?!vspec_binding_:!binding_)||current_frames_.load()!=prepared.frames){
                gpu_->synchronize();binding_.reset();vspec_binding_.reset();
                // The final flag requests stream synchronization, not capture:
                // ORT's enable_cuda_graph remains 0 for this dynamic session.
                if(vspec)vspec_binding_=std::make_unique<VSpecCudaBinding>(*session_,prepared.frames,*gpu_,vspec_times_);
                else binding_=std::make_unique<CudaBinding>(*session_,prepared.frames,gpu_.get(),true);
                current_frames_=prepared.frames;++binding_rebuilds_;
            }
            const auto on_step=[&](size_t completed,size_t){
                const size_t total_completed=chunk_index*steps+completed;step_index_=total_completed;ort_runs_=total_completed;model_evaluations_=total_completed*(vspec?2:1);
                if(step_progress)step_progress(total_completed,segments.size()*steps);
            };
            std::vector<float> full;
            if(vspec)full=vspec_binding_->generate(*session_,prepared.initial,prepared.cond,prepared.mel_cond,prepared.text,prepared.prompt,check_cancelled,on_step);
            else{full=binding_->generate(*session_,prepared.initial,prepared.cond,prepared.mel_cond,prepared.text,prepared.prompt);on_step(steps,steps);}
            // generate has copied back and synchronized its CUDA work. Cancellation
            // here leaves the session and reusable buffers ready for another job.
            check_cancelled();
            for(float& sample:full)sample/=9.0f;
            std::vector<float> waveform(full.begin()+prepared.prompt,full.begin()+prepared.predicted);
            if(prepared.rms<0.1f)for(float& sample:waveform)sample=sample*prepared.rms/0.1f;
            for(float sample:waveform)require(std::isfinite(sample),"Resident inference generated NaN/Inf");
            double generation_seconds=elapsed(synthesis_start);
            result.segments.push_back({segments[chunk_index].text,prepared.frames,double(waveform.size())/SAMPLE_RATE,generation_seconds,waveform.size()});
            result.frontend_seconds+=prepared.seconds;result.synthesis_seconds+=generation_seconds;
            result.frames=std::max(result.frames,prepared.frames);result.prompt_frames=prepared.prompt/FRAME;result.frontend_precision=prepared.frontend_precision;
            if(segments.size()>1){size_t fade=std::min(size_t(120),waveform.size()/2);if(fade>1)for(size_t i=0;i<fade;++i){float gain=float(i)/float(fade-1);waveform[i]*=gain;waveform[waveform.size()-1-i]*=gain;}}
            if(chunk_index)combined.insert(combined.end(),size_t(SAMPLE_RATE*0.12),0.0f);
            combined.insert(combined.end(),waveform.begin(),waveform.end());
            if(progress){progress(chunk_index+1,segments.size(),segments[chunk_index].text);check_cancelled();}
        }
        require(double(combined.size())/SAMPLE_RATE==planned.duration_seconds,"Generated length differs from the plan");
        check_cancelled();
        write_wav(output_wav,combined);
        result.output_path=fs::absolute(output_wav);result.duration_seconds=double(combined.size())/SAMPLE_RATE;
        result.request_seconds=elapsed(start);
        result.model_load_seconds=load_seconds_;result.load_count=1;result.request_index=++completed_;result.binding_rebuild_count=binding_rebuilds_.load();
        result.model_evaluations=model_evaluations_.load();result.ort_runs=ort_runs_.load();
        result.session_id=session_id_;result.precision=precision_;return result;
    }
};
}  // namespace wavegen_resident

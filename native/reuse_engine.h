#pragma once
// NVIDIA RE-USE: persistent native ONNX/CUDA inference, official STFT and
// overlap-add processing. No Python, external process, or model download.
#include "reuse_scan.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <complex>
#include <filesystem>
#include <functional>
#include <map>
#include <sstream>
#include <thread>

namespace wavegen_reuse {
namespace fs=std::filesystem;
using ReuseClock=std::chrono::steady_clock;
inline double seconds_since(ReuseClock::time_point start){return std::chrono::duration<double>(ReuseClock::now()-start).count();}
struct Config { fs::path model_directory,cuda_dll_directory; double chunk_seconds=5.0; };
struct Status {
    bool ready=false,busy=false;
    uint64_t load_count=0,completed_requests=0;
    std::string session_id,model_id="nvidia/NVIDIA-NemotronLabs-RE-USE",precision="FP32";
    std::string checkpoint_sha256="06badaf4029b297f97f7fe48d62990b48d5482608210df577354e0d4e0ed70e1";
    std::string source_revision="31f82f2efad1095034492f236e8dac9239ba713b";
    double model_load_seconds=0;
};
struct Result { std::vector<float> samples; int sample_rate=0; double inference_seconds=0,request_seconds=0,frontend_seconds=0; size_t chunks=0; bool silence_bypass=false; };
class Cancelled:public std::runtime_error { public: Cancelled():std::runtime_error("Enhancement cancelled"){} };

namespace engine_detail {
constexpr double pi=3.1415926535897932384626433832795;
inline void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
inline int even(int value){return value%2?value+1:value;}
struct DllDirectory { DLL_DIRECTORY_COOKIE cookie=nullptr; ~DllDirectory(){if(cookie)RemoveDllDirectory(cookie);} };
class Fft {
    size_t size_;
    std::vector<std::complex<double>> roots_;
    void transform(const std::complex<double>* input,size_t stride,std::complex<double>* output,size_t n,std::complex<double>* temp)const{
        if(n==1){output[0]=input[0];return;}
        size_t radix=2;while(n%radix)++radix;const size_t m=n/radix;
        for(size_t j=0;j<radix;++j)transform(input+j*stride,stride*radix,output+j*m,m,temp);
        for(size_t k=0;k<n;++k){std::complex<double> sum=0;for(size_t j=0;j<radix;++j)sum+=output[j*m+(k%m)]*roots_[(j*k*(size_/n))%size_];temp[k]=sum;}
        std::copy(temp,temp+n,output);
    }
public:
    explicit Fft(size_t n):size_(n),roots_(n){for(size_t k=0;k<n;++k)roots_[k]=std::polar(1.0,-2*pi*k/n);}
    void run(const std::vector<std::complex<double>>& input,std::vector<std::complex<double>>& output,std::vector<std::complex<double>>& temporary)const{transform(input.data(),1,output.data(),size_,temporary.data());}
};
struct Frontend {
    int nfft,hop,frequencies;
    Fft fft;
    std::vector<float> window;
    explicit Frontend(int rate):nfft(even(320*rate/8000)),hop(even(40*rate/8000)),frequencies(nfft/2+1),fft(nfft),window(nfft){
        // Match torch.hann_window's FP32 periodic Hann values closely.
        for(int i=0;i<nfft;++i)window[i]=float(.5-.5*std::cos(2*pi*i/nfft));
    }
    template<class Function> static void rows(size_t count,Function operation){
        const size_t workers=std::min<size_t>(4,count);
        std::vector<std::thread> pool;
        for(size_t worker=0;worker<workers;++worker)pool.emplace_back([&,worker]{operation(worker,workers);});
        for(auto& thread:pool)thread.join();
    }
    std::pair<std::vector<float>,std::vector<float>> stft(const std::vector<float>& wave)const{
        require(wave.size()>size_t(nfft/2),"Reference audio is too short for RE-USE reflect padding");
        const size_t frames=wave.size()/hop+1;
        std::vector<float> magnitude(size_t(frequencies)*frames),phase(magnitude.size());
        rows(frames,[&](size_t worker,size_t workers){
            std::vector<std::complex<double>> input(nfft),output(nfft),temp(nfft);
            for(size_t t=worker;t<frames;t+=workers){
                for(int k=0;k<nfft;++k){int64_t index=int64_t(t*hop)+k-nfft/2;if(index<0)index=-index;if(index>=int64_t(wave.size()))index=2*int64_t(wave.size())-2-index;input[k]=float(wave[size_t(index)]*window[k]);}
                fft.run(input,output,temp);
                // A real FFT has exactly zero imaginary DC/Nyquist. Preserve
                // cuFFT's +0 convention: the phase network distinguishes +pi
                // from -pi even though both describe the same complex value.
                for(int f=0;f<frequencies;++f){const float real=float(output[f].real()),imag=(f==0||f==nfft/2)?0.0f:float(output[f].imag());const size_t i=size_t(f)*frames+t;magnitude[i]=std::log1p(std::hypot(real,imag));phase[i]=std::atan2(imag,real);}
            }
        });
        return {std::move(magnitude),std::move(phase)};
    }
    std::vector<float> istft(const float* amplitude,const float* phase,size_t frames,size_t original_samples)const{
        const size_t full_length=size_t(nfft)+size_t(hop)*(frames-1);
        std::vector<float> inverse(frames*size_t(nfft));
        rows(frames,[&](size_t worker,size_t workers){
            std::vector<std::complex<double>> input(nfft),output(nfft),temp(nfft);
            for(size_t t=worker;t<frames;t+=workers){
                size_t zeros=0;for(int f=0;f<frequencies;++f)if(amplitude[size_t(f)*frames+t]<=0)++zeros;
                const bool suppress=zeros*2>size_t(frequencies);
                for(int f=0;f<frequencies;++f){const size_t i=size_t(f)*frames+t;const float mag=suppress?0.0f:std::expm1(std::max(0.0f,amplitude[i]));const float re=mag*std::cos(phase[i]),im=mag*std::sin(phase[i]);input[f]={re,-im};}
                // C2R discards the imaginary components of DC/Nyquist.
                input[0]={input[0].real(),0};input[nfft/2]={input[nfft/2].real(),0};
                for(int f=frequencies;f<nfft;++f)input[f]=std::conj(input[nfft-f]);
                fft.run(input,output,temp);
                for(int k=0;k<nfft;++k)inverse[t*size_t(nfft)+k]=float(output[k].real()/nfft)*window[k];
            }
        });
        std::vector<float> combined(full_length,0),normalization(full_length,0);
        for(size_t t=0;t<frames;++t)for(int k=0;k<nfft;++k){const size_t i=t*hop+k;combined[i]+=inverse[t*size_t(nfft)+k];normalization[i]+=window[k]*window[k];}
        const size_t natural_length=full_length-nfft;
        std::vector<float> result(original_samples,1e-8f);
        for(size_t i=0;i<std::min(original_samples,natural_length);++i){const size_t j=i+nfft/2;require(normalization[j]>1e-11f,"RE-USE inverse STFT has a zero overlap window");result[i]=combined[j]/normalization[j];}
        return result;
    }
};
}

class ReuseEngine {
    Config config_;
    Ort::Env environment_{ORT_LOGGING_LEVEL_WARNING,"nemotron_reuse"};
    ScanRegistration registration_{true}; // Own the operator before the session.
    Ort::SessionOptions options_;
    std::unique_ptr<Ort::Session> session_;
    std::map<int,std::unique_ptr<engine_detail::Frontend>> frontend_;
    mutable std::mutex mutex_;
    std::atomic<bool> busy_{false};
    std::atomic<uint64_t> completed_{0};
    double load_seconds_=0;
    std::string session_id_;
    engine_detail::DllDirectory directory_;
    using SetDevice=int(*)(int);using GetContext=int(*)(void**);using SetContext=int(*)(void*);
    SetDevice set_device_=nullptr;SetContext set_context_=nullptr;void* context_=nullptr;
    void activate()const{engine_detail::require(set_device_&&set_context_&&context_,"RE-USE CUDA context unavailable");engine_detail::require(set_device_(0)==0&&set_context_(context_)==0,"Cannot activate RE-USE CUDA context");}
    static void check_cancel(const std::function<bool()>& cancelled){if(cancelled&&cancelled())throw Cancelled();}
public:
    static bool available(const Config& config){return fs::is_regular_file(config.model_directory/"reuse.onnx")&&fs::is_regular_file(config.model_directory/"reuse_contract.json");}
    explicit ReuseEngine(const Config& config):config_(config){
        using engine_detail::require;
        auto started=ReuseClock::now();require(available(config_),"RE-USE model assets are missing");
        require(config_.chunk_seconds>0&&config_.chunk_seconds<=30,"Invalid RE-USE chunk length");
        config_.cuda_dll_directory=fs::absolute(config_.cuda_dll_directory);
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS|LOAD_LIBRARY_SEARCH_USER_DIRS);
        directory_.cookie=AddDllDirectory(config_.cuda_dll_directory.c_str());require(directory_.cookie!=nullptr,"Cannot register RE-USE CUDA DLL directory");
        auto runtime=LoadLibraryW(L"cudart64_12.dll");auto driver=LoadLibraryW(L"nvcuda.dll");require(runtime&&driver,"RE-USE requires the NVIDIA CUDA runtime and driver");
        set_device_=scan_detail::symbol<SetDevice>(runtime,"cudaSetDevice");set_context_=scan_detail::symbol<SetContext>(driver,"cuCtxSetCurrent");
        auto get_context=scan_detail::symbol<GetContext>(driver,"cuCtxGetCurrent");
        auto initialize=scan_detail::symbol<int(*)(void*)>(runtime,"cudaFree");
        require(set_device_(0)==0&&initialize(nullptr)==0,"Cannot initialize RE-USE CUDA device");
        require(get_context(&context_)==0&&context_,"Cannot capture RE-USE CUDA context");
        options_.SetIntraOpNumThreads(1);options_.SetInterOpNumThreads(1);options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        registration_.add(options_);
        OrtCUDAProviderOptionsV2* cuda=nullptr;Ort::ThrowOnError(Ort::GetApi().CreateCUDAProviderOptions(&cuda));
        const char* keys[]={"device_id","cudnn_conv_algo_search","use_tf32","do_copy_in_default_stream"};const char* values[]={"0","HEURISTIC","0","1"};
        try{Ort::ThrowOnError(Ort::GetApi().UpdateCUDAProviderOptions(cuda,keys,values,4));options_.AppendExecutionProvider_CUDA_V2(*cuda);}catch(...){Ort::GetApi().ReleaseCUDAProviderOptions(cuda);throw;}
        Ort::GetApi().ReleaseCUDAProviderOptions(cuda);
        session_=std::make_unique<Ort::Session>(environment_,(config_.model_directory/"reuse.onnx").c_str(),options_);
        require(session_->GetInputCount()==2&&session_->GetOutputCount()==2,"Invalid RE-USE graph signature");
        Ort::AllocatorWithDefaultOptions allocator;auto metadata=session_->GetModelMetadata();auto id=metadata.LookupCustomMetadataMapAllocated("model_id",allocator);auto precision=metadata.LookupCustomMetadataMapAllocated("precision",allocator);
        require(id&&std::string(id.get())=="nemotron_reuse"&&precision&&std::string(precision.get())=="FP32","Wrong RE-USE model identity or precision");
        const Status expected;auto revision=metadata.LookupCustomMetadataMapAllocated("source_revision",allocator);auto checkpoint=metadata.LookupCustomMetadataMapAllocated("checkpoint_sha256",allocator);auto scans=metadata.LookupCustomMetadataMapAllocated("selective_scans",allocator);
        require(revision&&std::string(revision.get())==expected.source_revision&&checkpoint&&std::string(checkpoint.get())==expected.checkpoint_sha256&&scans&&std::string(scans.get())=="120","RE-USE checkpoint or selective-scan provenance mismatch");
        const char* names[]={"noisy_mag","noisy_pha","enhanced_mag","enhanced_pha"};
        for(size_t i=0;i<2;++i){auto input=session_->GetInputNameAllocated(i,allocator);auto output=session_->GetOutputNameAllocated(i,allocator);require(input&&std::string(input.get())==names[i]&&output&&std::string(output.get())==names[i+2],"Unexpected RE-USE graph tensor names");}
        std::ostringstream identity;identity<<"reuse_session_"<<std::hex<<reinterpret_cast<uintptr_t>(session_.get());session_id_=identity.str();load_seconds_=seconds_since(started);
    }
    ReuseEngine(const ReuseEngine&)=delete;ReuseEngine& operator=(const ReuseEngine&)=delete;
    ~ReuseEngine(){try{activate();}catch(...){}session_.reset();}
    Status status()const{Status value;value.ready=bool(session_);value.busy=busy_.load();value.load_count=session_?1:0;value.completed_requests=completed_.load();value.session_id=session_id_;value.model_load_seconds=load_seconds_;return value;}
    Result enhance(const std::vector<float>& mono,int rate,std::function<bool()> cancelled={},std::function<void(size_t,size_t)> progress={}){
        using engine_detail::require;
        std::unique_lock<std::mutex> lock(mutex_,std::try_to_lock);require(lock.owns_lock(),"RE-USE is already enhancing audio");
        require(rate>=8000&&rate<=48000,"RE-USE supports sample rates from 8000 to 48000 Hz");require(!mono.empty(),"Cannot enhance empty audio");
        require(mono.size()<=size_t(rate)*600,"RE-USE accepts at most 600 seconds per request");
        bool exact_silence=true;for(float value:mono){require(std::isfinite(value),"Cannot enhance nonfinite audio samples");if(value!=0)exact_silence=false;}
        activate();check_cancel(cancelled);busy_=true;
        struct BusyGuard {std::atomic<bool>& value;~BusyGuard(){value=false;}} busy_guard{busy_};
        auto started=ReuseClock::now();Result result;result.sample_rate=rate;
        auto& frontend=frontend_[rate];if(!frontend)frontend=std::make_unique<engine_detail::Frontend>(rate);
        require(mono.size()>size_t(frontend->nfft/2),"Reference audio is too short for RE-USE reflect padding");
        // The official model can hallucinate a transient for all-zero input.
        // This exact-zero-only safeguard never gates quiet nonzero speech.
        if(exact_silence){
            if(progress)progress(0,1);check_cancel(cancelled);
            result.samples=mono;result.silence_bypass=true;result.request_seconds=seconds_since(started);
            if(progress)progress(1,1);check_cancel(cancelled);++completed_;return result;
        }
        const size_t chunk=size_t(std::llround(config_.chunk_seconds*rate));const size_t hop=std::max<size_t>(1,chunk/2);
        std::vector<size_t> starts;
        if(mono.size()<=chunk)starts.push_back(0);
        else{const size_t count=(mono.size()-chunk+hop-1)/hop+1;for(size_t i=0;i<count;++i)starts.push_back(i+1==count?mono.size()-chunk:i*hop);}
        std::vector<float> combined(mono.size(),0),window_sum(mono.size(),0),blend(chunk);
        for(size_t i=0;i<chunk;++i)blend[i]=std::max(1e-7f,float(.5-.5*std::cos(2*engine_detail::pi*i/chunk)));
        const char* input_names[]={"noisy_mag","noisy_pha"};const char* output_names[]={"enhanced_mag","enhanced_pha"};
        auto memory=Ort::MemoryInfo::CreateCpu(OrtArenaAllocator,OrtMemTypeDefault);
        for(size_t index=0;index<starts.size();++index){
            check_cancel(cancelled);if(progress)progress(index,starts.size());check_cancel(cancelled);
            const size_t offset=starts[index],count=std::min(chunk,mono.size()-offset);
            std::vector<float> part(mono.begin()+offset,mono.begin()+offset+count);
            auto phase_started=ReuseClock::now();auto spectra=frontend->stft(part);result.frontend_seconds+=seconds_since(phase_started);
            const size_t frames=count/frontend->hop+1;std::array<int64_t,3> shape={1,frontend->frequencies,int64_t(frames)};
            std::array<Ort::Value,2> inputs={Ort::Value::CreateTensor<float>(memory,spectra.first.data(),spectra.first.size(),shape.data(),3),Ort::Value::CreateTensor<float>(memory,spectra.second.data(),spectra.second.size(),shape.data(),3)};
            check_cancel(cancelled);phase_started=ReuseClock::now();auto outputs=session_->Run(Ort::RunOptions{nullptr},input_names,inputs.data(),2,output_names,2);result.inference_seconds+=seconds_since(phase_started);
            check_cancel(cancelled);for(auto& output:outputs)require(output.GetTensorTypeAndShapeInfo().GetShape()==std::vector<int64_t>(shape.begin(),shape.end()),"RE-USE output shape mismatch");
            phase_started=ReuseClock::now();auto audio=frontend->istft(outputs[0].GetTensorData<float>(),outputs[1].GetTensorData<float>(),frames,count);result.frontend_seconds+=seconds_since(phase_started);
            for(size_t i=0;i<count;++i){require(std::isfinite(audio[i]),"RE-USE produced nonfinite audio");const float weight=starts.size()==1?1.0f:blend[i];combined[offset+i]+=audio[i]*weight;window_sum[offset+i]+=weight;}
            check_cancel(cancelled);
        }
        result.samples.resize(mono.size());for(size_t i=0;i<mono.size();++i){require(window_sum[i]>0,"RE-USE chunk overlap has an uncovered sample");result.samples[i]=combined[i]/window_sum[i];require(std::isfinite(result.samples[i]),"RE-USE overlap output is nonfinite");}
        result.chunks=starts.size();result.request_seconds=seconds_since(started);
        if(progress)progress(starts.size(),starts.size());check_cancel(cancelled);++completed_;return result;
    }
};
}

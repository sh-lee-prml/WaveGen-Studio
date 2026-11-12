// WaveGen-Flash native Windows inference. No Python runtime or subprocesses.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <onnxruntime_cxx_api.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
constexpr int SAMPLE_RATE = 24000, FRAME = 480, MELS = 80, NFFT = 1920;
constexpr double PI = 3.141592653589793238462643383279502884;

static double elapsed(Clock::time_point start) {
    return std::chrono::duration<double>(Clock::now() - start).count();
}
static double median_value(std::vector<double> values){std::sort(values.begin(),values.end());return values.size()%2?values[values.size()/2]:(values[values.size()/2-1]+values[values.size()/2])/2;}
static void require(bool ok, const std::string& message) {
    if (!ok) throw std::runtime_error(message);
}
static std::string utf8(const std::wstring& input) {
    int n = WideCharToMultiByte(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
    std::string result(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, input.data(), static_cast<int>(input.size()), result.data(), n, nullptr, nullptr);
    return result;
}
static fs::path path_from_utf8(const std::string& input) { return fs::u8path(input); }
static std::string printable(const fs::path& path) { return utf8(path.wstring()); }
static std::string json_string(const std::string& input) {
    std::ostringstream out;
    out << '"';
    for (unsigned char c : input) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (c == '\n') out << "\\n";
        else if (c == '\r') out << "\\r";
        else if (c == '\t') out << "\\t";
        else if (c < 32) out << "\\u" << std::hex << std::setw(4) << std::setfill('0') << int(c) << std::dec;
        else out << c;
    }
    out << '"';
    return out.str();
}
template<class T> static std::vector<T> read_binary(const fs::path& path, size_t expected = 0) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    require(bool(in), "Cannot open " + printable(path));
    const auto bytes = in.tellg();
    require(bytes >= 0 && size_t(bytes) % sizeof(T) == 0, "Invalid binary tensor: " + printable(path));
    std::vector<T> values(size_t(bytes) / sizeof(T));
    require(!expected || values.size() == expected, "Tensor size mismatch: " + printable(path));
    in.seekg(0); in.read(reinterpret_cast<char*>(values.data()), bytes);
    require(bool(in), "Cannot read " + printable(path));
    return values;
}
template<class T> static void write_binary(const fs::path& path, const std::vector<T>& values) {
    if (!path.parent_path().empty()) fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(values.data()), values.size() * sizeof(T));
    require(bool(out), "Cannot write " + printable(path));
}
static uint16_t u16(const uint8_t* p) { return uint16_t(p[0]) | (uint16_t(p[1]) << 8); }
static uint32_t u32(const uint8_t* p) { return uint32_t(p[0]) | (uint32_t(p[1]) << 8) | (uint32_t(p[2]) << 16) | (uint32_t(p[3]) << 24); }
static std::vector<float> read_wav(const fs::path& path) {
    auto bytes = read_binary<uint8_t>(path);
    require(bytes.size() >= 12 && std::memcmp(bytes.data(), "RIFF", 4) == 0 && std::memcmp(bytes.data()+8,"WAVE",4)==0,
            "Reference must be a RIFF WAV file");
    uint16_t format=0, channels=0, bits=0, align=0;
    uint32_t rate=0;
    const uint8_t* pcm=nullptr; size_t pcm_size=0;
    for (size_t pos=12; pos+8<=bytes.size();) {
        const auto size=u32(bytes.data()+pos+4); size_t begin=pos+8;
        require(size <= bytes.size()-begin, "Truncated WAV chunk");
        if (std::memcmp(bytes.data()+pos,"fmt ",4)==0) {
            require(size>=16, "Invalid WAV fmt chunk");
            format=u16(bytes.data()+begin); channels=u16(bytes.data()+begin+2);
            rate=u32(bytes.data()+begin+4); align=u16(bytes.data()+begin+12); bits=u16(bytes.data()+begin+14);
            if (format==0xfffe) { require(size>=40,"Invalid extensible WAV"); format=u16(bytes.data()+begin+24); }
        } else if (std::memcmp(bytes.data()+pos,"data",4)==0) { pcm=bytes.data()+begin; pcm_size=size; }
        pos=begin+size+(size&1);
    }
    require(rate==SAMPLE_RATE,"Reference WAV must be 24000 Hz; convert/resample it before native inference");
    require(channels>0 && align==channels*(bits/8) && pcm && pcm_size>=align,"Invalid or empty WAV");
    require((format==1 && (bits==16||bits==24||bits==32)) || (format==3 && bits==32),
            "Supported WAV encodings: PCM16/24/32 or float32");
    std::vector<float> mono(pcm_size/align);
    for (size_t i=0; i<mono.size(); ++i) {
        double sum=0;
        for (unsigned channel=0;channel<channels;++channel) {
            const auto* p=pcm+i*align+channel*(bits/8); double value=0;
            if(format==3) { float f; std::memcpy(&f,p,4); value=f; }
            else if(bits==16) value=int16_t(u16(p))/32768.0;
            else if(bits==24) { int32_t n=int32_t(p[0])|(int32_t(p[1])<<8)|(int32_t(p[2])<<16); if(n&0x800000)n|=int32_t(0xff000000); value=n/8388608.0; }
            else value=int32_t(u32(p))/2147483648.0;
            require(std::isfinite(value),"Reference WAV contains nonfinite samples"); sum+=value;
        }
        mono[i]=float(sum/channels);
    }
    return mono;
}
static void write_wav(const fs::path& path,const std::vector<float>& samples) {
    if(!path.parent_path().empty())fs::create_directories(path.parent_path());
    std::ofstream out(path,std::ios::binary);
    auto w16=[&](uint16_t x){ char b[2]={char(x),char(x>>8)};out.write(b,2);};
    auto w32=[&](uint32_t x){ char b[4]={char(x),char(x>>8),char(x>>16),char(x>>24)};out.write(b,4);};
    out.write("RIFF",4);w32(36+uint32_t(samples.size()*2));out.write("WAVEfmt ",8);w32(16);w16(1);w16(1);w32(SAMPLE_RATE);w32(SAMPLE_RATE*2);w16(2);w16(16);out.write("data",4);w32(uint32_t(samples.size()*2));
    for(float f:samples){require(std::isfinite(f),"Generated audio contains nonfinite samples");int x=std::clamp(int(std::lrint(double(f)*32768.0)),-32768,32767);w16(uint16_t(int16_t(x)));}
    require(bool(out),"Cannot write WAV");
}

// Fixed-size mixed-radix FFT. All setup/frontend operations are native C++.
class Fft1920 {
    std::vector<std::complex<double>> roots_;
    void transform(const std::complex<double>* input,size_t stride,std::complex<double>* output,size_t n,std::complex<double>* temp) const {
        if(n==1){output[0]=input[0];return;}
        size_t radix=2;while(n%radix)++radix;const size_t m=n/radix;
        for(size_t j=0;j<radix;++j)transform(input+j*stride,stride*radix,output+j*m,m,temp);
        for(size_t k=0;k<n;++k){std::complex<double> sum=0;for(size_t j=0;j<radix;++j)sum+=output[j*m+(k%m)]*roots_[(j*k*(NFFT/n))%NFFT];temp[k]=sum;}
        std::copy(temp,temp+n,output);
    }
public:
    Fft1920():roots_(NFFT){for(int k=0;k<NFFT;++k)roots_[k]=std::polar(1.0,-2*PI*k/NFFT);}
    void run(const std::vector<std::complex<double>>& input,std::vector<std::complex<double>>& out)const{std::array<std::complex<double>,NFFT> temp;transform(input.data(),1,out.data(),NFFT,temp.data());}
};
static float round_bf16(float value){uint32_t bits;std::memcpy(&bits,&value,4);bits=(bits+0x7fff+((bits>>16)&1))&0xffff0000;std::memcpy(&value,&bits,4);return value;}
static std::vector<float> mel_frontend(const std::vector<float>& audio,const std::vector<float>& window,const std::vector<float>& filter,size_t known_frames,bool bf16) {
    require(audio.size()%FRAME==0 && audio.size()>NFFT/2,"Reference plus generated length is too short for reflect padding");
    const size_t frames=audio.size()/FRAME;
    std::vector<float> mel(frames*MELS);
    Fft1920 fft;
    std::array<std::vector<std::pair<int,float>>,MELS> nonzero;
    for(int k=0;k<=NFFT/2;++k)for(int m=0;m<MELS;++m)if(filter[k*MELS+m]!=0)nonzero[m].emplace_back(k,bf16?round_bf16(filter[k*MELS+m]):filter[k*MELS+m]);
    auto worker=[&](size_t start,size_t end){
      std::vector<std::complex<double>> input(NFFT),output(NFFT);
      for(size_t t=start;t<end;++t){
        for(int k=0;k<NFFT;++k){int64_t index=int64_t(t*FRAME)+k-NFFT/2;if(index<0)index=-index;if(index>=int64_t(audio.size()))index=2*int64_t(audio.size())-2-index;input[k]=double(float(audio[index]*window[k]));}
        fft.run(input,output);
        std::array<float,NFFT/2+1> magnitudes;for(int k=0;k<=NFFT/2;++k){float magnitude=float(std::abs(output[k]));magnitudes[k]=bf16?round_bf16(magnitude):magnitude;}
        for(int m=0;m<MELS;++m){double sum=0;for(const auto& [k,w]:nonzero[m])sum+=double(magnitudes[k])*w;float value=bf16?round_bf16(float(sum)):float(sum);mel[t*MELS+m]=std::log(std::max(value,bf16?round_bf16(1e-5f):1e-5f));}
      }
    };
    const size_t count=std::min(size_t(4),std::max(size_t(1),known_frames));
    std::vector<std::thread> workers;for(size_t i=0;i<count;++i)workers.emplace_back(worker,i*known_frames/count,(i+1)*known_frames/count);
    for(auto& thread:workers)thread.join();
    return mel;
}
static std::string normalize_english(std::string text){
    const std::pair<std::string,std::string> replacements[]={{"\xe2\x80\x9c","\""},{"\xe2\x80\x9d","\""},{"\xe2\x80\x98","'"},{"\xe2\x80\x99","'"}};
    for(const auto& [from,to]:replacements){size_t p=0;while((p=text.find(from,p))!=std::string::npos){text.replace(p,from.size(),to);p+=to.size();}}
    std::replace(text.begin(),text.end(),';',',');
    for(unsigned char c:text)require(c<128,"Native text frontend supports English ASCII and curly quotes; Chinese/pinyin tokenization is not included");
    return text;
}
// Vocabulary-independent token characters let the CPU planner detect truncation
// using exactly the same normalization and spacing as inference.
static std::string tokenize_characters(const std::string& combined){
    const std::string text=normalize_english(combined);
    std::string tokens;
    for(size_t p=0;p<text.size();){
        size_t end=p+1;
        if(std::isalnum(static_cast<unsigned char>(text[p]))) {
            while(end<text.size()) {
                if(std::isalnum(static_cast<unsigned char>(text[end]))) { ++end; continue; }
                if(std::string("._-").find(text[end])!=std::string::npos && end+1<text.size() && std::isalnum(static_cast<unsigned char>(text[end+1]))) { end+=2; continue; }
                break;
            }
        }
        if(!tokens.empty()&&end-p>1&&std::string(" :'\"").find(tokens.back())==std::string::npos)tokens+=' ';
        tokens.append(text,p,end-p);p=end;
    }
    return tokens;
}
static std::vector<int64_t> tokenize(const fs::path& vocab_path,const std::string& combined,size_t frames){
    std::ifstream in(vocab_path);require(bool(in),"Cannot read vocab.txt");std::map<std::string,int64_t> vocab;std::string line;int64_t index=0;
    while(std::getline(in,line)){if(!line.empty()&&line.back()=='\r')line.pop_back();vocab[line]=index++;}
    require(vocab.count(" ") && vocab.at(" ")==0,"Unexpected vocabulary");
    const std::string tokens=tokenize_characters(combined);
    std::vector<int64_t> ids(frames,-1);
    for(size_t i=0;i<std::min(tokens.size(),frames);++i){auto it=vocab.find(std::string(1,tokens[i]));ids[i]=it==vocab.end()?0:it->second;}
    return ids;
}
static std::string reference_text_prefix(const std::string& text){
    require(!text.empty(),"Reference transcript is empty");
    std::string prefix=text;if(static_cast<unsigned char>(prefix.back())<128)prefix+=' ';
    return prefix;
}
struct DurationEstimate {size_t prompt=0,generated=0,predicted=0,frames=0;};
// Match the source engine's UTF-8 byte calculation before punctuation
// normalization, including its double arithmetic and floor to whole samples.
static DurationEstimate estimate_duration(size_t reference_samples,size_t reference_text_bytes,size_t text_bytes,double speed){
    require(reference_text_bytes>0&&std::isfinite(speed)&&speed>0,"Invalid transcript or speed");
    DurationEstimate d;d.prompt=std::max(reference_samples/FRAME*FRAME,size_t(FRAME));
    const double generated=double(d.prompt)/reference_text_bytes*text_bytes/speed;
    require(std::isfinite(generated)&&generated<double(std::numeric_limits<size_t>::max()-d.prompt-FRAME),"Predicted duration is too large; shorten text or increase speed");
    d.generated=size_t(generated);d.predicted=d.prompt+d.generated;d.frames=(d.predicted+FRAME-1)/FRAME;return d;
}
static DurationEstimate estimate_duration_samples(size_t reference_samples,size_t generated_samples){
    DurationEstimate d;d.prompt=std::max(reference_samples/FRAME*FRAME,size_t(FRAME));
    require(generated_samples>0&&generated_samples<std::numeric_limits<size_t>::max()-d.prompt-FRAME,"Invalid requested sample count");
    d.generated=generated_samples;d.predicted=d.prompt+d.generated;d.frames=(d.predicted+FRAME-1)/FRAME;return d;
}
struct Options {
    fs::path model,assets,reference,output="generated_native.wav",cuda_dir,noise_file,dump_dir,fixture,metrics="native_metrics.json";
    std::string ref_text,text,frontend_precision="auto";uint64_t seed=0;double speed=1;size_t generated_samples=0;int repeats=1,warmups=0,frames=0;bool cpu=false,tf32=false,profile=false,frontend_only=false,tokenize_only=false,iobinding=true,gpu_euler=true,cuda_graph=true,benchmark_full=false;
};
static Options parse(int argc,wchar_t** argv){
    Options o;
    wchar_t module_path[32768];DWORD module_len=GetModuleFileNameW(nullptr,module_path,32768);
    fs::path executable_dir=fs::path(std::wstring(module_path,module_len)).parent_path();
    o.model=executable_dir/"model"/"wavegen_flash_step.onnx";o.assets=executable_dir/"model";
    if(fs::is_regular_file(executable_dir/"cudart64_12.dll"))o.cuda_dir=executable_dir;
    for(int i=1;i<argc;++i){std::string k=utf8(argv[i]);
        if(k=="--help"||k=="-h"){
            std::cout<<"WaveGen-Flash native C++/ONNX Runtime CUDA inference\n"
            "Usage: wavegen_flash_native.exe --model model.onnx --assets DIR\n"
            "  --ref-audio reference.wav --ref-text \"transcript\" --text \"English target\" --output out.wav\n"
            "Options: --cuda-dll-dir DIR --repeat 1 --warmups 0 --seed 0 --speed 1\n"
            "  --noise-file initial_wav.f32 --dump-tensors DIR --metrics metrics.json --tf32 --cpu --profile\n"
            "  --no-cuda-graph --benchmark-full-pipeline --cpu-euler --no-iobinding --frontend-precision auto|fp32|bf16\n"
            "Defaults: model/ beside EXE, CUDA Graph + GPU Euler, BF16/FP32 frontend per model assets.\n"
            "Parity: --step-fixture DIR --frames F | Frontend: --frontend-only --dump-tensors DIR\n"
            "Input: 24 kHz PCM16/24/32 or float32 WAV; English ASCII/curly quotes. No Python required.\n";std::exit(0);
        }
        if(k=="--cpu"){o.cpu=true;continue;}if(k=="--tf32"){o.tf32=true;continue;}if(k=="--profile"){o.profile=true;continue;}if(k=="--frontend-only"){o.frontend_only=true;continue;}if(k=="--tokenize-only"){o.tokenize_only=true;continue;}if(k=="--no-iobinding"){o.iobinding=false;continue;}if(k=="--cpu-euler"){o.gpu_euler=false;continue;}if(k=="--cuda-graph"){o.cuda_graph=true;continue;}if(k=="--no-cuda-graph"){o.cuda_graph=false;continue;}if(k=="--benchmark-full-pipeline"){o.benchmark_full=true;continue;}
        require(i+1<argc,"Missing value for "+k);std::string value=utf8(argv[++i]);
        if(k=="--model")o.model=path_from_utf8(value);else if(k=="--assets")o.assets=path_from_utf8(value);
        else if(k=="--ref-audio")o.reference=path_from_utf8(value);else if(k=="--output")o.output=path_from_utf8(value);
        else if(k=="--cuda-dll-dir")o.cuda_dir=path_from_utf8(value);else if(k=="--noise-file")o.noise_file=path_from_utf8(value);
        else if(k=="--dump-tensors")o.dump_dir=path_from_utf8(value);else if(k=="--step-fixture")o.fixture=path_from_utf8(value);
        else if(k=="--metrics")o.metrics=path_from_utf8(value);else if(k=="--ref-text")o.ref_text=value;else if(k=="--text")o.text=value;
        else if(k=="--frontend-precision")o.frontend_precision=value;
        else if(k=="--seed")o.seed=std::stoull(value);else if(k=="--speed")o.speed=std::stod(value);
        else if(k=="--repeat")o.repeats=std::stoi(value);else if(k=="--warmups")o.warmups=std::stoi(value);else if(k=="--frames")o.frames=std::stoi(value);
        else throw std::runtime_error("Unknown option "+k);
    }
    require(o.repeats>0&&o.warmups>=0,"repeat must be positive and warmups nonnegative");
    require(std::isfinite(o.speed)&&o.speed>0,"speed must be finite and positive");
    require(o.frontend_precision=="auto"||o.frontend_precision=="fp32"||o.frontend_precision=="bf16","frontend precision must be auto, fp32 or bf16");
    if(o.cpu||!o.iobinding){o.gpu_euler=false;o.cuda_graph=false;}
    require(!o.cuda_graph||(!o.cpu&&o.iobinding),"CUDA graph requires CUDA I/O binding");
    if(o.tokenize_only){require(!o.assets.empty()&&!o.text.empty()&&!o.dump_dir.empty(),"Tokenizer requires --assets, --text, --dump-tensors");return o;}
    require(o.frontend_only||!o.model.empty(),"--model is required");
    if(o.fixture.empty())require(!o.assets.empty()&&!o.reference.empty()&&!o.ref_text.empty()&&!o.text.empty(),"--assets, --ref-audio, --ref-text and --text are required");
    else require(o.frames>0,"--frames required with --step-fixture");
    return o;
}
// Protect model/reference/assets before any output file can be opened.
static bool same_file_path(const fs::path& first,const fs::path& second){
    if(first.empty()||second.empty())return false;
    std::error_code error;if(fs::equivalent(first,second,error)&&!error)return true;
    auto resolve=[](const fs::path& path){std::error_code ec;auto absolute=fs::absolute(path);auto canonical=fs::weakly_canonical(absolute,ec);return (ec?absolute:canonical).lexically_normal().wstring();};
    auto a=resolve(first),b=resolve(second);return CompareStringOrdinal(a.c_str(),int(a.size()),b.c_str(),int(b.size()),TRUE)==CSTR_EQUAL;
}
static void validate_output_paths(const Options& o){
    require(!same_file_path(o.output,o.metrics),"Output WAV and metrics must use different paths");
    std::vector<fs::path> protected_paths={o.reference,o.model,o.noise_file,o.model.parent_path()/"wavegen_flash_step.onnx.data",fs::path(o.model.wstring()+L".data")};
    for(const char* asset:{"hann_window.f32","mel_filter.f32","vocab.txt","frontend_precision.txt","frontend_precision.json","mel_filter_bf16_rounded.f32"})protected_paths.push_back(o.assets/asset);
    if(!o.fixture.empty())for(const char* input:{"wav_state.f32","mel_state.f32","wav_cond.f32","mel_cond.f32","text_ids.i64","time.f32"})protected_paths.push_back(o.fixture/input);
    // Obvious collisions are rejected before reading or loading any model.
    for(const auto& input:protected_paths){require(!same_file_path(o.output,input),"Output WAV aliases protected input: "+printable(input));require(!same_file_path(o.metrics,input),"Metrics aliases protected input: "+printable(input));}
    auto inside=[](const fs::path& path,const fs::path& directory){
        auto target=fs::weakly_canonical(fs::absolute(path)).lexically_normal().make_preferred().wstring();
        auto parent=fs::weakly_canonical(fs::absolute(directory)).lexically_normal().make_preferred().wstring();
        if(!parent.empty()&&parent.back()!=L'\\')parent+=L'\\';
        return target.size()>=parent.size()&&CompareStringOrdinal(target.c_str(),int(parent.size()),parent.c_str(),int(parent.size()),TRUE)==CSTR_EQUAL;
    };
    for(const auto& output:{o.output,o.metrics}) {
        require(!inside(output,o.model.parent_path()),"Outputs must be outside the model directory");
        require(!inside(output,o.assets),"Outputs must be outside the assets directory");
    }
}
static void setup_dlls(const fs::path& cuda_dir){
    if(cuda_dir.empty())return;
    require(fs::is_directory(cuda_dir),"CUDA DLL directory does not exist");
    require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)!=0,"SetDefaultDllDirectories failed");
    require(AddDllDirectory(fs::absolute(cuda_dir).c_str())!=nullptr,"AddDllDirectory failed");
    for(const wchar_t* name:{L"cudart64_12.dll",L"cublasLt64_12.dll",L"cublas64_12.dll",L"cudnn64_9.dll"})
        require(LoadLibraryExW(fs::absolute(cuda_dir/name).c_str(),nullptr,LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)!=nullptr,"Cannot load CUDA dependency: "+utf8(name));
}
#include "gpu_compute.h"
class CudaBinding {
    using Malloc=int(*)(void**,size_t);using Free=int(*)(void*);using Copy=int(*)(void*,const void*,size_t,int);using ErrorText=const char*(*)(int);
    Malloc malloc_;Free free_;Copy copy_;ErrorText error_;
    Ort::MemoryInfo memory_{"Cuda",OrtDeviceAllocator,0,OrtMemTypeDefault};
    std::vector<void*> buffers_;
    std::vector<Ort::Value> values_;
    Ort::IoBinding binding_;
    const float* previous_cond_=nullptr;const int64_t* previous_text_=nullptr;
    size_t frames_;
    GpuContext* context_;
    bool graph_;
    void check(int status){if(status)throw std::runtime_error(std::string("CUDA runtime: ")+error_(status));}
public:
    CudaBinding(Ort::Session& session,size_t frames,GpuContext* context,bool graph):binding_(session),frames_(frames),context_(context),graph_(graph){
        HMODULE library=GetModuleHandleW(L"cudart64_12.dll");if(!library)library=LoadLibraryW(L"cudart64_12.dll");require(library!=nullptr,"Cannot load CUDA runtime for I/O binding");
        malloc_=reinterpret_cast<Malloc>(GetProcAddress(library,"cudaMalloc"));free_=reinterpret_cast<Free>(GetProcAddress(library,"cudaFree"));copy_=reinterpret_cast<Copy>(GetProcAddress(library,"cudaMemcpy"));error_=reinterpret_cast<ErrorText>(GetProcAddress(library,"cudaGetErrorString"));require(malloc_&&free_&&copy_&&error_,"CUDA runtime exports missing");
        const size_t counts[]={frames*FRAME,frames*MELS,frames*FRAME,frames*MELS,frames,1,frames*FRAME,frames*MELS};
        const char* names[]={"wav_state","mel_state","wav_cond","mel_cond","text_ids","time","pred_wav","pred_mel"};
        std::array<int64_t,3> ws{1,int64_t(frames),FRAME},ms{1,int64_t(frames),MELS};std::array<int64_t,2> ts{1,int64_t(frames)};std::array<int64_t,1> scalar{1};
        for(size_t i=0;i<8;++i){void* pointer=nullptr;check(malloc_(&pointer,counts[i]*(i==4?sizeof(int64_t):sizeof(float))));buffers_.push_back(pointer);
            if(i==4)values_.emplace_back(Ort::Value::CreateTensor<int64_t>(memory_,static_cast<int64_t*>(pointer),counts[i],ts.data(),2));
            else if(i==5)values_.emplace_back(Ort::Value::CreateTensor<float>(memory_,static_cast<float*>(pointer),1,scalar.data(),1));
            else{auto shape=(i==1||i==3||i==7)?ms:ws;values_.emplace_back(Ort::Value::CreateTensor<float>(memory_,static_cast<float*>(pointer),counts[i],shape.data(),3));}
            if(i<6)binding_.BindInput(names[i],values_.back());else binding_.BindOutput(names[i],values_.back());
        }
        if(context_)buffers_.push_back(context_->allocate(frames*FRAME*sizeof(float)));
    }
    ~CudaBinding(){for(void* pointer:buffers_)free_(pointer);}
    std::pair<std::vector<float>,std::vector<float>> step(Ort::Session& session,std::vector<float>& wav,std::vector<float>& mel,std::vector<float>& cond,std::vector<float>& mel_cond,std::vector<int64_t>& text,float time){
        require(wav.size()==frames_*FRAME,"Fixed I/O binding frame count changed");
        check(copy_(buffers_[0],wav.data(),wav.size()*sizeof(float),1));check(copy_(buffers_[1],mel.data(),mel.size()*sizeof(float),1));
        if(previous_cond_!=cond.data()){check(copy_(buffers_[2],cond.data(),cond.size()*sizeof(float),1));check(copy_(buffers_[3],mel_cond.data(),mel_cond.size()*sizeof(float),1));previous_cond_=cond.data();}
        if(previous_text_!=text.data()){check(copy_(buffers_[4],text.data(),text.size()*sizeof(int64_t),1));previous_text_=text.data();}
        check(copy_(buffers_[5],&time,sizeof(float),1));binding_.SynchronizeInputs();session.Run(Ort::RunOptions{nullptr},binding_);binding_.SynchronizeOutputs();if(graph_&&context_)context_->synchronize_device();
        std::vector<float> pw(wav.size()),pm(mel.size());check(copy_(pw.data(),buffers_[6],pw.size()*sizeof(float),2));check(copy_(pm.data(),buffers_[7],pm.size()*sizeof(float),2));return {std::move(pw),std::move(pm)};
    }
    std::vector<float> generate(Ort::Session& session,std::vector<float>& initial,std::vector<float>& cond,std::vector<float>& mel_cond,std::vector<int64_t>& text,size_t prompt){
        require(context_!=nullptr,"GPU Euler requires a shared CUDA stream");
        auto& gpu=*context_;const size_t wav_bytes=initial.size()*sizeof(float),mel_bytes=mel_cond.size()*sizeof(float);
        gpu.copy(buffers_[8],initial.data(),wav_bytes,1);gpu.copy(buffers_[0],initial.data(),wav_bytes,1);gpu.clear(buffers_[1],mel_bytes);
        gpu.copy(buffers_[2],cond.data(),wav_bytes,1);gpu.copy(buffers_[3],mel_cond.data(),mel_bytes,1);gpu.copy(buffers_[4],text.data(),text.size()*sizeof(int64_t),1);
        const float times[]={0,0.1f,0.25f,0.5f,1};
        Ort::RunOptions run;if(!graph_)run.AddConfigEntry("disable_synchronize_execution_providers","1");
        for(int step=0;step<4;++step){float t=times[step],dt=times[step+1]-t;
            gpu.anchor(buffers_[0],buffers_[1],buffers_[8],buffers_[2],buffers_[3],int(prompt),int(prompt/FRAME*MELS),t,buffers_[5]);
            if(graph_)gpu.synchronize();
            session.Run(run,binding_);
            if(graph_)gpu.synchronize_device();
            gpu.euler(buffers_[0],buffers_[1],buffers_[6],buffers_[7],buffers_[2],buffers_[3],int(prompt),int(prompt/FRAME*MELS),int(initial.size()),int(mel_cond.size()),t,dt,step==3);
        }
        std::vector<float> result(initial.size());gpu.copy(result.data(),buffers_[0],wav_bytes,2);gpu.synchronize();return result;
    }
};
#include "vspec_compute.h"
class Engine {
    Ort::Env env_{ORT_LOGGING_LEVEL_WARNING,"wavegen_flash_native"};
    Ort::SessionOptions options_;
    std::unique_ptr<GpuContext> gpu_context_;
    std::unique_ptr<Ort::Session> session_;
    std::unique_ptr<CudaBinding> binding_;
    Ort::MemoryInfo memory_=Ort::MemoryInfo::CreateCpu(OrtArenaAllocator,OrtMemTypeDefault);
public:
    std::string precision="FP32";
    bool gpu_euler_active=false;
    explicit Engine(const Options& o,size_t frames=0){
        options_.SetIntraOpNumThreads(1);options_.SetInterOpNumThreads(1);options_.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
        if(frames)Ort::ThrowOnError(Ort::GetApi().AddFreeDimensionOverrideByName(options_,"frames",int64_t(frames)));
        if(o.profile){fs::path prefix=o.metrics.parent_path()/"wavegen_native_profile";if(!prefix.parent_path().empty())fs::create_directories(prefix.parent_path());options_.EnableProfiling(prefix.c_str());}
        if(!o.cpu){
            if(o.iobinding)gpu_context_=std::make_unique<GpuContext>();
            std::string stream_id=gpu_context_?std::to_string(reinterpret_cast<uintptr_t>(gpu_context_->stream)):"0";
            OrtCUDAProviderOptionsV2* cuda=nullptr;Ort::ThrowOnError(Ort::GetApi().CreateCUDAProviderOptions(&cuda));
            const char* keys[]={"device_id","cudnn_conv_algo_search","do_copy_in_default_stream","use_tf32"};
            const char* values[]={"0","HEURISTIC","1",o.tf32?"1":"0"};
            Ort::ThrowOnError(Ort::GetApi().UpdateCUDAProviderOptions(cuda,keys,values,4));
            if(gpu_context_){const char* key="user_compute_stream";const char* value=stream_id.c_str();Ort::ThrowOnError(Ort::GetApi().UpdateCUDAProviderOptions(cuda,&key,&value,1));}
            if(o.cuda_graph){const char* key="enable_cuda_graph";const char* value="1";Ort::ThrowOnError(Ort::GetApi().UpdateCUDAProviderOptions(cuda,&key,&value,1));}
            options_.AppendExecutionProvider_CUDA_V2(*cuda);Ort::GetApi().ReleaseCUDAProviderOptions(cuda);
        }
        session_=std::make_unique<Ort::Session>(env_,o.model.c_str(),options_);
        require(session_->GetInputCount()==6&&session_->GetOutputCount()==2,"Unexpected model graph interface");
        Ort::AllocatorWithDefaultOptions allocator;
        auto metadata=session_->GetModelMetadata();auto precision_name=metadata.LookupCustomMetadataMapAllocated("precision",allocator);if(precision_name)precision=precision_name.get();
        for(size_t i=0;i<session_->GetInputCount();++i){auto name=session_->GetInputNameAllocated(i,allocator);std::cout<<"Input "<<i<<": "<<name.get()<<'\n';}
        if(!o.cpu&&o.iobinding&&frames)binding_=std::make_unique<CudaBinding>(*session_,frames,gpu_context_.get(),o.cuda_graph);
        if(o.gpu_euler&&binding_){gpu_context_->compile();gpu_euler_active=true;}
    }
    std::pair<std::vector<float>,std::vector<float>> step(std::vector<float>& wav,std::vector<float>& mel,std::vector<float>& cond,std::vector<float>& mel_cond,std::vector<int64_t>& text,float time){
        if(binding_)return binding_->step(*session_,wav,mel,cond,mel_cond,text,time);
        const int64_t frames=int64_t(wav.size()/FRAME);std::array<int64_t,3> ws{1,frames,FRAME},ms{1,frames,MELS};std::array<int64_t,2> ts{1,frames};std::array<int64_t,1> scalar{1};
        std::vector<Ort::Value> inputs;
        inputs.emplace_back(Ort::Value::CreateTensor<float>(memory_,wav.data(),wav.size(),ws.data(),3));
        inputs.emplace_back(Ort::Value::CreateTensor<float>(memory_,mel.data(),mel.size(),ms.data(),3));
        inputs.emplace_back(Ort::Value::CreateTensor<float>(memory_,cond.data(),cond.size(),ws.data(),3));
        inputs.emplace_back(Ort::Value::CreateTensor<float>(memory_,mel_cond.data(),mel_cond.size(),ms.data(),3));
        inputs.emplace_back(Ort::Value::CreateTensor<int64_t>(memory_,text.data(),text.size(),ts.data(),2));
        inputs.emplace_back(Ort::Value::CreateTensor<float>(memory_,&time,1,scalar.data(),1));
        const char* names[]={"wav_state","mel_state","wav_cond","mel_cond","text_ids","time"};const char* outputs[]={"pred_wav","pred_mel"};
        auto result=session_->Run(Ort::RunOptions{nullptr},names,inputs.data(),inputs.size(),outputs,2);
        auto copy=[](Ort::Value& value,size_t n){require(value.GetTensorTypeAndShapeInfo().GetElementCount()==n,"Output tensor size mismatch");const float* p=value.GetTensorData<float>();return std::vector<float>(p,p+n);};
        return {copy(result[0],wav.size()),copy(result[1],mel.size())};
    }
    std::vector<float> generate(std::vector<float>& initial,std::vector<float>& cond,std::vector<float>& mel_cond,std::vector<int64_t>& text,size_t prompt){return binding_->generate(*session_,initial,cond,mel_cond,text,prompt);}
};
struct Prepared {
    size_t prompt=0,predicted=0,frames=0;float rms=0;double seconds=0;
    std::string frontend_precision;
    std::vector<float> cond,mel_cond,initial;std::vector<int64_t> text;
};
static Prepared prepare(const Options& o){
    auto started=Clock::now();Prepared p;auto audio=read_wav(o.reference);
    double squares=0;for(float x:audio)squares+=double(x)*x;p.rms=float(std::sqrt(squares/audio.size()));require(p.rms>1e-8f,"Reference audio is silent");
    if(p.rms<0.1f)for(float& x:audio)x=x*0.1f/p.rms;
    const std::string ref=reference_text_prefix(o.ref_text);
    normalize_english(ref);normalize_english(o.text);
    const auto duration=o.generated_samples?estimate_duration_samples(audio.size(),o.generated_samples):estimate_duration(audio.size(),ref.size(),o.text.size(),o.speed);
    p.prompt=duration.prompt;p.predicted=duration.predicted;p.frames=duration.frames;audio.resize(p.prompt,0);
    require(duration.generated>0,"Predicted output is empty");
    require(p.frames<=1500,"Prompt plus generated audio exceeds 30 seconds; shorten text/reference");
    audio.resize(p.frames*FRAME,0);
    auto window=read_binary<float>(o.assets/"hann_window.f32",NFFT);auto filter=read_binary<float>(o.assets/"mel_filter.f32",(NFFT/2+1)*MELS);
    p.frontend_precision=o.frontend_precision;
    if(p.frontend_precision=="auto"){p.frontend_precision="fp32";std::ifstream policy(o.assets/"frontend_precision.txt");if(policy){std::getline(policy,p.frontend_precision);if(!p.frontend_precision.empty()&&p.frontend_precision.back()=='\r')p.frontend_precision.pop_back();std::transform(p.frontend_precision.begin(),p.frontend_precision.end(),p.frontend_precision.begin(),[](unsigned char c){return char(std::tolower(c));});}}
    require(p.frontend_precision=="fp32"||p.frontend_precision=="bf16","Unexpected frontend_precision.txt policy");
    p.mel_cond=mel_frontend(audio,window,filter,p.prompt/FRAME,p.frontend_precision=="bf16");
    p.cond=audio;for(float& x:p.cond)x*=9.0f;
    p.text=tokenize(o.assets/"vocab.txt",ref+o.text,p.frames);
    if(!o.noise_file.empty())p.initial=read_binary<float>(o.noise_file,p.frames*FRAME);
    else{std::mt19937_64 rng(o.seed);std::normal_distribution<float> normal(0,1);p.initial.resize(p.frames*FRAME);for(float& x:p.initial)x=normal(rng);}
    if(!o.dump_dir.empty()){write_binary(o.dump_dir/"wav_cond.f32",p.cond);write_binary(o.dump_dir/"mel_cond.f32",p.mel_cond);write_binary(o.dump_dir/"text_ids.i64",p.text);write_binary(o.dump_dir/"initial_wav.f32",p.initial);}
    p.seconds=elapsed(started);return p;
}
static std::vector<float> synthesize(Engine& engine,Prepared& p,const Options& o){
    std::vector<float> wav=p.initial,mel(p.frames*MELS,0);const float times[]={0,0.1f,0.25f,0.5f,1};
    if(engine.gpu_euler_active)wav=engine.generate(p.initial,p.cond,p.mel_cond,p.text,p.prompt);
    else for(int step=0;step<4;++step){float t=times[step],dt=times[step+1]-t;
        for(size_t i=0;i<p.prompt;++i)wav[i]=(1-t)*p.initial[i]+t*p.cond[i];
        for(size_t i=0;i<p.prompt/FRAME*MELS;++i)mel[i]=t*p.mel_cond[i];
        auto [pred_wav,pred_mel]=engine.step(wav,mel,p.cond,p.mel_cond,p.text,t);
        for(size_t i=0;i<wav.size();++i){float clean=i<p.prompt?p.cond[i]:pred_wav[i];wav[i]=wav[i]+dt*((clean-wav[i])/std::max(1-t,0.02f));}
        if(step!=3)for(size_t i=0;i<mel.size();++i){float clean=i<p.prompt/FRAME*MELS?p.mel_cond[i]:pred_mel[i];mel[i]=mel[i]+dt*((clean-mel[i])/std::max(1-t,0.02f));}
    }
    for(size_t i=0;i<p.prompt;++i)wav[i]=p.cond[i];for(float& x:wav)x/=9.0f;
    if(!o.dump_dir.empty())write_binary(o.dump_dir/"final_full.f32",wav);
    std::vector<float> output(wav.begin()+p.prompt,wav.begin()+p.predicted);if(p.rms<0.1f)for(float& x:output)x=x*p.rms/0.1f;
    for(float x:output)require(std::isfinite(x),"Inference produced NaN/Inf");return output;
}
#ifndef WAVEGEN_EMBEDDED
int wmain(int argc,wchar_t** argv){
    try{
        auto all_started=Clock::now();Options o=parse(argc,argv);
        if(o.tokenize_only){auto ids=tokenize(o.assets/"vocab.txt",o.text,o.frames>0?o.frames:2048);write_binary(o.dump_dir/"text_ids.i64",ids);std::cout<<"Tokenization complete\n";return 0;}
        validate_output_paths(o);
        setup_dlls(o.cuda_dir);
        std::cout<<"Native ONNX Runtime "<<OrtGetApiBase()->GetVersionString()<<", provider="<<(o.cpu?"CPU":"CUDA")<<", TF32="<<o.tf32<<'\n';
        Prepared prepared;if(o.fixture.empty()){prepared=prepare(o);std::cout<<"Prepared "<<prepared.frames<<" frames; output "<<double(prepared.predicted-prepared.prompt)/SAMPLE_RATE<<" s; frontend "<<prepared.seconds<<" s\n";}
        if(o.frontend_only)return 0;
        auto load_started=Clock::now();Engine engine(o,o.fixture.empty()?prepared.frames:o.frames);double load_seconds=elapsed(load_started);std::cout<<"Model load "<<load_seconds<<" s\n";
        if(!o.fixture.empty()){
            size_t f=size_t(o.frames);auto wav=read_binary<float>(o.fixture/"wav_state.f32",f*FRAME);auto mel=read_binary<float>(o.fixture/"mel_state.f32",f*MELS);
            auto cond=read_binary<float>(o.fixture/"wav_cond.f32",f*FRAME);auto mel_cond=read_binary<float>(o.fixture/"mel_cond.f32",f*MELS);auto text=read_binary<int64_t>(o.fixture/"text_ids.i64",f);auto time=read_binary<float>(o.fixture/"time.f32",1);
            auto [pw,pm]=engine.step(wav,mel,cond,mel_cond,text,time[0]);fs::path dest=o.dump_dir.empty()?o.fixture/"native":o.dump_dir;write_binary(dest/"pred_wav.f32",pw);write_binary(dest/"pred_mel.f32",pm);std::cout<<"Saved one-step fixture predictions\n";return 0;
        }
        std::vector<float> result;std::vector<double> durations,total_durations,frontend_durations;
        for(int run=-o.warmups;run<o.repeats;++run){
            auto request_start=Clock::now();Prepared fresh;Prepared* current=&prepared;
            if(o.benchmark_full){fresh=prepare(o);current=&fresh;}
            auto core_start=Clock::now();result=synthesize(engine,*current,o);double core_seconds=elapsed(core_start);
            double total_seconds=o.benchmark_full?elapsed(request_start):core_seconds+prepared.seconds;
            std::cout<<(run<0?"Warmup ":"Run ")<<(run<0?run+o.warmups+1:run+1)<<": core="<<core_seconds<<" s, request="<<total_seconds<<" s\n";
            if(run>=0){durations.push_back(core_seconds);total_durations.push_back(total_seconds);frontend_durations.push_back(current->seconds);}
        }
        write_wav(o.output,result);double median=median_value(durations),median_total=median_value(total_durations),median_frontend=median_value(frontend_durations);
        double audio_seconds=double(result.size())/SAMPLE_RATE,squares=0,peak=0;for(float x:result){squares+=double(x)*x;peak=std::max(peak,std::abs(double(x)));}
        if(!o.metrics.parent_path().empty())fs::create_directories(o.metrics.parent_path());std::ofstream report(o.metrics);report<<std::setprecision(10)<<"{\n  \"implementation\": \"native C++ ONNX Runtime CUDA\",\n  \"python_runtime_required\": false,\n  \"onnxruntime_version\": "<<json_string(OrtGetApiBase()->GetVersionString())<<",\n  \"provider\": "<<json_string(o.cpu?"CPUExecutionProvider":"CUDAExecutionProvider")<<",\n  \"frontend_precision\": "<<json_string(prepared.frontend_precision)<<",\n  \"precision\": "<<json_string(engine.precision)<<",\n  \"tf32\": "<<(o.tf32?"true":"false")<<",\n  \"model\": "<<json_string(printable(o.model))<<",\n  \"output\": "<<json_string(printable(fs::absolute(o.output)))<<",\n  \"text\": "<<json_string(o.text)<<",\n  \"noise_source\": "<<json_string(o.noise_file.empty()?"C++ mt19937_64 normal_distribution (not PyTorch RNG parity)":printable(o.noise_file))<<",\n  \"seed\": "<<o.seed<<",\n  \"steps\": 4,\n  \"frames\": "<<prepared.frames<<",\n  \"sample_rate\": 24000,\n  \"audio_seconds\": "<<audio_seconds<<",\n  \"model_load_seconds\": "<<load_seconds<<",\n  \"frontend_seconds\": "<<prepared.seconds<<",\n  \"warmup_runs\": "<<o.warmups<<",\n  \"synthesis_seconds\": [";
        for(size_t i=0;i<durations.size();++i){if(i)report<<", ";report<<durations[i];}report<<"],\n  \"median_total_request_seconds\": "<<median_total<<",\n  \"median_frontend_seconds\": "<<median_frontend<<",\n  \"full_request_timing_measured\": "<<(o.benchmark_full?"true":"false")<<",\n  \"frontend_recomputed_each_run\": "<<(o.benchmark_full?"true":"false")<<",\n  \"cuda_graph\": "<<(o.cuda_graph?"true":"false")<<",\n  \"gpu_euler\": "<<(engine.gpu_euler_active?"true":"false")<<",\n  \"median_synthesis_seconds\": "<<median<<",\n  \"median_frontend_plus_synthesis_seconds\": "<<median_total<<",\n  \"median_frontend_plus_synthesis_rtf\": "<<median_total/audio_seconds<<",\n  \"persistent_cuda_io_binding\": "<<(!o.cpu&&o.iobinding?"true":"false")<<",\n  \"median_rtf\": "<<median/audio_seconds<<",\n  \"peak_absolute\": "<<peak<<",\n  \"rms\": "<<std::sqrt(squares/result.size())<<",\n  \"total_process_seconds\": "<<elapsed(all_started)<<"\n}\n";
        report.flush();require(bool(report),"Cannot write metrics: "+printable(o.metrics));report.close();require(!report.fail(),"Cannot close metrics: "+printable(o.metrics));
        std::cout<<"Saved "<<printable(fs::absolute(o.output))<<"; median="<<median<<" s, RTF="<<median/audio_seconds<<'\n';return 0;
    }catch(const Ort::Exception& e){std::cerr<<"ONNX Runtime error: "<<e.what()<<'\n';return 2;}catch(const std::exception& e){std::cerr<<"Error: "<<e.what()<<'\n';return 1;}
}
#endif  // WAVEGEN_EMBEDDED

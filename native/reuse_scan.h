#pragma once
// Native FP32 Mamba selective scan for NVIDIA RE-USE. The ONNX graph supplies
// the convolutions/projections; this op keeps all recurrence data on the CUDA
// provider's own stream. No Python, nvcc or CUDA toolkit installation is used.
#include <windows.h>
#include <onnxruntime_cxx_api.h>
#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace wavegen_reuse {
namespace scan_detail {
inline void check(bool ok,const std::string& message){if(!ok)throw std::runtime_error(message);}
template<class T> T symbol(HMODULE module,const char* name){
    auto value=reinterpret_cast<T>(GetProcAddress(module,name));
    check(value!=nullptr,std::string("RE-USE CUDA symbol missing: ")+name);return value;
}
class DeviceKernels {
    using ModuleLoad=int(*)(void**,const void*);
    using GetFunction=int(*)(void**,void*,const char*);
    using Launch=int(*)(void*,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,void*,void**,void**);
    using ModuleUnload=int(*)(void*);
    using GetContext=int(*)(void**);
    std::once_flag ready_;
    void* module_=nullptr;
    void* sequential_=nullptr;
    void* parallel_=nullptr;
    void* warp_=nullptr;
    void* context_=nullptr;
    Launch launch_=nullptr;
    ModuleUnload unload_=nullptr;
    GetContext current_=nullptr;
    void initialize(){
        HMODULE nvrtc=GetModuleHandleW(L"nvrtc64_120_0.dll");
        if(!nvrtc)nvrtc=LoadLibraryW(L"nvrtc64_120_0.dll");
        check(nvrtc!=nullptr,"RE-USE requires bundled nvrtc64_120_0.dll");
        using Create=int(*)(void**,const char*,const char*,int,const char*const*,const char*const*);
        using Compile=int(*)(void*,int,const char*const*);
        using GetSize=int(*)(void*,size_t*);using GetText=int(*)(void*,char*);using Destroy=int(*)(void**);
        auto create=symbol<Create>(nvrtc,"nvrtcCreateProgram");auto compile=symbol<Compile>(nvrtc,"nvrtcCompileProgram");
        auto size=symbol<GetSize>(nvrtc,"nvrtcGetPTXSize"),log_size=symbol<GetSize>(nvrtc,"nvrtcGetProgramLogSize");
        auto text=symbol<GetText>(nvrtc,"nvrtcGetPTX"),log_text=symbol<GetText>(nvrtc,"nvrtcGetProgramLog");
        auto destroy=symbol<Destroy>(nvrtc,"nvrtcDestroyProgram");
        const char* code=R"CUDA(
__device__ __forceinline__ float softplus(float x){return x>20.0f?x:log1pf(expf(x));}
extern "C" __global__ void reuse_scan_sequential(const float* u,const float* dt,const float* A,
 const float* B,const float* C,const float* D,const float* z,const float* bias,float* y,int batches,int channels,int length){
    int q=blockIdx.x*blockDim.x+threadIdx.x;
    if(q>=batches*channels)return;
    int b=q/channels,d=q%channels;
    float h[16];
    #pragma unroll
    for(int n=0;n<16;++n)h[n]=0.0f;
    for(int t=0;t<length;++t){
        int p=q*length+t;
        float step=softplus(dt[p]+bias[d]),input=u[p],out=0.0f;
        #pragma unroll
        for(int n=0;n<16;++n){
            int bc=(b*16+n)*length+t;
            h[n]=expf(step*A[d*16+n])*h[n]+(step*B[bc])*input;
            out=out+h[n]*C[bc];
        }
        y[p]=(out+D[d]*input)*(z[p]/(1.0f+expf(-z[p])));
    }
}
// Inclusive associative scan of affine transforms h[t]=a[t]*h[t-1]+b[t].
// One block handles one (batch,channel), with coalesced time-axis reads.
// State dimension is accumulated in FP32; temporal tiles retain exact context.
extern "C" __global__ void reuse_scan_parallel(const float* u,const float* dt,const float* A,
 const float* B,const float* C,const float* D,const float* z,const float* bias,float* y,int batches,int channels,int length){
    int q=blockIdx.x,b=q/channels,d=q%channels,thread=threadIdx.x,lane=thread&31,warp=thread>>5;
    __shared__ float warp_a[8],warp_b[8],carry[16];
    if(thread<16)carry[thread]=0.0f;
    __syncthreads();
    for(int base=0;base<length;base+=256){
        int t=base+thread,p=q*length+t;
        bool valid=t<length;
        float input=valid?u[p]:0.0f,step=valid?softplus(dt[p]+bias[d]):0.0f,out=0.0f;
        #pragma unroll 1
        for(int n=0;n<16;++n){
            int bc=(b*16+n)*length+t;
            float a=valid?expf(step*A[d*16+n]):1.0f;
            float v=valid?(step*B[bc])*input:0.0f;
            #pragma unroll
            for(int offset=1;offset<32;offset*=2){
                float pa=__shfl_up_sync(0xffffffff,a,offset),pv=__shfl_up_sync(0xffffffff,v,offset);
                if(lane>=offset){v=v+a*pv;a=a*pa;}
            }
            if(lane==31){warp_a[warp]=a;warp_b[warp]=v;}
            __syncthreads();
            // Eight warp aggregates are scanned by the first warp.
            if(warp==0){
                float wa=lane<8?warp_a[lane]:1.0f,wb=lane<8?warp_b[lane]:0.0f;
                #pragma unroll
                for(int offset=1;offset<8;offset*=2){
                    float pa=__shfl_up_sync(0xffffffff,wa,offset),pv=__shfl_up_sync(0xffffffff,wb,offset);
                    if(lane>=offset){wb=wb+wa*pv;wa=wa*pa;}
                }
                if(lane<8){warp_a[lane]=wa;warp_b[lane]=wb;}
            }
            __syncthreads();
            if(warp>0){v=v+a*warp_b[warp-1];a=a*warp_a[warp-1];}
            float h=v+a*carry[n];
            if(valid)out=out+h*C[bc];
            // Ensure every lane has read carry before it is replaced by tile end.
            __syncthreads();
            if(thread==255)carry[n]=h;
            __syncthreads();
        }
        if(valid)y[p]=(out+D[d]*input)*(z[p]/(1.0f+expf(-z[p])));
    }
}
extern "C" __global__ void reuse_scan_warp(const float* u,const float* dt,const float* A,
 const float* B,const float* C,const float* D,const float* z,const float* bias,float* y,int batches,int channels,int length){
    int q=blockIdx.x*4+(threadIdx.x>>5),lane=threadIdx.x&31;
    if(q>=batches*channels)return;
    int b=q/channels,d=q%channels;
    float carry[16];
    #pragma unroll
    for(int n=0;n<16;++n)carry[n]=0.0f;
    for(int base=0;base<length;base+=32){
        int t=base+lane,p=q*length+t;
        bool valid=t<length;
        float input=valid?u[p]:0.0f,step=valid?softplus(dt[p]+bias[d]):0.0f,out=0.0f;
        #pragma unroll
        for(int n=0;n<16;++n){
            int bc=(b*16+n)*length+t;
            float a=valid?expf(step*A[d*16+n]):1.0f;
            float v=valid?(step*B[bc])*input:0.0f;
            #pragma unroll
            for(int offset=1;offset<32;offset*=2){
                float pa=__shfl_up_sync(0xffffffff,a,offset),pv=__shfl_up_sync(0xffffffff,v,offset);
                if(lane>=offset){v=v+a*pv;a=a*pa;}
            }
            float h=v+a*carry[n];
            carry[n]=__shfl_sync(0xffffffff,h,31);
            if(valid)out=out+h*C[bc];
        }
        if(valid)y[p]=(out+D[d]*input)*(z[p]/(1.0f+expf(-z[p])));
    }
}
)CUDA";
        void* program=nullptr;
        check(create(&program,code,"wavegen_reuse_scan.cu",0,nullptr,nullptr)==0,"RE-USE NVRTC create failed");
        const char* options[]={"--gpu-architecture=compute_80","--fmad=false","--std=c++11"};
        int status=compile(program,3,options);
        if(status){size_t n=0;log_size(program,&n);std::string log(n,'\0');log_text(program,log.data());destroy(&program);throw std::runtime_error("RE-USE NVRTC compile failed: "+log);}
        size_t n=0;check(size(program,&n)==0,"RE-USE PTX size failed");
        std::string ptx(n,'\0');status=text(program,ptx.data());destroy(&program);check(status==0,"RE-USE PTX read failed");
        HMODULE driver=GetModuleHandleW(L"nvcuda.dll");if(!driver)driver=LoadLibraryW(L"nvcuda.dll");
        check(driver!=nullptr,"NVIDIA CUDA driver unavailable");
        auto load=symbol<ModuleLoad>(driver,"cuModuleLoadData");auto function=symbol<GetFunction>(driver,"cuModuleGetFunction");
        launch_=symbol<Launch>(driver,"cuLaunchKernel");unload_=symbol<ModuleUnload>(driver,"cuModuleUnload");
        current_=symbol<GetContext>(driver,"cuCtxGetCurrent");
        check(current_(&context_)==0&&context_,"RE-USE CUDA context unavailable");
        check(load(&module_,ptx.data())==0,"RE-USE CUDA module load failed");
        check(function(&sequential_,module_,"reuse_scan_sequential")==0,"RE-USE sequential scan symbol missing");
        check(function(&parallel_,module_,"reuse_scan_parallel")==0,"RE-USE parallel scan symbol missing");
        check(function(&warp_,module_,"reuse_scan_warp")==0,"RE-USE warp scan symbol missing");
    }
public:
    int strategy=1; // 0 sequential reference, 1 warp scan, 2 block scan (benchmark).
    ~DeviceKernels(){if(module_&&unload_)unload_(module_);}
    void run(const std::array<const float*,8>& inputs,float* output,int batches,int channels,int length,void* stream){
        std::call_once(ready_,[&]{initialize();});
        void* active=nullptr;check(current_(&active)==0&&active==context_,"RE-USE CUDA context changed");
        std::array<const float*,8> pointers=inputs;
        void* args[]={&pointers[0],&pointers[1],&pointers[2],&pointers[3],&pointers[4],&pointers[5],&pointers[6],&pointers[7],&output,&batches,&channels,&length};
        const unsigned blocks=strategy==2?unsigned(batches*channels):strategy==1?unsigned((batches*channels+3)/4):unsigned((batches*channels+127)/128);
        const int status=launch_(strategy==2?parallel_:strategy==1?warp_:sequential_,blocks,1,1,strategy==2?256:128,1,1,0,stream,args,nullptr);
        check(status==0,"RE-USE scan kernel launch failed: "+std::to_string(status));
    }
};
struct ScanKernel {
    std::shared_ptr<DeviceKernels> device;
    explicit ScanKernel(std::shared_ptr<DeviceKernels> value):device(std::move(value)){}
    OrtStatusPtr ComputeV2(OrtKernelContext* context) noexcept {
        try {
            Ort::KernelContext ctx(context);
            check(ctx.GetInputCount()==8,"RE-USE scan expects eight tensors");
            std::array<const float*,8> pointers{};
            std::array<std::vector<int64_t>,8> shapes;
            for(size_t i=0;i<8;++i){auto value=ctx.GetInput(i);shapes[i]=value.GetTensorTypeAndShapeInfo().GetShape();pointers[i]=value.GetTensorData<float>();}
            const auto& shape=shapes[0];
            check(shape.size()==3&&shape==shapes[1]&&shape==shapes[6],"RE-USE scan u/delta/z shapes differ");
            check(shape[0]>0&&shape[1]>0&&shape[2]>0&&shape[0]<=16384&&shape[1]<=4096&&shape[2]<=32768&&shape[0]*shape[1]*shape[2]<=std::numeric_limits<int>::max(),"RE-USE scan tensor dimensions out of bounds");
            const int b=int(shape[0]),d=int(shape[1]),l=int(shape[2]);
            check(shapes[2]==std::vector<int64_t>{d,16},"RE-USE scan requires A[channel,16]");
            check(shapes[3]==std::vector<int64_t>{b,16,l}&&shapes[4]==shapes[3],"RE-USE scan B/C shapes differ");
            check(shapes[5]==std::vector<int64_t>{d}&&shapes[7]==shapes[5],"RE-USE scan skip/bias shapes differ");
            auto output=ctx.GetOutput(0,shape);
            device->run(pointers,output.GetTensorMutableData<float>(),b,d,l,ctx.GetGPUComputeStream());
            return nullptr;
        }catch(const std::exception& error){return Ort::GetApi().CreateStatus(ORT_RUNTIME_EXCEPTION,error.what());}
        catch(...){return Ort::GetApi().CreateStatus(ORT_RUNTIME_EXCEPTION,"Unknown RE-USE scan failure");}
    }
};
struct ScanOp : Ort::CustomOpBase<ScanOp,ScanKernel,true> {
    std::shared_ptr<DeviceKernels> device=std::make_shared<DeviceKernels>();
    OrtStatusPtr CreateKernelV2(const OrtApi& api,const OrtKernelInfo*,void** kernel)const noexcept {
        try{*kernel=new ScanKernel(device);return nullptr;}
        catch(const std::exception& error){return api.CreateStatus(ORT_RUNTIME_EXCEPTION,error.what());}
    }
    const char* GetName()const{return "SelectiveScan";}
    const char* GetExecutionProviderType()const{return "CUDAExecutionProvider";}
    size_t GetInputTypeCount()const{return 8;}
    size_t GetOutputTypeCount()const{return 1;}
    ONNXTensorElementDataType GetInputType(size_t)const{return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;}
    ONNXTensorElementDataType GetOutputType(size_t)const{return ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT;}
};
} // namespace scan_detail
// Declare this before the session member so it outlives that session's kernels.
class ScanRegistration {
    scan_detail::ScanOp op_;
    Ort::CustomOpDomain domain_{"wavegen.reuse"};
public:
    explicit ScanRegistration(bool parallel=true){op_.device->strategy=parallel?1:0;domain_.Add(&op_);}
    void set_strategy_for_validation(int strategy){scan_detail::check(strategy>=0&&strategy<=2,"Invalid scan strategy");op_.device->strategy=strategy;}
    void add(Ort::SessionOptions& options){options.Add(domain_);}
};
} // namespace wavegen_reuse

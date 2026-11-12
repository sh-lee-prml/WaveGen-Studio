#pragma once
// CUDA Driver/Runtime and NVRTC C APIs are loaded from native redistributable DLLs.
// No Python, CUDA toolkit install, or nvcc process is needed on the target PC.
class GpuContext {
    using Allocate=int(*)(void**,size_t);using Release=int(*)(void*);
    using CreateStream=int(*)(void**,unsigned);using DestroyStream=int(*)(void*);
    using Synchronize=int(*)(void*);using DeviceSynchronize=int(*)();using CopyAsync=int(*)(void*,const void*,size_t,int,void*);
    using ClearAsync=int(*)(void*,int,size_t,void*);using ErrorText=const char*(*)(int);
    Allocate allocate_;Release release_;CreateStream create_;DestroyStream destroy_;Synchronize sync_;DeviceSynchronize device_sync_;CopyAsync copy_;ClearAsync clear_;ErrorText error_;
    using ModuleLoad=int(*)(void**,const void*);using GetFunction=int(*)(void**,void*,const char*);
    using Launch=int(*)(void*,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,unsigned,void*,void**,void**);
    using ModuleUnload=int(*)(void*);
    Launch launch_=nullptr;ModuleUnload unload_=nullptr;void* module_=nullptr;void* anchor_=nullptr;void* euler_=nullptr;void* velocity_euler_=nullptr;
    template<class T> static T symbol(HMODULE module,const char* name){auto value=reinterpret_cast<T>(GetProcAddress(module,name));require(value!=nullptr,std::string("Missing native CUDA export ")+name);return value;}
    void check(int code){if(code)throw std::runtime_error(std::string("CUDA runtime: ")+error_(code));}
    static void driver_check(int code,const char* op){require(code==0,std::string(op)+" failed, CUDA driver code "+std::to_string(code));}
public:
    void* stream=nullptr;
    GpuContext(){
        HMODULE runtime=GetModuleHandleW(L"cudart64_12.dll");if(!runtime)runtime=LoadLibraryW(L"cudart64_12.dll");require(runtime!=nullptr,"CUDA runtime DLL missing");
        allocate_=symbol<Allocate>(runtime,"cudaMalloc");release_=symbol<Release>(runtime,"cudaFree");create_=symbol<CreateStream>(runtime,"cudaStreamCreateWithFlags");destroy_=symbol<DestroyStream>(runtime,"cudaStreamDestroy");sync_=symbol<Synchronize>(runtime,"cudaStreamSynchronize");copy_=symbol<CopyAsync>(runtime,"cudaMemcpyAsync");clear_=symbol<ClearAsync>(runtime,"cudaMemsetAsync");error_=symbol<ErrorText>(runtime,"cudaGetErrorString");
        device_sync_=symbol<DeviceSynchronize>(runtime,"cudaDeviceSynchronize");check(create_(&stream,1));
    }
    ~GpuContext(){if(stream){sync_(stream);if(module_&&unload_)unload_(module_);destroy_(stream);}}
    void* allocate(size_t bytes){void* pointer=nullptr;check(allocate_(&pointer,bytes));return pointer;}
    void release(void* pointer){if(pointer)release_(pointer);}
    void copy(void* dst,const void* src,size_t bytes,int kind){check(copy_(dst,src,bytes,kind,stream));}
    void clear(void* pointer,size_t bytes){check(clear_(pointer,0,bytes,stream));}
    void synchronize(){check(sync_(stream));}
    void synchronize_device(){check(device_sync_());}
    void compile(){
        if(module_)return;
        HMODULE nvrtc=LoadLibraryW(L"nvrtc64_120_0.dll");require(nvrtc!=nullptr,"NVRTC DLL needed for native GPU Euler kernels");
        using CreateProgram=int(*)(void**,const char*,const char*,int,const char*const*,const char*const*);
        using CompileProgram=int(*)(void*,int,const char*const*);using GetSize=int(*)(void*,size_t*);using GetText=int(*)(void*,char*);using DestroyProgram=int(*)(void**);
        auto create=symbol<CreateProgram>(nvrtc,"nvrtcCreateProgram");auto compile=symbol<CompileProgram>(nvrtc,"nvrtcCompileProgram");auto ptxsize=symbol<GetSize>(nvrtc,"nvrtcGetPTXSize");auto ptxtext=symbol<GetText>(nvrtc,"nvrtcGetPTX");auto logsize=symbol<GetSize>(nvrtc,"nvrtcGetProgramLogSize");auto logtext=symbol<GetText>(nvrtc,"nvrtcGetProgramLog");auto destroy=symbol<DestroyProgram>(nvrtc,"nvrtcDestroyProgram");
        const char* source=R"CUDA(
extern "C" __global__ void anchor(float* wav,float* mel,const float* initial,const float* wc,const float* mc,int prompt,int mprompt,float t,float* timestep){
    int i=blockIdx.x*blockDim.x+threadIdx.x;
    if(i<prompt)wav[i]=(1.0f-t)*initial[i]+t*wc[i];
    if(i<mprompt)mel[i]=t*mc[i];
    if(i==0)timestep[0]=t;
}
extern "C" __global__ void euler(float* wav,float* mel,const float* pw,const float* pm,const float* wc,const float* mc,int prompt,int mprompt,int nw,int nm,float t,float dt,int last){
    int i=blockIdx.x*blockDim.x+threadIdx.x;
    float denominator=1.0f-t;
    if(i<nw){float clean=i<prompt?wc[i]:pw[i];wav[i]=wav[i]+dt*((clean-wav[i])/denominator);if(last&&i<prompt)wav[i]=wc[i];}
    if(i<nm&&!last){float clean=i<mprompt?mc[i]:pm[i];mel[i]=mel[i]+dt*((clean-mel[i])/denominator);}
}
extern "C" __global__ void velocity_euler(float* wav,float* mel,const float* vw,const float* vm,const float* initial,const float* wc,const float* mc,int prompt,int mprompt,int nw,int nm,float dt,int last){
    int i=blockIdx.x*blockDim.x+threadIdx.x;
    if(i<nw){float velocity=i<prompt?wc[i]-initial[i]:vw[i];wav[i]=wav[i]+dt*velocity;if(last&&i<prompt)wav[i]=wc[i];}
    if(i<nm){float velocity=i<mprompt?mc[i]:vm[i];mel[i]=mel[i]+dt*velocity;}
}
)CUDA";
        void* program=nullptr;require(create(&program,source,"wavegen_native_euler.cu",0,nullptr,nullptr)==0,"NVRTC create failed");
        const char* options[]={"--gpu-architecture=compute_80","--fmad=false","--std=c++11"};int status=compile(program,3,options);
        if(status){size_t n=0;logsize(program,&n);std::string log(n,'\0');logtext(program,log.data());destroy(&program);throw std::runtime_error("NVRTC compile failed: "+log);}
        size_t n=0;require(ptxsize(program,&n)==0,"NVRTC PTX size failed");std::string ptx(n,'\0');require(ptxtext(program,ptx.data())==0,"NVRTC PTX failed");destroy(&program);
        HMODULE driver=LoadLibraryW(L"nvcuda.dll");require(driver!=nullptr,"NVIDIA driver missing");auto load=symbol<ModuleLoad>(driver,"cuModuleLoadData");auto function=symbol<GetFunction>(driver,"cuModuleGetFunction");launch_=symbol<Launch>(driver,"cuLaunchKernel");unload_=symbol<ModuleUnload>(driver,"cuModuleUnload");
        driver_check(load(&module_,ptx.data()),"cuModuleLoadData");driver_check(function(&anchor_,module_,"anchor"),"cuModuleGetFunction(anchor)");driver_check(function(&euler_,module_,"euler"),"cuModuleGetFunction(euler)");
        driver_check(function(&velocity_euler_,module_,"velocity_euler"),"cuModuleGetFunction(velocity_euler)");
    }
    void anchor(void* wav,void* mel,void* initial,void* wc,void* mc,int prompt,int mprompt,float t,void* time){
        void* args[]={&wav,&mel,&initial,&wc,&mc,&prompt,&mprompt,&t,&time};
        driver_check(launch_(anchor_,(prompt+255)/256,1,1,256,1,1,0,stream,args,nullptr),"anchor kernel");
    }
    void euler(void* wav,void* mel,void* pw,void* pm,void* wc,void* mc,int prompt,int mprompt,int nw,int nm,float t,float dt,int last){
        void* args[]={&wav,&mel,&pw,&pm,&wc,&mc,&prompt,&mprompt,&nw,&nm,&t,&dt,&last};
        driver_check(launch_(euler_,(nw+255)/256,1,1,256,1,1,0,stream,args,nullptr),"Euler kernel");
    }
    void velocity_euler(void* wav,void* mel,void* vw,void* vm,void* initial,void* wc,void* mc,int prompt,int mprompt,int nw,int nm,float dt,int last){
        void* args[]={&wav,&mel,&vw,&vm,&initial,&wc,&mc,&prompt,&mprompt,&nw,&nm,&dt,&last};
        driver_check(launch_(velocity_euler_,(nw+255)/256,1,1,256,1,1,0,stream,args,nullptr),"Velocity Euler kernel");
    }
};

#pragma once
#include "philox_dropout.h"

// One shared-weight batch-two graph evaluates conditional/null branches once
// per Euler interval. The graph implements registered BF16 K3 proxy arithmetic;
// this runner supplies masks, anchors the model input and integrates FP32 state.
class VSpecCudaBinding {
    static constexpr size_t STEPS=50,BOTTLENECK=32;
    GpuContext& gpu_;
    Ort::MemoryInfo memory_{"Cuda",OrtDeviceAllocator,0,OrtMemTypeDefault};
    Ort::IoBinding binding_;
    std::vector<void*> buffers_;
    std::vector<Ort::Value> values_;
    size_t frames_;
    std::vector<float> times_;
    size_t dropout_grid_cap_=0;
    void run(Ort::Session& session){
        // A request can execute on a new native HTTP thread. Explicitly finish
        // stream input writes before ORT and output kernels before cancellation.
        gpu_.synchronize();session.Run(Ort::RunOptions{nullptr},binding_);gpu_.synchronize_device();
    }
    void release()noexcept{for(auto* buffer:buffers_)gpu_.release(buffer);buffers_.clear();}
public:
    static std::vector<float> schedule(const fs::path& assets){
        auto times=read_binary<float>(assets/"timesteps.f32",STEPS+1);
        require(times.front()==0&&times.back()==1,"VSpec requires the official 50-step time grid");
        for(size_t i=1;i<times.size();++i)require(std::isfinite(times[i])&&times[i]>times[i-1],"VSpec time grid is invalid");
        return times;
    }
    VSpecCudaBinding(Ort::Session& session,size_t frames,GpuContext& gpu,const std::vector<float>& times)
        :gpu_(gpu),binding_(session),frames_(frames),times_(times){
        require(times_.size()==STEPS+1&&frames>0&&frames<=1500,"Invalid VSpec binding dimensions");
        using DeviceAttribute=int(*)(int*,int,int);
        auto attribute=reinterpret_cast<DeviceAttribute>(GetProcAddress(GetModuleHandleW(L"cudart64_12.dll"),"cudaDeviceGetAttribute"));
        int multiprocessors=0,max_threads=0;
        require(attribute&&attribute(&multiprocessors,16,0)==0&&attribute(&max_threads,39,0)==0&&multiprocessors>0&&max_threads>=256,"Cannot query CUDA dropout RNG launch policy");
        dropout_grid_cap_=size_t(multiprocessors)*size_t(max_threads/256);
        const char* names[]={"wav_state","mel_state","wav_cond","mel_cond","text_ids","time","prompt_frames","step_index","bottleneck_keep","wav_velocity","mel_velocity"};
        const size_t counts[]={frames*FRAME,frames*MELS,frames*FRAME,frames*MELS,frames,1,1,1,4*frames*BOTTLENECK,frames*FRAME,frames*MELS};
        std::array<int64_t,3> wav_shape{1,int64_t(frames),FRAME},mel_shape{1,int64_t(frames),MELS};
        std::array<int64_t,2> text_shape{1,int64_t(frames)};std::array<int64_t,1> scalar_shape{1};
        std::array<int64_t,4> keep_shape{4,1,int64_t(frames),BOTTLENECK};
        try{
            for(size_t i=0;i<11;++i){
                const bool integer=i==4||i==6||i==7;void* pointer=gpu_.allocate(counts[i]*(integer?sizeof(int64_t):sizeof(float)));buffers_.push_back(pointer);
                if(integer){const auto* shape=i==4?text_shape.data():scalar_shape.data();const size_t dimensions=i==4?2:1;
                    values_.emplace_back(Ort::Value::CreateTensor<int64_t>(memory_,static_cast<int64_t*>(pointer),counts[i],shape,dimensions));}
                else if(i==5)values_.emplace_back(Ort::Value::CreateTensor<float>(memory_,static_cast<float*>(pointer),1,scalar_shape.data(),1));
                else if(i==8)values_.emplace_back(Ort::Value::CreateTensor<float>(memory_,static_cast<float*>(pointer),counts[i],keep_shape.data(),4));
                else{const auto shape=(i==1||i==3||i==10)?mel_shape:wav_shape;
                    values_.emplace_back(Ort::Value::CreateTensor<float>(memory_,static_cast<float*>(pointer),counts[i],shape.data(),3));}
                if(i<9)binding_.BindInput(names[i],values_.back());else binding_.BindOutput(names[i],values_.back());
            }
            // 11/12 are unmodified integration states; 13 is initial wav noise.
            buffers_.push_back(gpu_.allocate(frames*FRAME*sizeof(float)));
            buffers_.push_back(gpu_.allocate(frames*MELS*sizeof(float)));
            buffers_.push_back(gpu_.allocate(frames*FRAME*sizeof(float)));
        }catch(...){release();throw;}
    }
    ~VSpecCudaBinding(){release();}
    size_t frames()const{return frames_;}
    std::pair<std::vector<float>,std::vector<float>> velocity(Ort::Session& session,
            const std::vector<float>& wav,const std::vector<float>& mel,const std::vector<float>& cond,
            const std::vector<float>& mel_cond,const std::vector<int64_t>& text,size_t prompt_frames,
            size_t step,const std::vector<float>& keep,float time=std::numeric_limits<float>::quiet_NaN()){
        require(wav.size()==frames_*FRAME&&mel.size()==frames_*MELS&&cond.size()==wav.size()&&mel_cond.size()==mel.size()&&text.size()==frames_,"VSpec fixture dimensions changed");
        require(step<STEPS&&prompt_frames<frames_&&keep.size()==4*frames_*BOTTLENECK,"Invalid VSpec fixture controls");
        const int64_t prompt_value=int64_t(prompt_frames),step_value=int64_t(step);
        if(!std::isfinite(time))time=times_[step];
        gpu_.copy(buffers_[0],wav.data(),wav.size()*sizeof(float),1);gpu_.copy(buffers_[1],mel.data(),mel.size()*sizeof(float),1);
        gpu_.copy(buffers_[2],cond.data(),cond.size()*sizeof(float),1);gpu_.copy(buffers_[3],mel_cond.data(),mel_cond.size()*sizeof(float),1);
        gpu_.copy(buffers_[4],text.data(),text.size()*sizeof(int64_t),1);gpu_.copy(buffers_[5],&time,sizeof(float),1);
        gpu_.copy(buffers_[6],&prompt_value,sizeof(int64_t),1);gpu_.copy(buffers_[7],&step_value,sizeof(int64_t),1);
        gpu_.copy(buffers_[8],keep.data(),keep.size()*sizeof(float),1);run(session);
        std::vector<float> vw(wav.size()),vm(mel.size());gpu_.copy(vw.data(),buffers_[9],vw.size()*sizeof(float),2);gpu_.copy(vm.data(),buffers_[10],vm.size()*sizeof(float),2);gpu_.synchronize();return {std::move(vw),std::move(vm)};
    }
    std::vector<float> generate(Ort::Session& session,const std::vector<float>& initial,
            const std::vector<float>& cond,const std::vector<float>& mel_cond,const std::vector<int64_t>& text,size_t prompt,
            const std::function<void()>& check_cancelled={},const std::function<void(size_t,size_t)>& progress={},
            const std::vector<float>* fixture_masks=nullptr){
        const size_t wav_bytes=frames_*FRAME*sizeof(float),mel_bytes=frames_*MELS*sizeof(float),mask_count=4*frames_*BOTTLENECK;
        require(initial.size()==frames_*FRAME&&cond.size()==initial.size()&&mel_cond.size()==frames_*MELS&&text.size()==frames_,"VSpec generation dimensions changed");
        require(prompt>0&&prompt%FRAME==0&&prompt<initial.size(),"VSpec prompt is invalid");
        require(!fixture_masks||fixture_masks->size()==STEPS*mask_count,"VSpec dropout fixture must contain all 50 steps");
        const int64_t prompt_frames=int64_t(prompt/FRAME);
        gpu_.copy(buffers_[11],initial.data(),wav_bytes,1);gpu_.copy(buffers_[13],initial.data(),wav_bytes,1);gpu_.clear(buffers_[12],mel_bytes);
        gpu_.copy(buffers_[2],cond.data(),wav_bytes,1);gpu_.copy(buffers_[3],mel_cond.data(),mel_bytes,1);
        gpu_.copy(buffers_[4],text.data(),text.size()*sizeof(int64_t),1);gpu_.copy(buffers_[6],&prompt_frames,sizeof(int64_t),1);
        // The dedicated dropout generator is reset to seed zero per segment,
        // independent of the user waveform seed, as in the official sampler.
        // The native Philox implementation follows torch.rand's device grid and
        // four-value offset increments; all official F480 fixture masks match.
        PhiloxDropoutGenerator dropout_rng(dropout_grid_cap_);std::vector<float> keep(mask_count);
        try{
            if(check_cancelled)check_cancelled();if(progress)progress(0,STEPS);
            for(size_t step=0;step<STEPS;++step){
                if(check_cancelled)check_cancelled();
                const float* masks=nullptr;
                if(fixture_masks)masks=fixture_masks->data()+step*mask_count;
                else{for(size_t draw=0;draw<4;++draw)dropout_rng.fill(keep.data()+draw*frames_*BOTTLENECK,frames_*BOTTLENECK);masks=keep.data();}
                gpu_.copy(buffers_[8],masks,mask_count*sizeof(float),1);
                const int64_t index=int64_t(step);gpu_.copy(buffers_[7],&index,sizeof(int64_t),1);
                gpu_.copy(buffers_[0],buffers_[11],wav_bytes,3);gpu_.copy(buffers_[1],buffers_[12],mel_bytes,3);
                const float time=times_[step],dt=times_[step+1]-time;
                gpu_.anchor(buffers_[0],buffers_[1],buffers_[13],buffers_[2],buffers_[3],int(prompt),int(prompt/FRAME*MELS),time,buffers_[5]);
                run(session);
                gpu_.velocity_euler(buffers_[11],buffers_[12],buffers_[9],buffers_[10],buffers_[13],buffers_[2],buffers_[3],int(prompt),int(prompt/FRAME*MELS),int(initial.size()),int(mel_cond.size()),dt,step+1==STEPS);
                gpu_.synchronize();if(progress)progress(step+1,STEPS);if(check_cancelled)check_cancelled();
            }
            std::vector<float> result(initial.size());gpu_.copy(result.data(),buffers_[11],wav_bytes,2);gpu_.synchronize();return result;
        }catch(...){gpu_.synchronize();throw;}
    }
};

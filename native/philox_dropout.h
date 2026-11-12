#pragma once

// Philox4x32-10 with the CUDA uniform-float/grid-stride mapping used by
// torch.rand(F,32). No PyTorch/curand runtime dependency is needed. The grid cap
// comes from the active device, so offset consumption matches that device.
class PhiloxDropoutGenerator {
    uint64_t seed_,scalar_offset_=0;
    size_t grid_cap_;
    static std::array<uint32_t,4> block(uint64_t seed,uint64_t subsequence,uint64_t group){
        std::array<uint32_t,4> counter{uint32_t(group),uint32_t(group>>32),uint32_t(subsequence),uint32_t(subsequence>>32)};
        uint32_t key0=uint32_t(seed),key1=uint32_t(seed>>32);
        for(int round=0;round<10;++round){
            const uint64_t first=uint64_t(0xd2511f53U)*counter[0],second=uint64_t(0xcd9e8d57U)*counter[2];
            counter={uint32_t(second>>32)^counter[1]^key0,uint32_t(second),uint32_t(first>>32)^counter[3]^key1,uint32_t(first)};
            key0+=0x9e3779b9U;key1+=0xbb67ae85U;
        }
        return counter;
    }
public:
    explicit PhiloxDropoutGenerator(size_t grid_cap,uint64_t seed=0):seed_(seed),grid_cap_(grid_cap){require(grid_cap>0,"Invalid CUDA RNG grid cap");}
    void fill(float* output,size_t count){
        require(count>0,"Dropout mask is empty");const size_t grid=std::min((count+255)/256,grid_cap_),stride=256*grid;
        const size_t groups=(count-1)/(stride*4)+1;
        for(size_t thread=0;thread<std::min(count,stride);++thread){
            for(size_t group=0;group<groups;++group){
                const auto values=block(seed_,thread,scalar_offset_/4+group);
                for(size_t component=0;component<4;++component){const size_t index=thread+stride*(4*group+component);if(index>=count)break;
                    // curand uniform is (0,1]; torch maps its exact 1 back to0.
                    float uniform=float(values[component])*0x1p-32f+0x1p-32f;
                    if(uniform==1.0f)uniform=0.0f;output[index]=uniform>=0.2f?1.0f:0.0f;
                }
            }
        }
        scalar_offset_+=groups*4;
    }
    uint64_t scalar_offset()const{return scalar_offset_;}
};

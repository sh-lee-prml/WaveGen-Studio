// Offline fixture renderer using the exact character_effects.h runtime processing.
#include "character_effects.h"
#include "deps/headers/json.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cstring>
using Json=nlohmann::json;
namespace fs=std::filesystem;
std::vector<float> read_pcm(const fs::path& path){
    std::ifstream f(path,std::ios::binary);if(!f)throw std::runtime_error("Cannot read input WAV");
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(f)),{});
    auto u16=[&](size_t p){return uint16_t(bytes.at(p))|uint16_t(bytes.at(p+1))<<8;};
    auto u32=[&](size_t p){return uint32_t(u16(p))|uint32_t(u16(p+2))<<16;};
    if(bytes.size()<44||std::memcmp(bytes.data(),"RIFF",4)||std::memcmp(bytes.data()+8,"WAVE",4))throw std::runtime_error("Expected RIFF WAV");
    bool format=false;size_t data=0,size=0;
    for(size_t p=12;p+8<=bytes.size();){size_t length=u32(p+4);if(length>bytes.size()-p-8)throw std::runtime_error("Invalid WAV chunk");
        if(!std::memcmp(bytes.data()+p,"fmt ",4)){if(length<16||u16(p+8)!=1||u16(p+10)!=1||u32(p+12)!=24000||u16(p+20)!=2||u16(p+22)!=16)throw std::runtime_error("Expected mono 24kHz PCM16 WAV");format=true;}
        if(!std::memcmp(bytes.data()+p,"data",4)){data=p+8;size=length;}p+=8+length+(length&1);}
    if(!format||!data||!size||size%2)throw std::runtime_error("Missing or invalid PCM WAV data");
    std::vector<float> output(size/2);for(size_t i=0;i<output.size();++i)output[i]=int16_t(u16(data+2*i))/32768.0f;return output;
}
void write_pcm(const fs::path& path,const std::vector<float>& samples){
    if(!path.parent_path().empty())fs::create_directories(path.parent_path());std::ofstream out(path,std::ios::binary);
    auto w16=[&](uint16_t x){char b[2]={char(x),char(x>>8)};out.write(b,2);};
    auto w32=[&](uint32_t x){char b[4]={char(x),char(x>>8),char(x>>16),char(x>>24)};out.write(b,4);};
    out.write("RIFF",4);w32(36+uint32_t(samples.size()*2));out.write("WAVEfmt ",8);w32(16);w16(1);w16(1);w32(24000);w32(48000);w16(2);w16(16);out.write("data",4);w32(uint32_t(samples.size()*2));
    for(float value:samples){if(!std::isfinite(value))throw std::runtime_error("Nonfinite sample");int x=std::clamp(int(std::lrint(double(value)*32768.0)),-32768,32767);w16(uint16_t(int16_t(x)));}
    if(!out)throw std::runtime_error("Cannot write output WAV");
}
Json descriptor(const wavegen_character::Profile& p){return {{"id",p.id},{"version",1},{"category",p.category},{"semitones",p.semitones},
    {"drive",p.drive},{"highpass_hz",p.highpass},{"lowpass_hz",p.lowpass},{"ring_hz",p.ring_hz},{"ring_mix",p.ring_mix},
    {"chorus_ms",p.chorus_ms},{"chorus_depth_ms",p.chorus_depth_ms},{"chorus_hz",p.chorus_hz},{"chorus_mix",p.chorus_mix},
    {"echo_ms",p.echo_ms},{"echo_mix",p.echo_mix},{"sub_mix",p.sub_mix},{"bits",p.bits},{"hold",p.hold},{"digital_mix",p.digital_mix},
    {"sample_rate",24000},{"peak_ceiling_dbfs",-3},{"rms_matching","source RMS; maximum gain +6.02 dB; peak ceiling wins"},{"duration_preserved",true}};}
int wmain(int argc,wchar_t** argv){try{
    if(argc==2&&std::wstring(argv[1])==L"--list"){Json value=Json::array();for(const auto& profile:wavegen_character::profiles())value.push_back(descriptor(profile));std::cout<<value.dump(2)<<'\n';return 0;}
    if(argc!=4)throw std::runtime_error("Usage: character_render.exe PROFILE INPUT.wav OUTPUT.wav; or --list");
    std::wstring wide_id=argv[1];std::string id(wide_id.begin(),wide_id.end());const auto samples=read_pcm(argv[2]);auto processed=wavegen_character::process(samples,id);write_pcm(argv[3],processed.samples);
    auto result=descriptor(wavegen_character::profile(id));result.update({{"samples",processed.samples.size()},{"peak",processed.peak},{"gain",processed.gain},{"silence_bypass",processed.silence_bypass}});std::cout<<result.dump()<<'\n';return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}

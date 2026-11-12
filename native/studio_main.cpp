// WaveGen Studio: native, loopback-only UI host with resident model sessions.
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "../third_party/headers/httplib.h"
#include "../third_party/headers/json.hpp"
#include "resident_engine.h"
#include "speech_edit.h"
#include "avatar_png.h"
#include "reuse_engine.h"
#include "character_effects.h"
#include "version.h"
#include <bcrypt.h>
#include <shellapi.h>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <optional>
#include <set>

namespace studio {
using Json = nlohmann::json;
namespace fs = std::filesystem;
using httplib::Request;
using httplib::Response;
constexpr const char* APPLICATION = "WaveGen Studio";
constexpr size_t MAX_UPLOAD = 20 * 1024 * 1024;

struct HttpError : std::runtime_error {
    int code;
    HttpError(int status, const std::string& message) : std::runtime_error(message), code(status) {}
};
void ensure(bool condition, const std::string& message, int code=400) {
    if (!condition) throw HttpError(code, message);
}
std::string random_id(size_t count=16) {
    std::vector<unsigned char> bytes(count);
    ensure(BCryptGenRandom(nullptr, bytes.data(), ULONG(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG)==0,
           "Windows random number generation failed", 500);
    constexpr char hex[]="0123456789abcdef";
    std::string out; out.reserve(count*2);
    for (auto byte:bytes) { out+=hex[byte>>4]; out+=hex[byte&15]; }
    return out;
}
bool valid_id(const std::string& id) {
    return id.size()==32 && std::all_of(id.begin(),id.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
std::string timestamp() {
    SYSTEMTIME time; GetSystemTime(&time);
    char value[40]; std::snprintf(value,sizeof(value),"%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
        time.wYear,time.wMonth,time.wDay,time.wHour,time.wMinute,time.wSecond,time.wMilliseconds);
    return value;
}
std::string trimmed(std::string value) {
    auto white=[](unsigned char c){return c==' '||c=='\r'||c=='\n'||c=='\t';};
    while(!value.empty()&&white(value.back()))value.pop_back();
    size_t first=0;while(first<value.size()&&white(value[first]))++first;
    return value.substr(first);
}
std::string read_text(const fs::path& path) {
    std::ifstream stream(path,std::ios::binary);
    ensure(bool(stream),"Cannot read file: "+printable(path),500);
    return std::string(std::istreambuf_iterator<char>(stream),{});
}
std::string sha256_bytes(const std::string& bytes) {
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
    std::vector<unsigned char> object;
    struct Cleanup{BCRYPT_ALG_HANDLE& algorithm;BCRYPT_HASH_HANDLE& hash;~Cleanup(){if(hash)BCryptDestroyHash(hash);if(algorithm)BCryptCloseAlgorithmProvider(algorithm,0);}}cleanup{algorithm,hash};
    ensure(bytes.size()<=ULONG_MAX,"Hash input is too large",500);
    ensure(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)==0,"Cannot initialize SHA-256",500);
    DWORD size=0,written=0;
    ensure(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&written,0)==0,"Cannot initialize SHA-256 storage",500);
    object.resize(size);unsigned char digest[32];
    ensure(BCryptCreateHash(algorithm,&hash,object.data(),ULONG(object.size()),nullptr,0,0)==0&&
        BCryptHashData(hash,reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),ULONG(bytes.size()),0)==0&&
        BCryptFinishHash(hash,digest,sizeof(digest),0)==0,"Cannot compute SHA-256",500);
    constexpr char hex[]="0123456789abcdef";std::string result;result.reserve(64);
    for(auto value:digest){result+=hex[value>>4];result+=hex[value&15];}return result;
}
void write_atomic(const fs::path& path,const std::string& content) {
    fs::create_directories(path.parent_path());
    fs::path temporary=path;temporary+=L".tmp-"+path_from_utf8(random_id()).wstring();
    try {
        { std::ofstream stream(temporary,std::ios::binary|std::ios::trunc);
          ensure(bool(stream),"Cannot create temporary data file",500);
          stream.write(content.data(),std::streamsize(content.size()));stream.flush();
          ensure(bool(stream),"Cannot write data file",500); }
        ensure(MoveFileExW(temporary.c_str(),path.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH)!=0,
               "Cannot atomically save data file: "+printable(path),500);
    } catch(...) { std::error_code ignored;fs::remove(temporary,ignored);throw; }
}
void write_json(const fs::path& path,const Json& value) {write_atomic(path,value.dump(2)+"\n");}
Json read_json(const fs::path& path) {return Json::parse(read_text(path));}
void json_response(Response& response,const Json& value,int status=200) {
    response.status=status;response.set_content(value.dump(),"application/json; charset=utf-8");
}
void error_response(Response& response,const std::string& message,int status) {
    json_response(response,Json{{"error",message}},status);
}
Json validated_character_effect(const Json& value) {
    ensure(value.is_object()&&value.size()==2&&value.contains("id")&&value.at("id").is_string()&&
        value.contains("version")&&value.at("version").is_number_integer()&&value.at("version")==1,"Invalid character effect metadata",500);
    const auto id=value.at("id").get<std::string>();
    bool known=false;for(const auto& profile:wavegen_character::profiles())known|=id==profile.id;
    ensure(known,"Unknown character effect profile",500);return value;
}
void validate_character_metadata(const Json& value,const Json& effect) {
    ensure(value.is_object()&&value.contains("category")&&value.at("category").is_string()&&
        value.contains("base_voice")&&value.at("base_voice").is_string()&&value.contains("descriptions")&&value.at("descriptions").is_object(),"Invalid character candidate metadata",500);
    const auto base=value.at("base_voice").get<std::string>();ensure(!trimmed(base).empty()&&base.size()<=160,"Invalid character base voice",500);
    const auto& profile=wavegen_character::profile(effect.at("id").get<std::string>());
    ensure(value.at("category")==profile.category,"Character category does not match its effect",500);
    for(const auto* locale:{"en","ko","zh","ja"}){
        const auto& descriptions=value.at("descriptions");ensure(descriptions.contains(locale)&&descriptions.at(locale).is_string(),"Character description locale is missing",500);
        const auto text=descriptions.at(locale).get<std::string>();ensure(!trimmed(text).empty()&&text.size()<=2000,"Invalid character description",500);
    }
}
Json character_processing(const wavegen_character::Result& result) {
    return {{"engine","native_cpu"},{"gain",result.gain},{"peak",result.peak},{"peak_ceiling_dbfs",-3},
        {"silence_bypass",result.silence_bypass},{"order","tts,character"}};
}
double validate_character_sample(const std::string& bytes) {
    const auto* raw=reinterpret_cast<const uint8_t*>(bytes.data());
    ensure(bytes.size()>=44&&!std::memcmp(raw,"RIFF",4)&&!std::memcmp(raw+8,"WAVE",4),"Character sample must be a RIFF WAV",500);
    ensure(uint64_t(u32(raw+4))+8==bytes.size(),"Character sample RIFF size is invalid",500);
    bool format=false,data=false;size_t samples=0;bool nonzero=false;
    for(size_t pos=12;pos+8<=bytes.size();){const size_t length=u32(raw+pos+4),begin=pos+8;
        ensure(length<=bytes.size()-begin,"Character sample has a truncated WAV chunk",500);
        if(!std::memcmp(raw+pos,"fmt ",4)){
            ensure(!format&&length>=16&&u16(raw+begin)==1&&u16(raw+begin+2)==1&&u32(raw+begin+4)==SAMPLE_RATE&&u32(raw+begin+8)==SAMPLE_RATE*2&&u16(raw+begin+12)==2&&u16(raw+begin+14)==16,"Character sample must be mono 24kHz PCM16",500);format=true;
        }else if(!std::memcmp(raw+pos,"data",4)){
            ensure(!data&&length>0&&length%2==0,"Character sample PCM data is invalid",500);data=true;samples=length/2;
            for(size_t i=0;i<samples;++i){const int value=int16_t(u16(raw+begin+2*i));nonzero|=value!=0;ensure(std::abs(value)<=23197,"Character sample exceeds the -3dBFS ceiling",500);}
        }
        pos=begin+length+(length&1);
    }
    ensure(format&&data&&nonzero&&samples<=size_t(30*SAMPLE_RATE),"Character sample must be non-silent and no longer than 30 seconds",500);
    return double(samples)/SAMPLE_RATE;
}
struct Config {
    fs::path executable_dir,data_dir,web_dir,model,assets,cuda,vspec_model,vspec_assets,reuse_assets;
    int port=8765;bool explicit_port=false,no_browser=false;
};
Config config_from_args(int argc,wchar_t** argv) {
    wchar_t file[32768];DWORD n=GetModuleFileNameW(nullptr,file,32768);
    ensure(n>0&&n<32768,"Cannot locate executable",500);
    Config cfg;cfg.executable_dir=fs::path(std::wstring(file,n)).parent_path();
    cfg.data_dir=cfg.executable_dir/"data";cfg.web_dir=cfg.executable_dir/"studio_web";
    cfg.assets=cfg.executable_dir/"model";cfg.model=cfg.assets/"wavegen_flash_step.onnx";cfg.cuda=cfg.executable_dir;
    cfg.vspec_assets=cfg.executable_dir/"model"/"vspec";cfg.vspec_model=cfg.vspec_assets/"wavegen_vspec_step.onnx";
    cfg.reuse_assets=cfg.executable_dir/"model"/"reuse";
    for(int i=1;i<argc;++i){
        std::wstring key=argv[i];
        if(key==L"--no-browser"){cfg.no_browser=true;continue;}
        ensure(i+1<argc,"Missing value for "+utf8(key));std::wstring value=argv[++i];
        if(key==L"--port"){cfg.port=std::stoi(value);cfg.explicit_port=true;}
        else if(key==L"--data-dir")cfg.data_dir=fs::absolute(value);
        else if(key==L"--web-dir")cfg.web_dir=fs::absolute(value);
        else if(key==L"--model")cfg.model=fs::absolute(value);
        else if(key==L"--assets")cfg.assets=fs::absolute(value);
        else if(key==L"--vspec-model")cfg.vspec_model=fs::absolute(value);
        else if(key==L"--vspec-assets")cfg.vspec_assets=fs::absolute(value);
        else if(key==L"--reuse-assets")cfg.reuse_assets=fs::absolute(value);
        else if(key==L"--cuda-dll-dir")cfg.cuda=fs::absolute(value);
        else throw HttpError(400,"Unknown Studio option: "+utf8(key));
    }
    ensure(cfg.port>=1024&&cfg.port<=65535,"Port must be between 1024 and 65535");
    cfg.data_dir=fs::weakly_canonical(cfg.data_dir);
    return cfg;
}
std::string data_key(const Config& cfg) {
    std::wstring path=cfg.data_dir.wstring();
    std::transform(path.begin(),path.end(),path.begin(),::towlower);
    return std::to_string(std::hash<std::wstring>{}(path));
}
void open_browser(int port) {
    const auto url=L"http://127.0.0.1:"+std::to_wstring(port)+L"/";
    ensure(reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr,L"open",url.c_str(),nullptr,nullptr,SW_SHOWNORMAL))>32,
           "Cannot open the default browser. Open http://127.0.0.1:"+std::to_string(port)+"/ manually.",500);
}
bool existing_studio(int port,const Config& cfg) {
    try {
        httplib::Client client("127.0.0.1",port);client.set_connection_timeout(1,0);client.set_read_timeout(1,0);
        auto response=client.Get("/api/status");if(!response||response->status!=200)return false;
        auto status=Json::parse(response->body);
        return status.value("application","")==APPLICATION&&status.value("data_key","")==data_key(cfg);
    } catch(...) {return false;}
}

class Store {
    fs::path root_,voices_,outputs_,revisions_,recovery_,avatars_,preset_markers_,enhancements_;
    Json library_warnings_=Json::array();
public:
    explicit Store(const Config& cfg):root_(cfg.data_dir),voices_(root_/"voices"),outputs_(root_/"outputs"),
        revisions_(voices_/"revisions"),recovery_(root_/"recovery"/"outputs"),avatars_(voices_/"avatars"),preset_markers_(root_/"preset_installations"),enhancements_(root_/"enhancements") {
        fs::create_directories(voices_);fs::create_directories(outputs_);fs::create_directories(enhancements_);
        if(!fs::exists(root_/"initialized.json")) {
            write_json(root_/"initialized.json",Json{{"version",1},{"created_at",timestamp()}});
        }
        install_presets(cfg.executable_dir/"presets");
    }
    static fs::path preset_asset(const fs::path& directory,const std::string& filename,size_t maximum){
        ensure(!filename.empty()&&filename.find(':')==std::string::npos,"Invalid preset asset path",500);
        const auto relative=path_from_utf8(filename);
        ensure(!relative.is_absolute()&&!relative.has_root_path(),"Preset asset must use a relative path",500);
        for(const auto& component:relative)ensure(component!=".."&&component!=".","Preset asset path traversal is not allowed",500);
        std::error_code error;const auto root=fs::canonical(directory,error);
        ensure(!error,"Preset directory is missing or inaccessible",500);
        const auto path=fs::canonical(root/relative,error);
        ensure(!error,"Preset asset path is missing or inaccessible",500);
        auto base=root.begin(),candidate=path.begin();
        for(;base!=root.end();++base,++candidate){
            ensure(candidate!=path.end(),"Preset asset escapes its directory",500);
            auto a=base->wstring(),b=candidate->wstring();
            std::transform(a.begin(),a.end(),a.begin(),::towlower);std::transform(b.begin(),b.end(),b.begin(),::towlower);
            ensure(a==b,"Preset asset escapes its directory",500);
        }
        const bool regular=fs::is_regular_file(path,error);ensure(!error&&regular,"Preset asset is missing or inaccessible",500);
        const auto size=fs::file_size(path,error);ensure(!error&&size>0&&size<=maximum,"Preset asset is empty, inaccessible, or too large",500);
        return path;
    }
    void install_presets(const fs::path& directory){
        if(!fs::exists(directory/"catalog.json"))return;
        try{
            const auto catalog_path=preset_asset(directory,"catalog.json",1024*1024);
            const auto catalog=read_json(catalog_path);
            const auto& entries=catalog.is_array()?catalog:catalog.at("voices");
            ensure(entries.is_array()&&entries.size()<=100,"Preset catalog must contain at most 100 voices",500);
            for(const auto& entry:entries){
                // Character candidates were retired from the bundled library in
                // 1.11. A stale catalog must not install them again. Stored
                // profiles/history remain readable and explicitly restorable.
                if(entry.contains("character_effect")||entry.contains("character"))continue;
                std::string id;std::set<fs::path> new_files;bool committed=false;
                try{
                    id=entry.at("id").get<std::string>();ensure(valid_id(id),"Invalid preset ID",500);
                    const auto marker=preset_markers_/(id+".json");
                    if(fs::exists(marker))continue;
                    const auto destination=voices_/(id+".json");
                    // An existing profile (including a trashed/corrupt profile)
                    // always wins. Never reinterpret or replace user metadata.
                    if(fs::exists(destination)){write_json(marker,Json{{"id",id},{"installed_at",timestamp()},{"status","existing_profile_preserved"}});continue;}
                    const auto name=trimmed(entry.at("name").get<std::string>()),text=trimmed(entry.at("reference_text").get<std::string>());
                    ensure(!name.empty()&&name.size()<=160&&!text.empty()&&text.size()<=4000,"Invalid preset name or reference transcript",500);normalize_english(text);
                    ensure(entry.at("source").is_object()&&entry.at("license").is_object(),"Preset source and license must be objects",500);
                    ensure(entry.at("source").dump().size()<=65536&&entry.at("license").dump().size()<=65536,"Preset provenance is too large",500);
                    const auto audio_path=preset_asset(directory,entry.at("audio_file").get<std::string>(),MAX_UPLOAD);
                    const auto info=wavegen_resident::ResidentEngine::validate_reference(audio_path);
                    std::optional<Json> character_effect;
                    if(entry.contains("character_effect")||entry.contains("character")){
                        ensure(entry.contains("character_effect")&&entry.contains("character"),"Character metadata requires a known effect",500);
                        character_effect=validated_character_effect(entry.at("character_effect"));validate_character_metadata(entry.at("character"),*character_effect);
                    }
                    std::optional<std::string> sample;std::string sample_text,sample_model;
                    if(entry.contains("sample_file")||entry.contains("sample_text")){
                        ensure(character_effect.has_value()&&entry.contains("sample_file")&&entry.at("sample_file").is_string()&&entry.contains("sample_text")&&entry.at("sample_text").is_string(),"Character sample requires an audio/text pair",500);
                        sample_text=trimmed(entry.at("sample_text").get<std::string>());ensure(!sample_text.empty()&&sample_text.size()<=5000,"Invalid character sample transcript",500);normalize_english(sample_text);
                        sample_model=entry.value("sample_model_id","vspec");ensure(sample_model=="flash"||sample_model=="vspec","Invalid character sample model",500);
                        const auto path=preset_asset(directory,entry.at("sample_file").get<std::string>(),MAX_UPLOAD);
                        sample=read_text(path);
                        const double duration=validate_character_sample(*sample);
                        if(entry.contains("sample_duration_seconds"))ensure(entry.at("sample_duration_seconds").is_number()&&std::abs(entry.at("sample_duration_seconds").get<double>()-duration)<=1.0/SAMPLE_RATE,"Character sample duration differs from its WAV",500);
                    }
                    std::optional<std::string> avatar;
                    if(entry.contains("avatar_file")&&!entry.at("avatar_file").is_null()){
                        avatar=read_text(preset_asset(directory,entry.at("avatar_file").get<std::string>(),wavegen_avatar::PRESET_MAX_BYTES));wavegen_avatar::validate(*avatar,wavegen_avatar::PRESET_MAX_BYTES,2048);
                    }
                    const auto audio_file=id+"-"+random_id()+".wav";new_files.insert(voices_/audio_file);write_atomic(voices_/audio_file,read_text(audio_path));
                    Json voice={{"id",id},{"name",name},{"reference_text",text},{"audio_file",audio_file},{"original_audio_file",audio_file},
                        {"created_at",timestamp()},{"updated_at",timestamp()},{"builtin",false},{"preset",true},{"preset_id",id},{"preset_modified",false},
                        {"source",entry.at("source")},{"license",entry.at("license")},{"duration_seconds",info.duration_seconds},{"sample_rate",info.sample_rate}};
                    if(entry.contains("description")){ensure(entry.at("description").is_string()&&entry.at("description").get<std::string>().size()<=4000,"Invalid preset description",500);voice["description"]=entry.at("description");}
                    if(character_effect){voice["character_effect"]=*character_effect;voice["character"]=entry.at("character");}
                    if(sample){const auto file=id+"-"+random_id()+".sample.wav";new_files.insert(voices_/file);write_atomic(voices_/file,*sample);
                        voice["sample_file"]=file;voice["sample_text"]=sample_text;voice["sample_model_id"]=sample_model;
                        voice["sample_duration_seconds"]=double(read_wav(voices_/file).size())/SAMPLE_RATE;voice["sample_sha256"]=sha256_bytes(*sample);}
                    if(avatar){const auto file=id+"-"+random_id()+".png";new_files.insert(avatars_/file);write_atomic(avatars_/file,*avatar);voice["avatar_file"]=file;}
                    write_json(destination,voice);committed=true;
                    write_json(marker,Json{{"id",id},{"installed_at",timestamp()},{"status","installed"}});
                }catch(const std::exception& error){
                    if(!committed)for(const auto& file:new_files){std::error_code ignored;fs::remove(file,ignored);}
                    library_warnings_.push_back("Preset "+(id.empty()?std::string("catalog entry"):id)+": "+error.what());
                }
            }
        }catch(const std::exception& error){library_warnings_.push_back("Preset catalog: "+std::string(error.what()));}
    }
    fs::path safe_voice_avatar(const Json& voice) const {
        ensure(voice.contains("avatar_file")&&voice.at("avatar_file").is_string(),"Voice avatar was not found",404);
        const auto file=voice.at("avatar_file").get<std::string>();
        ensure(file.size()==69&&file.substr(65)==".png"&&file[32]=='-'&&valid_id(file.substr(0,32))&&valid_id(file.substr(33,32))&&file.substr(0,32)==voice.at("id").get<std::string>(),"Invalid stored profile avatar filename",500);
        return avatars_/path_from_utf8(file);
    }
    fs::path safe_voice_audio(const Json& voice,bool original=false) const {
        const std::string file=voice.at(original&&voice.contains("original_audio_file")?"original_audio_file":"audio_file").get<std::string>();
        ensure(file.size()==69&&file.substr(65)==".wav"&&file[32]=='-'&&valid_id(file.substr(0,32))&&valid_id(file.substr(33,32)),
               "Invalid stored profile audio filename",500);
        ensure(file.substr(0,32)==voice.at("id").get<std::string>(),"Stored profile audio belongs to another voice",500);
        return voices_/path_from_utf8(file);
    }
    fs::path safe_character_sample(const Json& voice) const {
        ensure(voice.contains("sample_file")&&voice.at("sample_file").is_string(),"Character sample was not found",404);
        const auto file=voice.at("sample_file").get<std::string>();
        ensure(file.size()==76&&file.substr(65)==".sample.wav"&&file[32]=='-'&&valid_id(file.substr(0,32))&&valid_id(file.substr(33,32))&&file.substr(0,32)==voice.at("id").get<std::string>(),"Invalid stored character sample filename",500);
        return voices_/path_from_utf8(file);
    }
    Json get_voice(const std::string& id,bool include_deleted=false) const {
        ensure(valid_id(id),"Invalid voice ID");auto path=voices_/(id+".json");
        ensure(fs::is_regular_file(path),"Voice profile was not found",404);
        auto voice=read_json(path);ensure(voice.value("id","")==id,"Invalid stored voice profile",500);
        ensure(voice.at("name").is_string()&&voice.at("reference_text").is_string()&&
               voice.at("created_at").is_string(),"Invalid stored voice profile fields",500);
        if(voice.contains("deleted_at")){
            ensure(voice.at("deleted_at").is_string()&&!voice.at("deleted_at").get<std::string>().empty(),"Invalid stored deletion date",500);
            ensure(include_deleted,"This voice is in the trash; restore it before use",404);
        }
        ensure(fs::is_regular_file(safe_voice_audio(voice)),"Stored reference WAV is missing",500);
        ensure(fs::is_regular_file(safe_voice_audio(voice,true)),"Stored original WAV is missing",500);
        if(voice.contains("character_effect")){const auto effect=validated_character_effect(voice.at("character_effect"));validate_character_metadata(voice.at("character"),effect);}
        if(voice.contains("sample_file"))ensure(fs::is_regular_file(safe_character_sample(voice)),"Stored character sample is missing",500);
        return voice;
    }
    Json public_voice(Json voice) const {
        voice["sample_audio_url"]=voice.contains("sample_file")?Json("/api/audio/character-samples/"+voice.at("id").get<std::string>()):Json(nullptr);
        voice.erase("sample_file");
        voice.erase("audio_file");voice.erase("original_audio_file");
        voice["avatar_url"]=voice.contains("avatar_file")?Json("/api/avatar/voices/"+voice.at("id").get<std::string>()):Json(nullptr);
        voice.erase("avatar_file");
        voice["audio_url"]="/api/audio/voices/"+voice.at("id").get<std::string>();
        voice["original_audio_url"]="/api/audio/originals/"+voice.at("id").get<std::string>();
        voice["ref_text"]=voice.at("reference_text");return voice;
    }
    Json list_voices(Json& warnings,bool deleted=false) const {
        for(const auto& warning:library_warnings_)warnings.push_back(warning);
        std::vector<Json> all;
        for(const auto& item:fs::directory_iterator(voices_)){
            if(item.path().extension()!=".json"||!valid_id(item.path().stem().string()))continue;
            const auto id=item.path().stem().string();
            try {
                auto voice=get_voice(id,true);
                if(voice.contains("deleted_at")==deleted)all.push_back(public_voice(std::move(voice)));
            } catch(const std::exception& error){warnings.push_back("Voice "+id+": "+error.what());}
        }
        std::sort(all.begin(),all.end(),[](const Json& a,const Json& b){return a.value("created_at","")<b.value("created_at","");});
        return all;
    }
    void save_revision(const Json& voice) const {
        const auto id=voice.at("id").get<std::string>();ensure(valid_id(id),"Invalid voice revision ID",500);
        // Immutable metadata snapshots retain their referenced WAVs and avatars. No automatic
        // revision or source-audio cleanup occurs; recovery can use this directory.
        write_json(revisions_/id/(random_id()+".json"),voice);
    }
    static void validate_original_audio(const fs::path& path) {
        // The model reference validator intentionally limits conditioning to 30 seconds.
        // The untrimmed source is never passed to inference and may contain 120 seconds.
        auto samples=read_wav(path);
        ensure(samples.size()<=size_t(120*SAMPLE_RATE),"Original reference audio must be no longer than 120 seconds");
        double square_sum=0;for(float sample:samples)square_sum+=double(sample)*sample;
        ensure(std::sqrt(square_sum/samples.size())>1e-8,"Original reference audio is silent");
    }
    static double reference_number(const Json& fields,const char* key,double minimum,double maximum) {
        ensure(fields.contains(key)&&fields.at(key).is_number(),std::string("Missing or invalid reference metadata: ")+key);
        const double value=fields.at(key).get<double>();
        ensure(std::isfinite(value)&&value>=minimum&&value<=maximum,std::string("Invalid reference metadata: ")+key);
        return value;
    }
    static void validate_reference_edit(Json& fields,size_t original_samples,size_t current_samples) {
        ensure(fields.at("reference_edit_version").is_number_integer()&&fields.at("reference_edit_version")==1,"Unsupported reference edit version");
        for(const auto* key:{"trim_enabled","normalize_enabled"})
            ensure(fields.contains(key)&&fields.at(key).is_boolean(),std::string("Missing or invalid reference metadata: ")+key);
        const double gain=reference_number(fields,"normalization_gain_db",-120,12);
        ensure(fields.at("normalize_enabled").get<bool>()||gain==0,"Disabled normalization requires zero gain");
        const double duration=reference_number(fields,"original_duration_seconds",0,120);
        const double actual_duration=double(original_samples)/SAMPLE_RATE;
        constexpr double tolerance=1.0/SAMPLE_RATE+1e-9;
        ensure(std::abs(duration-actual_duration)<=tolerance,"Original duration does not match the stored source WAV");
        const double selection_start=reference_number(fields,"selection_start_seconds",0,120);
        const double selection_end=reference_number(fields,"selection_end_seconds",0,120);
        const double trim_start=reference_number(fields,"trim_start_seconds",0,120);
        const double trim_end=reference_number(fields,"trim_end_seconds",0,120);
        ensure(selection_start<selection_end&&selection_end<=actual_duration+tolerance,"Reference selection is outside the original source");
        ensure(trim_start+trim_end<actual_duration+tolerance,"Reference trim removes the entire source");
        const int64_t count=int64_t(original_samples);
        auto to_sample=[&](double seconds){return std::min<int64_t>(count,std::llround(seconds*SAMPLE_RATE));};
        const int64_t first=to_sample(selection_start),last=to_sample(selection_end);
        const int64_t retained_first=to_sample(trim_start),retained_last=count-to_sample(trim_end);
        ensure(last>first&&retained_last>retained_first,"Reference selection or trim is empty");
        ensure(retained_first>=first-1&&retained_last<=last+1,"Reference trim must remain inside the selected original range");
        if(!fields.at("trim_enabled").get<bool>())
            ensure(std::abs(retained_first-first)<=1&&std::abs(retained_last-last)<=1,"Disabled trimming must preserve the full selected range");
        ensure(std::abs((retained_last-retained_first)-int64_t(current_samples))<=1,"Reference WAV length does not match selection and trim metadata");
        // Keep reopened positions on the original source's sample grid. The uploaded
        // PCM may have been quantized twice, so gain is metadata rather than a signal proof.
        fields["original_duration_seconds"]=actual_duration;
        fields["selection_start_seconds"]=double(first)/SAMPLE_RATE;
        fields["selection_end_seconds"]=double(last)/SAMPLE_RATE;
        fields["trim_start_seconds"]=double(retained_first)/SAMPLE_RATE;
        fields["trim_end_seconds"]=double(count-retained_last)/SAMPLE_RATE;
    }
    Json save_voice(const std::string& id,const std::string& name,const std::string& text,const std::optional<std::string>& audio,
                    const std::optional<std::string>& original_audio,const Json& extra,const std::optional<std::string>& avatar=std::nullopt,bool remove_avatar=false) {
        ensure(valid_id(id),"Invalid voice ID");const bool updating=fs::exists(voices_/(id+".json"));
        ensure(!(avatar&&remove_avatar),"Upload an avatar or remove it, not both");
        Json voice=updating?get_voice(id):Json{{"id",id},{"created_at",timestamp()},{"builtin",false}};
        const Json previous=voice;
        ensure(!original_audio||audio,"Original audio must be uploaded together with the conditioning WAV");
        ensure(!extra.contains("prompt_enhancement_id")||audio,"Prompt enhancement application requires its enhanced WAV");
        std::optional<Json> prompt_enhancement;
        if(extra.contains("prompt_enhancement_id")){
            ensure(extra.at("prompt_enhancement_id").is_string(),"Invalid prompt enhancement ID");
            const auto enhanced=get_reference_enhancement(extra.at("prompt_enhancement_id").get<std::string>());
            ensure(*audio==read_text(enhancement_path(enhanced.at("id").get<std::string>())),"Uploaded reference differs from the enhanced preview; prepare enhancement again",409);
            prompt_enhancement=enhanced.at("enhancement");
            prompt_enhancement->update(Json{{"enabled",true},{"id",enhanced.at("id")},{"input_audio_url",enhanced.at("input_audio_url")},
                {"input_sha256",enhanced.at("input_sha256")},{"output_sha256",enhanced.at("output_sha256")},{"applied_at",timestamp()}});
        }
        bool has_edit_metadata=false,has_reference_metadata=false;
        for(const auto* field:{"reference_edit_version","selection_start_seconds","selection_end_seconds","normalize_enabled","normalization_gain_db"})
            has_edit_metadata=has_edit_metadata||extra.contains(field);
        for(const auto* field:{"trim_enabled","trim_start_seconds","trim_end_seconds","original_duration_seconds"})
            has_reference_metadata=has_reference_metadata||extra.contains(field);
        ensure(audio||!(has_edit_metadata||has_reference_metadata),"Reference editing metadata requires an uploaded conditioning WAV");
        if(has_edit_metadata)ensure(extra.contains("reference_edit_version"),"Reference edit version is required");
        std::set<fs::path> new_files;
        if(updating){
            // Migrate a legacy profile lazily, retaining its old source if only trim changes.
            if(!voice.contains("original_audio_file"))voice["original_audio_file"]=voice.at("audio_file");
        }
        try {
            if(avatar){
                wavegen_avatar::validate(*avatar);
                const auto file=id+"-"+random_id()+".png";const auto path=avatars_/file;new_files.insert(path);write_atomic(path,*avatar);voice["avatar_file"]=file;
            }else if(remove_avatar)voice.erase("avatar_file");
            if(audio){
                ensure(!audio->empty()&&audio->size()<=MAX_UPLOAD,"Reference WAV must be nonempty and no larger than 20 MB");
                const std::string file=id+"-"+random_id()+".wav";const fs::path path=voices_/file;new_files.insert(path);
                write_atomic(path,*audio);
                auto info=wavegen_resident::ResidentEngine::validate_reference(path);
                ensure(info.duration_seconds<30.0,"Reference audio must be shorter than 30 seconds");
                voice["audio_file"]=file;voice["duration_seconds"]=info.duration_seconds;voice["sample_rate"]=info.sample_rate;
                if(!updating&&!original_audio)voice["original_audio_file"]=file;
            } else ensure(updating,"Reference WAV is required for a new voice profile");
            if(original_audio){
                ensure(!original_audio->empty()&&original_audio->size()<=MAX_UPLOAD,"Original WAV must be nonempty and no larger than 20 MB");
                const std::string file=id+"-"+random_id()+".wav";const fs::path path=voices_/file;new_files.insert(path);
                write_atomic(path,*original_audio);validate_original_audio(path);voice["original_audio_file"]=file;
            }
            // Provenance is package-owned. User saves cannot assert a license,
            // trusted source, preset flag, or arbitrary stored file reference.
            Json reference_fields=extra;
            if(has_edit_metadata){
                const auto original_samples=read_wav(safe_voice_audio(voice,true)).size();
                const auto current_samples=read_wav(safe_voice_audio(voice)).size();
                validate_reference_edit(reference_fields,original_samples,current_samples);
            }else if(audio){
                // Legacy clients may replace PCM without describing an edit. Do not
                // carry forward selections or timing from a different conditioning WAV.
                for(const auto* field:{"reference_edit_version","selection_start_seconds","selection_end_seconds","normalize_enabled","normalization_gain_db"})voice.erase(field);
                for(const auto* field:{"trim_enabled","trim_start_seconds","trim_end_seconds","original_duration_seconds"})if(!extra.contains(field))voice.erase(field);
            }
            for(const auto* field:{"trim_enabled","trim_start_seconds","trim_end_seconds","original_duration_seconds","reference_edit_version","selection_start_seconds","selection_end_seconds","normalize_enabled","normalization_gain_db"})
                if(reference_fields.contains(field))voice[field]=reference_fields.at(field);
            if(prompt_enhancement)voice["prompt_enhancement"]=*prompt_enhancement;
            else if(audio)voice.erase("prompt_enhancement");
            if(voice.value("preset",false)&&(audio||text!=previous.value("reference_text","")))voice["preset_modified"]=true;
            voice["name"]=name;voice["reference_text"]=text;voice["updated_at"]=timestamp();
            if(updating)save_revision(previous);
            write_json(voices_/(id+".json"),voice);
        } catch(...) {for(const auto& path:new_files){std::error_code ignored;fs::remove(path,ignored);}throw;}
        return public_voice(voice);
    }
    void delete_voice(const std::string& id) {
        auto voice=get_voice(id);save_revision(voice);
        voice["deleted_at"]=timestamp();voice["updated_at"]=timestamp();write_json(voices_/(id+".json"),voice);
    }
    Json restore_voice(const std::string& id) {
        auto voice=get_voice(id,true);ensure(voice.contains("deleted_at"),"Voice is not in the trash",409);
        save_revision(voice);voice.erase("deleted_at");voice["updated_at"]=timestamp();
        write_json(voices_/(id+".json"),voice);return public_voice(voice);
    }
    fs::path output_path(const std::string& id) const {ensure(valid_id(id),"Invalid output ID");return outputs_/(id+".wav");}
    fs::path enhancement_path(const std::string& id,bool input=false)const {
        ensure(valid_id(id),"Invalid enhancement ID");return enhancements_/(id+(input?".input.wav":".wav"));
    }
    void save_reference_enhancement(Json& value){
        const auto id=value.at("id").get<std::string>();
        const auto input=enhancement_path(id,true),output=enhancement_path(id);
        ensure(fs::is_regular_file(input)&&fs::is_regular_file(output),"Enhancement audio is incomplete",500);
        const auto before=read_wav(input),after=read_wav(output);
        ensure(before.size()==after.size()&&!after.empty(),"Enhancement must preserve the exact reference sample count",500);
        value["kind"]="reference";value["sample_rate"]=SAMPLE_RATE;value["samples"]=after.size();
        value["duration_seconds"]=double(after.size())/SAMPLE_RATE;
        value["input_sha256"]=sha256_bytes(read_text(input));value["output_sha256"]=sha256_bytes(read_text(output));
        value["audio_url"]="/api/audio/enhancements/"+id;value["input_audio_url"]="/api/audio/enhancement-inputs/"+id;
        write_json(enhancements_/(id+".json"),value);
    }
    Json get_reference_enhancement(const std::string& id)const {
        ensure(valid_id(id),"Invalid prompt enhancement ID");const auto metadata=enhancements_/(id+".json");
        ensure(fs::is_regular_file(metadata),"The enhanced reference preview was not found; prepare it again",404);
        auto value=read_json(metadata);
        ensure(value.value("id","")==id&&value.value("kind","")=="reference"&&value.contains("enhancement"),"Invalid stored reference enhancement",500);
        for(bool input:{true,false}){
            const auto path=enhancement_path(id,input);ensure(fs::is_regular_file(path),"The enhanced reference preview audio is missing",404);
            ensure(sha256_bytes(read_text(path))==value.at(input?"input_sha256":"output_sha256").get<std::string>(),"The enhanced reference preview has changed; prepare it again",409);
        }
        return value;
    }
    void require_completed_output(const std::string& id) const {
        const auto path=output_path(id);
        ensure(fs::is_regular_file(path)&&fs::file_size(path)>44,"Completed audio file is missing or empty",500);
    }
    void save_output(const Json& value) {const auto id=value.at("id").get<std::string>();require_completed_output(id);write_json(outputs_/(id+".json"),value);}
    void save_recovery_output(const Json& value) {const auto id=value.at("id").get<std::string>();require_completed_output(id);write_json(recovery_/(id+".json"),value);}
    Json get_output(const std::string& id) const {
        ensure(valid_id(id),"Invalid source audio ID");
        ensure(fs::is_regular_file(output_path(id)),"Source audio was not found",404);require_completed_output(id);
        const auto canonical=outputs_/(id+".json"),recovered=recovery_/(id+".json");
        const auto metadata=fs::is_regular_file(canonical)?canonical:recovered;
        ensure(fs::is_regular_file(metadata),"Source audio history was not found",404);
        auto value=read_json(metadata);ensure(value.value("id","")==id,"Invalid source audio history",500);
        return value;
    }
    std::vector<Json> history_records(Json& warnings) const {
        std::vector<Json> all;
        std::set<std::string> seen;
        for(const auto& directory:{outputs_,recovery_}){
            if(!fs::is_directory(directory))continue;
            for(const auto& item:fs::directory_iterator(directory)){
                const auto id=item.path().stem().string();if(item.path().extension()!=".json"||!valid_id(id)||seen.count(id))continue;
                try {
                    auto entry=read_json(item.path());ensure(entry.value("id","")==id,"Invalid stored history entry",500);
                    ensure(entry.at("text").is_string()&&entry.at("created_at").is_string()&&entry.at("voice_name").is_string(),"Invalid stored history fields",500);
                    const auto created=entry.at("created_at").get<std::string>();
                    ensure(!created.empty()&&created.size()<=128&&created.find('\0')==std::string::npos,"Invalid stored history date",500);
                    ensure(fs::is_regular_file(output_path(id)),"Generated WAV is missing",500);
                    entry["audio_url"]="/api/audio/outputs/"+id;
                    if(directory==recovery_)warnings.push_back("Result "+id+" is available from recovery metadata; its history record could not be saved.");
                    all.push_back(std::move(entry));seen.insert(id);
                } catch(const std::exception& error){warnings.push_back("Result "+id+": "+error.what());}
            }
        }
        std::sort(all.begin(),all.end(),[](const Json& a,const Json& b){
            const auto left=a.at("created_at").get<std::string>(),right=b.at("created_at").get<std::string>();
            return left!=right?left>right:a.at("id").get<std::string>()>b.at("id").get<std::string>();
        });return all;
    }
    static std::string history_query(std::string query){
        ensure(query.size()<=512,"History search must contain no more than 512 UTF-8 bytes");
        try{Json(query).dump();}catch(const nlohmann::json::exception&){throw HttpError(400,"History search must use valid UTF-8");}
        query=trimmed(std::move(query));
        for(char& value:query)if(value>='A'&&value<='Z')value=char(value-'A'+'a');return query;
    }
    static std::string encode_history_cursor(const Json& entry,const std::string& query){
        const auto created=entry.at("created_at").get<std::string>(),id=entry.at("id").get<std::string>();
        constexpr char hex[]="0123456789abcdef";std::string encoded;encoded.reserve(created.size()*2);
        for(unsigned char value:created){encoded+=hex[value>>4];encoded+=hex[value&15];}
        return "h1."+encoded+"."+id+"."+sha256_bytes("h1\n"+created+"\n"+id+"\n"+query);
    }
    static std::pair<std::string,std::string> decode_history_cursor(const std::string& cursor,const std::string& query){
        ensure(cursor.size()<=390&&cursor.rfind("h1.",0)==0,"Invalid history cursor");
        const auto first=cursor.find('.',3),second=first==std::string::npos?std::string::npos:cursor.find('.',first+1);
        ensure(first!=std::string::npos&&second!=std::string::npos&&cursor.find('.',second+1)==std::string::npos,"Invalid history cursor");
        const auto encoded=cursor.substr(3,first-3),id=cursor.substr(first+1,second-first-1),checksum=cursor.substr(second+1);
        ensure(!encoded.empty()&&encoded.size()<=256&&encoded.size()%2==0&&valid_id(id)&&checksum.size()==64,"Invalid history cursor");
        auto digit=[](char value){return value>='0'&&value<='9'?value-'0':value>='a'&&value<='f'?value-'a'+10:-1;};
        std::string created;created.reserve(encoded.size()/2);
        for(size_t index=0;index<encoded.size();index+=2){const int a=digit(encoded[index]),b=digit(encoded[index+1]);ensure(a>=0&&b>=0,"Invalid history cursor");created+=char((a<<4)|b);}
        ensure(created.find('\0')==std::string::npos&&checksum==sha256_bytes("h1\n"+created+"\n"+id+"\n"+query),"History cursor is invalid or belongs to a different search");
        return {created,id};
    }
    Json history_page(Json& warnings,size_t limit=200,const std::string& cursor="",const std::string& search="")const{
        ensure(limit>=1&&limit<=200,"History page size must be between 1 and 200");
        const auto query=history_query(search);
        const auto anchor=cursor.empty()?std::pair<std::string,std::string>{}:decode_history_cursor(cursor,query);
        const auto records=history_records(warnings);Json page=Json::array();size_t total=0;bool has_more=false;
        for(const auto& entry:records){
            std::string haystack=entry.at("text").get<std::string>()+"\n"+entry.at("voice_name").get<std::string>();
            for(const auto* field:{"model_id","model_name","request_id","id"})if(entry.contains(field)&&entry.at(field).is_string())haystack+="\n"+entry.at(field).get<std::string>();
            for(char& value:haystack)if(value>='A'&&value<='Z')value=char(value-'A'+'a');
            if(!query.empty()&&haystack.find(query)==std::string::npos)continue;
            ++total;const auto key=std::make_pair(entry.at("created_at").get<std::string>(),entry.at("id").get<std::string>());
            if(!cursor.empty()&&key>=anchor)continue;
            if(page.size()<limit)page.push_back(entry);else has_more=true;
        }
        return Json{{"items",page},{"warnings",warnings},{"total",total},{"total_all",records.size()},{"limit",limit},
            {"has_more",has_more},{"next_cursor",has_more?Json(encode_history_cursor(page.back(),query)):Json(nullptr)}};
    }
    Json history(Json& warnings) const {
        return history_page(warnings).at("items");
    }
};

class Application {
public:
    Config cfg;
    httplib::Server server;
    Store store;
    std::mutex state_mutex,data_mutex;
    std::unique_ptr<wavegen_resident::ResidentEngine> engine,vspec_engine;
    std::unique_ptr<wavegen_reuse::ReuseEngine> reuse_engine;
    std::thread loading_thread,shutdown_thread;
    std::atomic<bool> shutdown_requested{false};
    std::condition_variable shutdown_condition;
    std::mutex shutdown_mutex;
    std::string state="loading",message="Loading the speech model...",active_voice,active_request,chunk_text;
    bool cancel_requested=false,finalizing=false;
    size_t chunk_index=0,chunk_count=0;
    size_t step_index=0,step_count=0;
    std::string active_model="flash";
    std::string phase="",enhancement_error;
    const std::string instance_id=random_id(),token=random_id(32);
    Json engine_status={{"model_load_count",0},{"generation_count",0},{"model_load_seconds",0.0},{"session_id",""}};
    explicit Application(Config value):cfg(std::move(value)),store(cfg){}
    ~Application(){
        shutdown_requested=true;shutdown_condition.notify_all();
        if(shutdown_thread.joinable())shutdown_thread.join();
        if(loading_thread.joinable())loading_thread.join();
    }
    void update_engine_status() {
        auto* selected=active_model=="vspec"?vspec_engine.get():engine.get();
        if(!selected){
            engine_status={{"model_load_count",0},{"generation_count",0},{"model_load_seconds",0.0},{"session_id",""},
                {"model_id",active_model},{"steps",active_model=="vspec"?50:4},{"ort_runs",0},{"model_evaluations",0}};
            return;
        }
        auto value=selected->status();
        engine_status={{"model_load_count",value.load_count},{"generation_count",value.completed_requests},
            {"model_load_seconds",value.model_load_seconds},{"session_id",value.session_id},
            {"binding_rebuild_count",value.binding_rebuild_count},{"precision",value.precision},{"current_frames",value.current_frames},
            {"model_id",active_model},{"steps",value.steps},{"ort_runs",value.ort_runs},{"model_evaluations",value.model_evaluations}};
    }
    static std::string model_name(const std::string& id){return id=="vspec"?"WaveGen V-Spec":"WaveGen-Flash";}
    static std::string requested_model(const Json& body,const std::string& fallback="flash"){
        const auto id=body.value("model_id",fallback);
        ensure(id=="flash"||id=="vspec","Unknown generation model");return id;
    }
    bool model_available(const std::string& id) const {
        const auto& path=id=="vspec"?cfg.vspec_model:cfg.model;
        const auto& assets=id=="vspec"?cfg.vspec_assets:cfg.assets;
        return !path.empty()&&fs::is_regular_file(path)&&fs::is_regular_file(assets/"vocab.txt")&&fs::is_regular_file(assets/"mel_filter.f32")&&fs::is_regular_file(assets/"hann_window.f32");
    }
    void require_model(const std::string& id) const {
        ensure(model_available(id),id=="vspec"?"V-Spec model is not installed":"Flash model is not installed",503);
    }
    Json models_status()const{
        Json models=Json::array();
        for(const std::string id:{"flash","vspec"}){
            const auto* selected=id=="vspec"?vspec_engine.get():engine.get();
            auto value=selected?selected->status():wavegen_resident::Status{};
            models.push_back(Json{{"id",id},{"name",model_name(id)},{"steps",id=="vspec"?50:4},
                {"available",model_available(id)},{"loaded",bool(selected)},{"load_count",value.load_count},
                {"session_id",value.session_id},{"generation_count",value.completed_requests}});
        }
        return models;
    }
    // An active request reserves the sole GPU job slot before entering here.
    // Publish only a fully initialized engine; a failed load keeps Flash usable.
    wavegen_resident::ResidentEngine& select_engine(const std::string& id){
        {
            std::lock_guard<std::mutex> lock(state_mutex);
            active_model=id;
            auto* selected=id=="vspec"?vspec_engine.get():engine.get();
            if(selected){update_engine_status();return *selected;}
            engine_status={{"model_load_count",0},{"generation_count",0},{"model_load_seconds",0.0},{"session_id",""},
                {"model_id",id},{"steps",id=="vspec"?50:4}};
            state="loading_model";message="Loading "+model_name(id)+" for the first use...";
        }
        wavegen_resident::Config config;config.model_id=id;
        config.model_path=id=="vspec"?cfg.vspec_model:cfg.model;
        config.assets_directory=id=="vspec"?cfg.vspec_assets:cfg.assets;config.cuda_dll_directory=cfg.cuda;
        std::unique_ptr<wavegen_resident::ResidentEngine> loaded;
        try{loaded=std::make_unique<wavegen_resident::ResidentEngine>(config);}
        catch(const std::exception& error){throw HttpError(500,std::string("Failed to load ")+(id=="vspec"?"V-Spec":"Flash")+" model: "+error.what());}
        std::lock_guard<std::mutex> lock(state_mutex);
        auto& destination=id=="vspec"?vspec_engine:engine;destination=std::move(loaded);
        update_engine_status();state="generating";message="Generating speech...";return *destination;
    }
    wavegen_reuse::Config reuse_config()const {
        wavegen_reuse::Config config;config.model_directory=cfg.reuse_assets;config.cuda_dll_directory=cfg.cuda;return config;
    }
    bool enhancement_available()const{return wavegen_reuse::ReuseEngine::available(reuse_config());}
    Json enhancement_status()const {
        Json result={{"id","reuse"},{"model_id","reuse"},{"model_name","RE-USE"},{"available",enhancement_available()},
            {"loaded",bool(reuse_engine)},{"load_count",0},{"session_id",""},{"processing_count",0},{"model_load_seconds",0.0},{"precision","FP32"}};
        if(reuse_engine){const auto value=reuse_engine->status();result.update(Json{{"load_count",value.load_count},{"session_id",value.session_id},
            {"processing_count",value.completed_requests},{"model_load_seconds",value.model_load_seconds},{"precision",value.precision}});}
        if(!enhancement_error.empty())result["error"]=enhancement_error;return result;
    }
    wavegen_reuse::ReuseEngine& select_enhancement_engine(){
        {
            std::lock_guard<std::mutex> lock(state_mutex);phase="enhancement";finalizing=false;step_index=0;step_count=0;
            if(cancel_requested)throw wavegen_reuse::Cancelled();
            if(reuse_engine){state="enhancing";message="Enhancing audio with RE-USE...";return *reuse_engine;}
            state="loading_enhancement";message="Loading RE-USE for the first use...";
        }
        std::unique_ptr<wavegen_reuse::ReuseEngine> loaded;
        try {loaded=std::make_unique<wavegen_reuse::ReuseEngine>(reuse_config());}
        catch(const std::exception& error){std::lock_guard<std::mutex> lock(state_mutex);enhancement_error=error.what();throw HttpError(500,"Failed to load RE-USE: "+enhancement_error);}
        std::lock_guard<std::mutex> lock(state_mutex);reuse_engine=std::move(loaded);enhancement_error.clear();
        state="enhancing";message="Enhancing audio with RE-USE...";
        if(cancel_requested)throw wavegen_reuse::Cancelled();return *reuse_engine;
    }
    std::pair<wavegen_reuse::Result,Json> process_enhancement(const std::vector<float>& input,const std::string& request_id){
        ensure(!input.empty()&&input.size()<=size_t(600*SAMPLE_RATE),"Speech enhancement requires audio no longer than 600 seconds");
        const auto started=Clock::now();auto& selected=select_enhancement_engine();
        const auto cancelled=[this,request_id]{std::lock_guard<std::mutex> lock(state_mutex);return active_request==request_id&&cancel_requested;};
        const auto progress=[this](size_t completed,size_t total){
            std::lock_guard<std::mutex> lock(state_mutex);step_index=completed;step_count=total;
            if(completed==total&&total&&!cancel_requested)finalizing=true;
            if(!cancel_requested)message="Enhancing audio: "+std::to_string(completed)+" of "+std::to_string(total)+"...";
        };
        auto result=selected.enhance(input,SAMPLE_RATE,cancelled,progress);
        ensure(result.sample_rate==SAMPLE_RATE&&result.samples.size()==input.size(),"RE-USE returned an unexpected audio length or sample rate",500);
        for(float sample:result.samples)ensure(std::isfinite(sample),"RE-USE returned nonfinite audio samples",500);
        {std::lock_guard<std::mutex> lock(state_mutex);if(cancel_requested)throw wavegen_reuse::Cancelled();finalizing=true;}
        const auto value=selected.status();
        Json provenance={{"model_id",value.model_id},{"model_name","RE-USE"},{"precision",value.precision},
            {"checkpoint_sha256",value.checkpoint_sha256},{"source_revision",value.source_revision},
            {"processing_seconds",elapsed(started)},{"inference_seconds",result.inference_seconds},{"request_seconds",result.request_seconds},
            {"silence_bypass",result.silence_bypass},
            {"model_load_seconds",value.model_load_seconds},{"model_load_count",value.load_count},{"session_id",value.session_id},
            {"sample_rate",SAMPLE_RATE},{"samples",input.size()}};
        return {std::move(result),std::move(provenance)};
    }
    Json status() {
        std::lock_guard<std::mutex> lock(state_mutex);update_engine_status();Json result=engine_status;
        result.update(Json{{"application",APPLICATION},{"version",WAVEGEN_STUDIO_VERSION},{"display_version",WAVEGEN_STUDIO_DISPLAY_VERSION},{"pid",GetCurrentProcessId()},
            {"instance_id",instance_id},{"data_key",data_key(cfg)},{"state",state},{"message",message},
            {"model",model_name(active_model)},{"model_id",active_model},{"active_model_id",active_model},{"models",models_status()},
            {"port",cfg.port},{"active_voice_id",active_voice},{"step_index",step_index},{"step_count",step_count},
            {"chunk_index",chunk_index},{"chunk_count",chunk_count},{"request_id",active_request},
            {"chunk_text",chunk_text},{"cancel_requested",cancel_requested},
            {"phase",phase},{"enhancement",enhancement_status()},
            {"can_cancel",!active_request.empty()&&!cancel_requested&&!finalizing}});
        return result;
    }
    void start_loading() {
        loading_thread=std::thread([this]{
            try {
                wavegen_resident::Config config;config.model_path=cfg.model;config.assets_directory=cfg.assets;config.cuda_dll_directory=cfg.cuda;
                auto loaded=std::make_unique<wavegen_resident::ResidentEngine>(config);
                std::lock_guard<std::mutex> lock(state_mutex);engine=std::move(loaded);update_engine_status();state="ready";message="Ready to generate speech.";
            } catch(const std::exception& error){std::lock_guard<std::mutex> lock(state_mutex);state="error";message=error.what();}
        });
        shutdown_thread=std::thread([this]{std::unique_lock<std::mutex> lock(shutdown_mutex);shutdown_condition.wait(lock,[this]{return shutdown_requested.load();});
            lock.unlock();std::this_thread::sleep_for(std::chrono::milliseconds(200));server.stop();});
    }
    bool valid_host(const Request& request) const {
        const auto host=request.get_header_value("Host");return host=="127.0.0.1:"+std::to_string(cfg.port)||host=="localhost:"+std::to_string(cfg.port);
    }
    bool valid_origin(const Request& request) const {
        if(!request.has_header("Origin"))return true;
        const auto origin=request.get_header_value("Origin");return origin=="http://127.0.0.1:"+std::to_string(cfg.port)||origin=="http://localhost:"+std::to_string(cfg.port);
    }
    bool authenticated(const Request& request) const {
        const auto cookies=request.get_header_value("Cookie");std::istringstream stream(cookies);std::string item;
        while(std::getline(stream,item,';'))if(trimmed(item)==cookie_name()+"="+token)return true;return false;
    }
    std::string cookie_name() const {return "wavegen_studio_"+std::to_string(cfg.port);}
    static std::pair<std::string,std::string> profile_fields(const Request& request) {
        std::string name,text;
        if(request.is_multipart_form_data()){
            name=request.form.get_field("name");text=request.form.get_field("reference_text");
            if(text.empty())text=request.form.get_field("ref_text");
        } else {auto body=Json::parse(request.body);name=body.value("name","");text=body.value("reference_text",body.value("ref_text",""));}
        name=trimmed(name);text=trimmed(text);
        ensure(!name.empty()&&name.size()<=160,"Voice name must contain 1 to 160 UTF-8 bytes");
        ensure(!text.empty()&&text.size()<=4000,"Reference transcript must contain 1 to 4000 bytes");
        normalize_english(text);return {name,text};
    }
    static double multipart_number(const std::string& raw,const char* field,double minimum,double maximum) {
        size_t used=0;double value=0;
        try {value=std::stod(raw,&used);}
        catch(const std::invalid_argument&){throw HttpError(400,std::string("Invalid numeric field: ")+field);}
        catch(const std::out_of_range&){throw HttpError(400,std::string("Numeric field is out of range: ")+field);}
        ensure(used==raw.size()&&std::isfinite(value)&&value>=minimum&&value<=maximum,std::string("Invalid numeric field: ")+field);
        return value;
    }
    void profile_save(const Request& request,Response& response,bool update) {
        const auto [name,text]=profile_fields(request);
        const auto id=update?request.matches[1].str():random_id();
        std::optional<std::string> audio,original_audio,avatar;bool remove_avatar=false;
        if(request.is_multipart_form_data()&&request.form.has_file("audio"))audio=request.form.get_file("audio").content;
        if(request.is_multipart_form_data()&&request.form.has_file("original_audio"))original_audio=request.form.get_file("original_audio").content;
        if(request.is_multipart_form_data()&&request.form.has_file("avatar"))avatar=request.form.get_file("avatar").content;
        if(request.is_multipart_form_data()&&request.form.has_field("remove_avatar")){
            const auto value=request.form.get_field("remove_avatar");ensure(value=="true"||value=="false"||value=="1"||value=="0","Invalid remove_avatar value");
            remove_avatar=value=="true"||value=="1";
        }else if(!request.is_multipart_form_data()){
            const auto body=Json::parse(request.body);if(body.contains("remove_avatar"))remove_avatar=body.at("remove_avatar").get<bool>();
        }
        Json extra=Json::object();
        if(request.is_multipart_form_data()){
            if(request.form.has_field("prompt_enhancement_id")){
                const auto id=request.form.get_field("prompt_enhancement_id");ensure(valid_id(id),"Invalid prompt enhancement ID");extra["prompt_enhancement_id"]=id;
            }
            for(const auto* field:{"trim_enabled","normalize_enabled"})if(request.form.has_field(field)){
                const auto value=request.form.get_field(field);
                ensure(value=="true"||value=="false"||value=="1"||value=="0",std::string("Invalid boolean field: ")+field);
                extra[field]=(value=="true"||value=="1");
            }
            for(const auto* field:{"trim_start_seconds","trim_end_seconds","original_duration_seconds","selection_start_seconds","selection_end_seconds"}){
                if(request.form.has_field(field))extra[field]=multipart_number(request.form.get_field(field),field,0,120);
            }
            if(request.form.has_field("normalization_gain_db"))
                extra["normalization_gain_db"]=multipart_number(request.form.get_field("normalization_gain_db"),"normalization_gain_db",-120,12);
            if(request.form.has_field("reference_edit_version")){
                ensure(request.form.get_field("reference_edit_version")=="1","Unsupported reference edit version");extra["reference_edit_version"]=1;
            }
        }
        std::scoped_lock lock(state_mutex,data_mutex);
        ensure(!(active_voice==id&&!active_request.empty()),"This voice is currently generating speech; edit it after completion",409);
        if(update)store.get_voice(id);
        json_response(response,Json{{"voice",store.save_voice(id,name,text,audio,original_audio,extra,avatar,remove_avatar)}},update?200:201);
    }
    static double requested_duration(const Json& body){
        if(!body.contains("duration_seconds")||body.at("duration_seconds").is_null())return 0;
        const double value=body.at("duration_seconds").get<double>();
        ensure(std::isfinite(value)&&(value==0||(value>=0.2&&value<=600)),"Target duration must be 0 (automatic) or between 0.2 and 600 seconds");
        return value;
    }
    static uint64_t requested_seed(const Json& body,uint64_t fallback=0){
        if(!body.contains("seed"))return fallback;
        ensure(body.at("seed").is_number_integer()&&body.at("seed").get<double>()>=0,"Seed must be a nonnegative integer");
        const auto value=body.at("seed").get<uint64_t>();ensure(value<=9007199254740991ULL,"Seed is too large");return value;
    }
    static Json segments_json(const std::vector<wavegen_resident::Segment>& segments,size_t offset=0){
        Json values=Json::array();
        for(const auto& segment:segments){
            const auto samples=segment.samples?segment.samples:size_t(std::llround(segment.duration_seconds*SAMPLE_RATE));
            values.push_back(Json{{"text",segment.text},{"frames",segment.frames},{"duration_seconds",segment.duration_seconds},
                {"generation_seconds",segment.generation_seconds},{"samples",samples},{"start_sample",offset},{"end_sample",offset+samples},
                {"start_seconds",double(offset)/SAMPLE_RATE},{"end_seconds",double(offset+samples)/SAMPLE_RATE}});
            offset+=samples+size_t(SAMPLE_RATE*0.12);
        }
        return values;
    }
    static Json plan_json(const wavegen_resident::Plan& planned,double requested=0){
        return Json{{"duration_seconds",planned.duration_seconds},{"segment_count",planned.segments.size()},
            {"prompt_frames",planned.prompt_frames},{"samples",planned.samples},{"sample_rate",SAMPLE_RATE},
            {"duration_mode",requested>0?"fixed":"auto"},{"requested_duration_seconds",requested},{"segments",segments_json(planned.segments)}};
    }
    // Caller holds data_mutex. A completed WAV survives metadata-write failures.
    void persist_result(Json& result){
        const auto id=result.at("id").get<std::string>();
        try {store.save_output(result);}
        catch(const std::exception& error){
            store.require_completed_output(id);result["history_saved"]=false;
            result["warning"]="Audio is complete and preserved, but its history record could not be saved: "+std::string(error.what());
            result["recovery_metadata_saved"]=true;
            try {store.save_recovery_output(result);}
            catch(const std::exception& recovery_error){result["recovery_metadata_saved"]=false;
                result["warning"]=result.at("warning").get<std::string>()+" Recovery metadata also failed: "+recovery_error.what();}
        }
    }
    void plan(const Request& request,Response& response) {
        const auto body=Json::parse(request.body);
        const auto model_id=requested_model(body);require_model(model_id);
        const bool enhance_requested=body.value("enhance_output",false);
        if(enhance_requested)ensure(enhancement_available(),"RE-USE enhancement model is not installed",503);
        const std::string voice_id=body.value("voice_id",""),text=trimmed(body.value("text",""));
        ensure(valid_id(voice_id),"Select a saved voice profile");
        ensure(!text.empty()&&text.size()<=5000,"Generation text must contain 1 to 5000 bytes");normalize_english(text);
        const double duration=requested_duration(body);
        const double speed=duration>0?1.0:body.value("speed",1.0);const bool split_long_text=body.value("split_long_text",true);
        ensure(std::isfinite(speed)&&speed>=0.25&&speed<=4.0,"Speed must be between 0.25 and 4");
        Json voice;fs::path reference;
        {std::lock_guard<std::mutex> lock(data_mutex);voice=store.get_voice(voice_id);reference=store.safe_voice_audio(voice);}
        const auto planned=wavegen_resident::ResidentEngine::plan(reference,voice.at("reference_text").get<std::string>(),text,speed,split_long_text,duration);
        auto result=plan_json(planned,duration);result["model_id"]=model_id;result["steps"]=model_id=="vspec"?50:4;
        if(enhance_requested)ensure(planned.samples<=size_t(600*SAMPLE_RATE),"Speech enhancement requires audio no longer than 600 seconds");
        result["enhance_output"]=enhance_requested;
        json_response(response,result);
    }
    void cancel(const Request& request,Response& response) {
        const auto body=Json::parse(request.body);const auto id=body.value("request_id","");
        ensure(valid_id(id),"A valid request_id is required");
        std::lock_guard<std::mutex> lock(state_mutex);
        ensure(!active_request.empty()&&active_request==id,"This generation is no longer active",409);
        ensure(!finalizing,"Audio generation has finished and is being saved",409);
        cancel_requested=true;message=(state=="loading_model"||state=="loading_enhancement")?"Cancelling after model preparation...":"Cancelling audio processing...";
        json_response(response,Json{{"cancelled",true},{"request_id",id}});
    }
    // Call while holding state_mutex. A cancelled request releases its UI and
    // server locks while preserving the resident model session.
    void finish_generation(const std::string& next_message) {
        if(active_model=="vspec"&&!vspec_engine)active_model="flash";
        if(engine||vspec_engine)update_engine_status();state="ready";active_voice.clear();active_request.clear();
        step_index=0;step_count=0;
        chunk_text.clear();cancel_requested=false;finalizing=false;phase.clear();message=next_message;
    }
    Json apply_character(std::vector<float>& samples,const Json& voice,const std::string& request_id) {
        if(!voice.contains("character_effect"))return nullptr;
        const auto effect=validated_character_effect(voice.at("character_effect"));
        {
            std::lock_guard<std::mutex> lock(state_mutex);
            ensure(active_request==request_id,"This character request is no longer active",409);
            if(cancel_requested)throw wavegen_resident::Cancelled();
            // Synthesis has sealed its own WAV. The following cancellable CPU
            // pass is still part of the same uncommitted Studio request.
            finalizing=false;phase="character";message="Applying character voice...";
        }
        auto processed=wavegen_character::process(samples,effect.at("id").get<std::string>(),[this,request_id]{
            std::lock_guard<std::mutex> lock(state_mutex);
            if(active_request!=request_id||cancel_requested)throw wavegen_resident::Cancelled();return false;
        });
        auto metadata=character_processing(processed);samples=std::move(processed.samples);
        {
            std::lock_guard<std::mutex> lock(state_mutex);
            if(cancel_requested)throw wavegen_resident::Cancelled();finalizing=true;message="Saving character audio...";
        }
        return metadata;
    }
    Json enhance_saved_output(const Json& source,const std::string& request_id,const Clock::time_point& started){
        const auto source_id=source.at("id").get<std::string>();const auto input_path=store.output_path(source_id);
        const auto input=read_wav(input_path);auto processed=process_enhancement(input,request_id);
        const auto id=random_id();const auto output=store.output_path(id);bool complete=false;
        try{
            write_wav(output,processed.first.samples);store.require_completed_output(id);complete=true;
            auto provenance=std::move(processed.second);provenance["input_sha256"]=sha256_bytes(read_text(input_path));provenance["output_sha256"]=sha256_bytes(read_text(output));
            Json result=source;
            for(const auto* key:{"warning","recovery_metadata_saved","raw_result","cancelled","enhancement_failed"})result.erase(key);
            result.update(Json{{"id",id},{"request_id",request_id},{"created_at",timestamp()},{"audio_url","/api/audio/outputs/"+id},
                {"source_id",source_id},{"parent_id",source_id},{"original_audio_url","/api/audio/outputs/"+source_id},
                {"enhanced",true},{"enhance_output",true},{"enhance_output_requested",true},{"enhancement",provenance},{"processing_operation","enhance"},
                {"source_generation_seconds",source.value("generation_seconds",0.0)},{"generation_seconds",elapsed(started)},
                {"enhancement_seconds",provenance.at("processing_seconds")},{"samples",input.size()},{"sample_rate",SAMPLE_RATE},
                {"duration_seconds",double(input.size())/SAMPLE_RATE},{"history_saved",true}});
            if(source.contains("character_effect")||source.value("derived_from_character",false)){
                result["character_effect_may_be_softened"]=true;
                if(result.contains("character_processing"))result["character_processing"]["order"]=result["character_processing"].value("order","tts,character")+",reuse";
            }
            {std::scoped_lock lock(state_mutex,data_mutex);persist_result(result);}
            return result;
        }catch(...){if(!complete){std::error_code ignored;fs::remove(output,ignored);}throw;}
    }
    void enhancement_failure(Response& response,const std::string& request_id,const Json& raw,const std::string& error,bool cancelled){
        {std::lock_guard<std::mutex> lock(state_mutex);finish_generation(cancelled?"Enhancement cancelled. Original audio is preserved.":"Enhancement failed. Original audio is preserved.");}
        Json result={{"request_id",request_id},{"enhancement_failed",true}};
        if(cancelled)result["cancelled"]=true;else result["error"]=error;
        if(!raw.is_null())result["raw_result"]=raw;
        json_response(response,result,cancelled?200:500);
    }
    void enhance_output(const Request& request,Response& response){
        const auto started=Clock::now();const auto body=Json::parse(request.body);
        const auto source_id=body.value("source_id","");ensure(valid_id(source_id),"Select a saved source audio file");
        const auto request_id=body.value("request_id",random_id());ensure(valid_id(request_id),"request_id must contain 32 lowercase hexadecimal characters");
        ensure(enhancement_available(),"RE-USE enhancement model is not installed",503);Json source;
        {
            std::scoped_lock lock(state_mutex,data_mutex);
            ensure(state=="ready"&&active_request.empty(),"Another audio request is running or the model is not ready",409);
            ensure(!shutdown_requested,"Studio is shutting down",409);source=store.get_output(source_id);
            ensure(read_wav(store.output_path(source_id)).size()<=size_t(600*SAMPLE_RATE),"Speech enhancement requires audio no longer than 600 seconds");
            state="enhancing";phase="enhancement";active_request=request_id;active_voice="";cancel_requested=false;finalizing=false;
            chunk_index=0;chunk_count=0;chunk_text.clear();step_index=0;step_count=0;message="Enhancing audio with RE-USE...";
        }
        try{
            auto result=enhance_saved_output(source,request_id,started);
            {std::lock_guard<std::mutex> lock(state_mutex);finish_generation("Audio enhancement complete.");}
            result["raw_result"]=source;json_response(response,result);
        }catch(const wavegen_reuse::Cancelled&){enhancement_failure(response,request_id,source,"",true);}
        catch(const std::exception& error){bool cancelled;{std::lock_guard<std::mutex> lock(state_mutex);cancelled=cancel_requested;}
            enhancement_failure(response,request_id,source,error.what(),cancelled);}
    }
    void enhance_reference(const Request& request,Response& response){
        ensure(request.is_multipart_form_data()&&request.form.has_file("audio"),"Upload the prepared reference WAV for enhancement");
        const auto audio=request.form.get_file("audio").content;ensure(!audio.empty()&&audio.size()<=MAX_UPLOAD,"Reference WAV must be nonempty and no larger than 20 MB");
        const auto request_id=request.form.has_field("request_id")?request.form.get_field("request_id"):random_id();
        ensure(valid_id(request_id),"request_id must contain 32 lowercase hexadecimal characters");
        ensure(enhancement_available(),"RE-USE enhancement model is not installed",503);
        const auto id=random_id();const auto input=store.enhancement_path(id,true),output=store.enhancement_path(id);bool complete=false,reserved=false;
        try{
            write_atomic(input,audio);auto info=wavegen_resident::ResidentEngine::validate_reference(input);
            ensure(info.duration_seconds<30,"Reference audio must be shorter than 30 seconds");const auto samples=read_wav(input);
            {
                std::lock_guard<std::mutex> lock(state_mutex);
                ensure(state=="ready"&&active_request.empty(),"Another audio request is running or the model is not ready",409);
                ensure(!shutdown_requested,"Studio is shutting down",409);
                state="enhancing";phase="enhancement";active_request=request_id;active_voice="";cancel_requested=false;finalizing=false;
                chunk_index=0;chunk_count=0;chunk_text.clear();step_index=0;step_count=0;message="Enhancing reference audio with RE-USE...";reserved=true;
            }
            auto processed=process_enhancement(samples,request_id);write_wav(output,processed.first.samples);
            Json result={{"id",id},{"request_id",request_id},{"created_at",timestamp()},{"enhancement",processed.second}};
            {std::scoped_lock lock(state_mutex,data_mutex);store.save_reference_enhancement(result);complete=true;finish_generation("Reference enhancement is ready to preview and apply.");}
            json_response(response,result);
        }catch(const wavegen_reuse::Cancelled&){
            if(!complete){std::error_code ignored;fs::remove(input,ignored);fs::remove(output,ignored);}
            enhancement_failure(response,request_id,nullptr,"",true);
        }catch(const std::exception& error){
            if(!complete){std::error_code ignored;fs::remove(input,ignored);fs::remove(output,ignored);}
            if(!reserved)throw;
            bool cancelled;{std::lock_guard<std::mutex> lock(state_mutex);cancelled=cancel_requested;}
            enhancement_failure(response,request_id,nullptr,error.what(),cancelled);
        }
    }
    void generate(const Request& request,Response& response) {
        const auto request_started=Clock::now();
        const auto body=Json::parse(request.body);const std::string voice_id=body.value("voice_id",""),text=trimmed(body.value("text",""));
        const auto model_id=requested_model(body);require_model(model_id);
        const bool enhance_requested=body.value("enhance_output",false);
        if(enhance_requested)ensure(enhancement_available(),"RE-USE enhancement model is not installed",503);
        ensure(valid_id(voice_id),"Select a saved voice profile");ensure(!text.empty()&&text.size()<=5000,"Generation text must contain 1 to 5000 bytes");normalize_english(text);
        const uint64_t seed=requested_seed(body);const double duration=requested_duration(body);double speed=1.0;
        bool split_long_text=body.value("split_long_text",true);
        if(duration==0&&body.contains("speed"))speed=body["speed"].get<double>();ensure(std::isfinite(speed)&&speed>=0.25&&speed<=4.0,"Speed must be between 0.25 and 4");
        const std::string request_id=body.contains("request_id")?body.at("request_id").get<std::string>():random_id();
        ensure(valid_id(request_id),"request_id must contain 32 lowercase hexadecimal characters");
        const auto id=random_id();const fs::path output=store.output_path(id);
        Json voice;fs::path reference;
        {
            std::scoped_lock lock(state_mutex,data_mutex);
            ensure(state=="ready",state=="loading"?"The model is still loading":state=="generating"?"Another generation is running":message,409);
            ensure(active_request.empty(),"Another audio request is running",409);
            ensure(!shutdown_requested,"Studio is shutting down",409);
            voice=store.get_voice(voice_id);reference=store.safe_voice_audio(voice);
            if(enhance_requested){const auto planned=wavegen_resident::ResidentEngine::plan(reference,voice.at("reference_text").get<std::string>(),text,speed,split_long_text,duration);
                ensure(planned.samples<=size_t(600*SAMPLE_RATE),"Speech enhancement requires audio no longer than 600 seconds");}
            state="generating";active_voice=voice_id;
            active_request=request_id;active_model=model_id;phase="tts";cancel_requested=false;finalizing=false;chunk_text.clear();chunk_index=0;chunk_count=0;step_index=0;step_count=model_id=="vspec"?50:4;message="Generating speech...";
        }
        bool audio_completed=false;
        try {
            const auto preparation_started=Clock::now();
            auto& selected_engine=select_engine(model_id);
            const double preparation_seconds=elapsed(preparation_started);
            const auto progress=[this](size_t completed,size_t total,const std::string& text){
                std::lock_guard<std::mutex> lock(state_mutex);chunk_index=completed;chunk_count=total;
                chunk_text=text;
                // Seal cancellation before the engine writes WAV/increments its
                // completed counter. An already accepted cancellation stays set
                // and is observed by the engine immediately after this callback.
                if(completed==total&&!cancel_requested)finalizing=true;
                if(!cancel_requested)message=completed<total?"Generating segment "+std::to_string(completed+1)+" of "+std::to_string(total)+"...":"Finishing audio...";
            };
            const auto cancelled=[this,request_id]{std::lock_guard<std::mutex> lock(state_mutex);return active_request==request_id&&cancel_requested;};
            const auto step_progress=[this](size_t completed,size_t total){std::lock_guard<std::mutex> lock(state_mutex);step_index=completed;step_count=total;};
            const auto generated=selected_engine.synthesize(reference,voice.at("reference_text").get<std::string>(),text,seed,speed,output,progress,split_long_text,cancelled,duration,step_progress);
            Json character_stats=nullptr;
            if(voice.contains("character_effect")){
                auto samples=read_wav(output);character_stats=apply_character(samples,voice,request_id);write_wav(output,samples);
            }
            store.require_completed_output(id);
            audio_completed=true;
            Json result={{"id",id},{"request_id",request_id},{"voice_id",voice_id},{"voice_name",voice.at("name")},{"text",text},{"seed",seed},{"speed",speed},
                {"model_id",model_id},{"model_name",model_name(model_id)},{"steps",generated.steps},{"ort_runs",generated.ort_runs},{"model_evaluations",generated.model_evaluations},{"model_scope","full"},
                {"audio_url","/api/audio/outputs/"+id},{"created_at",timestamp()},{"duration_seconds",generated.duration_seconds},
                {"generation_seconds",elapsed(request_started)},{"synthesis_seconds",generated.synthesis_seconds},
                {"model_preparation_seconds",preparation_seconds},{"model_load_seconds",generated.model_load_seconds},
                {"frontend_seconds",generated.frontend_seconds},{"model_load_count",generated.load_count},
                {"session_id",generated.session_id},{"request_index",generated.request_index},{"precision",generated.precision},
                {"frontend_precision",generated.frontend_precision},{"frames",generated.frames},{"split_long_text",split_long_text},
                {"segments",segments_json(generated.segments)},{"segments_count",generated.segments.size()},{"segment_count",generated.segments.size()},{"history_saved",true},
                {"sample_rate",SAMPLE_RATE},{"samples",size_t(std::llround(generated.duration_seconds*SAMPLE_RATE))},
                {"duration_mode",duration>0?"fixed":"auto"},{"requested_duration_seconds",duration},{"transcript_stale",false},
                {"enhance_output",false},{"enhance_output_requested",enhance_requested},{"enhanced",false}};
            if(voice.contains("prompt_enhancement"))result["prompt_enhancement"]=voice.at("prompt_enhancement");
            if(!character_stats.is_null()){
                result["character_effect"]=validated_character_effect(voice.at("character_effect"));result["character_effect_scope"]="full";
                result["character_processing"]=character_stats;result["derived_from_character"]=true;
            }
            {
                // Serialize the final cancel check and commit. A successful cancel
                // can never race with a history record being added afterward.
                std::scoped_lock lock(state_mutex,data_mutex);
                if(cancel_requested)throw wavegen_resident::Cancelled();
                persist_result(result);
                if(!enhance_requested)finish_generation("Ready to generate speech.");
            }
            if(enhance_requested){
                try{
                    auto enhanced=enhance_saved_output(result,request_id,request_started);
                    {std::lock_guard<std::mutex> lock(state_mutex);finish_generation("Speech generation and enhancement complete.");}
                    enhanced["raw_result"]=result;json_response(response,enhanced);
                }catch(const wavegen_reuse::Cancelled&){enhancement_failure(response,request_id,result,"",true);}
                catch(const std::exception& error){bool cancelled;{std::lock_guard<std::mutex> lock(state_mutex);cancelled=cancel_requested;}
                    enhancement_failure(response,request_id,result,error.what(),cancelled);}
                return;
            }
            json_response(response,result);
        } catch(const wavegen_resident::Cancelled&) {
            std::error_code ignored;fs::remove(output,ignored);
            {std::lock_guard<std::mutex> lock(state_mutex);finish_generation("Generation cancelled. Ready to generate speech.");}
            json_response(response,Json{{"cancelled",true},{"request_id",request_id}});
        } catch(...) {
            if(!audio_completed){std::error_code ignored;fs::remove(output,ignored);}
            {std::lock_guard<std::mutex> lock(state_mutex);finish_generation(audio_completed?
                "Audio was generated and preserved, but the request could not be finalized.":
                "Generation failed. Check the text and reference audio, then try again.");}
            throw;
        }
    }
    struct EditInput {
        Json source,voice;
        std::string source_id,operation,text,voice_id,model_id;
        std::vector<float> samples;
        wavegen_edit::Range range;
        fs::path reference;
        uint64_t seed=0;
        double duration=0;
        size_t output_samples=0;
        wavegen_resident::Plan replacement;
        bool regenerates()const{return operation=="regenerate";}
    };
    EditInput prepare_edit(const Json& body){
        EditInput input;input.source_id=body.value("source_id","");input.operation=body.value("operation","");
        ensure(valid_id(input.source_id),"Select a saved source audio file");
        ensure(input.operation=="cut"||input.operation=="keep"||input.regenerates(),"Edit operation must be cut, keep, or regenerate");
        {std::lock_guard<std::mutex> lock(data_mutex);input.source=store.get_output(input.source_id);}
        input.model_id=input.regenerates()?requested_model(body,input.source.value("model_id","flash")):input.source.value("model_id","flash");
        if(input.regenerates())require_model(input.model_id);
        input.samples=read_wav(store.output_path(input.source_id));
        input.range=wavegen_edit::select(input.samples.size(),body.at("start_seconds").get<double>(),body.at("end_seconds").get<double>());
        const size_t selected=input.range.end-input.range.start;
        input.voice_id=input.regenerates()?body.value("voice_id",input.source.value("voice_id","")):input.source.value("voice_id","");
        input.seed=requested_seed(body,input.source.value("seed",uint64_t(0)));
        if(input.regenerates()){
            input.text=trimmed(body.value("text",""));
            ensure(!input.text.empty()&&input.text.size()<=5000,"Replacement text must contain 1 to 5000 bytes");normalize_english(input.text);
            input.duration=requested_duration(body);
            {std::lock_guard<std::mutex> lock(data_mutex);input.voice=store.get_voice(input.voice_id);input.reference=store.safe_voice_audio(input.voice);}
            input.replacement=wavegen_resident::ResidentEngine::plan(input.reference,input.voice.at("reference_text").get<std::string>(),input.text,1.0,true,input.duration);
            input.output_samples=input.samples.size()-selected+input.replacement.samples;
        }else{
            input.output_samples=input.operation=="keep"?selected:input.samples.size()-selected;
            ensure(input.output_samples>0,"The edit would remove all audio");
        }
        return input;
    }
    Json edit_plan_json(const EditInput& input){
        Json result={{"source_id",input.source_id},{"parent_id",input.source_id},{"operation",input.operation},
            {"model_id",input.model_id},{"steps",input.model_id=="vspec"?50:4},
            {"sample_rate",SAMPLE_RATE},{"samples",input.output_samples},{"duration_seconds",double(input.output_samples)/SAMPLE_RATE},
            {"source_samples",input.samples.size()},{"source_duration_seconds",double(input.samples.size())/SAMPLE_RATE},
            {"start_sample",input.range.start},{"end_sample",input.range.end},
            {"start_seconds",double(input.range.start)/SAMPLE_RATE},{"end_seconds",double(input.range.end)/SAMPLE_RATE},
            {"selection_duration_seconds",double(input.range.end-input.range.start)/SAMPLE_RATE},
            {"replacement_duration_seconds",input.regenerates()?input.replacement.duration_seconds:0.0},{"transcript_stale",true}};
        if(input.regenerates())result["replacement_plan"]=plan_json(input.replacement,input.duration);
        return result;
    }
    void edit_plan(const Request& request,Response& response){json_response(response,edit_plan_json(prepare_edit(Json::parse(request.body))));}
    void edit_audio(const Request& request,Response& response){
        const auto started=Clock::now();const auto body=Json::parse(request.body);
        const std::string request_id=body.contains("request_id")?body.at("request_id").get<std::string>():random_id();
        ensure(valid_id(request_id),"request_id must contain 32 lowercase hexadecimal characters");
        auto input=prepare_edit(body);
        const auto id=random_id();const auto output=store.output_path(id);
        const fs::path temporary=output.parent_path()/(id+".replacement.wav");
        {
            std::scoped_lock lock(state_mutex,data_mutex);
            ensure(state!="generating"&&state!="loading_model"&&active_request.empty(),"Another audio request is running",409);
            ensure(!shutdown_requested,"Studio is shutting down",409);
            if(input.regenerates()){
                ensure(state=="ready",state=="loading"?"The model is still loading":message,409);
                store.get_voice(input.voice_id); // The planned immutable WAV remains valid; reject a newly trashed voice.
            }
            // PCM-only edits reserve the shared request slot without changing a
            // loading/error model into a falsely ready state.
            active_request=request_id;active_voice=input.regenerates()?input.voice_id:"";
            cancel_requested=false;finalizing=!input.regenerates();chunk_index=0;chunk_count=0;chunk_text.clear();
            if(input.regenerates()){state="generating";phase="tts";active_model=input.model_id;step_index=0;step_count=input.model_id=="vspec"?50:4;message="Regenerating selected audio...";}
        }
        const auto release=[&](const std::string& message){
            std::lock_guard<std::mutex> lock(state_mutex);
            if(input.regenerates())finish_generation(message);
            else{active_request.clear();active_voice.clear();finalizing=false;cancel_requested=false;}
        };
        const auto cleanup_temporary=[&]{std::error_code ignored;fs::remove(temporary,ignored);};
        bool audio_completed=false;
        try{
            wavegen_resident::Result generated;std::vector<float> replacement;Json character_stats=nullptr;
            if(input.regenerates()){
                auto& selected_engine=select_engine(input.model_id);
                const auto progress=[this](size_t completed,size_t total,const std::string& text){
                    std::lock_guard<std::mutex> lock(state_mutex);chunk_index=completed;chunk_count=total;chunk_text=text;
                    if(completed==total&&!cancel_requested)finalizing=true;
                    if(!cancel_requested)message=completed<total?"Regenerating segment "+std::to_string(completed+1)+" of "+std::to_string(total)+"...":"Saving edited audio...";
                };
                const auto cancelled=[this,request_id]{std::lock_guard<std::mutex> lock(state_mutex);return active_request==request_id&&cancel_requested;};
                const auto step_progress=[this](size_t completed,size_t total){std::lock_guard<std::mutex> lock(state_mutex);step_index=completed;step_count=total;};
                generated=selected_engine.synthesize(input.reference,input.voice.at("reference_text").get<std::string>(),input.text,input.seed,1.0,temporary,progress,true,cancelled,input.duration,step_progress);
                replacement=read_wav(temporary);
                ensure(replacement.size()==input.replacement.samples,"Replacement duration changed after planning; retry edit",500);
                if(input.voice.contains("character_effect"))character_stats=apply_character(replacement,input.voice,request_id);
            }
            auto edited=wavegen_edit::apply(input.samples,input.range,input.operation,replacement);
            ensure(edited.size()==input.output_samples,"Edited duration differs from the plan",500);
            write_wav(output,edited);store.require_completed_output(id);audio_completed=true;cleanup_temporary();
            Json edit={{"operation",input.operation},{"start_sample",input.range.start},{"end_sample",input.range.end},
                {"model_id",input.model_id},{"source_model_id",input.source.value("model_id","flash")},
                {"start_seconds",double(input.range.start)/SAMPLE_RATE},{"end_seconds",double(input.range.end)/SAMPLE_RATE},
                {"selection_duration_seconds",double(input.range.end-input.range.start)/SAMPLE_RATE},{"fade_seconds",0.005},
                {"text",input.text},{"seed",input.seed},{"duration_mode",input.duration>0?"fixed":"auto"},
                {"requested_duration_seconds",input.duration},{"replacement_duration_seconds",double(replacement.size())/SAMPLE_RATE},
                {"replacement_segments",segments_json(generated.segments,input.range.start)}};
            Json result={{"id",id},{"request_id",request_id},{"parent_id",input.source_id},{"source_id",input.source_id},{"edit",edit},
                {"model_id",input.model_id},{"model_name",model_name(input.model_id)},{"steps",input.model_id=="vspec"?50:4},
                {"ort_runs",generated.ort_runs},{"model_evaluations",generated.model_evaluations},{"model_scope",input.regenerates()?"replacement":"inherited"},
                {"voice_id",input.voice_id},{"voice_name",input.regenerates()?input.voice.at("name"):input.source.value("voice_name",Json("Saved voice"))},
                {"text",input.source.value("text","")},{"transcript_stale",true},{"transcript_status","unaligned_after_edit"},
                {"seed",input.seed},{"speed",1.0},{"split_long_text",true},{"duration_mode","auto"},{"requested_duration_seconds",0},
                {"audio_url","/api/audio/outputs/"+id},{"created_at",timestamp()},{"sample_rate",SAMPLE_RATE},{"samples",edited.size()},
                {"duration_seconds",double(edited.size())/SAMPLE_RATE},{"generation_seconds",elapsed(started)},
                {"synthesis_seconds",generated.synthesis_seconds},{"frontend_seconds",generated.frontend_seconds},
                {"frames",generated.frames},{"precision",input.regenerates()?generated.precision:"PCM16"},
                {"frontend_precision",input.regenerates()?generated.frontend_precision:"pcm_edit"},
                {"segments",Json::array()},{"segments_count",0},{"segment_count",0},{"history_saved",true},
                {"enhanced",false},{"enhance_output",false},{"derived_from_enhanced",input.source.value("enhanced",false)}};
            if(input.regenerates()&&input.voice.contains("prompt_enhancement"))result["prompt_enhancement"]=input.voice.at("prompt_enhancement");
            if(input.source.contains("character_effect")){
                result["source_character_effect"]=input.source.at("character_effect");
                result["source_character_effect_scope"]=input.source.value("character_effect_scope","full");
                result["derived_from_character"]=true;
            }else if(input.source.value("derived_from_character",false))result["derived_from_character"]=true;
            if(!character_stats.is_null()){
                const auto effect=validated_character_effect(input.voice.at("character_effect"));
                result["character_effect"]=effect;result["character_effect_scope"]="replacement";result["character_processing"]=character_stats;
                result["edit"]["character_effect"]=effect;result["edit"]["character_processing"]=character_stats;result["derived_from_character"]=true;
            }else if(!input.regenerates()&&input.source.contains("character_effect")){
                result["character_effect"]=input.source.at("character_effect");result["character_effect_scope"]="inherited";
                if(input.source.contains("character_processing"))result["character_processing"]=input.source.at("character_processing");
            }
            {
                std::scoped_lock lock(state_mutex,data_mutex);
                if(cancel_requested)throw wavegen_resident::Cancelled();
                if(input.regenerates()){
                    update_engine_status();result["model_load_count"]=generated.load_count;
                    result["session_id"]=generated.session_id;result["request_index"]=generated.request_index;
                }else{
                    result["model_load_count"]=input.source.value("model_load_count",0);
                    result["session_id"]=input.source.value("session_id","");result["request_index"]=input.source.value("request_index",uint64_t(0));
                }
                persist_result(result);
                if(input.regenerates())finish_generation("Ready to generate speech.");
                else{active_request.clear();active_voice.clear();finalizing=false;cancel_requested=false;}
            }
            json_response(response,result);
        }catch(const wavegen_resident::Cancelled&){
            cleanup_temporary();std::error_code ignored;fs::remove(output,ignored);release("Edit cancelled. Ready to generate speech.");
            json_response(response,Json{{"cancelled",true},{"request_id",request_id}});
        }catch(...){
            cleanup_temporary();if(!audio_completed){std::error_code ignored;fs::remove(output,ignored);}
            release(audio_completed?"Edited audio is preserved, but the request could not be finalized.":"Audio edit failed. Check the selection and try again.");throw;
        }
    }
    void serve_audio(Response& response,const fs::path& path) {
        ensure(fs::is_regular_file(path),"Audio file was not found",404);
        response.set_content(read_text(path),"audio/wav");response.set_header("Accept-Ranges","bytes");
    }
    void list_history(const Request& request,Response& response){
        for(const auto* field:{"limit","cursor","q"})ensure(request.get_param_value_count(field)<=1,std::string("Duplicate history parameter: ")+field);
        size_t limit=200;
        if(request.has_param("limit")){
            const auto value=request.get_param_value("limit");
            ensure(!value.empty()&&value.size()<=3&&std::all_of(value.begin(),value.end(),[](char c){return c>='0'&&c<='9';}),"History page size must be an integer between 1 and 200");
            limit=std::stoul(value);ensure(limit>=1&&limit<=200,"History page size must be between 1 and 200");
        }
        const auto cursor=request.get_param_value("cursor"),query=request.get_param_value("q");
        ensure(!request.has_param("cursor")||!cursor.empty(),"History cursor cannot be empty");
        std::lock_guard<std::mutex> lock(data_mutex);Json warnings=Json::array();json_response(response,store.history_page(warnings,limit,cursor,query));
    }
    void routes() {
        server.new_task_queue=[] {return new httplib::ThreadPool(8);};
        server.set_payload_max_length(2*MAX_UPLOAD+wavegen_avatar::MAX_BYTES+65536);server.set_read_timeout(60,0);server.set_write_timeout(60,0);
        server.set_exception_handler([](const Request&,Response& response,std::exception_ptr ptr){
            try {if(ptr)std::rethrow_exception(ptr);}catch(const HttpError& e){error_response(response,e.what(),e.code);}
            catch(const nlohmann::json::exception&){error_response(response,"Invalid JSON or request fields",400);}
            catch(const std::exception& e){error_response(response,e.what(),400);}catch(...){error_response(response,"Unexpected server error",500);}
        });
        server.set_error_handler([](const Request&,Response& response){if(response.body.empty())error_response(response,response.status==413?"Upload exceeds the request size limit (20 MB per WAV)":"Request was not found or rejected",response.status);});
        server.set_pre_routing_handler([this](const Request& request,Response& response){
            response.set_header("Cache-Control","no-store");response.set_header("X-Content-Type-Options","nosniff");response.set_header("Referrer-Policy","no-referrer");
            response.set_header("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
            if(!valid_host(request)||!valid_origin(request)){error_response(response,"Only requests from this local Studio are allowed",403);return httplib::Server::HandlerResponse::Handled;}
            const bool api=request.path.rfind("/api/",0)==0;
            if(api&&request.path!="/api/status"&&!authenticated(request)){error_response(response,"Open WaveGen Studio in this browser first",403);return httplib::Server::HandlerResponse::Handled;}
            if(request.method!="GET"&&request.method!="HEAD"&&request.get_header_value("X-WaveGen-Client")!="studio"){
                error_response(response,"Missing Studio request header",403);return httplib::Server::HandlerResponse::Handled;}
            return httplib::Server::HandlerResponse::Unhandled;
        });
        auto index=[this](const Request&,Response& response){response.set_header("Set-Cookie",cookie_name()+"="+token+"; Path=/; HttpOnly; SameSite=Strict");response.set_content(read_text(cfg.web_dir/"index.html"),"text/html; charset=utf-8");};
        server.Get("/",index);server.Get("/index.html",index);
        server.Get("/app.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"app.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-zh.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-zh.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-ja.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-ja.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-features.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-features.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-library.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-library.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-models.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-models.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-reference.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-reference.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-enhance.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-enhance.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-ux-voice.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-ux-voice.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-ux-edit.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-ux-edit.js"),"application/javascript; charset=utf-8");});
        server.Get("/i18n-ux-history.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"i18n-ux-history.js"),"application/javascript; charset=utf-8");});
        server.Get("/reference-editor.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"reference-editor.js"),"application/javascript; charset=utf-8");});
        server.Get("/reference-editor.css",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"reference-editor.css"),"text/css; charset=utf-8");});
        server.Get("/speech-edit.js",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"speech-edit.js"),"application/javascript; charset=utf-8");});
        server.Get("/speech-edit.css",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"speech-edit.css"),"text/css; charset=utf-8");});
        server.Get("/style.css",[this](const Request&,Response& response){response.set_content(read_text(cfg.web_dir/"style.css"),"text/css; charset=utf-8");});
        server.Get("/api/status",[this](const Request&,Response& response){json_response(response,status());});
        server.Get("/api/voices",[this](const Request&,Response& response){std::lock_guard<std::mutex> lock(data_mutex);
            Json warnings=Json::array();auto voices=store.list_voices(warnings);json_response(response,Json{{"voices",voices},{"warnings",warnings}});});
        server.Get("/api/trash",[this](const Request&,Response& response){std::lock_guard<std::mutex> lock(data_mutex);
            Json warnings=Json::array();auto voices=store.list_voices(warnings,true);json_response(response,Json{{"voices",voices},{"warnings",warnings}});});
        server.Post("/api/voices",[this](const Request& request,Response& response){profile_save(request,response,false);});
        auto edit=[this](const Request& request,Response& response){profile_save(request,response,true);};
        server.Put(R"(/api/voices/([0-9a-f]{32}))",edit);server.Patch(R"(/api/voices/([0-9a-f]{32}))",edit);
        server.Delete(R"(/api/voices/([0-9a-f]{32}))",[this](const Request& request,Response& response){
            const auto id=request.matches[1].str();std::scoped_lock lock(state_mutex,data_mutex);
            ensure(!(active_voice==id&&!active_request.empty()),"This voice is currently generating speech; delete it after completion",409);
            store.delete_voice(id);json_response(response,Json{{"ok",true}});
        });
        server.Post(R"(/api/voices/([0-9a-f]{32})/restore)",[this](const Request& request,Response& response){
            std::lock_guard<std::mutex> lock(data_mutex);json_response(response,Json{{"voice",store.restore_voice(request.matches[1].str())}});
        });
        server.Post("/api/plan",[this](const Request& request,Response& response){plan(request,response);});
        server.Post("/api/cancel",[this](const Request& request,Response& response){cancel(request,response);});
        server.Post("/api/generate",[this](const Request& request,Response& response){generate(request,response);});
        server.Post("/api/enhance",[this](const Request& request,Response& response){enhance_output(request,response);});
        server.Post("/api/enhance/reference",[this](const Request& request,Response& response){enhance_reference(request,response);});
        server.Post("/api/edit/plan",[this](const Request& request,Response& response){edit_plan(request,response);});
        server.Post("/api/edit",[this](const Request& request,Response& response){edit_audio(request,response);});
        server.Get("/api/history",[this](const Request& request,Response& response){list_history(request,response);});
        server.Get(R"(/api/audio/voices/([0-9a-f]{32}))",[this](const Request& request,Response& response){std::lock_guard<std::mutex> lock(data_mutex);serve_audio(response,store.safe_voice_audio(store.get_voice(request.matches[1].str())));});
        server.Get(R"(/api/audio/originals/([0-9a-f]{32}))",[this](const Request& request,Response& response){std::lock_guard<std::mutex> lock(data_mutex);serve_audio(response,store.safe_voice_audio(store.get_voice(request.matches[1].str()),true));});
        server.Get(R"(/api/audio/character-samples/([0-9a-f]{32}))",[this](const Request& request,Response& response){std::lock_guard<std::mutex> lock(data_mutex);serve_audio(response,store.safe_character_sample(store.get_voice(request.matches[1].str())));});
        server.Get(R"(/api/avatar/voices/([0-9a-f]{32}))",[this](const Request& request,Response& response){
            std::lock_guard<std::mutex> lock(data_mutex);const auto path=store.safe_voice_avatar(store.get_voice(request.matches[1].str(),true));
            ensure(fs::is_regular_file(path),"Voice avatar was not found",404);response.set_content(read_text(path),"image/png");
        });
        server.Get(R"(/api/audio/outputs/([0-9a-f]{32}))",[this](const Request& request,Response& response){std::lock_guard<std::mutex> lock(data_mutex);serve_audio(response,store.output_path(request.matches[1].str()));});
        server.Get(R"(/api/audio/enhancements/([0-9a-f]{32}))",[this](const Request& request,Response& response){std::lock_guard<std::mutex> lock(data_mutex);const auto id=request.matches[1].str();store.get_reference_enhancement(id);serve_audio(response,store.enhancement_path(id));});
        server.Get(R"(/api/audio/enhancement-inputs/([0-9a-f]{32}))",[this](const Request& request,Response& response){std::lock_guard<std::mutex> lock(data_mutex);const auto id=request.matches[1].str();store.get_reference_enhancement(id);serve_audio(response,store.enhancement_path(id,true));});
        server.Post("/api/shutdown",[this](const Request&,Response& response){json_response(response,Json{{"ok",true}});shutdown_requested=true;shutdown_condition.notify_all();});
    }
};

int run(int argc,wchar_t** argv) {
    auto cfg=config_from_args(argc,argv);fs::create_directories(cfg.data_dir);
    const auto lock_path=cfg.data_dir/"studio.lock";
    HANDLE lock=CreateFileW(lock_path.c_str(),GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ,nullptr,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
    if(lock==INVALID_HANDLE_VALUE){
        for(int retry=0;retry<20;++retry){
            try {auto record=read_json(cfg.data_dir/"studio_instance.json");int port=record.value("port",cfg.port);
                if(existing_studio(port,cfg)){if(!cfg.no_browser)open_browser(port);return 0;}}
            catch(...){}
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        throw HttpError(409,"WaveGen Studio is already starting or this data directory is locked.");
    }
    struct CloseLock{HANDLE value;~CloseLock(){CloseHandle(value);}}close_lock{lock};
    ensure(fs::is_regular_file(cfg.web_dir/"index.html"),"studio_web/index.html is missing beside the executable",500);
    Application app(cfg);app.routes();bool bound=false;
    const int max_port=cfg.explicit_port?cfg.port:std::min(cfg.port+20,65535);
    for(int port=cfg.port;port<=max_port;++port){
        if(app.server.bind_to_port("127.0.0.1",port)){app.cfg.port=port;bound=true;break;}
    }
    ensure(bound,"The requested local port is already in use. Start with another --port.",500);
    write_json(cfg.data_dir/"studio_instance.json",Json{{"application",APPLICATION},{"port",app.cfg.port},{"pid",GetCurrentProcessId()},{"instance_id",app.instance_id},{"data_key",data_key(cfg)}});
    app.start_loading();
    if(!cfg.no_browser)open_browser(app.cfg.port);
    app.server.listen_after_bind();
    app.shutdown_requested=true;app.shutdown_condition.notify_all();
    return 0;
}
} // namespace studio

int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int) {
    int argc=0;wchar_t** argv=CommandLineToArgvW(GetCommandLineW(),&argc);
    bool no_browser=false;for(int i=1;i<argc;++i)if(std::wstring(argv[i])==L"--no-browser")no_browser=true;
    int result=0;
    try {result=studio::run(argc,argv);}
    catch(const std::exception& error){
        std::cerr<<"WaveGen Studio: "<<error.what()<<'\n';
        if(!no_browser){const auto message=fs::u8path(error.what()).wstring();MessageBoxW(nullptr,message.c_str(),L"WaveGen Studio",MB_OK|MB_ICONERROR);}
        result=1;
    }
    if(argv)LocalFree(argv);return result;
}

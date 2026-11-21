#define wWinMain unused_studio_entry
#include "../native/studio_main.cpp"
#undef wWinMain
using studio::Json;
static void check(bool value,const char* message){if(!value)throw std::runtime_error(message);}
int main(int argc,char** argv){
    try{
        check(argc==2,"Pass repository root");const fs::path root=fs::absolute(path_from_utf8(argv[1]));
        studio::Config config;config.executable_dir=root;config.data_dir=root/"test-output"/("s-"+studio::random_id(4));
        studio::Store store(config);Json warnings=Json::array();auto initial=store.list_voices(warnings);
        const auto catalog=studio::read_json(root/"presets/catalog.json").at("voices");
        if(initial.size()!=catalog.size()||!warnings.empty())std::cerr<<warnings.dump()<<" voices="<<initial.size()<<'\n';
        check(catalog.size()==5&&initial.size()==catalog.size()&&warnings.empty(),"Fresh installation must import all five release presets");
        for(const auto& preset:catalog)check(store.get_voice(preset.at("id")).at("reference_text")==preset.at("reference_text"),"Preset transcript differs from its catalog entry");
        for(const auto& voice:initial)check(!voice.contains("character_effect")&&!voice.value("builtin",false),"Unexpected legacy/example profile");
        const std::string id=initial[0].at("id");auto saved=store.get_voice(id);const auto audio=studio::read_text(config.data_dir/"voices"/saved.at("audio_file").get<std::string>());
        store.save_voice(id,"My retained voice",saved.at("reference_text"),std::nullopt,std::nullopt,Json::object());
        studio::Store reopened(config);check(reopened.get_voice(id).at("name")=="My retained voice","Restart overwrote user edits");
        reopened.delete_voice(id);bool missing=false;try{reopened.get_voice(id);}catch(const studio::HttpError& e){missing=e.code==404;}check(missing,"Trash did not hide voice");
        studio::Store again(config);Json trash_warnings=Json::array();check(again.list_voices(trash_warnings).size()==initial.size()-1,"Restart resurrected a trashed preset");
        again.restore_voice(id);check(again.get_voice(id).at("name")=="My retained voice","Restore lost edited name");
        check(studio::read_text(config.data_dir/"voices"/saved.at("audio_file").get<std::string>())==audio,"Reference bytes changed");
        bool rejected=false;try{again.save_voice(id,"Bad",saved.at("reference_text"),std::string("not a WAV"),std::nullopt,Json::object());}catch(...){rejected=true;}
        check(rejected&&again.get_voice(id).at("name")=="My retained voice","Invalid audio write did not roll back");
        check(studio::read_json(root/"version.json").at("version")==WAVEGEN_STUDIO_VERSION,"Generated version differs from release");
        std::cout<<"Passed public Store checks: starter presets, transcripts, edit/reopen, trash/restart/restore, immutable reference, invalid-write rollback. No GPU.\n";return 0;
    }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}

#pragma once
#include <wincodec.h>

namespace wavegen_avatar {
constexpr size_t MAX_BYTES=2*1024*1024;
constexpr size_t PRESET_MAX_BYTES=4*1024*1024;
inline void checked(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
template<class T> struct ComPtr {
    T* pointer=nullptr;
    ~ComPtr(){if(pointer)pointer->Release();}
    T* operator->()const{return pointer;}
    T** address(){return &pointer;}
};
// Use the Windows PNG codec, with a bounded output allocation. Dynamic COM
// entry points keep the standalone build's existing link dependencies intact.
inline void validate(const std::string& bytes,size_t max_bytes=MAX_BYTES,UINT max_dimension=1024){
    constexpr unsigned char signature[]={137,80,78,71,13,10,26,10};
    checked(max_bytes<=PRESET_MAX_BYTES&&max_dimension<=2048,"Invalid avatar decoder limits");
    checked(bytes.size()>=33&&bytes.size()<=max_bytes,max_bytes==MAX_BYTES?"Avatar must be a PNG no larger than 2 MB":"Preset avatar must be a PNG no larger than 4 MB");
    checked(std::memcmp(bytes.data(),signature,8)==0,"Avatar must be a valid PNG image");
    const auto big_endian=[&](size_t offset){const auto* p=reinterpret_cast<const unsigned char*>(bytes.data()+offset);return (uint32_t(p[0])<<24)|(uint32_t(p[1])<<16)|(uint32_t(p[2])<<8)|p[3];};
    checked(big_endian(8)==13&&std::memcmp(bytes.data()+12,"IHDR",4)==0,"Avatar PNG has an invalid image header");
    const auto dimension_error=max_dimension==1024?"Avatar dimensions must be between 1 and 1024 pixels":"Preset avatar dimensions must be between 1 and 2048 pixels";
    checked(big_endian(16)>0&&big_endian(20)>0&&big_endian(16)<=max_dimension&&big_endian(20)<=max_dimension,dimension_error);
    // WIC is intentionally tolerant of some damaged PNG streams. Validate the
    // container/chunk CRCs and zlib header first, then require bounded decoding.
    static const auto crc_table=[](){std::array<uint32_t,256> table{};for(uint32_t i=0;i<256;++i){uint32_t value=i;for(int bit=0;bit<8;++bit)value=(value&1)?(value>>1)^0xedb88320U:value>>1;table[i]=value;}return table;}();
    size_t position=8,idat_bytes=0;bool ended=false,idat_seen=false,idat_closed=false;unsigned char zlib_header[2]{};
    while(position<bytes.size()){
        checked(bytes.size()-position>=12,"Avatar PNG has a truncated chunk");const size_t length=big_endian(position);
        checked(length<=bytes.size()-position-12,"Avatar PNG has a truncated chunk");
        const auto* type=bytes.data()+position+4;uint32_t crc=0xffffffffU;
        for(size_t i=0;i<length+4;++i)crc=crc_table[(crc^static_cast<unsigned char>(type[i]))&255]^(crc>>8);
        checked((crc^0xffffffffU)==big_endian(position+8+length),"Avatar PNG has a corrupt chunk checksum");
        const bool idat=std::memcmp(type,"IDAT",4)==0;
        if(idat){checked(!idat_closed,"Avatar PNG has invalid image-data ordering");for(size_t i=0;i<length&&idat_bytes+i<2;++i)zlib_header[idat_bytes+i]=static_cast<unsigned char>(type[4+i]);idat_bytes+=length;idat_seen=true;}
        else if(idat_seen)idat_closed=true;
        if(std::memcmp(type,"IHDR",4)==0)checked(position==8&&length==13,"Avatar PNG has duplicate image headers");
        if(std::memcmp(type,"IEND",4)==0){checked(length==0&&position+12==bytes.size(),"Avatar PNG has an invalid end marker");ended=true;}
        position+=length+12;
    }
    checked(ended&&idat_bytes>=6,"Avatar PNG has no complete image data");
    checked((zlib_header[0]&15)==8&&(zlib_header[0]>>4)<=7&&!(zlib_header[1]&32)&&((unsigned(zlib_header[0])*256+zlib_header[1])%31)==0,"Avatar PNG has invalid compressed image data");
    struct ComRuntime {
        using Initialize=HRESULT(WINAPI*)(LPVOID,DWORD);
        using Uninitialize=void(WINAPI*)();
        using Create=HRESULT(WINAPI*)(REFCLSID,LPUNKNOWN,DWORD,REFIID,LPVOID*);
        HMODULE module=nullptr;Uninitialize uninitialize=nullptr;Create create=nullptr;bool initialized=false;
        ComRuntime(){
            module=LoadLibraryExW(L"ole32.dll",nullptr,LOAD_LIBRARY_SEARCH_SYSTEM32);
            checked(module!=nullptr,"Windows image decoder is unavailable");
            auto initialize=reinterpret_cast<Initialize>(GetProcAddress(module,"CoInitializeEx"));
            uninitialize=reinterpret_cast<Uninitialize>(GetProcAddress(module,"CoUninitialize"));
            create=reinterpret_cast<Create>(GetProcAddress(module,"CoCreateInstance"));
            if(!initialize||!uninitialize||!create){FreeLibrary(module);module=nullptr;checked(false,"Windows image decoder is unavailable");}
            const auto result=initialize(nullptr,COINIT_MULTITHREADED);
            if(FAILED(result)&&result!=RPC_E_CHANGED_MODE){FreeLibrary(module);module=nullptr;checked(false,"Cannot initialize Windows image decoder");}
            initialized=SUCCEEDED(result);
        }
        ~ComRuntime(){if(initialized)uninitialize();if(module)FreeLibrary(module);}
    } runtime;
    const GUID factory_class={0xcacaf262,0x9370,0x4615,{0xa1,0x3b,0x9f,0x55,0x39,0xda,0x4c,0x0a}};
    const GUID factory_interface={0xec5ec8a9,0xc395,0x4314,{0x9c,0x77,0x54,0xd7,0xa9,0x35,0xff,0x70}};
    const GUID png_container={0x1b7cfaf4,0x713f,0x473c,{0xbb,0xcd,0x61,0x37,0x42,0x5f,0xae,0xaf}};
    const GUID rgba={0xf5c7ad2d,0x6a8d,0x43dd,{0xa7,0xa8,0xa2,0x99,0x35,0x26,0x1a,0xe9}};
    ComPtr<IWICImagingFactory> factory;
    checked(SUCCEEDED(runtime.create(factory_class,nullptr,CLSCTX_INPROC_SERVER,factory_interface,reinterpret_cast<void**>(factory.address()))),"Cannot create Windows image decoder");
    ComPtr<IWICStream> stream;
    checked(SUCCEEDED(factory->CreateStream(stream.address())),"Cannot open avatar image");
    checked(SUCCEEDED(stream->InitializeFromMemory(reinterpret_cast<BYTE*>(const_cast<char*>(bytes.data())),DWORD(bytes.size()))),"Cannot read avatar image");
    ComPtr<IWICBitmapDecoder> decoder;
    checked(SUCCEEDED(factory->CreateDecoderFromStream(stream.pointer,nullptr,WICDecodeMetadataCacheOnDemand,decoder.address())),"Avatar PNG is corrupt or unsupported");
    GUID container{};UINT frames=0;
    checked(SUCCEEDED(decoder->GetContainerFormat(&container))&&std::memcmp(&container,&png_container,sizeof(GUID))==0,"Avatar must be a PNG image");
    checked(SUCCEEDED(decoder->GetFrameCount(&frames))&&frames==1,"Avatar must contain one PNG image");
    ComPtr<IWICBitmapFrameDecode> frame;UINT width=0,height=0;
    checked(SUCCEEDED(decoder->GetFrame(0,frame.address()))&&SUCCEEDED(frame->GetSize(&width,&height)),"Cannot decode avatar dimensions");
    checked(width>0&&height>0&&width<=max_dimension&&height<=max_dimension,dimension_error);
    ComPtr<IWICFormatConverter> converter;
    checked(SUCCEEDED(factory->CreateFormatConverter(converter.address()))&&SUCCEEDED(converter->Initialize(frame.pointer,rgba,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom)),"Cannot decode avatar pixels");
    const UINT stride=width*4,size=stride*height;std::vector<BYTE> pixels(size);
    checked(SUCCEEDED(converter->CopyPixels(nullptr,stride,size,pixels.data())),"Avatar PNG contains corrupt pixel data");
}
} // namespace wavegen_avatar

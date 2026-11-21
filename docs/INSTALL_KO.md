# Windows 설치

[English](INSTALL.md) · [README](../README_KO.md) · [업데이트](UPDATING_KO.md)

Windows x64와 NVIDIA GPU·호환 드라이버가 필요합니다. 0.2는 RTX 5090(32GB), 0.1은 RTX 5080(16GB)에서 검증했습니다. 최소 VRAM은 아직 확인되지 않았습니다. **실행에 Python·Node.js·Visual Studio·CUDA Toolkit은 필요하지 않습니다.** 모델·런타임과 다운로드 캐시·백업을 위한 여유 공간을 준비하세요.

[Microsoft Visual C++ x64 Redistributable](https://aka.ms/vc14/vc_redist.x64.exe)이 없다면 Microsoft에서 설치하세요. [공식 안내](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist)를 참고하세요. WaveGen 모델의 **CC BY-NC 4.0 비상업 조건**은 [라이선스 안내](LICENSING.md)에 정리했습니다.

## 처음 설치

1. **[Windows 앱 ZIP](https://github.com/sh-lee-prml/WaveGen-Studio/releases/download/v0.2.0-beta.1/WaveGen-Studio-0.2.0-beta.1-app-windows-x64.zip)**을 받아 `C:\Apps\WaveGen Studio`처럼 쓰기 가능한 폴더에 압축을 풉니다. [Releases](https://github.com/sh-lee-prml/WaveGen-Studio/releases)의 Source code 압축 파일은 개발자용이며 일반 사용에는 필요하지 않습니다.
2. Microsoft 런타임이 없다면 위 공식 링크로 설치하고 NVIDIA 드라이버를 확인합니다.
3. **Install-WaveGen-Studio.cmd**를 더블클릭합니다. 같은 폴더에 베타를 포함한 최신 공개 배포의 런타임·Flash·V-Spec·RE-USE를 받아 SHA-256을 확인합니다. 설치 후 자동 실행하지 않습니다.
4. **Launch-WaveGen-Studio.cmd**를 더블클릭하고 기본 목소리와 짧은 영어 문장으로 시험합니다.

전체 다운로드는 약 **3.9GB**이며 최초 다운로드·압축 해제·설치 작업을 위해 **15GB 여유 공간**을 권장합니다. 추후 백업과 녹음은 추가 공간을 사용합니다. 작은 앱 ZIP은 설치 시작 파일입니다.

**다운로드 출처:** 앱과 런타임은 GitHub Releases에서 받습니다. Flash·V-Spec·RE-USE 네이티브 모델 팩은 원래 [LeeSangHoon/WaveGen Hugging Face 저장소](https://huggingface.co/LeeSangHoon/WaveGen)에서 받습니다. 배포 매니페스트는 변경되지 않는 Hugging Face 리비전과 `config.json`의 해시를 고정합니다. 모델 다운로드가 필요할 때 이 설정을 받아 검증하고, 실제 팩 경로와 체크섬을 읽어 설치합니다. 이미 검증한 모델·캐시는 재사용하며 앱 실행 때마다 모델을 받지 않습니다.

설치 경로는 짧게 정하세요. Windows 파일 이름에 여유를 두기 위해 설치 폴더의 전체 경로를 **128자**로 제한합니다. `C:\Apps\WaveGen Studio` 같은 경로를 사용할 수 있습니다.

다운로드한 스크립트가 PowerShell 정책으로 차단되면 내용을 확인하고 조직의 승인된 실행 방법을 사용하세요. 앱 실행을 위해 컴퓨터 전체의 실행 정책을 바꿀 필요는 없습니다. EXE만 따로 옮기지 말고 모델·DLL·폴더를 함께 보관하세요.

## 설치 옵션

압축을 푼 앱 폴더에서 PowerShell을 열어 Flash만 설치할 수 있습니다.

```powershell
.\Install-WaveGen-Studio.cmd -Models flash
```

설치 경로를 직접 지정하려면 다음을 사용합니다.

```powershell
& .\scripts\install.ps1 -InstallDirectory 'C:\Apps\WaveGen Studio' -Models flash
```

CMD는 같은 폴더에 설치합니다. `scripts/install.ps1`을 직접 호출하면서 경로를 생략하면 `%LOCALAPPDATA%\WaveGen Studio`를 사용합니다. `-Models`는 `flash`, `vspec`, `reuse`를 받으며 기본값은 모두입니다. 제외한 모델 기능은 사용할 파일이 없으므로 나중에 같은 설치 위치에 추가하세요. TTS 모델 하나는 압축 해제 후 약 1.4GB이며 정확한 다운로드 크기는 배포 매니페스트를 확인하세요.

Microsoft 공식 서명 설치 프로그램 실행을 명시적으로 허용하려면 `-InstallVcRuntime`을 추가합니다. Microsoft 설치 과정에서 시스템 권한을 요청할 수 있습니다. Studio가 GPU 드라이버를 설치하거나 다른 앱의 Microsoft DLL을 복사하지는 않습니다.

특정 배포를 고정하려면 `-ReleaseTag 'v0.2.0-beta.1'`처럼 배포 페이지의 정확한 태그를 지정하세요. `manifest.json`과 SHA-256은 파일 무결성을 확인하며 디지털 서명은 아닙니다. 공식 저장소·배포에서 파일을 받으세요. 고급 설치의 `-ManifestPath`와 `-CacheDirectory`는 해당 목록의 파일을 미리 받은 경우 사용할 수 있습니다.

DLL 누락은 Microsoft 런타임과 같은 버전의 앱 런타임 팩을, 모델 누락은 같은 설치 위치의 모델 팩을 확인하세요. 해시 검사가 실패하면 건너뛰지 말고 공식 배포로 다시 시도하세요. GPU 메모리가 부족하면 앱을 종료하고 다른 GPU 앱을 닫은 뒤 짧은 문장으로 확인하세요. 자세한 문제 해결은 [영어 설치 안내](INSTALL.md#if-it-does-not-start)에 있습니다.

원본 모델·논문·학습·연구 구현은 [WaveGen](https://github.com/sh-lee-prml/WaveGen)을 참고하세요.

# WaveGen Studio · 0.1 (beta)

[English](README.md) · [설치](docs/INSTALL_KO.md) · [사용법](docs/USER_GUIDE_KO.md) · [개발·빌드](docs/BUILDING.md) · [목소리 기여](docs/VOICE_CONTRIBUTIONS_KO.md)

**구독료와 유료 API가 없는 무료 로컬 음성 스튜디오입니다.**

**비상업용으로 무료 사용할 수 있습니다.** WaveGen 모델은 CC BY-NC 4.0이며, Studio의 독자적인 코드는 별도 MIT 라이선스입니다.

[WaveGen](https://github.com/sh-lee-prml/WaveGen)으로 영어 음성을 만들고 편집하는 Windows 로컬 앱입니다. 목소리를 고르고 문장을 입력하면 작성 영역 옆에서 결과를 바로 들어볼 수 있습니다. 네이티브 C++ EXE와 브라우저 화면으로 실행하며, **사용할 때 Python을 설치할 필요가 없습니다.**

첫 공개 베타 버전은 `0.1.0-beta.1`입니다. 현재 검증 환경은 **Windows x64, NVIDIA RTX 5080 16GB**입니다. 다른 GPU의 동작은 아직 검증하지 않았습니다. WaveGen 모델은 **CC BY-NC 4.0 비상업용 조건**이며, Studio 코드의 라이선스와 별개입니다.

## 시작하기

**[Windows 베타 다운로드](https://github.com/sh-lee-prml/WaveGen-Studio/releases/download/v0.1.0-beta.1/WaveGen-Studio-0.1.0-beta.1-app-windows-x64.zip)** · [설치 안내](docs/INSTALL_KO.md)

일반 사용자는 앱 ZIP을 받으면 됩니다. GitHub의 Source code ZIP은 개발자용입니다.

1. 쓰기 가능한 폴더에 압축을 풀고 **Install-WaveGen-Studio.cmd**를 실행해 검증된 런타임·모델을 받습니다. NVIDIA 드라이버와 Microsoft 런타임은 [설치 안내](docs/INSTALL_KO.md)를 참고하세요.
2. **Launch-WaveGen-Studio.cmd**를 실행합니다. DLL과 나머지 폴더도 함께 보관하세요.
3. **Mira, Rowan, Kai** 중 하나를 고르고 짧은 영어 문장을 입력한 뒤 **음성 만들기**를 누릅니다. 넓은 화면에서는 작성 영역 오른쪽, 작은 화면에서는 생성 버튼 바로 아래에 결과가 표시됩니다.
4. **내 목소리 추가**로 참조 녹음과 정확한 대사를 저장할 수 있습니다.

앱과 런타임은 GitHub Releases에서, Flash·V-Spec·RE-USE 네이티브 모델 팩은 원래 [LeeSangHoon/WaveGen Hugging Face 저장소](https://huggingface.co/LeeSangHoon/WaveGen)에서 받습니다. 변경되지 않는 리비전에 고정하고 체크섬을 확인하며, 업데이트할 때 이미 검증한 모델은 재사용합니다.

첫 요청은 모델을 불러오는 시간이 필요할 수 있습니다. 불러온 모델은 다음 요청을 위해 메모리에 유지됩니다. 브라우저 탭을 닫아도 앱은 실행 중이며, **앱 종료**를 눌러야 메모리가 해제됩니다.

## 주요 기능

| 영역 | 기능 |
| --- | --- |
| 음성 생성 | WaveGen-Flash 4단계 / V-Spec 50단계, 긴 글 자동 분할, 고정·랜덤 시드, 속도, 목표 길이 |
| 목소리 보관 | 이름·참조 음성·이미지 프로필, 원본 보존, 편집 이력, 휴지통과 복원 |
| 참조 음성 준비 | WAV/MP3 가져오기, 파형 구간 선택, 미리듣기, 되돌리기, 앞뒤 무음 제거, 선택적 피크 볼륨 조정 |
| 음성 향상 | NVIDIA RE-USE를 이용한 참조 음성의 Prompt Enhancement와 생성 음성의 Speech Enhancement, 전후 비교 |
| 생성 음성 편집 | 구간 남기기·삭제·재생성, 원본을 보존하는 새 결과 저장 |
| 작업 이어가기 | 기록 검색, 문장·설정 불러오기, 초안 자동 보관, 중지, 연결 중단 후 작업 확인 |
| 화면 언어 | English 기본값, 한국어·简体中文·日本語 지원 |

허가된 CMU ARCTIC 참조 프로필 3종을 제공합니다. 공개 패키지에는 개인 녹음이나 생성 기록을 포함하지 않습니다. 효과를 입힌 캐릭터 후보 갤러리는 제공하지 않습니다.

## 좋은 참조 목소리 등록하기

한 사람이 또렷하게 말하는 완전한 **영어 문장 3–10초**를 권장합니다. 원본은 최대 120초까지 가져와 사용할 부분을 고를 수 있지만, 저장할 참조 음성은 **30초 미만**이어야 합니다. 남긴 구간에서 실제로 말한 내용을 **Reference Text**에 그대로 적으세요. 직접 녹음했거나 사용 권한이 있는 자료를 사용하세요.

편집기는 무음과 피크 볼륨을 조절합니다. 대사 일치를 자동 판정하거나 모든 잡음·녹음 문제를 해결하지는 않으며, 목소리 유사도도 보장하지 않습니다. 저장 전에 들어보세요. [참조 음성 사용법 →](docs/USER_GUIDE_KO.md#참조-음성)

## 현재 제한

- 음성 생성 문장과 Reference Text는 **영어**를 지원합니다. 화면 언어를 바꿔도 음성 지원 언어는 바뀌지 않습니다.
- 현재 **Windows NVIDIA CUDA** 환경을 대상으로 합니다. CPU 전용·AMD·Intel GPU·macOS·Linux 앱은 지원하지 않습니다.
- 검증한 GPU는 16GB입니다. 불러온 모델과 문장 길이, 향상 기능에 따라 메모리 사용량이 달라지며 더 낮은 최소 사양은 확정하지 않았습니다.
- 네이티브 ONNX 계산은 검증했지만 원본 PyTorch와 비트 단위로 같지는 않습니다. BF16 TTS와 일부 FP32 연산을 사용합니다. 같은 시드는 같은 환경의 재현에 도움이 되지만 버전·장치 간 동일한 오디오를 보장하지 않습니다.
- 긴 글은 나누어 생성합니다. 발음·속도·목소리 유사도와 구간 연결이 달라질 수 있습니다. 목표 길이는 쉼과 발음에 영향을 줄 수 있습니다.
- 음성 향상은 선택 사항이며 숨소리나 음색도 바꿀 수 있습니다. 원본과 비교하세요.
- 로컬 데스크톱 앱이며 여러 사용자를 위한 인터넷 서비스가 아닙니다. 최초 다운로드에는 인터넷이 필요하고, 일반 합성은 로컬 파일로 실행합니다.

## 함께 개선해주세요

버그 제보, 작은 개선, 번역, **목소리 기여**를 환영합니다. 오디오 샘플과 정확한 Reference Text, 출처·라이선스, 녹음자의 사용 허락 근거를 [목소리 제안 양식](https://github.com/sh-lee-prml/WaveGen-Studio/issues/new?template=voice_submission.yml)으로 보내주세요. 제출한 자료는 **검토 후** 라이브러리에 반영할 수 있으며 자동으로 배포되는 것은 아닙니다. 공개 공유할 권한이 없는 녹음은 올리지 마세요. [기여 안내 →](docs/VOICE_CONTRIBUTIONS_KO.md)

코드와 버그 제보는 [CONTRIBUTING.md](CONTRIBUTING.md), 기존 설치 업데이트는 [업데이트·백업 안내](docs/UPDATING_KO.md)를 참고하세요.

## 감사와 라이선스

**Sang-Hoon Lee, Ha-Yeong Choi**와 [WaveGen 프로젝트](https://github.com/sh-lee-prml/WaveGen), [NVIDIA RE-USE](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-RE-USE), Mamba, ONNX Runtime, CMU ARCTIC 및 이 앱을 가능하게 한 오픈소스 프로젝트에 감사드립니다.

Studio의 독자적인 코드는 [MIT 라이선스](LICENSE)입니다. WaveGen 체크포인트는 **CC BY-NC 4.0**이며, RE-USE·외부 라이브러리·런타임·참조 녹음에는 각각의 조건이 적용됩니다. [라이선스 구분과 고지](docs/LICENSING.md)를 확인하세요. 저장소의 MIT 라이선스가 WaveGen 모델의 상업 이용을 허용하는 것은 아닙니다.

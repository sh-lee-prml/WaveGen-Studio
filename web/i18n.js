"use strict";

(() => {
  // Canonical keys are shared with i18n-ja.js and i18n-zh.js. Values: [English, Korean].
  const messages = {
    "app.home": ["WaveGen Studio home", "WaveGen Studio 홈"],
    "app.language": ["Display language", "표시 언어"],
    "app.languageHint": ["Changes the interface only. Speech language stays unchanged.", "화면 표시만 바뀌며 음성 생성 언어는 그대로예요."],
    "app.local": ["LOCAL", "LOCAL"],
    "app.introEyebrow": ["YOUR WORDS, YOUR VOICE", "나의 문장, 나의 목소리"],
    "app.introTitle": ["Words into voice.", "문장을, 목소리로."],
    "app.introDescription": ["Choose a voice and write the story you want to tell.", "목소리를 고르고 들려주고 싶은 이야기를 적어 보세요."],
    "common.close": ["Close", "닫기"],
    "common.cancel": ["Cancel", "취소"],
    "common.retry": ["Try again", "다시 불러오기"],
    "common.checkAgain": ["Check again", "다시 확인"],
    "common.refresh": ["Refresh", "새로고침"],
    "common.undo": ["Undo", "되돌리기"],
    "common.restore": ["Restore", "복원"],
    "common.restoring": ["Restoring…", "복원 중…"],
    "common.settings": ["Settings", "설정"],
    "common.voice": ["Voice", "목소리"],
    "common.savedVoice": ["Saved voice", "저장된 목소리"],
    "common.audio": ["Audio", "음성"],
    "common.referenceAudio": ["Reference audio", "참조 오디오"],
    "common.durationSeconds": ["{seconds}s", "{seconds}초"],
    "common.today": ["Today {time}", "오늘 {time}"],
    "library.eyebrow": ["VOICE LIBRARY", "목소리 보관함"],
    "library.title": ["My voices", "내 목소리"],
    "library.search": ["Find a voice", "목소리 찾기"],
    "library.searchAria": ["Search saved voices", "저장된 목소리 검색"],
    "library.groupAria": ["Voice library", "목소리 보관함"],
    "library.listAria": ["Saved voices", "저장된 목소리"],
    "library.add": ["Save a new voice", "새 목소리 저장"],
    "library.trash": ["Trash", "휴지통"],
    "library.trashLoading": ["Loading trash…", "휴지통을 불러오는 중…"],
    "library.trashError": ["Couldn't load trash.", "휴지통을 불러오지 못했어요."],
    "library.noMatch": ["No matching voices", "찾는 목소리가 없어요"],
    "library.trashEmpty": ["Trash is empty", "휴지통이 비어 있어요"],
    "library.trashHint": ["You can restore deleted voices here.", "삭제한 목소리를 여기서 복원할 수 있어요."],
    "library.loadError": ["Couldn't load your voices", "목소리를 불러오지 못했어요"],
    "library.empty": ["Save your own voice", "나만의 목소리를 저장해 보세요"],
    "library.reconnectHint": ["We'll reload them when the connection returns.", "연결되면 다시 불러올게요."],
    "library.searchHint": ["Try a different name.", "다른 이름으로 검색해 보세요."],
    "library.emptyHint": ["A short recording is all you need to start.", "짧은 오디오 하나면 시작할 수 있어요."],
    "library.example": ["Example voice", "기본 예제 목소리"],
    "library.savedDuration": ["{duration} · Saved voice", "{duration} · 저장된 목소리"],
    "library.storageLead": ["Your voices and generated audio", "목소리와 생성한 음성은"],
    "library.storageTail": ["stay on this computer.", "이 컴퓨터에 저장돼요."],
    "library.missingSelection": ["The selected voice is no longer available. Please choose another voice.", "선택했던 목소리를 찾을 수 없어요. 사용할 목소리를 다시 골라 주세요."],
    "library.restored": ["Voice restored.", "목소리를 복원했어요."],
    "library.trashed": ["Voice moved to trash. Generated audio is unchanged.", "목소리를 휴지통으로 옮겼어요. 생성한 음성은 그대로예요."],
    "composer.title": ["Create new audio", "새 음성 만들기"],
    "composer.languageBadge": ["ENGLISH", "ENGLISH"],
    "composer.selectedVoice": ["Selected voice", "선택한 목소리"],
    "composer.chooseVoice": ["Choose a voice", "목소리를 선택해 주세요"],
    "composer.chooseFromLibrary": ["Choose a voice from the library", "왼쪽에서 목소리를 선택해 주세요"],
    "composer.inputAria": ["English text to generate", "생성할 영어 문장"],
    "composer.placeholder": ["Hello there. Let’s make something worth listening to.", "Hello there. Let’s make something worth listening to."],
    "composer.englishHint": ["Speech generation currently supports English.", "현재 영어 문장 생성을 지원해요."],
    "composer.advanced": ["More settings", "세부 설정"],
    "composer.speed": ["Speed", "속도"],
    "composer.slower": ["Slower", "느리게"],
    "composer.faster": ["Faster", "빠르게"],
    "composer.seed": ["Seed", "시드"],
    "composer.seedHint": ["Reuse a seed to repeat the same settings.", "같은 설정으로 다시 만들 때 사용해요."],
    "composer.split": ["Automatically split long text", "긴 글 자동 나누기"],
    "composer.splitHint": ["Generate in sections, then join them into one audio file.", "문장별로 만들고 하나의 음성으로 이어 드려요."],
    "composer.longHint": ["Long stories are split into manageable sections.", "긴 이야기도 자연스럽게 나누어 만들 수 있어요."],
    "composer.splitLimit": ["Each section, including the reference audio, stays within 30 seconds.", "각 구간은 참조 음성과 합쳐 30초 이내로 나누어요."],
    "composer.singleLimit": ["The reference and new audio together must fit within 30 seconds.", "참조 음성과 새 음성을 합쳐 30초 이내인 문장을 만들 수 있어요."],
    "composer.byteHint": ["UTF-8 input limit: a regular English character uses 1 unit; a curly quote uses 3.", "UTF-8 입력 용량이에요. 일반 영문은 1칸, 곡선 따옴표는 3칸을 사용해요."],
    "composer.speedChip": ["Speed {speed}×", "속도 {speed}×"],
    "composer.seedChip": ["Seed {seed}", "시드 {seed}"],
    "composer.splitOff": ["Auto split off", "자동 나누기 끔"],
    "plan.empty": ["Enter text to see its expected duration.", "문장을 입력하면 예상 길이를 알려 드려요."],
    "plan.chooseVoice": ["Choose a voice to check the expected duration.", "목소리를 선택하면 읽을 길이를 확인할 수 있어요."],
    "plan.invalid": ["Please check the text first.", "입력한 문장을 먼저 확인해 주세요."],
    "plan.loading": ["Checking expected duration…", "예상 길이를 확인하는 중…"],
    "plan.summaryOne": ["Expected audio {duration} · {count} section", "예상 음성 {duration} · {count}개 구간"],
    "plan.summaryMany": ["Expected audio {duration} · {count} sections joined into one file", "예상 음성 {duration} · {count}개 구간을 하나의 파일로 저장"],
    "plan.preview": ["Preview the sections", "나누어 읽을 문장 보기"],
    "generate.action": ["Generate audio", "음성 만들기"],
    "generate.working": ["Generating audio", "음성 만드는 중"],
    "generate.progressButton": ["Generating {done}/{total}", "만드는 중 {done}/{total}"],
    "generate.stopped": ["The app is closed", "앱이 종료되었어요"],
    "generate.loading": ["Preparing model", "모델 준비 중"],
    "generate.connection": ["Check the connection", "연결 상태를 확인해 주세요"],
    "generate.planning": ["Checking duration", "길이 확인 중"],
    "generate.workingTitle": ["Giving your story a voice", "이야기에 목소리를 입히고 있어요"],
    "generate.workingHint": ["Reading your text in the selected voice. Please wait a moment.", "선택한 목소리로 문장을 읽고 있어요. 잠시만 기다려 주세요."],
    "generate.progress": ["{done} of {total} sections complete · Please wait.", "{total}개 구간 중 {done}개 완료 · 잠시만 기다려 주세요."],
    "generate.complete": ["Your audio is ready.", "새 음성이 완성됐어요."],
    "generate.completeWarning": ["Your audio is ready. Check the save notice below the result.", "음성은 완성됐어요. 결과 아래 저장 안내를 확인해 주세요."],
    "generate.recovered": ["Connection restored. We found your completed audio.", "연결을 확인하고 완료된 음성을 찾았어요."],
    "generate.recovering": ["Reconnecting. Your input is safe; we'll look for the completed result automatically.", "연결을 다시 확인하고 있어요. 입력은 보관되며 완료된 결과를 자동으로 찾아드려요."],
    "generate.otherBusy": ["Another audio request is running. Try again when it finishes.", "다른 음성을 만들고 있어요. 완료된 뒤 다시 눌러 주세요."],
    "cancel.action": ["Stop generation", "생성 중단"],
    "cancel.requested": ["Stop requested", "중단 요청됨"],
    "cancel.waitHint": ["Stopping after the current section. Incomplete audio won't be saved.", "현재 구간을 마치면 중단해요. 완료되지 않은 결과는 저장하지 않아요."],
    "cancel.recoverHint": ["Checking the connection. You don't need to submit the same request again.", "연결을 다시 확인하고 있어요. 같은 요청을 다시 보내지 않아도 돼요."],
    "cancel.hint": ["Stopping finishes the current section, then ends the request.", "중단하면 현재 구간까지만 처리하고 종료해요."],
    "cancel.initialHint": ["Creating the audio one section at a time.", "완성된 구간부터 차례로 만들고 있어요."],
    "cancel.toast": ["Stop requested. Finishing the current section first.", "중단을 요청했어요. 현재 구간을 마무리하고 멈춰요."],
    "cancel.finished": ["Generation has finished or is saving. Your result will appear shortly.", "이미 생성이 끝났거나 마무리 중이에요. 잠시 후 결과를 확인해 주세요."],
    "cancel.done": ["Generation stopped. Your text is unchanged.", "생성을 중단했어요. 입력한 문장은 그대로예요."],
    "status.ready": ["Ready", "준비 완료"],
    "status.loading": ["Preparing model", "모델 준비 중"],
    "status.generating": ["Generating audio", "음성 만드는 중"],
    "status.error": ["Check connection", "연결 확인 필요"],
    "status.stopped": ["App closed", "앱 종료됨"],
    "connection.action": ["Reconnect", "다시 연결"],
    "connection.notice": ["Reconnecting to the app. Your draft is safe.", "앱에 다시 연결하는 중이에요. 입력한 내용은 보관되어 있어요."],
    "connection.modelFailure": ["Couldn't prepare the model. Please reopen the app.", "모델을 준비하지 못했어요. 앱을 다시 열어 주세요."],
    "connection.historyRecovery": ["Checking the previous request's history. We'll show completed audio when reconnected.", "이전 작업의 기록을 다시 확인하고 있어요. 연결되면 완료된 결과를 보여드릴게요."],
    "connection.foundResult": ["We found your completed audio in history.", "완료된 음성을 생성 기록에서 찾았어요."],
    "connection.previousChecked": ["Previous request checked. Completed audio appears in history.", "이전 작업 상태를 확인했어요. 완료된 결과는 생성 기록에 표시돼요."],
    "warnings.title": ["Please check your saved data", "저장된 자료를 확인해 주세요"],
    "warnings.details": ["Details: {details}", "상세 내용: {details}"],
    "result.title": ["Generated audio", "생성한 음성"],
    "result.emptyTitle": ["Your first story starts here", "첫 이야기를 기다리고 있어요"],
    "result.emptyHint": ["Listen to your audio and save it here after generation.", "음성을 만들면 여기서 바로 듣고 저장할 수 있어요."],
    "result.playAria": ["Play generated audio", "생성한 음성 재생"],
    "result.downloadAria": ["Download generated audio", "생성한 음성 다운로드"],
    "result.downloadTitle": ["Download WAV", "WAV 다운로드"],
    "result.joined": ["{count} sections joined", "{count}개 구간을 이어 붙였어요"],
    "result.generatedIn": ["Created in {seconds}s", "{seconds}초 만에 완성"],
    "result.reuse": ["Load text and settings", "문장·설정 불러오기"],
    "result.reuseHint": ["Load into the editor, then change what you need.", "편집기에 불러온 뒤 원하는 부분만 바꿔 보세요."],
    "result.saveWarning": ["Audio is ready, but check its history save status. {details} You can download the WAV now.", "음성은 완성되었지만 기록 저장을 확인해 주세요. {details} WAV는 지금 다운로드할 수 있어요."],
    "result.reused": ["Text and settings loaded. Generation has not started.", "문장과 설정을 불러왔어요. 생성은 아직 시작하지 않았어요."],
    "result.reusedMissingVoice": ["Text and settings loaded. The previous voice is unavailable; please choose a voice.", "문장과 설정을 불러왔어요. 이전 목소리가 없으니 새 목소리를 선택해 주세요."],
    "result.undoDraft": ["Your previous draft is restored.", "원래 초안으로 되돌렸어요."],
    "history.loading": ["Loading history", "기록 불러오는 중"],
    "history.countOne": ["{count} recording", "{count}개의 이야기"],
    "history.countMany": ["{count} recordings", "{count}개의 이야기"],
    "history.connection": ["Check history connection", "기록 연결 확인 필요"],
    "history.empty": ["No audio generated yet", "아직 만든 음성이 없어요"],
    "history.search": ["Find text or a voice in history", "문장 또는 목소리로 기록 찾기"],
    "history.searchAria": ["Search generated audio", "생성 기록 검색"],
    "history.listAria": ["Generation history", "생성 기록"],
    "history.playAria": ["Play audio by {voice}: {text}", "{voice}의 생성 음성 재생: {text}"],
    "history.noMatch": ["No matches. Try different text or a voice name.", "검색 결과가 없어요. 다른 문장이나 목소리 이름으로 찾아보세요."],
    "history.more": ["Show older recordings", "이전 기록 더 보기"],
    "history.moreCount": ["Show older recordings ({count})", "이전 기록 더 보기 ({count})"],
    "history.loadError": ["Couldn't load history. Existing audio is safe. Select Refresh to try again.", "기록을 불러오지 못했어요. 기존 결과는 보관되어 있어요. 새로고침을 눌러 다시 확인해 주세요."],
    "voice.eyebrow": ["VOICE PROFILE", "목소리 프로필"],
    "voice.settings": ["Voice settings", "목소리 설정"],
    "voice.description": ["Save a short voice sample together with the words spoken in it.", "짧은 목소리 샘플과 그 안에 담긴 문장을 함께 저장하세요."],
    "voice.name": ["Voice name", "목소리 이름"],
    "voice.namePlaceholder": ["For example: Calm narrator", "예: 차분한 내레이션"],
    "voice.upload": ["Drop an audio file here or click to choose", "오디오 파일을 놓거나 눌러서 선택"],
    "voice.replaceAudio": ["Choose a file to replace this audio", "다른 오디오로 바꾸려면 선택"],
    "voice.uploadHint": ["WAV · MP3 · Up to 50 MB", "WAV · MP3 · 최대 50 MB"],
    "voice.trim": ["Trim silence at the start and end", "앞뒤 무음 제거"],
    "voice.trimHint": ["Pauses within the recording stay unchanged.", "말 사이의 쉼은 그대로 유지해요."],
    "voice.previewAria": ["Preview reference audio", "참조 오디오 미리듣기"],
    "voice.sampleHint": ["3–10 seconds recommended · Under 30 seconds after trimming · Source up to 2 minutes", "3–10초 샘플 권장 · 무음 정리 후 30초 미만 · 원본은 2분까지"],
    "voice.transcript": ["Words spoken in the recording", "녹음에서 말한 문장"],
    "voice.transcriptPlaceholder": ["Enter the English words exactly as spoken in the audio.", "오디오에 들리는 영어 문장을 그대로 적어 주세요."],
    "voice.transcriptGuidance": ["This is the recording's actual transcript, not the text you want to generate. Listen for any missing words.", "새로 만들 문장이 아닌, 이 녹음의 실제 대사예요. 미리듣기로 빠진 단어가 없는지 확인해 주세요."],
    "voice.transcriptReminder": ["You replaced the audio. Check that the transcript matches the new recording.", "오디오를 바꿨어요. 녹음 대사도 새 오디오와 일치하는지 확인해 주세요."],
    "voice.discardQuestion": ["You have unsaved changes.", "아직 저장하지 않은 변경사항이 있어요."],
    "voice.keepEditing": ["Keep editing", "계속 편집"],
    "voice.discard": ["Close without saving", "저장하지 않고 닫기"],
    "voice.trashQuestion": ["Move this voice to trash?", "이 목소리를 휴지통으로 옮길까요?"],
    "voice.trashHint": ["You can restore it from trash later.", "나중에 휴지통에서 복원할 수 있어요."],
    "voice.trashAction": ["Move to trash", "휴지통으로 이동"],
    "voice.save": ["Save voice", "목소리 저장"],
    "voice.saveChanges": ["Save changes", "변경사항 저장"],
    "voice.saving": ["Saving…", "저장하는 중…"],
    "voice.processing": ["Processing audio…", "오디오 정리 중…"],
    "voice.reading": ["Reading and preparing audio…", "오디오를 읽고 정리하는 중…"],
    "voice.chooseOtherFile": ["Please choose another audio file", "다른 오디오 파일을 선택해 주세요"],
    "voice.referenceLabel": ["{name} · Reference audio", "{name} · 참조 오디오"],
    "voice.savedReference": ["Saved reference audio", "저장된 참조 오디오"],
    "voice.originalSaved": ["The original is saved too. Toggle silence trimming to preview the difference.", "원본도 함께 저장되어 있어요. 무음 옵션을 바꿔 다시 들어보세요."],
    "voice.existingAudio": ["This is saved audio. Changing the file or trimming option applies it again.", "저장된 오디오예요. 파일을 바꾸거나 무음 옵션을 바꾸면 다시 적용해요."],
    "voice.trimSummary": ["Trimmed {start}s at start · {end}s at end · Final {duration}s", "앞 {start}초 · 뒤 {end}초 정리 · 최종 {duration}초"],
    "voice.trimOffSummary": ["Trimming off · Original duration {duration}s", "무음 제거 끔 · 원본 길이 {duration}초"],
    "voice.saved": ["Voice saved.", "새 목소리를 저장했어요."],
    "voice.updated": ["Voice settings saved.", "목소리 설정을 저장했어요."],
    "shutdown.action": ["Quit app", "앱 종료"],
    "shutdown.footer": ["The app keeps running when you close this window.", "창을 닫아도 앱은 계속 실행돼요."],
    "shutdown.title": ["Quit Studio?", "Studio를 종료할까요?"],
    "shutdown.description": ["Close the app and free its memory.\nYour saved voices and history will remain.", "앱을 종료하고 사용 중인 메모리를 정리해요.\n저장한 목소리와 생성 기록은 그대로 남아요."],
    "shutdown.busy": ["Audio is being generated.\nPlease wait for it to finish before quitting.", "지금 음성을 만들고 있어요.\n완료된 뒤 앱을 종료해 주세요."],
    "shutdown.keepUsing": ["Keep using Studio", "계속 사용하기"],
    "shutdown.closing": ["Closing…", "종료하는 중…"],
    "shutdown.closed": ["The app is closed. You can close this window.", "앱을 종료했어요. 이 창을 닫아도 괜찮아요."],
    "shutdown.toast": ["Studio is closed. See you next time.", "앱이 종료됐어요. 다음에 또 만나요."],
    "error.slowConnection": ["The connection is taking a little longer. Try again shortly.", "연결이 잠시 지연되고 있어요. 잠시 후 다시 시도해 주세요."],
    "error.network": ["Can't connect to the app. Check that WaveGen Studio is running.", "앱에 연결할 수 없어요. WaveGen Studio가 실행 중인지 확인해 주세요."],
    "error.generic": ["Couldn't complete the request. Please try again.", "요청을 처리하지 못했어요. 다시 시도해 주세요."],
    "error.http": ["Couldn't complete the request. ({status})", "요청을 처리하지 못했어요. ({status})"],
    "error.details": ["Couldn't complete the request. Details: {details}", "요청을 처리하지 못했어요. 상세 내용: {details}"],
    "error.auth": ["Couldn't reconnect to the app.", "앱 연결을 다시 확인하지 못했어요."],
    "error.textLong": ["The text exceeds the input limit. Please shorten it.", "문장이 입력 한도를 넘었어요. 내용을 조금 줄여 주세요."],
    "error.transcriptLong": ["The transcript is too long. Use a shorter reference recording and its transcript.", "녹음 대사가 너무 길어요. 짧은 참조 오디오와 그 대사를 사용해 주세요."],
    "error.english": ["Use English and standard punctuation. Check for long dashes, ellipses, or special spaces.", "영어와 기본 문장부호만 사용할 수 있어요. 긴 대시·말줄임표·특수 공백을 확인해 주세요."],
    "error.length": ["This is too long for one section. Turn on automatic splitting or shorten the reference audio.", "한 번에 읽을 수 있는 길이를 넘었어요. 자동 나누기를 켜거나 참조 오디오를 짧게 바꿔 주세요."],
    "error.tooManySections": ["Too many sections are needed. Shorten the text or increase the speed.", "너무 많은 구간이 필요해요. 글을 줄이거나 속도를 높여 주세요."],
    "error.denseText": ["There is too little reading time for the text. Check that the reference transcript matches its audio, or lower the speed.", "문장에 비해 읽을 시간이 너무 짧아요. 참조 오디오와 녹음 대사가 정확히 일치하는지 확인하거나 속도를 낮춰 주세요."],
    "error.finishing": ["Audio generation is complete and the file is being saved. Your result will appear shortly.", "음성 생성은 끝났고 파일을 저장하는 중이에요. 잠시 후 결과를 확인해 주세요."],
    "error.voiceBusy": ["This voice is in use. Wait for generation to finish before changing it.", "지금 사용 중인 목소리예요. 생성이 끝난 뒤 변경해 주세요."],
    "error.missingData": ["Couldn't find this item. Refresh the list or check the trash.", "이 자료를 찾을 수 없어요. 목록을 새로고침하거나 휴지통을 확인해 주세요."],
    "error.chooseVoice": ["Select or save a voice first.", "먼저 사용할 목소리를 선택하거나 저장해 주세요."],
    "error.seed": ["Enter a whole-number seed between 0 and 4,294,967,295.", "시드는 0부터 4,294,967,295 사이의 정수로 입력해 주세요."],
    "error.speed": ["Set the speed between 0.5 and 2.0.", "속도는 0.5부터 2.0 사이로 설정해 주세요."],
    "error.audioSupport": ["This browser can't convert audio. Open Studio in a recent Chrome or Edge browser.", "이 브라우저는 오디오 변환을 지원하지 않아요. 최신 Chrome 또는 Edge에서 열어 주세요."],
    "error.audioDecode": ["Couldn't read the audio. It may be damaged or unsupported. Try a standard WAV or MP3 file.", "오디오를 읽지 못했어요. 손상되었거나 브라우저가 지원하지 않는 형식일 수 있어요. 일반 WAV 또는 MP3 파일로 다시 선택해 주세요."],
    "error.audioEmpty": ["The audio has nothing to play.", "오디오에 재생할 내용이 없어요."],
    "error.audioSourceLong": ["Choose source audio no longer than 2 minutes. A short voice sample works best.", "원본 오디오는 2분 이하로 선택해 주세요. 짧은 목소리 샘플을 사용하면 더 좋아요."],
    "error.audioSilent": ["No audible speech was found. Choose a recording with a clear voice.", "말소리를 찾지 못했어요. 무음 파일이 아닌지 확인하고 목소리가 담긴 오디오를 선택해 주세요."],
    "error.audioTooShort": ["The voice is too brief or too quiet. Try a 3–10 second voice sample.", "말소리가 너무 짧거나 거의 들리지 않아요. 3–10초 정도의 목소리 샘플을 선택해 주세요."],
    "error.audioReferenceLong": ["Leave room for new audio. The reference must be shorter than 30 seconds after trimming.", "새 음성이 들어갈 여유가 필요해요. 참조 오디오는 무음 정리 후 30초 미만으로 선택해 주세요."],
    "error.audioFormat": ["Choose a WAV or MP3 file.", "WAV 또는 MP3 파일을 선택해 주세요."],
    "error.audioFileLarge": ["Choose an audio file of 50 MB or less.", "오디오 파일은 50 MB 이하로 선택해 주세요."],
    "error.audioFileEmpty": ["An empty audio file can't be used.", "빈 오디오 파일은 사용할 수 없어요."],
    "error.audioReadSaved": ["Couldn't read the saved audio. Please select the file again.", "저장된 오디오를 읽지 못했어요. 파일을 다시 선택해 주세요."],
    "error.voiceName": ["Enter a voice name.", "목소리 이름을 입력해 주세요."],
    "error.voiceNameLong": ["The voice name is too long. Use up to 160 English characters or about 53 CJK characters.", "목소리 이름이 너무 길어요. 한글은 약 53자, 영문은 160자 이내로 줄여 주세요."],
    "error.referenceText": ["Enter the words spoken in the reference audio.", "참조 오디오에서 말한 문장을 입력해 주세요."],
    "error.referenceFile": ["Choose reference audio first.", "참조 오디오를 먼저 선택해 주세요."],
    "validation.generationLabel": ["The text", "생성할 문장"],
    "validation.referenceLabel": ["The transcript", "녹음 대사"],
    "validation.emDash": ["an em dash (—)", "긴 대시(—)"],
    "validation.enDash": ["a dash (–)", "대시(–)"],
    "validation.ellipsis": ["an ellipsis (…)", "말줄임표(…)"],
    "validation.nbsp": ["a non-breaking space", "특수 공백"],
    "validation.zeroWidth": ["an invisible space", "보이지 않는 공백"],
    "validation.unsupported": ["{label} contains unsupported characters: {characters}. Use English and standard punctuation. Curly quotes are supported.", "{label}에 지원하지 않는 문자 {characters}가 있어요. 영어와 기본 문장부호로 바꿔 주세요. 곡선 따옴표는 사용할 수 있어요."],
    "validation.tooLong": ["{label} exceeds the input limit. Shorten it a little; curly quotes use more space than regular characters.", "{label}이 입력 한도를 넘었어요. 내용을 조금 줄여 주세요. 곡선 따옴표는 일반 글자보다 입력 공간을 더 사용해요."]
  };

  const catalogs = { en: {}, ko: {} };
  for (const [key, pair] of Object.entries(messages)) { catalogs.en[key] = pair[0]; catalogs.ko[key] = pair[1]; }
  const supported = ["en", "ko", "zh", "ja"];
  const storageKey = "wavegen.uiLocale.v1";
  let translationIndex = null;
  let locale = "en";
  try { const stored = localStorage.getItem(storageKey); if (supported.includes(stored)) locale = stored; } catch { /* English remains the explicit default. */ }
  function t(key, params = {}) {
    const message = catalogs[locale]?.[key] ?? catalogs.en[key] ?? key;
    return message.replace(/\{(\w+)\}/g, (match, name) => params[name] == null ? match : String(params[name]));
  }
  function register(language, catalog) {
    if (!supported.includes(language) || !catalog || typeof catalog !== "object") throw new Error("Invalid Studio locale catalog");
    catalogs[language] = { ...(catalogs[language] || {}), ...catalog };
    translationIndex = null;
  }
  function translate(message, depth = 0) {
    if (typeof message !== "string" || !message) return message || "";
    if (!translationIndex) {
      const exact = new Map(), patterns = [];
      for (const catalog of Object.values(catalogs)) for (const [key, value] of Object.entries(catalog)) {
        if (!value.includes("{")) { if (!exact.has(value)) exact.set(value, key); continue; }
        const names = [];
        let pattern = "", offset = 0;
        for (const match of value.matchAll(/\{(\w+)\}/g)) {
          // A unit template such as "{seconds}s" must never consume raw words ending in s.
          const numeric = ["seconds", "count", "done", "total", "start", "end", "seed", "speed", "status"].includes(match[1]);
          pattern += value.slice(offset, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (numeric ? "([0-9]+(?:[.,][0-9]+)?)" : "(.*?)");
          names.push(match[1]); offset = match.index + match[0].length;
        }
        pattern += value.slice(offset).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        patterns.push({ key, names, expression: new RegExp("^" + pattern + "$", "s"), specificity: value.replace(/\{\w+\}/g, "").length });
      }
      patterns.sort((a, b) => b.specificity - a.specificity);
      translationIndex = { exact, patterns };
    }
    if (translationIndex.exact.has(message)) return t(translationIndex.exact.get(message));
    for (const pattern of translationIndex.patterns) {
      const match = pattern.expression.exec(message);
      if (!match) continue;
      const params = {};
      pattern.names.forEach((name, index) => {
        const raw = match[index + 1];
        params[name] = depth < 2 && !["name", "voice", "text", "details"].includes(name) ? translate(raw, depth + 1) : raw;
      });
      return t(pattern.key, params);
    }
    return message;
  }
  function applyStatic(root = document) {
    root.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = t(element.getAttribute("data-i18n")); });
    for (const attribute of ["placeholder", "title", "aria-label"]) {
      root.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`))));
    }
  }
  function setLocale(language) {
    if (!supported.includes(language)) return false;
    locale = language;
    try { localStorage.setItem(storageKey, locale); } catch { /* The selection still works for this session. */ }
    if (typeof document !== "undefined") document.documentElement.lang = locale === "zh" ? "zh-CN" : locale;
    if (typeof window.dispatchEvent === "function") window.dispatchEvent(new CustomEvent("studio-locale-change", { detail: { locale } }));
    return true;
  }
  window.StudioI18n = { t, register, setLocale, translate, applyStatic, getLocale: () => locale, getCatalog: (language) => ({ ...(catalogs[language] || {}) }), getKeys: () => Object.keys(catalogs.en), locales: supported.slice(), storageKey };
})();

"use strict";
(() => {
  const messages = {
    "uxVoice.imageOptional": ["Character image · optional", "캐릭터 이미지 · 선택 사항", "角色图片 · 可选", "キャラクター画像・任意"],
    "uxVoice.enhancementOptional": ["Audio enhancement · optional", "음성 향상 · 선택 사항", "音频增强 · 可选", "音声の改善・任意"],
    "uxVoice.recoverAudio": ["Keep the previous recording", "이전 녹음 유지", "保留之前的录音", "変更前の録音を使う"],
    "uxVoice.audioRecovered": ["The previous recording is restored. Your other changes are kept.", "이전 녹음을 복원했어요. 다른 수정 내용은 유지해요.", "已恢复之前的录音，其他修改仍保留。", "変更前の録音に戻しました。他の変更は保持されています。"],
    "uxVoice.chooseEnhancement": ["Choose Use enhanced audio or Keep the original before saving.", "저장 전에 ‘향상한 음성 사용’ 또는 ‘원본 유지’를 선택해 주세요.", "保存前，请选择使用增强音频或保留原始音频。", "保存する前に、改善後の音声を使うか元の音声を保つか選んでください。"],
    "uxVoice.pendingEnhancement": ["Choose which version to save below.", "아래에서 저장할 음성 버전을 선택해 주세요.", "请在下方选择要保存的音频版本。", "下で保存する音声のバージョンを選んでください。"],
    "uxVoice.saveEnhanced": ["Will save: enhanced audio", "저장할 음성: 향상한 버전", "将保存：增强音频", "保存する音声：改善後の音声"],
    "uxVoice.savePrepared": ["Will save: prepared audio", "저장할 음성: 다듬은 버전", "将保存：处理后的音频", "保存する音声：調整後の音声"],
    "uxVoice.saveUnchanged": ["The saved recording stays unchanged.", "저장된 녹음은 그대로 유지해요.", "已保存的录音保持不变。", "保存済みの録音は変更されません。"],
    "uxVoice.saveNeedsAudio": ["Choose a recording to continue.", "계속하려면 녹음을 선택해 주세요.", "请选择录音以继续。", "続けるには録音を選んでください。"],
    "uxVoice.saveAudioIssue": ["Fix the audio issue, or keep the previous recording.", "음성 문제를 해결하거나 이전 녹음을 유지해 주세요.", "请解决音频问题，或保留之前的录音。", "音声の問題を解消するか、変更前の録音を使ってください。"],
    "uxVoice.saveAudioIssueNew": ["Fix the audio issue before saving.", "저장 전에 음성 문제를 해결해 주세요.", "保存前，请先解决音频问题。", "保存する前に音声の問題を解消してください。"],
    "uxVoice.saveImageIssue": ["Fix the image issue, or undo the image change.", "이미지 문제를 해결하거나 이미지 변경을 되돌려 주세요.", "请解决图片问题，或撤销图片更改。", "画像の問題を解消するか、画像の変更を元に戻してください。"],
    "uxVoice.saveTranscript": ["Confirm that the words match before saving.", "저장 전에 대사가 일치하는지 확인해 주세요.", "保存前，请确认文字与录音一致。", "保存前に、文章と音声の一致を確認してください。"],
    "uxVoice.saveEnhancing": ["Wait for enhancement, or stop it to continue editing.", "향상이 끝나기를 기다리거나 중지하고 편집을 계속하세요.", "请等待增强完成，或停止增强后继续编辑。", "改善処理の完了を待つか、停止して編集を続けてください。"],
    "uxVoice.savedBaseline": ["Back to the saved recording. No audio changes will be uploaded.", "저장된 녹음으로 돌아왔어요. 음성 파일은 변경하지 않아요.", "已恢复保存的录音，不会上传音频更改。", "保存済みの録音に戻りました。音声の変更は送信されません。"],
    "voiceOwn.add": ["Add your voice", "내 목소리 추가", "添加自己的声音", "自分の声を追加"],
    "voiceOwn.shortGuide": ["Add a clear voice clip and its matching transcript.", "깨끗한 음성 녹음과 일치하는 대사를 함께 등록하세요.", "添加清晰的语音片段和对应文字。", "明瞭な音声と、その内容に一致する文章を登録できます。"],
    "voiceOwn.guide": ["Choose a clear 3–10 second clip (under 30 seconds after editing), then enter exactly what it says.", "깨끗한 3~10초 녹음을 선택하고, 들리는 대사를 그대로 입력하세요. 편집 후 길이는 30초 미만이어야 해요.", "选择清晰的3–10秒录音（编辑后须短于30秒），并准确填写其中的文字。", "明瞭な3〜10秒の録音を選び、聞こえる言葉をそのまま入力してください。編集後の長さは30秒未満にしてください。"],
    "voiceOwn.permission": ["Use your own recording or one you have permission to use.", "본인의 녹음이나 사용 허락을 받은 녹음을 사용하세요.", "请使用自己的录音或已获准使用的录音。", "ご自身の録音、または使用許可を得た録音をお使いください。"]
  };
  for (const [index, locale] of ["en", "ko", "zh", "ja"].entries()) window.StudioI18n.register(locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])));
})();

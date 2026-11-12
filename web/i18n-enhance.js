"use strict";
(() => {
  const messages = {
    "enhance.outputOption": ["Speech Enhancement", "Speech Enhancement · 생성 음성 향상", "Speech Enhancement · 生成语音增强", "Speech Enhancement・生成音声の改善"],
    "enhance.outputHint": ["Optional RE-USE audio processing after generation. The original recording is kept.", "선택 사항 · 생성 후 RE-USE로 음성을 처리해요. 원본 녹음은 보관해요.", "可选 · 生成后使用 RE-USE 处理音频，并保留原始录音。", "任意・生成後にRE-USEで音声を処理します。元の録音は保持します。"],
    "enhance.referenceTitle": ["Prompt Enhancement", "Prompt Enhancement · 참조 음성 향상", "Prompt Enhancement · 参考音频增强", "Prompt Enhancement・参照音声の改善"],
    "enhance.referenceHint": ["Process the prepared reference audio with RE-USE. Compare both versions before choosing; Reference Text stays unchanged.", "다듬은 참조 음성을 RE-USE로 처리해요. 두 버전을 듣고 선택하세요. Reference Text는 바꾸지 않아요.", "使用 RE-USE 处理准备好的参考音频。试听两个版本后再选择；Reference Text 保持不变。", "調整済みの参照音声をRE-USEで処理します。両方を聴いてから選んでください。Reference Textは変更しません。"],
    "enhance.referenceAction": ["Try audio enhancement", "음성 향상 시도", "尝试音频增强", "音声の改善を試す"],
    "enhance.existingAction": ["Enhance this recording", "이 녹음 향상", "增强此录音", "この録音を改善"],
    "enhance.badge": ["RE-USE enhanced", "RE-USE 향상 적용", "已用 RE-USE 增强", "RE-USEで改善済み"],
    "enhance.before": ["Before enhancement", "향상 전", "增强前", "改善前"],
    "enhance.after": ["After enhancement", "향상 후", "增强后", "改善後"],
    "enhance.apply": ["Use enhanced audio", "향상한 음성 사용", "使用增强音频", "改善後の音声を使う"],
    "enhance.discard": ["Keep the original", "기존 음성 유지", "保留原音频", "元の音声を使う"],
    "enhance.applied": ["Enhanced audio selected. Listen again and confirm its transcript before saving.", "향상한 음성을 선택했어요. 다시 듣고 대사가 일치하는지 확인한 뒤 저장하세요.", "已选择增强音频。请再次试听并确认文字一致后保存。", "改善後の音声を選択しました。もう一度聴き、文章が一致することを確認してから保存してください。"],
    "enhance.compareHint": ["Enhancement can change the voice or introduce artifacts. Keep whichever version sounds better to you.", "처리 과정에서 목소리가 달라지거나 어색한 소리가 생길 수 있어요. 직접 듣고 더 나은 버전을 선택하세요.", "增强可能改变声音或引入不自然的效果。请试听后保留您觉得更好的版本。", "処理によって声が変わったり、不自然な音が生じたりする場合があります。聴き比べて好ましい方を選んでください。"],
    "enhance.available": ["Ready when you need it · off by default", "필요할 때 사용 · 기본은 꺼짐", "可按需使用 · 默认关闭", "必要なときに使用・初期設定はオフ"],
    "enhance.unavailable": ["The RE-USE audio enhancement model is not installed.", "RE-USE 음성 향상 모델이 설치되어 있지 않아요.", "未安装 RE-USE 音频增强模型。", "RE-USE音声改善モデルがインストールされていません。"],
    "enhance.firstUse": ["The enhancement model is prepared on first use.", "처음 사용할 때 향상 모델을 준비해요.", "首次使用时会准备增强模型。", "初回使用時に改善モデルを準備します。"],
    "enhance.loading": ["Preparing audio enhancement…", "음성 향상 모델 준비 중…", "正在准备音频增强…", "音声改善モデルを準備中…"],
    "enhance.working": ["Enhancing audio…", "음성 향상 처리 중…", "正在增强音频…", "音声を改善中…"],
    "enhance.cancel": ["Stop enhancement", "향상 처리 중지", "停止增强", "改善処理を停止"],
    "enhance.cancelHint": ["Stopping at a safe boundary. Your original audio stays unchanged.", "안전하게 중지할 수 있는 지점에서 멈춰요. 원본 음성은 그대로 유지해요.", "将在安全的处理边界停止。原始音频保持不变。", "安全に停止できる区切りで止まります。元の音声は変更しません。"],
    "enhance.cancelled": ["Enhancement stopped. Original audio kept.", "향상 처리를 중지했어요. 원본 음성은 유지했어요.", "增强已停止，原始音频已保留。", "改善処理を停止しました。元の音声は保持されています。"],
    "enhance.retry": ["Try enhancement again", "음성 향상 다시 시도", "重试音频增强", "音声改善を再試行"],
    "enhance.failed": ["Enhancement failed. Your original audio is still available. {details}", "향상 처리에 실패했어요. 원본 음성은 계속 사용할 수 있어요. {details}", "增强失败。原始音频仍可使用。{details}", "改善処理に失敗しました。元の音声は引き続き使用できます。{details}"],
    "enhance.complete": ["Enhanced recording saved as a new version. Original kept.", "향상한 녹음을 새 버전으로 저장했어요. 원본도 보관했어요.", "增强后的录音已另存为新版本，原始录音仍保留。", "改善後の録音を新しいバージョンとして保存しました。元の録音も保持しています。"],
    "enhance.openReference": ["Open the reference editor first to prepare the audio you want to enhance.", "먼저 참조 음성 편집을 열어 향상할 음성을 준비하세요.", "请先打开参考音频编辑器，准备要增强的音频。", "先に参照音声エディターを開き、改善する音声を準備してください。"],
    "enhance.stale": ["The audio settings changed. Try enhancement again for the current selection.", "음성 설정이 바뀌었어요. 현재 선택한 구간에 다시 적용하세요.", "音频设置已改变。请对当前选区重新增强。", "音声設定が変わりました。現在の選択範囲でもう一度実行してください。"],
    "enhance.originalMissing": ["The original version is unavailable for comparison.", "비교할 원본 버전을 찾을 수 없어요.", "无法获取原始版本进行比较。", "比較用の元バージョンを取得できません。"],
    "enhance.previewInvalid": ["The enhanced preview could not be read. Your prepared audio is unchanged.", "향상한 미리듣기 음성을 읽지 못했어요. 다듬은 기존 음성은 그대로예요.", "无法读取增强预览。已准备的音频保持不变。", "改善後の試聴音声を読み込めませんでした。調整済みの元音声は変更していません。"],
    "enhance.rawSaved": ["The original generated audio is saved below. Enhancement did not finish; you can try it again from this recording.", "생성한 원본 음성은 아래에 저장했어요. 향상 처리가 완료되지 않았으므로 이 녹음에서 다시 시도할 수 있어요.", "原始生成音频已保存在下方。增强未完成，可从此录音重试。", "生成した元の音声は下に保存されています。改善処理は完了していません。この録音から再試行できます。"]
  };
  for (const [index, locale] of ["en", "ko", "zh", "ja"].entries()) window.StudioI18n.register(locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])));
})();

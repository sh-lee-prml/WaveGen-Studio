"use strict";
(() => {
  const messages = {
    "models.label": ["Generation mode", "생성 모드", "生成模式", "生成モード"],
    "models.flash": ["Fast · Flash (4 steps)", "빠른 생성 · Flash (4단계)", "快速 · Flash（4 步）", "高速 · Flash（4ステップ）"],
    "models.vspec": ["High quality · V-Spec (50 steps)", "고품질 · V-Spec (50단계)", "高质量 · V-Spec（50 步）", "高品質 · V-Spec（50ステップ）"],
    "models.flashHint": ["Quick generation for trying ideas and everyday use.", "아이디어를 빠르게 확인하거나 일상적인 생성에 사용해 보세요.", "快速生成，适合尝试创意和日常使用。", "アイデアを試したいときや、普段の音声生成に。"],
    "models.vspecHint": ["More inference steps take longer. Results depend on the voice and text.", "더 많은 단계로 생성해 시간이 더 걸려요. 결과는 목소리와 문장에 따라 달라져요.", "更多推理步骤需要更长时间。效果因音色和文本而异。", "生成ステップが多いため時間がかかります。仕上がりは音声や文章によって異なります。"],
    "models.firstUse": ["First use prepares {model}. It stays ready while the app is open.", "처음 생성할 때 {model}을 준비해요. 앱이 열려 있는 동안 준비 상태를 유지해요.", "首次生成时会准备 {model}。应用运行期间会保持就绪。", "初回の生成時に{model}を準備します。アプリの起動中は準備済みの状態を保ちます。"],
    "models.loading": ["Preparing {model}…", "{model} 준비 중…", "正在准备 {model}…", "{model}を準備中…"],
    "models.loadingCancel": ["Stopping will finish after model preparation.", "중단은 모델 준비가 끝난 뒤 완료돼요.", "模型准备完成后会停止。", "モデルの準備が終わると停止します。"],
    "models.unavailable": ["{model} is not installed. Choose an available mode or install its model files.", "{model}이 설치되어 있지 않아요. 사용 가능한 모드를 선택하거나 모델 파일을 설치해 주세요.", "尚未安装 {model}。请选择可用模式或安装相应模型文件。", "{model}がインストールされていません。利用可能なモードを選ぶか、モデルファイルをインストールしてください。"],
    "models.unavailableOption": ["{label} · unavailable", "{label} · 사용 불가", "{label} · 不可用", "{label}・利用不可"],
    "models.unknown": ["The saved mode “{model}” is not supported. Choose Flash or V-Spec.", "저장된 모드 “{model}”을 지원하지 않아요. Flash 또는 V-Spec을 선택해 주세요.", "不支持已保存的模式“{model}”。请选择 Flash 或 V-Spec。", "保存されたモード「{model}」には対応していません。FlashまたはV-Specを選んでください。"],
    "models.loadError": ["Could not prepare {model}. Your text is still here. Try again or choose another mode.", "{model}을 준비하지 못했어요. 입력한 문장은 유지돼요. 다시 시도하거나 다른 모드를 선택해 주세요.", "无法准备 {model}。输入的文本已保留。请重试或选择其他模式。", "{model}を準備できませんでした。入力した文章は残っています。再試行するか、別のモードを選んでください。"],
    "models.result": ["{model} · {steps} steps", "{model} · {steps}단계", "{model} · {steps} 步", "{model}・{steps}ステップ"],
    "models.replacementResult": ["Replacement: {mode}", "교체 구간: {mode}", "替换片段：{mode}", "置換部分：{mode}"],
    "models.inheritedResult": ["Source mode: {mode}", "원본 모드: {mode}", "原始模式：{mode}", "元のモード：{mode}"],
    "models.editHint": ["Applies only to the regenerated selection. The rest of the recording stays unchanged.", "재생성할 선택 구간에만 적용돼요. 나머지 오디오는 그대로 유지돼요.", "仅应用于重新生成的选区，其余录音保持不变。", "再生成する選択範囲だけに適用されます。それ以外の音声は変わりません。"],
    "models.stepProgress": ["Inference steps {done}/{total}", "전체 추론 {done}/{total}단계", "推理进度 {done}/{total} 步", "推論ステップ {done}/{total}"],
    "models.choose": ["Choose a generation mode", "생성 모드를 선택해 주세요", "请选择生成模式", "生成モードを選んでください"]
  };
  for (const [index, locale] of ["en", "ko", "zh", "ja"].entries()) {
    window.StudioI18n.register(locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])));
  }
})();

"use strict";
(() => {
  const catalogs = {
    en: { "uxHistory.queryLong": "Search text is too long. Use a short part of the sentence or a voice name.", "uxHistory.versions": "Original and enhanced audio kept", "uxHistory.original": "Listen to original", "uxHistory.loadingMore": "Loading older recordings…", "uxHistory.moreFailed": "Couldn't load older recordings. Your current list is kept. Try Show older recordings again." },
    ko: { "uxHistory.queryLong": "검색어가 너무 깁니다. 문장의 짧은 일부나 목소리 이름을 입력해 주세요.", "uxHistory.versions": "원본과 향상 음성 모두 보관됨", "uxHistory.original": "원본 듣기", "uxHistory.loadingMore": "이전 녹음 불러오는 중…", "uxHistory.moreFailed": "이전 녹음을 불러오지 못했습니다. 현재 목록은 유지됩니다. 이전 녹음 보기를 다시 눌러 주세요." },
    zh: { "uxHistory.queryLong": "搜索内容过长。请输入句子的一小部分或声音名称。", "uxHistory.versions": "原始和增强音频均已保留", "uxHistory.original": "收听原始音频", "uxHistory.loadingMore": "正在加载较早的录音…", "uxHistory.moreFailed": "无法加载较早的录音。当前列表已保留。请再次点击显示较早的录音。" },
    ja: { "uxHistory.queryLong": "検索語が長すぎます。文の短い一部または声の名前を入力してください。", "uxHistory.versions": "元の音声と補正後の音声を保存済み", "uxHistory.original": "元の音声を聴く", "uxHistory.loadingMore": "過去の録音を読み込み中…", "uxHistory.moreFailed": "過去の録音を読み込めませんでした。現在の一覧は保持されています。もう一度、過去の録音を表示してください。" },
  };
  for (const [locale, catalog] of Object.entries(catalogs)) window.StudioI18n.register(locale, catalog);
  const output = {
    "studio.workspace": ["Workspace", "작업 공간", "工作区", "ワークスペース"],
    "studio.theme": ["Color theme", "화면 테마", "界面主题", "画面テーマ"],
    "studio.system": ["System", "시스템", "跟随系统", "システム"],
    "studio.light": ["White", "화이트", "白色", "ホワイト"],
    "studio.dark": ["Black", "블랙", "黑色", "ブラック"],
    "studio.create": ["Create", "음성 만들기", "创作", "作成"],
    "studio.recordings": ["Recordings", "녹음 보관함", "录音", "録音"],
    "studio.voices": ["Voice library", "목소리 라이브러리", "声音库", "音声ライブラリ"],
    "studio.returnToScript": ["Back to script", "대본으로 돌아가기", "返回文稿", "原稿に戻る"],
    "studio.speech": ["Speech studio", "음성 스튜디오", "语音工作室", "音声スタジオ"],
    "studio.change": ["Change", "변경", "更换", "変更"],
    "studio.preview": ["Preview selected voice", "선택한 목소리 미리 듣기", "试听所选声音", "選択した声を試聴"],
    "studio.previewError": ["The voice preview could not be played.", "목소리 미리 듣기를 재생할 수 없습니다.", "无法播放所选声音。", "選択した声を再生できませんでした。"],
    "studio.script": ["Script", "대본", "文稿", "原稿"],
    "studio.sample": ["Try a sample", "예시 대본 넣기", "试用示例", "例文を使う"],
    "studio.placeholder": ["Type or paste your English script…", "영어 대본을 입력하거나 붙여넣으세요…", "输入或粘贴英文文稿…", "英文の原稿を入力または貼り付けてください…"],
    "studio.outputEmpty": ["Generate a script to listen here.", "대본으로 음성을 생성하면 여기서 들어볼 수 있습니다.", "生成音频后可在此试听。", "音声を生成するとここで再生できます。"],
    "output.ready": ["Ready to listen", "바로 들을 수 있어요", "可以收听了", "再生できます"],
    "output.view": ["View audio", "생성 음성 보기", "查看音频", "音声を表示"],
    "output.details": ["Text and generation details", "문장과 생성 정보", "文本与生成详情", "文章と生成情報"],
    "output.compare": ["Compare with the original", "원본과 비교하기", "与原始音频比较", "元の音声と比較"],
    "output.history": ["Saved recordings", "저장한 녹음", "已保存的录音", "保存した録音"],
    "output.splitOn": ["Long text · auto split", "긴 글 · 자동 나누기", "长文本 · 自动分段", "長文・自動分割"],
    "output.enhanceOn": ["Enhancement on", "음성 향상 켜짐", "音频增强已开启", "音声改善オン"],
    "output.characterFull": ["Character effect · full audio", "캐릭터 효과 · 전체 음성", "角色效果 · 整段音频", "キャラクター効果・音声全体"],
    "output.characterReplacement": ["Character effect · regenerated section", "캐릭터 효과 · 재생성한 구간", "角色效果 · 重新生成的片段", "キャラクター効果・再生成した区間"],
    "output.characterInherited": ["Character effect retained from source", "기존 음성의 캐릭터 효과 유지", "保留来源音频的角色效果", "元の音声のキャラクター効果を保持"],
    "output.characterMixed": ["Edited mix · character audio from source", "편집한 혼합 음성 · 원본의 캐릭터 음성 포함", "编辑后的混合音频 · 包含来源角色声音", "編集したミックス・元のキャラクター音声を含む"],
    "output.characterSoftened": ["Enhancement may soften the character effect", "음성 향상으로 캐릭터 효과가 약해질 수 있어요", "音频增强可能减弱角色效果", "音声改善によりキャラクター効果が弱まる場合があります"]
  };
  for (const [index, locale] of ["en", "ko", "zh", "ja"].entries()) window.StudioI18n.register(locale, Object.fromEntries(Object.entries(output).map(([key, values]) => [key, values[index]])));
})();

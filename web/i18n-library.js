"use strict";
(() => {
  const messages = {
    "libraryX.image": ["Character image", "캐릭터 이미지", "角色图片", "キャラクター画像"],
    "libraryX.optional": ["Optional", "선택 사항", "可选", "任意"],
    "libraryX.chooseImage": ["Choose image", "이미지 선택", "选择图片", "画像を選択"],
    "libraryX.replaceImage": ["Replace image", "이미지 교체", "更换图片", "画像を変更"],
    "libraryX.removeImage": ["Remove image", "이미지 삭제", "移除图片", "画像を削除"],
    "libraryX.imageDrop": ["Drop a PNG, JPG or WebP image here", "PNG·JPG·WebP 이미지를 여기에 놓으세요", "将 PNG、JPG 或 WebP 图片拖到这里", "PNG・JPG・WebP画像をここにドロップ"],
    "libraryX.imageHint": ["Up to 10 MB. Cropped to a square and saved without image metadata.", "최대 10 MB. 정사각형으로 잘라 이미지 메타데이터 없이 저장해요.", "最大 10 MB。将裁为正方形，并移除图片元数据后保存。", "最大10 MB。正方形に切り抜き、画像のメタデータを除いて保存します。"],
    "libraryX.imageProcessing": ["Preparing image…", "이미지 준비 중…", "正在准备图片…", "画像を準備中…"],
    "libraryX.imageReady": ["New image ready to save", "새 이미지를 저장할 준비가 됐어요", "新图片已准备好保存", "新しい画像を保存できます"],
    "libraryX.imageRemoved": ["Image will be removed when saved", "저장하면 이미지를 삭제해요", "保存时将移除图片", "保存すると画像が削除されます"],
    "libraryX.imageFormat": ["Choose a PNG, JPG or WebP image.", "PNG·JPG·WebP 이미지를 선택해 주세요.", "请选择 PNG、JPG 或 WebP 图片。", "PNG・JPG・WebP画像を選んでください。"],
    "libraryX.imageLarge": ["Choose an image of 10 MB or less.", "10 MB 이하 이미지를 선택해 주세요.", "请选择不超过 10 MB 的图片。", "10 MB以下の画像を選んでください。"],
    "libraryX.imagePixels": ["Use an image up to 16 megapixels, with each side no larger than 8,192 pixels.", "1,600만 화소 이하, 한 변이 8,192픽셀 이하인 이미지를 사용해 주세요.", "请使用不超过 1600 万像素，且每边不超过 8192 像素的图片。", "1600万画素以下、各辺8192ピクセル以下の画像を使用してください。"],
    "libraryX.imageDecode": ["Could not read this image. Try another PNG, JPG or WebP file.", "이미지를 읽지 못했어요. 다른 PNG·JPG·WebP 파일을 선택해 주세요.", "无法读取此图片。请尝试其他 PNG、JPG 或 WebP 文件。", "画像を読み込めませんでした。別のPNG・JPG・WebPファイルを選んでください。"],
    "libraryX.imageEncode": ["Could not prepare the image. Try a smaller image.", "이미지를 준비하지 못했어요. 더 작은 이미지를 사용해 주세요.", "无法处理图片。请尝试较小的图片。", "画像を準備できませんでした。より小さい画像を試してください。"],
    "libraryX.preset": ["Starter voice · terms", "프리셋 · 사용 조건", "预设音色 · 使用条款", "プリセット・利用条件"],
    "libraryX.modifiedPreset": ["Customized starter voice", "수정한 프리셋 목소리", "已修改的预设音色", "変更済みのプリセット音声"],
    "libraryX.sourceTitle": ["Source and usage terms", "출처와 사용 조건", "来源与使用条款", "出典と利用条件"],
    "libraryX.sourceLink": ["Original source", "원본 출처", "原始来源", "元の出典"],
    "libraryX.licenseLink": ["Read license", "라이선스 보기", "查看许可", "ライセンスを読む"],
    "libraryX.attribution": ["Attribution", "출처 표시", "署名", "クレジット"],
    "libraryX.fictional": ["The bundled character artwork is fictional and does not depict the original speaker.", "함께 제공된 캐릭터 그림은 가상 인물이며 원본 화자의 실제 모습이 아니에요.", "随附角色插画为虚构人物，并非原始说话人的肖像。", "付属のキャラクターは架空の人物で、元の話者の姿を表したものではありません。"],
    "libraryX.modifiedNotice": ["The reference audio or transcript was changed. Original source terms still apply to the supplied sample.", "참조 오디오 또는 녹음 대사가 변경됐어요. 제공된 원본 샘플의 사용 조건은 그대로 적용돼요.", "参考音频或转写已被修改。原始来源的使用条款仍适用于提供的样本。", "参照音声または文章が変更されました。提供されたサンプルには元の利用条件が引き続き適用されます。"],
    "libraryX.licenseNotice": ["Included license notice", "동봉된 라이선스 고지", "随附许可声明", "同梱のライセンス表記"],
    "libraryX.modelTerms": ["These terms cover the sample. The bundled WaveGen model is licensed CC BY-NC 4.0 (non-commercial).", "이 조건은 음성 샘플에 적용돼요. 동봉된 WaveGen 모델은 비상업용 CC BY-NC 4.0이에요.", "这些条款适用于样本。随附的 WaveGen 模型采用 CC BY-NC 4.0 许可，仅限非商业用途。", "これらの条件はサンプルに適用されます。同梱のWaveGenモデルは非商用のCC BY-NC 4.0ライセンスです。"]
  };
  for (const [index, locale] of ["en", "ko", "zh", "ja"].entries()) {
    window.StudioI18n.register(locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])));
  }
})();

"use strict";
(() => {
  const messages = {
    "editUx.draftRestored": ["Your edit settings and Undo history were restored in this tab. No new audio was created.", "이 탭에서 편집 설정과 실행 취소 기록을 복원했어요. 새 음성은 생성하지 않았어요.", "已在此标签页中恢复编辑设置和撤销历史，未生成新的音频。", "このタブの編集設定と元に戻す履歴を復元しました。新しい音声は生成していません。"],
    "editUx.restoring": ["Restoring the unfinished edit…", "완료되지 않은 편집을 확인하는 중…", "正在恢复未完成的编辑…", "未完了の編集を確認中…"],
    "editUx.checking": ["Checking the edit and saved history…", "편집 상태와 저장 기록 확인 중…", "正在检查编辑状态和保存记录…", "編集状況と保存履歴を確認中…"],
    "editUx.waiting": ["This edit is still running. Its request is kept, and you can stop it below.", "아직 편집 중이에요. 요청을 유지하고 있으며 아래에서 중지할 수 있어요.", "此编辑仍在运行。请求已保留，您可以在下方停止。", "この編集はまだ実行中です。要求は保持されており、下で停止できます。"],
    "editUx.uncertain": ["The connection was interrupted. The edit may still be running. Your original audio and pending request are kept; check again or stop the edit.", "연결이 끊겨 편집이 계속 진행 중일 수 있어요. 원본 음성과 요청을 유지했어요. 상태를 다시 확인하거나 편집을 중지하세요.", "连接中断，编辑可能仍在运行。原始音频和待处理请求已保留；请重新检查或停止编辑。", "接続が中断され、編集が続いている可能性があります。元音声と処理中の要求は保持されています。再確認するか、編集を停止してください。"],
    "editUx.checkAgain": ["Check edit status", "편집 상태 다시 확인", "重新检查编辑状态", "編集状況を再確認"],
    "editUx.stopWaiting": ["Stop waiting", "추적 종료", "停止等待", "待機を終了"],
    "editUx.stopWaitingHint": ["This only closes tracking; processing may still finish. Check history before trying again.", "진행 상황 추적만 닫으며, 처리는 이후에 완료될 수 있어요. 다시 시도하기 전에 저장 기록을 확인하세요.", "此操作仅关闭进度跟踪，处理仍可能完成。再次尝试前，请先检查历史记录。", "進捗の確認だけを終了します。処理は後から完了する可能性があります。再試行する前に保存履歴を確認してください。"],
    "editUx.recovered": ["The completed edit was found in history.", "저장 기록에서 완료된 편집을 찾았어요.", "已在历史记录中找到完成的编辑。", "保存履歴から完了した編集が見つかりました。"],
    "editUx.notSaved": ["The edit is no longer running and no completed result was found. Your original audio and edit settings are kept; you can try again.", "편집이 더 이상 진행 중이지 않으며 완료된 결과를 찾지 못했어요. 원본 음성과 편집 설정은 유지했으니 다시 시도할 수 있어요.", "编辑已不再运行，也未找到完成的结果。原始音频和编辑设置已保留，可再次尝试。", "編集は終了していますが、完了した結果は見つかりませんでした。元音声と編集設定は保持されているため、再試行できます。"],
    "editUx.otherData": ["This app is using a different data folder. The previous request was not cancelled or changed.", "앱이 다른 데이터 폴더를 사용하고 있어요. 이전 요청을 취소하거나 변경하지 않았어요.", "此应用正在使用不同的数据文件夹。之前的请求未被取消或更改。", "このアプリは別のデータフォルダーを使用しています。前の要求は取り消しも変更もしていません。"]
  };
  for (const [index, locale] of ["en", "ko", "zh", "ja"].entries()) window.StudioI18n.register(locale, Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])));
})();

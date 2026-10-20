// Reconcile transcript.json's speaker labels against the note's markdown
// transcript (the actual source of truth for renames — the rename UI, voice
// bank merges, and auto-naming all write there, but historically never wrote
// back to transcript.json). Groups the raw segments into consecutive
// same-speaker runs and zips them positionally against the markdown's
// "**Speaker:** text" paragraphs (formatDiarizedTranscript produces exactly
// one paragraph per run), so playback always reflects the current name even
// when transcript.json itself was never updated. Falls back to the raw
// labels if the run/paragraph counts don't line up (e.g. no markdown yet).
function reconcileSegmentSpeakers(rawSegments, markdownTranscript) {
  if (!markdownTranscript || !rawSegments.length) return rawSegments;

  const runs = [];
  const segRunIndex = [];
  for (const seg of rawSegments) {
    const label = seg?.speaker ?? null;
    const last = runs[runs.length - 1];
    if (!last || last.label !== label) runs.push({ label });
    segRunIndex.push(runs.length - 1);
  }

  // Parse the markdown into blocks exactly the way the per-paragraph edit
  // handler does (split on blank lines), keeping each labeled paragraph's
  // BLOCK index. A resumed meeting can carry unlabeled preamble blocks, so
  // the Nth labeled paragraph is not necessarily the Nth block — using the
  // run index directly as paragraphIndex would make per-paragraph edits
  // land N blocks early.
  const blocks = markdownTranscript.split(/\n{2,}/);
  const mdParas = [];
  blocks.forEach((block, blockIndex) => {
    const m = /^\*\*(.+?):\*\*/.exec(block);
    if (m) mdParas.push({ label: m[1].trim(), blockIndex });
  });

  // Run/paragraph counts only line up when reconciliation is trustworthy —
  // that's also the only time a raw segment's run index can be trusted as
  // the markdown paragraph index for a later per-paragraph edit.
  if (mdParas.length !== runs.length) return rawSegments;

  // Map each segment to its run's markdown label BY RUN INDEX, not by raw
  // label — the same raw diarization speaker id commonly recurs in separate,
  // non-adjacent runs (A talks, B talks, A talks again). A label-keyed map
  // would let the last run's name silently overwrite earlier runs sharing
  // that raw id, misattributing whole stretches of the karaoke view.
  return rawSegments.map((seg, i) => {
    const runIndex = segRunIndex[i];
    const para = mdParas[runIndex];
    const mdLabel = runs[runIndex].label != null ? para.label : null;
    return mdLabel != null
      ? { ...seg, speaker: mdLabel, paragraphIndex: para.blockIndex }
      : { ...seg, paragraphIndex: para.blockIndex };
  });
}

module.exports = { reconcileSegmentSpeakers };

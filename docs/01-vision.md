# 01 — Vision

## One paragraph

Musician listens to a recording and explains its harmony the way a good teacher
sitting next to you would: it separates the instruments, writes down what each one
plays, names the chords *including the voicing*, shows how the progression is built,
and, when you play your own MIDI keyboard, tells you how what you played relates to
what is on the record. Under the hood it is a plugin kernel, so it can grow new
abilities while running, and it can ask a coding agent to write those abilities for
it.

## Why existing tools fall short

- Stem splitters (Demucs, BS-RoFormer, Moises) stop at audio. They do not explain.
- Chord-detection apps (Chordify and friends) give a coarse chord symbol per beat,
  no voicing, no function, and are opaque about confidence.
- Transcription tools (AnthemScore, MuseScore import) give you a pile of notes with
  no harmonic interpretation, and their notation is usually unreadable without cleanup.
- Theory libraries (music21, tonal.js) can name a chord from pitches but do not
  reason about voicing type, do not rank alternatives, and are not connected to audio.
- Nothing combines a live MIDI input with an analysed recording in one view.

## What would make this new

These are the propositions worth the effort. They are ordered by how much they
differentiate, not by how easy they are.

1. **Voicing-level harmony, not chord symbols.** Given the notes actually sounding,
   name the chord *and* the voicing: root-position close, drop 2, drop 3, rootless
   A/B form, shell, quartal stack, upper-structure triad ("D triad over C7"),
   spread, cluster, "So What" voicing, polychord. With the bass stem separated we
   know the true bass note, which resolves most slash-chord ambiguity that
   symbol-only tools get wrong. See `04-harmony-engine.md`.

2. **Progression as grammar, not a list.** Parse a chord sequence into a functional
   tree: a ii–V–I nested inside a longer cadence, a tritone substitution standing in
   for a V, a backdoor cadence, a Coltrane cycle, modal interchange. Output is a
   tree with Roman numerals and named idioms, so the UI can say "bars 5–8 are a
   ii–V into the relative minor, with the V replaced by its tritone sub".

3. **Consensus with provenance.** Three independent routes produce chords: an
   audio chord recogniser on the mix, the symbolic engine on transcribed stems, and
   the symbolic engine on live MIDI. They vote. Where they disagree, that
   disagreement is *shown*, because it is usually where the interesting harmony is
   (a suspension, a rootless voicing, a passing chord).

4. **Play-along comparison.** Plug in a keyboard, play over the song, and see your
   voicing beside the record's voicing at that beat. "You played a rootless
   Cmaj9 in A form; the record has a drop-2 with the 7th on top."

5. **A workbench that grows itself.** The UI has a box: "Add a plugin that detects
   Coltrane changes." That request goes to Claude Code or Codex with the plugin
   contract and conformance tests attached. The agent writes the plugin in a
   sandbox, the tests run, and the loader hot-mounts it. No restart. If it
   misbehaves, its Cordis context branch is torn down and nothing else notices.

6. **Time-travel re-analysis.** The analysis document is event-sourced. Swap the
   chord engine for a new version and diff the two analyses of the same song. This
   is how we evaluate every change to the harmony engine.

## What this is not

- Not a DAW. We do not edit or render audio beyond playback of stems.
- Not a notation editor. We render notation for reading; MuseScore is the editor.
- Not a cloud service (for now). Everything runs locally on the owner's machine.

## Who it is for

First user is the owner: a musician who wants to learn from records and wants a
software project that is a learning experience in systems design. Second users are
jazz and pop musicians who transcribe by ear and want a second opinion, and
teachers who want to show voicings and function from a real recording.

## Log

- 2026-09-18: first draft from the initial conversation.

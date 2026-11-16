import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { flushNoteBoard, getNoteBoard, saveNoteBoard } from "../../ipc/noteBoard";
import { onNoteBoardChanged } from "../../ipc/events";
import type { WysiwygHandle } from "../CenterPane/doc/WysiwygEditor";
import "../CenterPane/doc/docTheme.css";
import "./notes.css";

// The Markdown editor is heavy; load it only when the Notes tab first opens.
const WysiwygEditor = lazy(() =>
  import("../CenterPane/doc/WysiwygEditor").then((m) => ({ default: m.WysiwygEditor })),
);

/** The notes board: one Markdown note for the whole app, saved automatically while typing. */
export function NotesTab() {
  const t = useT();
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const editor = useRef<WysiwygHandle>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = () => {
    setFailed(false);
    getNoteBoard().then(setBody, () => setFailed(true));
  };
  useEffect(() => {
    load();
    return () => void flushNoteBoard();
  }, []);

  // Another window saved: show its text, unless the user is typing here.
  useEffect(() => {
    const typing = () => !!box.current?.contains(document.activeElement);
    const off = onNoteBoardChanged(() => {
      if (typing()) return;
      void getNoteBoard().then((next) => {
        const current = editor.current;
        if (current && !typing() && current.getMarkdown() !== next) current.setMarkdown(next);
      });
    });
    return () => void off.then((unlisten) => unlisten());
  }, []);

  if (failed) {
    return (
      <div className="insp-section notes-message">
        {t("notes.loadFailed")}{" "}
        <button className="btn" onClick={load}>{t("common.retry")}</button>
      </div>
    );
  }
  if (body === null) return <div className="insp-section notes-message">{t("common.loading")}</div>;
  return (
    <div ref={box} className="docview notes-tab" aria-label={t("notes.title")} onBlur={() => void flushNoteBoard()}>
      <Suspense fallback={<div className="insp-section notes-message">{t("common.loading")}</div>}>
        <WysiwygEditor
          ref={editor}
          defaultValue={body}
          docPath=""
          textOnly
          onEdited={() => {
            const markdown = editor.current?.getMarkdown();
            if (markdown != null) saveNoteBoard(markdown);
          }}
        />
      </Suspense>
    </div>
  );
}
